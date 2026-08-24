/**
 * Product Identity Batch 4 — batch selection + cost metrics.
 * Selection = uncategorized ∪ needs_enrichment; one classify-items call per receipt.
 */

import { getCategoryBatchAiMaxItems } from './env';
import type { ProductAttributes } from './productIdentityContract';
import {
  buildSemanticInputFingerprint,
  type MerchantProductSemanticCache,
} from './productIdentitySemanticContract';
import {
  needsSemanticEnrichment,
  PRODUCT_IDENTITY_SEMANTIC_VERSION,
  type SemanticGateInput,
  type SemanticStatus,
} from './productIdentitySemanticGate';

export type SemanticBatchCostMetrics = {
  semanticBatchCalled: boolean;
  semanticItemsSent: number;
  semanticItemsApplied: number;
  semanticItemsSuggested: number;
  semanticItemsIgnored: number;
  semanticCacheHits: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
};

export function emptySemanticBatchCostMetrics(): SemanticBatchCostMetrics {
  return {
    semanticBatchCalled: false,
    semanticItemsSent: 0,
    semanticItemsApplied: 0,
    semanticItemsSuggested: 0,
    semanticItemsIgnored: 0,
    semanticCacheHits: 0,
    inputTokens: null,
    outputTokens: null,
    estimatedCost: null,
  };
}

export type BatchSemanticSelectItem = {
  index: number;
  rawName: string;
  normalizedName?: string;
  merchantName?: string | null;
  knownCategory?: string | null;
  knownFamily?: string | null;
  knownAttributes?: ProductAttributes | null;
  selectReasons: Array<'uncategorized' | 'needs_enrichment'>;
};

function itemRawName(it: any): string {
  return (
    (typeof it?.name === 'string' && it.name) ||
    (typeof it?.raw_name === 'string' && it.raw_name) ||
    (typeof it?.normalized_name === 'string' && it.normalized_name) ||
    ''
  );
}

function readSemanticCache(it: any): MerchantProductSemanticCache | null {
  const raw = it?.semantic_json;
  if (!raw || typeof raw !== 'object') return null;
  return raw as MerchantProductSemanticCache;
}

/**
 * Clear stale enriched/sufficient cache when input fingerprint no longer matches.
 * Mutates item in place so production selection does not trust semantic_status alone.
 */
export function invalidateStaleSemanticCacheOnItem(it: any): boolean {
  if (!it || typeof it !== 'object') return false;
  const status = it.semantic_status as SemanticStatus | null | undefined;
  if (status !== 'enriched' && status !== 'sufficient') return false;
  const cache = readSemanticCache(it);
  const attrs =
    (it.product_attributes as ProductAttributes | null) ??
    cache?.attributes ??
    null;
  const currentFp = buildSemanticInputFingerprint({
    rawName: itemRawName(it),
    merchantKey:
      typeof it.merchant_key === 'string'
        ? it.merchant_key
        : typeof it.merchantName === 'string'
          ? it.merchantName
          : null,
    attributes: attrs,
    semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    modelVersion: cache?.modelVersion ?? null,
  });
  const cachedFp = typeof cache?.inputFingerprint === 'string' ? cache.inputFingerprint : '';
  const versionOk =
    !cache?.semanticResolverVersion ||
    cache.semanticResolverVersion === PRODUCT_IDENTITY_SEMANTIC_VERSION;
  if (cachedFp && cachedFp === currentFp && versionOk) return false;
  it.semantic_status = 'needs_enrichment';
  it.semantic_json = null;
  return true;
}

function gateInputFromItem(it: any): SemanticGateInput {
  invalidateStaleSemanticCacheOnItem(it);
  const category = typeof it?.category === 'string' ? it.category : null;
  const explicit =
    typeof it?.classification_confidence === 'number'
      ? it.classification_confidence
      : typeof it?.category_confidence === 'number'
        ? it.category_confidence
        : null;
  // Stub confidence 0 on an already-classified item is treated as "missing"
  // (common in tests / incomplete enricher payloads), not as weak evidence.
  const categoryConfidence =
    typeof explicit === 'number' && explicit > 0
      ? explicit
      : category && category !== 'uncategorized' && category !== 'unknown'
        ? 0.9
        : typeof explicit === 'number'
          ? explicit
          : null;

  const cache = readSemanticCache(it);
  const attrs =
    (it?.product_attributes as ProductAttributes | null) ??
    cache?.attributes ??
    null;
  const rawName = itemRawName(it);
  const merchantKey =
    typeof it?.merchant_key === 'string'
      ? it.merchant_key
      : typeof it?.merchantName === 'string'
        ? it.merchantName
        : null;
  const currentSemanticInputFingerprint = buildSemanticInputFingerprint({
    rawName,
    merchantKey,
    attributes: attrs,
    semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    modelVersion: cache?.modelVersion ?? null,
  });

  return {
    rawName,
    normalizedName: (() => {
      const n = typeof it?.normalized_name === 'string' ? it.normalized_name.trim() : '';
      const raw = itemRawName(it);
      if (!n || (n.length <= 1 && /[A-Za-z]/.test(n) && raw && raw !== n)) return raw || null;
      return n;
    })(),
    comparisonKey: typeof it?.comparison_key === 'string' ? it.comparison_key : null,
    merchantKey,
    existingMerchantProductMatch: !!it?.merchant_product_existing_match,
    createdMerchantProduct: !!it?.merchant_product_created,
    brand: typeof it?.brand === 'string' ? it.brand : null,
    category,
    categoryConfidence,
    attributes: attrs,
    cachedSemanticStatus: (it?.semantic_status as SemanticStatus | null) ?? null,
    cachedSemanticInputFingerprint:
      typeof cache?.inputFingerprint === 'string' ? cache.inputFingerprint : null,
    cachedSemanticResolverVersion:
      typeof cache?.semanticResolverVersion === 'string'
        ? cache.semanticResolverVersion
        : null,
    currentSemanticInputFingerprint,
    identityLevel: typeof it?.identity_level === 'string' ? it.identity_level : null,
    identityConfidence:
      typeof it?.identity_confidence === 'number' ? it.identity_confidence : null,
  };
}

export function selectBatchSemanticItems(
  items: any[],
  maxItems: number = getCategoryBatchAiMaxItems()
): BatchSemanticSelectItem[] {
  const out: BatchSemanticSelectItem[] = [];
  if (!Array.isArray(items) || maxItems <= 0) return out;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const rawName = itemRawName(it);
    if (!rawName.trim()) continue;

    const reasons: Array<'uncategorized' | 'needs_enrichment'> = [];
    if (it.category === 'uncategorized') reasons.push('uncategorized');
    if (needsSemanticEnrichment(gateInputFromItem(it))) reasons.push('needs_enrichment');
    if (!reasons.length) continue;

    out.push({
      index: i,
      rawName,
      normalizedName: typeof it.normalized_name === 'string' ? it.normalized_name : undefined,
      merchantName: typeof it.merchant_name === 'string' ? it.merchant_name : null,
      knownCategory:
        typeof it.category === 'string' && it.category !== 'uncategorized' ? it.category : null,
      knownFamily:
        typeof it.family === 'string'
          ? it.family
          : typeof it.product_family === 'string'
            ? it.product_family
            : null,
      knownAttributes: (it.product_attributes as ProductAttributes | null) ?? null,
      selectReasons: reasons,
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

export function semanticSelectWouldCallAi(items: any[]): boolean {
  return selectBatchSemanticItems(items, 1).length > 0;
}
