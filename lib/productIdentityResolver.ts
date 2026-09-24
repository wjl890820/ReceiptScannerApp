/**
 * Product Identity Resolver (Batch 3).
 *
 * Deterministic-first, conservative: prefer unresolved over false merge.
 * Shadow / derived only — does not mutate receipt SoT or Analysis.
 * Gemini additional calls = 0.
 */

import {
  PRODUCT_IDENTITY_RESOLVER_VERSION,
  emptyProductAttributes,
  type ProductAttributes,
  type ProductIdentityLevel,
  type ProductIdentitySourceV1,
  type ReceiptItemIdentityLink,
} from './productIdentityContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import { buildItemIdentityFingerprint } from './productIdentityFingerprint';
import {
  attributesAreCompatible,
  hasStemStructuralEvidence,
  stemStructuralEvidenceBalanced,
  type StructuralConflict,
} from './productIdentityStructuralConflict';
import { combinedNameSimilarityAtOrAbovePotential } from './productIdentitySimilarity';
import { buildIdentityNameStem } from './productIdentityNameStem';
import { resolveProductIdentity } from './productIdentity';
import {
  classifyGenericWeakIdentity,
  isGenericFamilyLabel,
} from './productIdentityGenericLabel';
import type {
  MerchantProductRecord,
  ProductIdentityStore,
} from './productIdentityStore';
import {
  merchantProductIdentityStemSource,
} from './productIdentityStore';

export { isGenericFamilyLabel } from './productIdentityGenericLabel';

/** Same-merchant fuzzy auto-match (intentionally very high). */
export const FUZZY_AUTO_MATCH_THRESHOLD = 0.98;
/** Below this, ignore as fuzzy candidate. */
export const FUZZY_CANDIDATE_FLOOR = 0.9;

export type ResolveIdentityEvidence = {
  aliasCanonicalName?: string | null;
  dictionaryCanonicalName?: string | null;
  trustedCanonicalProductId?: string | null;
};

export type ResolveIdentityInput = {
  rawName: string;
  merchantKey: string;
  receiptId?: string;
  itemSourceIndex?: number;
  quantity?: number | null;
  lineTotal?: number | null;
  evidence?: ResolveIdentityEvidence;
};

/**
 * @internal H8.1 / H8.2 test-only structural counters.
 * `catalogLists` aliases `catalogMaterializations` for H8.1 callers.
 */
export type ResolveIdentityStemPhaseStats = {
  resolverCalls: number;
  catalogMaterializations: number;
  /** @deprecated Prefer catalogMaterializations; kept equal for H8.1. */
  catalogLists: number;
  exactHits: number;
  stemHits: number;
  stemRejected: number;
  fuzzyEntries: number;
  stemCandidateChecks: number;
  candidateStemComputations: number;
  stemIndexLookups: number;
  stemIndexedCandidateChecks: number;
  fuzzyCandidateChecks: number;
};

export type ResolveIdentityOptions = {
  /**
   * @internal H8.1 — when false, phase 2b uses original linear catalog scan.
   * Default / omitted = stem index.
   */
  __useMerchantProductStemIndexForTests?: boolean;
  /**
   * @internal H8.2 — when true, materialize catalog after link / before exact
   * (pre-H8.2 eager HEAD). Default / omitted = lazy (materialize at fuzzy / baseline stem).
   */
  __eagerCatalogMaterializationForTests?: boolean;
  /** @internal H8.1 / H8.2 operation-count seam. */
  __stemPhaseStatsForTests?: ResolveIdentityStemPhaseStats | null;
};

/** @internal Empty counter bag for H8.2 tests. */
export function __emptyResolveIdentityStemPhaseStatsForTests(): ResolveIdentityStemPhaseStats {
  return {
    resolverCalls: 0,
    catalogMaterializations: 0,
    catalogLists: 0,
    exactHits: 0,
    stemHits: 0,
    stemRejected: 0,
    fuzzyEntries: 0,
    stemCandidateChecks: 0,
    candidateStemComputations: 0,
    stemIndexLookups: 0,
    stemIndexedCandidateChecks: 0,
    fuzzyCandidateChecks: 0,
  };
}

