/**
 * Product Identity Batch 4.1 — cache-aware receipt-level AI call-rate simulation.
 */

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { isV1SupportedReceipt } from './merchantType';
import {
  receiptRowFromIntelligenceExport,
  buildDedupedShadowObservations,
} from './productIdentityShadowAuditDataset';
import type { ProductIntelligenceExportPayload } from './productIdentityShadowAudit';
import type { ShadowIdentityObservation } from './productIdentityShadowAudit';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  type ProductIdentityStore,
} from './productIdentityStore';
import { resolveLocalCategoryForSemanticGate } from './productIdentityLocalCategory';
import {
  needsSemanticEnrichment,
  PRODUCT_IDENTITY_SEMANTIC_VERSION,
} from './productIdentitySemanticGate';
import { selectBatchSemanticItems } from './productIdentitySemanticBatch';
import {
  emptyProductAttributes,
  type ProductAttributes,
} from './productIdentityContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import type { MerchantProductSemanticCache } from './productIdentitySemanticContract';
import { getCategoryBatchAiMaxItems } from './env';

export type ReceiptBinMetrics = {
  label: string;
  receiptCount: number;
  newMerchantProducts: number;
  semanticAiCandidates: number;
  categoryOnlyCallRate: number;
  combinedCallRate: number;
};

export type ReceiptSemanticCostReport = {
  receiptCount: number;
  receiptsThatWouldCallCategoryBatch: number;
  categoryBatchCallRate: number;
  receiptsThatWouldCallCombinedBatch: number;
  combinedBatchCallRate: number;
  absoluteIncrease: number;
  percentagePointIncrease: number;
  combinedBatchCallsPer100Receipts: number;
  itemsSentPer100Receipts: number;
  meanItemsPerCalledBatch: number;
  medianItemsPerCalledBatch: number;
  maxItemsPerBatch: number;
  uniqueNewMpsNeedingSemanticAiPer100Receipts: number;
  bins: ReceiptBinMetrics[];
};

