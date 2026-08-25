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
import { combinedNameSimilarity } from './productIdentitySimilarity';
import { buildIdentityNameStem } from './productIdentityNameStem';
import { resolveProductIdentity } from './productIdentity';
import type {
  MerchantProductRecord,
  ProductIdentityStore,
} from './productIdentityStore';
import type { ProductIdentityHotPathTiming } from './homeColdStartTiming';

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
    skuId: null,
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

function isGenericFamilyLabel(
  normalizedName: string,
  familyKey: string | null
): boolean {
  const stripped = normalizedName
    .replace(
      /\d+(?:\.\d+)?\s*(?:ml|l|g|kg|個|本|枚|袋|箱|缶|ロール|m|cm|mm)/gi,
      ''
    )
    .replace(/\s+/g, '')
    .trim();
  if (!stripped) return false;
  // Pure commodity labels (with or without familyKey from legacy resolver).
  if (/^(牛乳|ミルク|低脂肪乳|成分無調整牛乳|卵|たまご|米|水|お茶|パン|豆腐)$/.test(stripped)) {
    return true;
  }
  if (!familyKey) return false;
  if (stripped.length > 10) return false;
  return /(牛乳|ミルク|卵|たまご|米|水|お茶|パン|豆腐)/.test(stripped);
}