/**
 * @internal Baseline phase-2b candidate discovery: linear catalog scan + stem
 * equality. Does not apply structural/compat gates (resolver still does).
 */
export function __baselineStemEqualCandidatesForTests(
  catalog: readonly MerchantProductRecord[],
  inquiryStem: string,
  stats?: Pick<
    ResolveIdentityStemPhaseStats,
    'stemCandidateChecks' | 'candidateStemComputations'
  > | null
): MerchantProductRecord[] {
  const out: MerchantProductRecord[] = [];
  if (inquiryStem.length < 2) return out;
  for (const candidate of catalog) {
    if (stats) {
      stats.stemCandidateChecks += 1;
      stats.candidateStemComputations += 1;
    }
    const candStem = buildIdentityNameStem(
      merchantProductIdentityStemSource(candidate)
    );
    if (!candStem || candStem !== inquiryStem) continue;
    out.push(candidate);
  }
  return out;
}

export type FuzzyCandidate = {
  merchantProductId: string;
  displayName: string | null;
  similarity: number;
  conflicts: StructuralConflict[];
  decision: 'auto_match' | 'candidate_only' | 'rejected_conflict';
  reason: string;
};

export type ResolveIdentityResult = {
  link: ReceiptItemIdentityLink;
  fingerprint: string;
  normalizedName: string;
  comparisonKey: string;
  attributes: ProductAttributes;
  createdMerchantProduct: boolean;
  fuzzyCandidates: FuzzyCandidate[];
  conflictsRejected: StructuralConflict[];
  reason: string;
};

function makeLink(
  partial: Partial<ReceiptItemIdentityLink> & {
    identityLevel: ProductIdentityLevel;
    identitySource: ProductIdentitySourceV1 | string;
    identityConfidence: number;
  }
): ReceiptItemIdentityLink {
  return {
    merchantProductId: partial.merchantProductId ?? null,
    canonicalProductId: partial.canonicalProductId ?? null,
    skuId: partial.skuId ?? null,
    identityLevel: partial.identityLevel,
    identityConfidence: partial.identityConfidence,
    identitySource: partial.identitySource,
    resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
  };
}

function pickDisplayName(
  rawName: string,
  normalizedName: string,
  strongName: string | null
): string {
  return strongName?.trim() || normalizedName || rawName;
}

function persistOptionalLink(
  store: ProductIdentityStore,
  input: ResolveIdentityInput,
  fingerprint: string,
  merchantKey: string,
  link: ReceiptItemIdentityLink
): void {
  if (input.receiptId == null || input.itemSourceIndex == null) return;
  store.saveLink({
    receiptId: input.receiptId,
    itemSourceIndex: input.itemSourceIndex,
    itemFingerprint: fingerprint,
    merchantKey,
    ...link,
  });
}

function finishMatch(args: {
  store: ProductIdentityStore;
  input: ResolveIdentityInput;
  fingerprint: string;
  normalizedName: string;
  comparisonKey: string;
  attributes: ProductAttributes;
  merchant: MerchantProductRecord;
  created: boolean;
  level: ProductIdentityLevel;
  confidence: number;
  source: ProductIdentitySourceV1 | string;
  canonicalProductId: string | null;
  reason: string;
  fuzzyCandidates: FuzzyCandidate[];
  conflictsRejected: StructuralConflict[];
}): ResolveIdentityResult {
  const link = makeLink({
    merchantProductId: args.merchant.id,
    canonicalProductId: args.canonicalProductId,
    identityLevel: args.level,
    identityConfidence: args.confidence,
    identitySource: args.source,
  });
  persistOptionalLink(
    args.store,
    args.input,
    args.fingerprint,
    args.merchant.merchantKey,
    link
  );
  return {
    link,
    fingerprint: args.fingerprint,
    normalizedName: args.normalizedName,
    comparisonKey: args.comparisonKey,
    attributes: args.attributes,
    createdMerchantProduct: args.created,
    fuzzyCandidates: args.fuzzyCandidates,
    conflictsRejected: args.conflictsRejected,
    reason: args.reason,
  };
}

