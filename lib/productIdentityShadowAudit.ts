/**
 * Product Identity Shadow Audit — Batch 3.1 (pure in-memory metrics).
 *
 * Audit / metrics only. Gemini additional calls = 0.
 * Does NOT import analyticsReceiptSelection, merchantType, db, or expo-sqlite.
 * Does not write merchant_products / identity links to SQLite or Supabase.
 */

import {
  FUZZY_AUTO_MATCH_THRESHOLD,
  FUZZY_CANDIDATE_FLOOR,
  resolveReceiptItemIdentity,
  type ResolveIdentityResult,
} from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  type MerchantProductRecord,
  type ProductIdentityStore,
} from './productIdentityStore';
import {
  attributesAreCompatible,
  type StructuralConflict,
} from './productIdentityStructuralConflict';
import { combinedNameSimilarity } from './productIdentitySimilarity';
import {
  emptyProductAttributes,
  type ProductAttributes,
  type ProductIdentityLevel,
} from './productIdentityContract';
import { buildIdentityNameStem } from './productIdentityNameStem';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';

/** Audit-only probe floor — does NOT change resolver thresholds. */
export const AUDIT_FUZZY_PROBE_FLOOR = 0.75;

export type ShadowIdentityObservation = {
  receiptId: string;
  itemSourceIndex: number;
  rawName: string;
  merchantKey: string;
  quantity?: number | null;
  lineTotal?: number | null;
};

/** What the resolver did (action), independent of identity level. */
export type ShadowResolutionAction =
  | 'cache_hit'
  | 'existing_exact'
  | 'existing_stem'
  | 'alias_match'
  | 'dictionary_match'
  | 'fuzzy_auto_match'
  | 'new_merchant_entity'
  | 'family_fallback'
  | 'unresolved';

export type ShadowDatasetSummary = {
  storedReceiptCount: number;
  purchaseCandidateCount: number;
  duplicateExtrasExcluded: number;
  contentExactExtras: number;
  structuralExactExtras: number;
  reconciledStructuralExtras: number;
  v1SupportedPurchaseCandidateCount: number;
  eligibleItemObservations: number;
  appliedV1MerchantFilter: boolean;
};

export type ShadowEntityAssignment = {
  /** Matched a MerchantProduct that already existed earlier in this run. */
  merchantProductExistingMatch: number;
  /** Created a new MerchantProduct container for this observation. */
  merchantProductNewEntity: number;
  merchantProductTotalAssigned: number;
  distinctMerchantProducts: number;
  canonicalExistingMatch: number;
  canonicalNewEntity: number;
};

export type ShadowReuseQuality = {
  /**
   * existingMatch / eligibleObservations
   * Share of observations that reused a MerchantProduct created earlier
   * in this shadow run (cross-observation reuse).
   */
  merchantProductReuseRate: number;
  /**
   * existingMatch / (existingMatch + newEntity)
   * Among assigned merchant containers, fraction that were reuse vs create.
   */
  reuseAmongAssignedRate: number;
  merchantProductsWith2PlusObservations: number;
  merchantProductsWith3PlusObservations: number;
  observationsPerMerchantProduct: {
    mean: number;
    median: number;
    max: number;
  };
};

export type ShadowPairSample = {
  merchantKey: string;
  itemA: string;
  itemB: string;
  similarity: number;
  attributesA: string;
  attributesB: string;
  variantConflict: boolean;
  structuralConflict: boolean;
  resolverDecision: string;
  reason: string;
  conflicts?: StructuralConflict[];
};

export type ShadowStemDiagnostics = {
  stemCandidateCount: number;
  stemAcceptedCount: number;
  stemRejectedStructuralConflict: number;
  stemRejectedVariantConflict: number;
  acceptSamples: ShadowPairSample[];
};

export type ShadowConflictDiagnostics = {
  structuralConflictCandidates: number;
  structuralConflictRejected: number;
  variantConflictCandidates: number;
  variantConflictRejected: number;
};