function persistOptionalLink(
  store: ProductIdentityStore,
  input: ResolveIdentityInput,
  fingerprint: string,
  merchantKey: string,
  link: ReceiptItemIdentityLink,
  timing?: ProductIdentityHotPathTiming | null
): void {
  if (input.receiptId == null || input.itemSourceIndex == null) return;
  const startedAt = timing?.start();
  store.saveLink({
    receiptId: input.receiptId,
    itemSourceIndex: input.itemSourceIndex,
    itemFingerprint: fingerprint,
    merchantKey,
    ...link,
  });
  timing?.increment('linkPersistenceCount');
  if (startedAt != null) {
    timing?.addElapsed('identityLinkPersistence', startedAt);
  }
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
  timing?: ProductIdentityHotPathTiming | null;
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
    link,
    args.timing
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
  timing?: ProductIdentityHotPathTiming | null
): ResolveIdentityResult {
  const merchantKey = scopeMerchantKeyForIdentity(input.merchantKey, input.receiptId);
  const rawName = typeof input.rawName === 'string' ? input.rawName : '';
  const normalizationStartedAt = timing?.start();
  const norm = normalizeProductForIdentity(rawName);
  timing?.increment('normalizationCallCount');
  if (normalizationStartedAt != null) {
    timing?.addElapsed('identityNormalization', normalizationStartedAt);
  }
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

  const catalogStartedAt = timing?.start();
  const catalog = store.listMerchantProducts(merchantKey);
  timing?.increment('catalogLookupCount');
  timing?.increment('catalogCandidateCount', catalog.length);
  if (catalogStartedAt != null) {
    timing?.addElapsed('identityMerchantCatalogRetrieval', catalogStartedAt);
  }

  const inquiryStem = buildIdentityNameStem(
    norm.normalizedName || norm.comparisonKey || rawName
  );

  // 2) Exact comparisonKey within merchant
  if (norm.comparisonKey) {
    const exactStartedAt = timing?.start();
    const exact = store.findMerchantProductByComparisonKey(
      merchantKey,
      norm.comparisonKey
    );
    timing?.increment('exactLookupCount');
    timing?.increment(
      exact ? 'exactLookupHitCount' : 'exactLookupMissCount'
    );
    if (exactStartedAt != null) {
      timing?.addElapsed('identityExactLookup', exactStartedAt);
    }
    if (exact) {
      const compat = attributesAreCompatible(
        attributes,
        exact.attributes ?? emptyProductAttributes(),
        variantText,
        `${exact.canonicalDisplayName ?? ''} ${exact.normalizedName ?? ''}`
      );
      if (compat.ok) {
        timing?.increment('exactAcceptedMatchCount');
        return finishMatch({
          store,
          input,
          fingerprint,
          normalizedName: norm.normalizedName,
          comparisonKey: norm.comparisonKey,
          attributes,
          merchant: exact,
          created: false,
          level: 'merchant_product',
          confidence: 0.97,
          source: 'normalized_exact',
          canonicalProductId: trustedCanonical,
          reason: 'same_merchant_comparison_key',
          fuzzyCandidates,
          conflictsRejected,
          timing,
        });
      }
      conflictsRejected.push(...compat.conflicts);
    }
  }

  // 2b) Exact identity stem + compatible attributes (same merchant).
  // Bridges unit aliases like 1L ↔ 1000ml without fuzzy merge.
  // Underspecified anchors must NOT bridge conflicting specified variants.
  if (inquiryStem.length >= 2) {
    const stemStartedAt = timing?.start();
    for (const candidate of catalog) {
      timing?.increment('stemCandidateVisitCount');
      const candStem = buildIdentityNameStem(
        candidate.normalizedName ||
          candidate.canonicalDisplayName ||
          candidate.comparisonKey
      );
      if (!candStem || candStem !== inquiryStem) continue;
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
      timing?.increment('stemAcceptedMatchCount');
      if (stemStartedAt != null) {
        timing?.addElapsed('identityStemEvaluation', stemStartedAt);
      }
      return finishMatch({
        store,
        input,
        fingerprint,
        normalizedName: norm.normalizedName,
        comparisonKey: norm.comparisonKey,
        attributes,
        merchant: candidate,
        created: false,
        level: 'merchant_product',
        confidence: 0.96,
        source: 'normalized_exact',
        canonicalProductId: trustedCanonical,
        reason: 'same_merchant_identity_stem',
        fuzzyCandidates,
        conflictsRejected,
        timing,
      });
    }
    if (stemStartedAt != null) {
      timing?.addElapsed('identityStemEvaluation', stemStartedAt);
    }
  }

  // 3–4) Alias / dictionary exact
  if (strongName) {
    const strongNormalizationStartedAt = timing?.start();
    const strong = normalizeProductForIdentity(strongName);
    timing?.increment('normalizationCallCount');
    if (strongNormalizationStartedAt != null) {
      timing?.addElapsed(
        'identityNormalization',
        strongNormalizationStartedAt
      );
    }
    const exactStartedAt = timing?.start();
    const hit = store.findMerchantProductByComparisonKey(
      merchantKey,
      strong.comparisonKey
    );
    timing?.increment('exactLookupCount');
    timing?.increment(hit ? 'exactLookupHitCount' : 'exactLookupMissCount');
    if (exactStartedAt != null) {
      timing?.addElapsed('identityExactLookup', exactStartedAt);
    }
    if (hit) {
      const compat = attributesAreCompatible(
        attributes,
        hit.attributes ?? emptyProductAttributes(),
        variantText,
        `${hit.canonicalDisplayName ?? ''} ${hit.normalizedName ?? ''}`
      );
      if (compat.ok) {
        timing?.increment('exactAcceptedMatchCount');
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
          timing,
        });
      }
      conflictsRejected.push(...compat.conflicts);
    }
  }

  // 5) Same-merchant fuzzy only
  let bestAuto: { merchant: MerchantProductRecord; score: number } | null = null;
  const fuzzyStartedAt = timing?.start();
  for (const candidate of catalog) {
    timing?.increment('fuzzyCandidateVisitCount');
    timing?.increment('similarityCallCount');
    const score = combinedNameSimilarity(
      norm.comparisonKey,
      candidate.comparisonKey
    );
    if (score < FUZZY_CANDIDATE_FLOOR) continue;
    timing?.increment('fuzzyCandidateFloorCount');
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
      timing?.increment('fuzzyAutoThresholdCount');
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
  if (fuzzyStartedAt != null) {
    timing?.addElapsed('identityFuzzyEvaluation', fuzzyStartedAt);
  }

  if (bestAuto) {
    timing?.increment('fuzzyAcceptedMatchCount');
    return finishMatch({
      store,
      input,
      fingerprint,
      normalizedName: norm.normalizedName,
      comparisonKey: norm.comparisonKey,
      attributes,
      merchant: bestAuto.merchant,
      created: false,
      level: 'merchant_product',
      confidence: Math.min(
        0.96,
        0.9 + (bestAuto.score - FUZZY_AUTO_MATCH_THRESHOLD) * 2
      ),
      source: 'fuzzy_exact',
      canonicalProductId: trustedCanonical,
      reason: 'same_merchant_fuzzy_auto',
      fuzzyCandidates,
      conflictsRejected,
      timing,
    });
  }

  // 6) Create MerchantProduct when comparison key exists
  if (norm.comparisonKey) {
    const upsertStartedAt = timing?.start();
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
    timing?.increment('merchantProductUpsertCount');
    if (upsertStartedAt != null) {
      timing?.addElapsed('identityMerchantProductUpsert', upsertStartedAt);
    }

    const legacy = resolveProductIdentity({ rawName });
    const familyKey = legacy.productFamilyKey;
    const hasSpec = attributes.entries.some((e) =>
      ['volume', 'mass', 'count', 'length', 'roll_count'].includes(
        String(e.dimension)
      )
    );
    const generic = isGenericFamilyLabel(norm.normalizedName, familyKey);

    let level: ProductIdentityLevel = 'merchant_product';
    let source: ProductIdentitySourceV1 | string = 'merchant_exact';
    let confidence = 0.93;
    let reason = 'new_merchant_product';

    if (generic) {
      level = hasSpec ? 'family_spec' : 'family_only';
      source = hasSpec ? 'family_spec' : 'family_only';
      confidence = hasSpec ? 0.55 : 0.35;
      reason = hasSpec ? 'family_spec_generic' : 'family_only_generic';
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
      timing,
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