/**
 * Resolve a receipt line to MerchantProduct (+ optional trusted Canonical).
 * Never auto-merges across merchants into Canonical without trusted evidence.
 */
/** Bare missing-merchant bucket — must never be shared across receipts. */
export const UNKNOWN_MERCHANT_KEY = 'unknown_merchant';

/**
 * Scope merchant identity for MP keys.
 * Missing merchant evidence → per-receipt unknown scope (or unresolved orphan).
 */
export function scopeMerchantKeyForIdentity(
  merchantKey: string | null | undefined,
  receiptId?: string | null
): string {
  const trimmed = typeof merchantKey === 'string' ? merchantKey.trim() : '';
  if (trimmed && trimmed !== UNKNOWN_MERCHANT_KEY) return trimmed;
  const rid = typeof receiptId === 'string' ? receiptId.trim() : '';
  if (rid) return `${UNKNOWN_MERCHANT_KEY}:receipt:${rid}`;
  return `${UNKNOWN_MERCHANT_KEY}:orphan`;
}

export function isUnknownMerchantScopeKey(merchantKey: string | null | undefined): boolean {
  const k = typeof merchantKey === 'string' ? merchantKey.trim() : '';
  return !k || k === UNKNOWN_MERCHANT_KEY || k.startsWith(`${UNKNOWN_MERCHANT_KEY}:`);
}