function attrsFromName(rawName: string): ProductAttributes {
  try {
    return normalizeProductForIdentity(rawName).attributes ?? emptyProductAttributes();
  } catch {
    return emptyProductAttributes();
  }
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function parseReceiptTime(raw: Record<string, unknown>): number {
  for (const c of [raw.transaction_at, raw.scanned_at, raw.created_at]) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && c.trim()) {
      const ms = Date.parse(c);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return 0;
}

function cacheRecord(
  status: 'enriched' | 'sufficient',
  attrs: ProductAttributes,
  confidence: number,
  reason: string
): MerchantProductSemanticCache {
  return {
    status,
    brand: null,
    suggestedBrand: null,
    canonicalName: null,
    suggestedCanonicalName: null,
    productType: null,
    semanticTags: [],
    attributes: attrs,
    confidence,
    reason,
    conflicts: [],
    semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    inputFingerprint: '',
    modelVersion: null,
    enrichedAt: new Date().toISOString(),
  };
}

export function orderedV1PurchaseReceiptIds(
  payload: ProductIntelligenceExportPayload
): string[] {
  const rows = (payload.receipts ?? []).map(receiptRowFromIntelligenceExport);
  const selection = selectAnalyticsReceipts(rows);
  const v1 = selection.analyticsReceipts.filter(isV1SupportedReceipt);
  const byId = new Map(
    (payload.receipts ?? []).map((r) => [String(r.id), r as Record<string, unknown>])
  );
  return [...v1]
    .map((r) => r.id)
    .sort((a, b) => {
      const ta = parseReceiptTime(byId.get(a) ?? {});
      const tb = parseReceiptTime(byId.get(b) ?? {});
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });
}

export function runReceiptSemanticCostSimulation(
  payload: ProductIntelligenceExportPayload,
  store: ProductIdentityStore = createMemoryProductIdentityStore()
): ReceiptSemanticCostReport {
  const { observations } = buildDedupedShadowObservations(payload, {
    applyV1MerchantFilter: true,
  });
  const orderedIds = orderedV1PurchaseReceiptIds(payload);
  const byReceipt = new Map<string, ShadowIdentityObservation[]>();
  for (const obs of observations) {
    const list = byReceipt.get(obs.receiptId) ?? [];
    list.push(obs);
    byReceipt.set(obs.receiptId, list);
  }

  const maxItems = getCategoryBatchAiMaxItems();
  let categoryOnlyCalls = 0;
  let combinedCalls = 0;
  const batchSizes: number[] = [];
  let itemsSent = 0;
  const newMpsNeedingAi = new Set<string>();
  const binStats = Array.from({ length: 5 }, () => ({
    newMps: 0,
    semanticCandidates: 0,
    categoryCalls: 0,
    combinedCalls: 0,
    receiptCount: 0,
  }));

  for (let ri = 0; ri < orderedIds.length; ri++) {
    const receiptId = orderedIds[ri]!;
    const obsList = (byReceipt.get(receiptId) ?? []).sort(
      (a, b) => a.itemSourceIndex - b.itemSourceIndex
    );
    const bin = binStats[Math.min(4, Math.floor(ri / 20))]!;
    bin.receiptCount += 1;

    const items: any[] = [];
    let categoryOnlyWouldCall = false;

    for (const obs of obsList) {
      const resolved = resolveReceiptItemIdentity(
        {
          rawName: obs.rawName,
          merchantKey: obs.merchantKey,
          receiptId: obs.receiptId,
          itemSourceIndex: obs.itemSourceIndex,
          quantity: obs.quantity,
          lineTotal: obs.lineTotal,
        },
        store
      );
      const existingMatch =
        !resolved.createdMerchantProduct && !!resolved.link.merchantProductId;
      const created = !!resolved.createdMerchantProduct;
      if (created) bin.newMps += 1;

      const mpId = resolved.link.merchantProductId;
      const mp = mpId
        ? store.listMerchantProducts(obs.merchantKey).find((m) => m.id === mpId) ?? null
        : null;

      const local = resolveLocalCategoryForSemanticGate(
        obs.rawName,
        mp?.normalizedName ?? resolved.normalizedName ?? obs.rawName,
        obs.merchantKey
      );
      if (local.category === 'uncategorized') categoryOnlyWouldCall = true;

      const attrs = mp?.attributes ?? resolved.attributes ?? attrsFromName(obs.rawName);
      const cachedStatus = mp?.semanticStatus ?? null;
      const needEnrich = needsSemanticEnrichment({
        rawName: obs.rawName,
        normalizedName: mp?.normalizedName ?? resolved.normalizedName ?? obs.rawName,
        comparisonKey: mp?.comparisonKey ?? resolved.comparisonKey ?? null,
        merchantKey: obs.merchantKey,
        existingMerchantProductMatch: existingMatch,
        createdMerchantProduct: created,
        brand: mp?.brand ?? null,
        category: local.category,
        categoryConfidence: local.confidence,
        categorySource: local.source,
        attributes: attrs,
        cachedSemanticStatus: cachedStatus,
        identityLevel: resolved.link.identityLevel,
        identityConfidence: resolved.link.identityConfidence,
      });

      if (needEnrich && cachedStatus !== 'enriched' && cachedStatus !== 'sufficient') {
        bin.semanticCandidates += 1;
        if (mp) newMpsNeedingAi.add(mp.id);
      }

      items.push({
        name: obs.rawName,
        normalized_name: mp?.normalizedName ?? resolved.normalizedName ?? obs.rawName,
        category: local.category,
        classification_confidence: local.confidence,
        merchant_product_created: created,
        merchant_product_existing_match: existingMatch,
        semantic_status: cachedStatus,
        product_attributes: attrs,
        comparison_key: mp?.comparisonKey ?? resolved.comparisonKey,
        merchant_key: obs.merchantKey,
        identity_level: resolved.link.identityLevel,
        identity_confidence: resolved.link.identityConfidence,
        _mpId: mpId,
        _needEnrich: needEnrich,
        _attrs: attrs,
      });
    }

    if (categoryOnlyWouldCall) {
      categoryOnlyCalls += 1;
      bin.categoryCalls += 1;
    }

    const selected = selectBatchSemanticItems(items, maxItems);
    if (selected.length > 0) {
      combinedCalls += 1;
      bin.combinedCalls += 1;
      batchSizes.push(selected.length);
      itemsSent += selected.length;
    }

    for (const it of items) {
      const mpId = it._mpId as string | null;
      if (!mpId) continue;
      const cached = it.semantic_status as string | null;
      if (cached === 'enriched' || cached === 'sufficient') continue;
      const wasSelected = selected.some((s) => items[s.index] === it);
      if (wasSelected || it._needEnrich) {
        store.saveMerchantProductSemantic(
          mpId,
          cacheRecord('enriched', it._attrs, 0, 'receipt_sim_cache_mark')
        );
      } else if (it.category !== 'uncategorized') {
        store.saveMerchantProductSemantic(
          mpId,
          cacheRecord(
            'sufficient',
            it._attrs,
            it.classification_confidence ?? 0.9,
            'receipt_sim_sufficient'
          )
        );
      }
    }
  }

  const n = orderedIds.length || 1;
  const calledBatches = batchSizes.length;
  const mean = calledBatches > 0 ? itemsSent / calledBatches : 0;
  const scale = 100 / n;
  const labels = ['first20', 'next20', 'next20b', 'next20c', 'last20'];

  return {
    receiptCount: orderedIds.length,
    receiptsThatWouldCallCategoryBatch: categoryOnlyCalls,
    categoryBatchCallRate: categoryOnlyCalls / n,
    receiptsThatWouldCallCombinedBatch: combinedCalls,
    combinedBatchCallRate: combinedCalls / n,
    absoluteIncrease: combinedCalls - categoryOnlyCalls,
    percentagePointIncrease: ((combinedCalls - categoryOnlyCalls) / n) * 100,
    combinedBatchCallsPer100Receipts: combinedCalls * scale,
    itemsSentPer100Receipts: itemsSent * scale,
    meanItemsPerCalledBatch: mean,
    medianItemsPerCalledBatch: median(batchSizes),
    maxItemsPerBatch: batchSizes.length ? Math.max(...batchSizes) : 0,
    uniqueNewMpsNeedingSemanticAiPer100Receipts: newMpsNeedingAi.size * scale,
    bins: binStats.map((b, i) => ({
      label: labels[i] ?? `bin${i}`,
      receiptCount: b.receiptCount,
      newMerchantProducts: b.newMps,
      semanticAiCandidates: b.semanticCandidates,
      categoryOnlyCallRate: b.receiptCount ? b.categoryCalls / b.receiptCount : 0,
      combinedCallRate: b.receiptCount ? b.combinedCalls / b.receiptCount : 0,
    })),
  };
}