export type ShadowIdentityAuditReport = {
  contractVersion: 'meruno-product-identity-shadow-audit-v3.1';
  thresholds: {
    fuzzyAutoMatch: number;
    fuzzyCandidateFloor: number;
    auditFuzzyProbeFloor: number;
  };
  dataset: ShadowDatasetSummary;
  byLevel: Record<ProductIdentityLevel, number>;
  byAction: Record<ShadowResolutionAction, number>;
  entityAssignment: ShadowEntityAssignment;
  reuseQuality: ShadowReuseQuality;
  stemDiagnostics: ShadowStemDiagnostics;
  conflictDiagnostics: ShadowConflictDiagnostics;
  fuzzyRiskPairs: ShadowPairSample[];
  fixtureConflictSamples: ShadowPairSample[];
  geminiAdditionalCalls: 0;
};

export type ProductIntelligenceExportPayload = {
  receipts?: Array<Record<string, unknown>>;
  receiptItems?: Array<{
    receipt_id: string;
    source_index?: number;
    name?: string | null;
    raw_name?: string | null;
    quantity?: number | null;
    lineTotal?: number | null;
    line_total?: number | null;
  }>;
};

function emptyLevels(): Record<ProductIdentityLevel, number> {
  return {
    sku_exact: 0,
    product_exact: 0,
    merchant_product: 0,
    family_spec: 0,
    family_only: 0,
    unresolved: 0,
  };
}

function emptyActions(): Record<ShadowResolutionAction, number> {
  return {
    cache_hit: 0,
    existing_exact: 0,
    existing_stem: 0,
    alias_match: 0,
    dictionary_match: 0,
    fuzzy_auto_match: 0,
    new_merchant_entity: 0,
    family_fallback: 0,
    unresolved: 0,
  };
}

