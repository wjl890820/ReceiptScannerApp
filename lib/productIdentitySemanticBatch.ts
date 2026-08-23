/**
 * Product Identity Batch 4 — batch selection + cost metrics.
 * Selection = uncategorized ∪ needs_enrichment; one classify-items call per receipt.
 */

import { getCategoryBatchAiMaxItems } from './env';
import {
  needsSemanticEnrichment,
  type SemanticGateInput,
  type SemanticStatus,
} from './productIdentitySemanticGate';
import type { ProductAttributes } from './productIdentityContract';

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

function gateInputFromItem(it: any): SemanticGateInput {
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

  return {
    rawName: itemRawName(it),
    normalizedName: (() => {
      const n = typeof it?.normalized_name === 'string' ? it.normalized_name.trim() : '';
      const raw = itemRawName(it);
      if (!n || (n.length <= 1 && /[A-Za-z]/.test(n) && raw && raw !== n)) return raw || null;
      return n;
    })(),
    comparisonKey: typeof it?.comparison_key === 'string' ? it.comparison_key : null,
    merchantKey: typeof it?.merchant_key === 'string' ? it.merchant_key : null,
    existingMerchantProductMatch: !!it?.merchant_product_existing_match,
    createdMerchantProduct: !!it?.merchant_product_created,
    brand: typeof it?.brand === 'string' ? it.brand : null,
    category,
    categoryConfidence,
    attributes: (it?.product_attributes as ProductAttributes | null) ?? null,
    cachedSemanticStatus: (it?.semantic_status as SemanticStatus | null) ?? null,
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