export function resolveReceiptItemIdentity(
  input: ResolveIdentityInput,
  store: ProductIdentityStore,
  options?: ResolveIdentityOptions
): ResolveIdentityResult {
  const stats = options?.__stemPhaseStatsForTests ?? null;
  if (stats) stats.resolverCalls += 1;
  const useStemIndex = options?.__useMerchantProductStemIndexForTests !== false;
  const eagerCatalog = options?.__eagerCatalogMaterializationForTests === true;

  const merchantKey = scopeMerchantKeyForIdentity(input.merchantKey, input.receiptId);
  const rawName = typeof input.rawName === 'string' ? input.rawName : '';
  const norm = normalizeProductForIdentity(rawName);
  const attributes = norm.attributes ?? emptyProductAttributes();
  const fingerprint = buildItemIdentityFingerprint({
    rawName,
    normalizedName: norm.normalizedName,
    comparisonKey: norm.comparisonKey,
    attributes,
    quantity: input.quantity,
    lineTotal: input.lineTotal,
  });

  const fuzzyCandidates: FuzzyCandidate[] = [];
  const conflictsRejected: StructuralConflict[] = [];
  const evidence = input.evidence ?? {};
  const variantText = `${rawName} ${norm.normalizedName}`;
  const trustedCanonical = evidence.trustedCanonicalProductId?.trim() || null;
  const strongName =
    evidence.aliasCanonicalName?.trim() ||
    evidence.dictionaryCanonicalName?.trim() ||
    null;

  // H8.2: at most one listMerchantProducts per resolve call.
  let catalog: MerchantProductRecord[] | null = null;
  const ensureCatalog = (): MerchantProductRecord[] => {
    if (catalog === null) {
      catalog = store.listMerchantProducts(merchantKey);
      if (stats) {
        stats.catalogMaterializations += 1;
        stats.catalogLists += 1;
      }
    }
    return catalog;
  };

  // 1) Cache hit — bind to merchant + resolverVersion (never reuse across merchants/versions)
  if (input.receiptId != null && input.itemSourceIndex != null) {
    const cached = store.getLink(input.receiptId, input.itemSourceIndex);
    if (
      cached &&
      !cached.stale &&
      cached.itemFingerprint === fingerprint &&
      cached.merchantKey === merchantKey &&
      cached.resolverVersion === PRODUCT_IDENTITY_RESOLVER_VERSION
    ) {
      const legacyFamily = resolveProductIdentity({ rawName }).productFamilyKey;
      const weak = classifyGenericWeakIdentity(
        norm.normalizedName,
        legacyFamily,
        attributes
      );
      // A3: never trust a stale strong cache over current generic weakness.
      if (weak) {
        const link = makeLink({
          merchantProductId: cached.merchantProductId,
          canonicalProductId: cached.canonicalProductId,
          skuId: cached.skuId,
          identityLevel: weak.level,
          identityConfidence: weak.confidence,
          identitySource: weak.source,
        });
        persistOptionalLink(store, input, fingerprint, merchantKey, link);
        return {
          link,
          fingerprint,
          normalizedName: norm.normalizedName,
          comparisonKey: norm.comparisonKey,
          attributes,
          createdMerchantProduct: false,
          fuzzyCandidates,
          conflictsRejected,
          reason: 'cache_hit_reclassified_generic',
        };
      }
      return {
        link: {
          merchantProductId: cached.merchantProductId,
          canonicalProductId: cached.canonicalProductId,
          skuId: cached.skuId,
          identityLevel: cached.identityLevel,
          identityConfidence: cached.identityConfidence,
          identitySource: 'cache',
          resolverVersion: cached.resolverVersion,
        },
        fingerprint,
        normalizedName: norm.normalizedName,
        comparisonKey: norm.comparisonKey,
        attributes,
        createdMerchantProduct: false,
        fuzzyCandidates,
        conflictsRejected,
        reason: 'cache_hit',
      };
    }
    if (
      cached &&
      (cached.itemFingerprint !== fingerprint ||
        cached.merchantKey !== merchantKey ||
        cached.resolverVersion !== PRODUCT_IDENTITY_RESOLVER_VERSION)
    ) {
      store.markLinkStale(input.receiptId, input.itemSourceIndex);
    }
  }

  // Pre-H8.2 eager HEAD: materialize after link, before exact/stem/alias.
  if (eagerCatalog) {
    ensureCatalog();
  }

  const inquiryStem = buildIdentityNameStem(
    norm.normalizedName || norm.comparisonKey || rawName
  );

  // 2) Exact comparisonKey within merchant
  if (norm.comparisonKey) {
    const exact = store.findMerchantProductByComparisonKey(
      merchantKey,
      norm.comparisonKey
    );
    if (exact) {
      const compat = attributesAreCompatible(
        attributes,
        exact.attributes ?? emptyProductAttributes(),
        variantText,
        `${exact.canonicalDisplayName ?? ''} ${exact.normalizedName ?? ''}`
      );
      if (compat.ok) {
        if (stats) stats.exactHits += 1;
        const legacyFamily = resolveProductIdentity({ rawName }).productFamilyKey;
        const weak = classifyGenericWeakIdentity(
          norm.normalizedName,
          legacyFamily,
          attributes
        );
        return finishMatch({
          store,
          input,
          fingerprint,
          normalizedName: norm.normalizedName,
          comparisonKey: norm.comparisonKey,
          attributes,
          merchant: exact,
          created: false,
          level: weak?.level ?? 'merchant_product',
          confidence: weak?.confidence ?? 0.97,
          source: weak?.source ?? 'normalized_exact',
          canonicalProductId: trustedCanonical,
          reason: weak?.reason ?? 'same_merchant_comparison_key',
          fuzzyCandidates,
          conflictsRejected,
        });
      }
      conflictsRejected.push(...compat.conflicts);
    }
  }

  // 2b) Exact identity stem + compatible attributes (same merchant).
  // Bridges unit aliases like 1L ↔ 1000ml without fuzzy merge.
  // Underspecified anchors must NOT bridge conflicting specified variants.
  // H8.1: insertion-order stem index replaces full-catalog stem discovery;
  // downstream structural/compat gates and first-winner semantics unchanged.
  if (inquiryStem.length >= 2) {
    let stemSawCandidates = false;
    const stemCandidates = useStemIndex
      ? (() => {
          if (stats) stats.stemIndexLookups += 1;
          return store.findMerchantProductsByNameStem(merchantKey, inquiryStem);
        })()
      : __baselineStemEqualCandidatesForTests(
          ensureCatalog(),
          inquiryStem,
          stats
        );

    for (const candidate of stemCandidates) {
      stemSawCandidates = true;
      if (stats) {
        if (useStemIndex) stats.stemIndexedCandidateChecks += 1;
      }
      // Indexed path: stem equality already applied; still run gates in order.
      // Baseline path: helper already filtered by stem equality.
      const candAttrs = candidate.attributes ?? emptyProductAttributes();
      if (!stemStructuralEvidenceBalanced(attributes, candAttrs)) {
        conflictsRejected.push({
          kind: 'pack_structure',
          left: hasStemStructuralEvidence(attributes)
            ? 'specified_structural'
            : 'underspecified',
          right: hasStemStructuralEvidence(candAttrs)
            ? 'specified_structural'
            : 'underspecified',
        });
        continue;
      }
      const compat = attributesAreCompatible(
        attributes,
        candAttrs,
        variantText,
        `${candidate.canonicalDisplayName ?? ''} ${candidate.normalizedName ?? ''}`
      );
      if (!compat.ok) {
        conflictsRejected.push(...compat.conflicts);
        continue;
      }
      if (stats) stats.stemHits += 1;
      const legacyFamily = resolveProductIdentity({ rawName }).productFamilyKey;
      const weak = classifyGenericWeakIdentity(
        norm.normalizedName,
        legacyFamily,
        attributes
      );
      return finishMatch({
        store,
        input,
        fingerprint,
        normalizedName: norm.normalizedName,
        comparisonKey: norm.comparisonKey,
        attributes,
        merchant: candidate,
        created: false,
        level: weak?.level ?? 'merchant_product',
        confidence: weak?.confidence ?? 0.96,
        source: weak?.source ?? 'normalized_exact',
        canonicalProductId: trustedCanonical,
        reason: weak?.reason ?? 'same_merchant_identity_stem',
        fuzzyCandidates,
        conflictsRejected,
      });
    }
    if (stemSawCandidates && stats) stats.stemRejected += 1;
  }

  // 3–4) Alias / dictionary exact
  if (strongName) {
    const strong = normalizeProductForIdentity(strongName);
    const hit = store.findMerchantProductByComparisonKey(
      merchantKey,
      strong.comparisonKey
    );
    if (hit) {
      const compat = attributesAreCompatible(
        attributes,
        hit.attributes ?? emptyProductAttributes(),
        variantText,
        `${hit.canonicalDisplayName ?? ''} ${hit.normalizedName ?? ''}`
      );
      if (compat.ok) {
        return finishMatch({
          store,
          input,
          fingerprint,
          normalizedName: norm.normalizedName,
          comparisonKey: norm.comparisonKey,
          attributes,
          merchant: hit,
          created: false,
          level: 'merchant_product',
          confidence: 0.95,
          source: evidence.aliasCanonicalName ? 'alias_exact' : 'dictionary_exact',
          canonicalProductId: trustedCanonical,
          reason: 'alias_or_dictionary_exact',
          fuzzyCandidates,
          conflictsRejected,
        });
      }
      conflictsRejected.push(...compat.conflicts);
    }
  }

  // 5) Same-merchant fuzzy only — H8.2: first production full-catalog consumer.
  if (stats) stats.fuzzyEntries += 1;
  const fuzzyCatalog = ensureCatalog();
  let bestAuto: { merchant: MerchantProductRecord; score: number } | null = null;
  for (const candidate of fuzzyCatalog) {
    if (stats) stats.fuzzyCandidateChecks += 1;
    const score = combinedNameSimilarityAtOrAbovePotential(
      norm.comparisonKey,
      candidate.comparisonKey,
      FUZZY_CANDIDATE_FLOOR
    );
    if (score == null) continue;
    if (score < FUZZY_CANDIDATE_FLOOR) continue;
    const compat = attributesAreCompatible(
      attributes,
      candidate.attributes ?? emptyProductAttributes(),
      variantText,
      `${candidate.canonicalDisplayName ?? ''} ${candidate.normalizedName ?? ''}`
    );
    if (!compat.ok) {
      fuzzyCandidates.push({
        merchantProductId: candidate.id,
        displayName: candidate.canonicalDisplayName,
        similarity: score,
        conflicts: compat.conflicts,
        decision: 'rejected_conflict',
        reason: 'structural_or_variant_conflict',
      });
      conflictsRejected.push(...compat.conflicts);
      continue;
    }
    if (score >= FUZZY_AUTO_MATCH_THRESHOLD) {
      fuzzyCandidates.push({
        merchantProductId: candidate.id,
        displayName: candidate.canonicalDisplayName,
        similarity: score,
        conflicts: [],
        decision: 'auto_match',
        reason: 'same_merchant_fuzzy_high',
      });
      if (!bestAuto || score > bestAuto.score) {
        bestAuto = { merchant: candidate, score };
      }
    } else {
      fuzzyCandidates.push({
        merchantProductId: candidate.id,
        displayName: candidate.canonicalDisplayName,
        similarity: score,
        conflicts: [],
        decision: 'candidate_only',
        reason: 'gray_zone_no_auto_merge',
      });
    }
  }

  if (bestAuto) {
    const legacyFamily = resolveProductIdentity({ rawName }).productFamilyKey;
    const weak = classifyGenericWeakIdentity(
      norm.normalizedName,
      legacyFamily,
      attributes
    );
    return finishMatch({
      store,
      input,
      fingerprint,
      normalizedName: norm.normalizedName,
      comparisonKey: norm.comparisonKey,
      attributes,
      merchant: bestAuto.merchant,
      created: false,
      level: weak?.level ?? 'merchant_product',
      confidence:
        weak?.confidence ??
        Math.min(
          0.96,
          0.9 + (bestAuto.score - FUZZY_AUTO_MATCH_THRESHOLD) * 2
        ),
      source: weak?.source ?? 'fuzzy_exact',
      canonicalProductId: trustedCanonical,
      reason: weak?.reason ?? 'same_merchant_fuzzy_auto',
      fuzzyCandidates,
      conflictsRejected,
    });
  }

  // 6) Create MerchantProduct when comparison key exists
  if (norm.comparisonKey) {
    const created = store.upsertMerchantProduct({
      merchantKey,
      comparisonKey: norm.comparisonKey,
      canonicalDisplayName: pickDisplayName(
        rawName,
        norm.normalizedName,
        strongName
      ),
      normalizedName: norm.normalizedName || null,
      brand: null,
      attributes,
    });

    const legacy = resolveProductIdentity({ rawName });
    const weak = classifyGenericWeakIdentity(
      norm.normalizedName,
      legacy.productFamilyKey,
      attributes
    );

    let level: ProductIdentityLevel = 'merchant_product';
    let source: ProductIdentitySourceV1 | string = 'merchant_exact';
    let confidence = 0.93;
    let reason = 'new_merchant_product';

    if (weak) {
      level = weak.level;
      source = weak.source;
      confidence = weak.confidence;
      reason = weak.reason;
    }

    return finishMatch({
      store,
      input,
      fingerprint,
      normalizedName: norm.normalizedName,
      comparisonKey: norm.comparisonKey,
      attributes,
      merchant: created,
      created: true,
      level,
      confidence,
      source,
      canonicalProductId: trustedCanonical,
      reason,
      fuzzyCandidates,
      conflictsRejected,
    });
  }

  // 7) unresolved
  const link = makeLink({
    identityLevel: 'unresolved',
    identityConfidence: 0,
    identitySource: 'unresolved',
  });
  persistOptionalLink(store, input, fingerprint, merchantKey, link);
  return {
    link,
    fingerprint,
    normalizedName: norm.normalizedName,
    comparisonKey: norm.comparisonKey,
    attributes,
    createdMerchantProduct: false,
    fuzzyCandidates,
    conflictsRejected,
    reason: 'unresolved_empty_key',
  };
}