function attrsText(attrs: ProductAttributes): string {
  return attrs.entries
    .map((e) => `${e.dimension}=${e.value}${e.unit ?? ''}`)
    .join(',');
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function mapResolutionAction(result: ResolveIdentityResult): ShadowResolutionAction {
  switch (result.reason) {
    case 'cache_hit':
      return 'cache_hit';
    case 'same_merchant_comparison_key':
      return 'existing_exact';
    case 'same_merchant_identity_stem':
      return 'existing_stem';
    case 'alias_or_dictionary_exact': {
      const src = String(result.link.identitySource);
      return src === 'dictionary_exact' ? 'dictionary_match' : 'alias_match';
    }
    case 'same_merchant_fuzzy_auto':
      return 'fuzzy_auto_match';
    case 'family_spec_generic':
    case 'family_only_generic':
      return 'family_fallback';
    case 'new_merchant_product':
      return 'new_merchant_entity';
    case 'unresolved_empty_key':
      return 'unresolved';
    default:
      if (result.createdMerchantProduct) {
        if (
          result.link.identityLevel === 'family_spec' ||
          result.link.identityLevel === 'family_only'
        ) {
          return 'family_fallback';
        }
        return 'new_merchant_entity';
      }
      if (result.link.merchantProductId) return 'existing_exact';
      return 'unresolved';
  }
}

function classifyConflicts(conflicts: StructuralConflict[]): {
  structural: boolean;
  variant: boolean;
} {
  let structural = false;
  let variant = false;
  for (const c of conflicts) {
    if (c.kind === 'variant_token') variant = true;
    else structural = true;
  }
  return { structural, variant };
}

export function observationsFromProductIntelligenceExport(
  payload: ProductIntelligenceExportPayload
): ShadowIdentityObservation[] {
  const merchantById = new Map<string, string>();
  for (const r of payload.receipts ?? []) {
    const id = String(r.id ?? '');
    if (!id) continue;
    const key = String(
      (r.merchant_normalized as string | null) ||
        (r.merchant_raw as string | null) ||
        ''
    ).trim();
    merchantById.set(id, key || 'unknown_merchant');
  }
  const out: ShadowIdentityObservation[] = [];
  for (const item of payload.receiptItems ?? []) {
    const raw = (item.raw_name || item.name || '').trim();
    if (!raw) continue;
    out.push({
      receiptId: item.receipt_id,
      itemSourceIndex: item.source_index ?? 0,
      rawName: raw,
      merchantKey: merchantById.get(item.receipt_id) ?? 'unknown_merchant',
      quantity: item.quantity,
      lineTotal: item.lineTotal ?? item.line_total,
    });
  }
  return out;
}

/**
 * Probe same-merchant stem candidates already in the store before resolve.
 * Diagnostics only — does not change resolver behavior.
 */
function probeStemAgainstStore(
  obs: ShadowIdentityObservation,
  store: ProductIdentityStore,
  diagnostics: ShadowStemDiagnostics
): void {
  const norm = normalizeProductForIdentity(obs.rawName);
  const stem = buildIdentityNameStem(
    norm.normalizedName || norm.comparisonKey || obs.rawName
  );
  if (stem.length < 2) return;

  const catalog = store.listMerchantProducts(
    obs.merchantKey || 'unknown_merchant'
  );
  for (const candidate of catalog) {
    const candStem = buildIdentityNameStem(
      candidate.normalizedName ||
        candidate.canonicalDisplayName ||
        candidate.comparisonKey
    );
    if (!candStem || candStem !== stem) continue;
    diagnostics.stemCandidateCount += 1;

    const leftText = `${obs.rawName} ${norm.normalizedName}`;
    const rightText = `${candidate.canonicalDisplayName ?? ''} ${candidate.normalizedName ?? ''}`;
    const compat = attributesAreCompatible(
      norm.attributes ?? emptyProductAttributes(),
      candidate.attributes ?? emptyProductAttributes(),
      leftText,
      rightText
    );
    if (!compat.ok) {
      const kinds = classifyConflicts(compat.conflicts);
      if (kinds.structural) diagnostics.stemRejectedStructuralConflict += 1;
      if (kinds.variant) diagnostics.stemRejectedVariantConflict += 1;
    }
  }
}

function buildFixtureConflictSamples(): ShadowPairSample[] {
  const pairs: Array<[string, string, string]> = [
    ['コーラ500ml', 'コーラ1.5L', 'volume_conflict'],
    ['コーラ500ml×6本', 'コーラ3L', 'multipack_vs_bulk'],
    ['午後の紅茶 ミルクティー500ml', '午後の紅茶 レモンティー500ml', 'variant_token'],
    ['コカコーラ500ml', 'コカコーラZERO500ml', 'variant_token_zero'],
    ['低脂肪乳 1L', '普通牛乳 1L', 'variant_token_low_fat'],
  ];
  const out: ShadowPairSample[] = [];
  for (const [left, right, tag] of pairs) {
    const a = normalizeProductForIdentity(left);
    const b = normalizeProductForIdentity(right);
    const compat = attributesAreCompatible(
      a.attributes,
      b.attributes,
      left,
      right
    );
    const kinds = classifyConflicts(compat.conflicts);
    out.push({
      merchantKey: '(fixture)',
      itemA: left,
      itemB: right,
      similarity: combinedNameSimilarity(a.comparisonKey, b.comparisonKey),
      attributesA: attrsText(a.attributes),
      attributesB: attrsText(b.attributes),
      variantConflict: kinds.variant,
      structuralConflict: kinds.structural,
      resolverDecision: compat.ok ? 'unexpected_compatible' : 'rejected',
      reason: tag,
      conflicts: compat.conflicts,
    });
  }
  return out;
}

function collectFuzzyRiskPairs(
  store: ProductIdentityStore,
  observations: ShadowIdentityObservation[]
): ShadowPairSample[] {
  const merchantKeys = [
    ...new Set(observations.map((o) => o.merchantKey || 'unknown_merchant')),
  ];
  const pairs: ShadowPairSample[] = [];

  for (const merchantKey of merchantKeys) {
    const products = store.listMerchantProducts(merchantKey);
    if (products.length < 2) continue;

    const buckets = new Map<string, MerchantProductRecord[]>();
    if (products.length <= 100) {
      buckets.set('_all', products);
    } else {
      for (const p of products) {
        const stem = buildIdentityNameStem(
          p.normalizedName || p.canonicalDisplayName || p.comparisonKey
        );
        const key = stem.slice(0, 4) || '_';
        const list = buckets.get(key) ?? [];
        list.push(p);
        buckets.set(key, list);
      }
    }

    for (const bucket of buckets.values()) {
      const limit = Math.min(bucket.length, 80);
      for (let i = 0; i < limit; i += 1) {
        for (let j = i + 1; j < limit; j += 1) {
          const a = bucket[i]!;
          const b = bucket[j]!;
          if (a.comparisonKey === b.comparisonKey) continue;
          const sim = combinedNameSimilarity(a.comparisonKey, b.comparisonKey);
          if (sim < AUDIT_FUZZY_PROBE_FLOOR) continue;

          const leftText = `${a.canonicalDisplayName ?? ''} ${a.normalizedName ?? ''}`;
          const rightText = `${b.canonicalDisplayName ?? ''} ${b.normalizedName ?? ''}`;
          const compat = attributesAreCompatible(
            a.attributes ?? emptyProductAttributes(),
            b.attributes ?? emptyProductAttributes(),
            leftText,
            rightText
          );
          const kinds = classifyConflicts(compat.conflicts);
          pairs.push({
            merchantKey,
            itemA: a.canonicalDisplayName || a.comparisonKey,
            itemB: b.canonicalDisplayName || b.comparisonKey,
            similarity: sim,
            attributesA: attrsText(a.attributes ?? emptyProductAttributes()),
            attributesB: attrsText(b.attributes ?? emptyProductAttributes()),
            variantConflict: kinds.variant,
            structuralConflict: kinds.structural,
            resolverDecision: !compat.ok
              ? 'would_reject_conflict'
              : sim >= FUZZY_AUTO_MATCH_THRESHOLD
                ? 'above_auto_but_kept_separate'
                : sim >= FUZZY_CANDIDATE_FLOOR
                  ? 'resolver_gray_zone_candidate_only'
                  : 'audit_probe_only_below_resolver_floor',
            reason: !compat.ok
              ? 'structural_or_variant_conflict'
              : 'non_exact_near_pair',
            conflicts: compat.conflicts,
          });
        }
      }
    }
  }

  return pairs.sort((x, y) => y.similarity - x.similarity).slice(0, 20);
}

export function runShadowIdentityAudit(
  observations: ShadowIdentityObservation[],
  store: ProductIdentityStore = createMemoryProductIdentityStore(),
  dataset?: ShadowDatasetSummary
): ShadowIdentityAuditReport {
  const byLevel = emptyLevels();
  const byAction = emptyActions();
  let merchantProductExistingMatch = 0;
  let merchantProductNewEntity = 0;
  const canonicalExistingMatch = 0;
  const canonicalNewEntity = 0;

  const obsCountByMerchantProduct = new Map<string, number>();
  const stemDiagnostics: ShadowStemDiagnostics = {
    stemCandidateCount: 0,
    stemAcceptedCount: 0,
    stemRejectedStructuralConflict: 0,
    stemRejectedVariantConflict: 0,
    acceptSamples: [],
  };
  const conflictDiagnostics: ShadowConflictDiagnostics = {
    structuralConflictCandidates: 0,
    structuralConflictRejected: 0,
    variantConflictCandidates: 0,
    variantConflictRejected: 0,
  };

  for (const obs of observations) {
    const name = (obs.rawName || '').trim();
    if (!name) {
      byLevel.unresolved += 1;
      byAction.unresolved += 1;
      continue;
    }

    probeStemAgainstStore(obs, store, stemDiagnostics);

    const result = resolveReceiptItemIdentity(
      {
        rawName: name,
        merchantKey: obs.merchantKey || 'unknown_merchant',
        receiptId: obs.receiptId,
        itemSourceIndex: obs.itemSourceIndex,
        quantity: obs.quantity,
        lineTotal: obs.lineTotal,
      },
      store
    );

    const level = result.link.identityLevel;
    byLevel[level] = (byLevel[level] ?? 0) + 1;
    const action = mapResolutionAction(result);
    byAction[action] += 1;

    if (action === 'existing_stem') {
      stemDiagnostics.stemAcceptedCount += 1;
      if (stemDiagnostics.acceptSamples.length < 12) {
        stemDiagnostics.acceptSamples.push({
          merchantKey: obs.merchantKey,
          itemA: name,
          itemB: result.link.merchantProductId ?? '(matched)',
          similarity: 1,
          attributesA: attrsText(result.attributes),
          attributesB: '',
          variantConflict: false,
          structuralConflict: false,
          resolverDecision: 'existing_stem',
          reason: result.reason,
        });
      }
    }

    if (result.createdMerchantProduct) {
      merchantProductNewEntity += 1;
    } else if (result.link.merchantProductId) {
      merchantProductExistingMatch += 1;
    }

    if (result.link.merchantProductId) {
      const id = result.link.merchantProductId;
      obsCountByMerchantProduct.set(
        id,
        (obsCountByMerchantProduct.get(id) ?? 0) + 1
      );
    }

    for (const c of result.conflictsRejected) {
      if (c.kind === 'variant_token') {
        conflictDiagnostics.variantConflictCandidates += 1;
        conflictDiagnostics.variantConflictRejected += 1;
      } else {
        conflictDiagnostics.structuralConflictCandidates += 1;
        conflictDiagnostics.structuralConflictRejected += 1;
      }
    }
    for (const fc of result.fuzzyCandidates) {
      if (fc.decision === 'rejected_conflict') {
        const kinds = classifyConflicts(fc.conflicts);
        if (kinds.structural) {
          conflictDiagnostics.structuralConflictCandidates += 1;
          conflictDiagnostics.structuralConflictRejected += 1;
        }
        if (kinds.variant) {
          conflictDiagnostics.variantConflictCandidates += 1;
          conflictDiagnostics.variantConflictRejected += 1;
        }
      }
    }
  }

  const fuzzyRiskPairs = collectFuzzyRiskPairs(store, observations);
  for (const pair of fuzzyRiskPairs) {
    if (pair.structuralConflict) {
      conflictDiagnostics.structuralConflictCandidates += 1;
    }
    if (pair.variantConflict) {
      conflictDiagnostics.variantConflictCandidates += 1;
    }
  }

  const counts = [...obsCountByMerchantProduct.values()];
  const distinctMerchantProducts = counts.length;
  const totalAssigned =
    merchantProductExistingMatch + merchantProductNewEntity;
  const eligible = observations.length;
  const with2 = counts.filter((n) => n >= 2).length;
  const with3 = counts.filter((n) => n >= 3).length;
  const sum = counts.reduce((a, b) => a + b, 0);
  const mean = counts.length ? sum / counts.length : 0;
  const maxObs = counts.length ? Math.max(...counts) : 0;

  const datasetSummary: ShadowDatasetSummary = dataset ?? {
    storedReceiptCount: 0,
    purchaseCandidateCount: 0,
    duplicateExtrasExcluded: 0,
    contentExactExtras: 0,
    structuralExactExtras: 0,
    reconciledStructuralExtras: 0,
    v1SupportedPurchaseCandidateCount: 0,
    eligibleItemObservations: eligible,
    appliedV1MerchantFilter: false,
  };

  return {
    contractVersion: 'meruno-product-identity-shadow-audit-v3.1',
    thresholds: {
      fuzzyAutoMatch: FUZZY_AUTO_MATCH_THRESHOLD,
      fuzzyCandidateFloor: FUZZY_CANDIDATE_FLOOR,
      auditFuzzyProbeFloor: AUDIT_FUZZY_PROBE_FLOOR,
    },
    dataset: {
      ...datasetSummary,
      eligibleItemObservations: eligible,
    },
    byLevel,
    byAction,
    entityAssignment: {
      merchantProductExistingMatch,
      merchantProductNewEntity,
      merchantProductTotalAssigned: totalAssigned,
      distinctMerchantProducts,
      canonicalExistingMatch,
      canonicalNewEntity,
    },
    reuseQuality: {
      merchantProductReuseRate:
        eligible > 0 ? merchantProductExistingMatch / eligible : 0,
      reuseAmongAssignedRate:
        totalAssigned > 0 ? merchantProductExistingMatch / totalAssigned : 0,
      merchantProductsWith2PlusObservations: with2,
      merchantProductsWith3PlusObservations: with3,
      observationsPerMerchantProduct: {
        mean,
        median: median(counts),
        max: maxObs,
      },
    },
    stemDiagnostics,
    conflictDiagnostics,
    fuzzyRiskPairs,
    fixtureConflictSamples: buildFixtureConflictSamples(),
    geminiAdditionalCalls: 0,
  };
}
