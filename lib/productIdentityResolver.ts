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
  type StructuralConflict,
} from './productIdentityStructuralConflict';
import { combinedNameSimilarity } from './productIdentitySimilarity';
import { buildIdentityNameStem } from './productIdentityNameStem';
import { resolveProductIdentity } from './productIdentity';
import type {
  MerchantProductRecord,
  ProductIdentityStore,
} from './productIdentityStore';

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
export function resolveReceiptItemIdentity(
  input: ResolveIdentityInput,
  store: ProductIdentityStore
): ResolveIdentityResult {
  const merchantKey = (input.merchantKey || '').trim() || 'unknown_merchant';
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

  // 1) Cache hit
  if (input.receiptId != null && input.itemSourceIndex != null) {
    const cached = store.getLink(input.receiptId, input.itemSourceIndex);
    if (cached && !cached.stale && cached.itemFingerprint === fingerprint) {
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
    if (cached && cached.itemFingerprint !== fingerprint) {
      store.markLinkStale(input.receiptId, input.itemSourceIndex);
    }
  }

  const catalog = store.listMerchantProducts(merchantKey);

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
        });
      }
      conflictsRejected.push(...compat.conflicts);
    }
  }

  // 2b) Exact identity stem + compatible attributes (same merchant).
  // Bridges unit aliases like 1L ↔ 1000ml without fuzzy merge.
  if (inquiryStem.length >= 2) {
    for (const candidate of catalog) {
      const candStem = buildIdentityNameStem(
        candidate.normalizedName ||
          candidate.canonicalDisplayName ||
          candidate.comparisonKey
      );
      if (!candStem || candStem !== inquiryStem) continue;
      const compat = attributesAreCompatible(
        attributes,
        candidate.attributes ?? emptyProductAttributes(),
        variantText,
        `${candidate.canonicalDisplayName ?? ''} ${candidate.normalizedName ?? ''}`
      );
      if (!compat.ok) {
        conflictsRejected.push(...compat.conflicts);
        continue;
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
      });
    }
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

  // 5) Same-merchant fuzzy only
  let bestAuto: { merchant: MerchantProductRecord; score: number } | null = null;
  for (const candidate of catalog) {
    const score = combinedNameSimilarity(
      norm.comparisonKey,
      candidate.comparisonKey
    );
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
