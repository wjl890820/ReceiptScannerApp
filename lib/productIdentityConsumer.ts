/**
 * Product Identity Batch 5B — identity-backed consumer pipeline.
 * Derived / in-memory only. No mass DB write. Gemini additional calls = 0.
 */

import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import {
  buildMerchantProductPriceHistory,
  computePurchaseUnitPrice,
  type MerchantProductPricePoint,
} from './productIdentityPriceComparison';
import {
  evaluateMerchantProductHistoryEligibility,
  evaluatePriceObservationQuality,
  type PriceObservationQualityLevel,
} from './productIdentityPriceObservationQuality';
import { resolveMerchantProductDisplayName } from './productIdentityPresentationContract';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  type MerchantProductRecord,
  type ProductIdentityStore,
} from './productIdentityStore';

export type IdentityConsumerObservation = {
  receiptId: string;
  itemSourceIndex: number;
  rawName: string;
  merchantKey: string;
  occurredAt: number;
  lineTotal: number | null | undefined;
  quantity: number | null | undefined;
  displayName?: string | null;
};

export type QualifiedIdentityObservation = IdentityConsumerObservation & {
  merchantProductId: string;
  purchaseUnitPrice: number | null;
  quality: PriceObservationQualityLevel;
  includeInHistory: boolean;
  includeInTrend: boolean;
  suspectedIntegerMultiple: number | null;
};

export type IdentityMerchantProductHistoryView = {
  strategy: 'same_merchant_product';
  merchantProductId: string;
  merchantKey: string;
  displayName: string;
  priceHistoryEligible: boolean;
  simpleDeltaEligible: boolean;
  trendInsightEligible: boolean;
  historyPoints: Array<{
    receiptId: string;
    itemSourceIndex: number;
    occurredAt: number;
    rawName: string;
    purchaseUnitPrice: number;
    quality: PriceObservationQualityLevel;
  }>;
  trendPoints: Array<{
    receiptId: string;
    occurredAt: number;
    purchaseUnitPrice: number;
  }>;
  stats: {
    latest: number | null;
    previousTrusted: number | null;
    minTrusted: number | null;
    maxTrusted: number | null;
    meanTrusted: number | null;
    medianTrusted: number | null;
    purchaseCount: number;
    firstPurchaseAt: number | null;
    latestPurchaseAt: number | null;
    qualityExcludedCount: number;
    suspectedAnomalyCount: number;
  };
  presentationTitleKey: 'priceHistory.titleMerchantLocal';
  presentationSubtitleKey: 'priceHistory.subtitle.merchantProduct';
};

export type IdentityFrequentProductGroup = {
  groupingType: 'merchant_product';
  key: string;
  displayName: string;
  merchantKey: string;
  distinctReceiptCount: number;
  firstPurchaseAt: number | null;
  latestPurchaseAt: number | null;
  rawNameVariants: string[];
};

function usableTs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function listMerchantProductsForKeys(
  store: ProductIdentityStore,
  merchantKeys: Iterable<string>
): MerchantProductRecord[] {
  const out = new Map<string, MerchantProductRecord>();
  for (const key of merchantKeys) {
    for (const mp of store.listMerchantProducts(key)) {
      out.set(mp.id, mp);
    }
  }
  return [...out.values()];
}

export function resolveIdentityConsumerObservations(
  observations: readonly IdentityConsumerObservation[],
  store: ProductIdentityStore = createMemoryProductIdentityStore()
): {
  store: ProductIdentityStore;
  qualified: QualifiedIdentityObservation[];
} {
  type Draft = IdentityConsumerObservation & {
    merchantProductId: string | null;
    purchaseUnitPrice: number | null;
  };
  const draft: Draft[] = [];

  for (const obs of observations) {
    const name = (obs.rawName || '').trim();
    if (!name) continue;
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
    draft.push({
      ...obs,
      merchantProductId: result.link.merchantProductId,
      purchaseUnitPrice: computePurchaseUnitPrice(obs.lineTotal, obs.quantity),
    });
  }

  const peersByMp = new Map<string, number[]>();
  for (const row of draft) {
    if (!row.merchantProductId || row.purchaseUnitPrice == null) continue;
    const list = peersByMp.get(row.merchantProductId) ?? [];
    list.push(row.purchaseUnitPrice);
    peersByMp.set(row.merchantProductId, list);
  }

  const qualified: QualifiedIdentityObservation[] = [];
  for (const row of draft) {
    if (!row.merchantProductId) continue;
    const peerPrices = [...(peersByMp.get(row.merchantProductId) ?? [])];
    if (row.purchaseUnitPrice != null) {
      const idx = peerPrices.indexOf(row.purchaseUnitPrice);
      if (idx >= 0) peerPrices.splice(idx, 1);
    }
    const attrs = normalizeProductForIdentity(row.rawName).attributes;
    const quality = evaluatePriceObservationQuality({
      lineTotal: row.lineTotal,
      quantity: row.quantity,
      peerPurchaseUnitPrices: peerPrices,
      attributes: attrs,
      rawName: row.rawName,
    });
    qualified.push({
      ...row,
      merchantProductId: row.merchantProductId,
      purchaseUnitPrice: quality.rawPurchaseUnitPrice,
      quality: quality.quality,
      includeInHistory: quality.includeInHistory,
      includeInTrend: quality.includeInTrend,
      suspectedIntegerMultiple: quality.suspectedIntegerMultiple,
    });
  }

  return { store, qualified };
}

export function buildIdentityMerchantProductHistoryView(
  merchantProductId: string,
  observations: readonly QualifiedIdentityObservation[],
  merchantProduct?: MerchantProductRecord | null
): IdentityMerchantProductHistoryView | null {
  const rows = observations.filter(
    (o) => o.merchantProductId === merchantProductId
  );
  if (!rows.length) return null;

  const eligibility = evaluateMerchantProductHistoryEligibility({
    merchantProductId,
    observations: rows.map((o) => ({
      occurredAt: o.occurredAt,
      quality: o.quality,
    })),
  });

  const historyRows = rows
    .filter((o) => o.includeInHistory && o.purchaseUnitPrice != null)
    .sort(
      (a, b) =>
        a.occurredAt - b.occurredAt ||
        a.receiptId.localeCompare(b.receiptId) ||
        a.itemSourceIndex - b.itemSourceIndex
    );
  const trendRows = rows
    .filter((o) => o.includeInTrend && o.purchaseUnitPrice != null)
    .sort(
      (a, b) =>
        a.occurredAt - b.occurredAt ||
        a.receiptId.localeCompare(b.receiptId) ||
        a.itemSourceIndex - b.itemSourceIndex
    );
  const trustedPrices = trendRows.map((r) => r.purchaseUnitPrice!);

  return {
    strategy: 'same_merchant_product',
    merchantProductId,
    merchantKey: rows[0]!.merchantKey,
    displayName: resolveMerchantProductDisplayName({
      canonicalDisplayName: merchantProduct?.canonicalDisplayName,
      normalizedName: merchantProduct?.normalizedName,
      bestObservedRawName: historyRows[historyRows.length - 1]?.rawName ?? rows[0]?.rawName,
    }),
    priceHistoryEligible: eligibility.priceHistoryEligible,
    simpleDeltaEligible: eligibility.simpleDeltaEligible,
    trendInsightEligible: eligibility.trendInsightEligible,
    historyPoints: historyRows.map((r) => ({
      receiptId: r.receiptId,
      itemSourceIndex: r.itemSourceIndex,
      occurredAt: r.occurredAt,
      rawName: r.rawName,
      purchaseUnitPrice: r.purchaseUnitPrice!,
      quality: r.quality,
    })),
    trendPoints: trendRows.map((r) => ({
      receiptId: r.receiptId,
      occurredAt: r.occurredAt,
      purchaseUnitPrice: r.purchaseUnitPrice!,
    })),
    stats: {
      latest:
        historyRows.length > 0
          ? historyRows[historyRows.length - 1]!.purchaseUnitPrice
          : null,
      previousTrusted:
        trustedPrices.length >= 2
          ? trustedPrices[trustedPrices.length - 2]!
          : null,
      minTrusted: trustedPrices.length ? Math.min(...trustedPrices) : null,
      maxTrusted: trustedPrices.length ? Math.max(...trustedPrices) : null,
      meanTrusted: trustedPrices.length
        ? trustedPrices.reduce((a, b) => a + b, 0) / trustedPrices.length
        : null,
      medianTrusted: trustedPrices.length ? median(trustedPrices) : null,
      purchaseCount: historyRows.length,
      firstPurchaseAt: usableTs(historyRows[0]?.occurredAt),
      latestPurchaseAt: usableTs(
        historyRows[historyRows.length - 1]?.occurredAt
      ),
      qualityExcludedCount: eligibility.qualityExcludedCount,
      suspectedAnomalyCount: eligibility.suspectedAnomalyCount,
    },
    presentationTitleKey: 'priceHistory.titleMerchantLocal',
    presentationSubtitleKey: 'priceHistory.subtitle.merchantProduct',
  };
}

export function buildIdentityFrequentProductGroups(
  observations: readonly IdentityConsumerObservation[],
  store: ProductIdentityStore = createMemoryProductIdentityStore()
): {
  groups: IdentityFrequentProductGroup[];
  qualified: QualifiedIdentityObservation[];
  store: ProductIdentityStore;
} {
  const { qualified, store: usedStore } =
    resolveIdentityConsumerObservations(observations, store);
  const byMp = new Map<string, QualifiedIdentityObservation[]>();
  for (const q of qualified) {
    const list = byMp.get(q.merchantProductId) ?? [];
    list.push(q);
    byMp.set(q.merchantProductId, list);
  }
  const mpById = new Map(
    listMerchantProductsForKeys(
      usedStore,
      new Set(qualified.map((q) => q.merchantKey))
    ).map((m) => [m.id, m])
  );

  const groups: IdentityFrequentProductGroup[] = [];
  for (const [mpId, rows] of byMp) {
    const receiptIds = new Set(rows.map((r) => r.receiptId));
    if (receiptIds.size < 2) continue;
    const sorted = [...rows].sort(
      (a, b) =>
        a.occurredAt - b.occurredAt ||
        a.receiptId.localeCompare(b.receiptId) ||
        a.itemSourceIndex - b.itemSourceIndex
    );
    const mp = mpById.get(mpId);
    const rawNames = [
      ...new Set(sorted.map((r) => r.rawName.trim()).filter(Boolean)),
    ];
    let first: number | null = null;
    let latest: number | null = null;
    for (const r of sorted) {
      const ts = usableTs(r.occurredAt);
      if (ts == null) continue;
      if (first == null || ts < first) first = ts;
      if (latest == null || ts > latest) latest = ts;
    }
    groups.push({
      groupingType: 'merchant_product',
      key: mpId,
      displayName: resolveMerchantProductDisplayName({
        canonicalDisplayName: mp?.canonicalDisplayName,
        normalizedName: mp?.normalizedName,
        bestObservedRawName: rawNames[0] ?? null,
      }),
      merchantKey: sorted[0]!.merchantKey,
      distinctReceiptCount: receiptIds.size,
      firstPurchaseAt: first,
      latestPurchaseAt: latest,
      rawNameVariants: rawNames,
    });
  }

  groups.sort(
    (a, b) =>
      b.distinctReceiptCount - a.distinctReceiptCount ||
      (b.latestPurchaseAt ?? 0) - (a.latestPurchaseAt ?? 0) ||
      a.displayName.localeCompare(b.displayName)
  );
  return { groups, qualified, store: usedStore };
}

export function identityObservationsFromPriceHistoryRows(
  rows: Array<{
    receiptId: string;
    sourceIndex: number;
    occurredAt: number;
    merchantRaw: string | null;
    merchantNormalized: string | null;
    displayName: string;
    lineTotal: number | null;
    purchaseQuantity: number | null;
  }>
): IdentityConsumerObservation[] {
  return rows.map((r) => ({
    receiptId: r.receiptId,
    itemSourceIndex: r.sourceIndex,
    rawName: r.displayName,
    merchantKey:
      (r.merchantNormalized || r.merchantRaw || '').trim() || 'unknown_merchant',
    occurredAt: r.occurredAt,
    lineTotal: r.lineTotal,
    quantity: r.purchaseQuantity,
    displayName: r.displayName,
  }));
}

/**
 * Prefer identity merchant-local history when eligible; else null → legacy.
 */
export function tryBuildIdentityPriceHistoryForRows(
  rows: Array<{
    receiptId: string;
    itemId: string;
    sourceIndex: number;
    occurredAt: number;
    merchantRaw: string | null;
    merchantNormalized: string | null;
    displayName: string;
    currency: string | null;
    lineTotal: number | null;
    purchaseQuantity: number | null;
  }>,
  preferredMerchantProductId?: string | null
): IdentityMerchantProductHistoryView | null {
  if (!rows.length) return null;
  const observations = identityObservationsFromPriceHistoryRows(rows);
  const { qualified, store } =
    resolveIdentityConsumerObservations(observations);
  if (!qualified.length) return null;

  const countByMp = new Map<string, number>();
  for (const q of qualified) {
    countByMp.set(
      q.merchantProductId,
      (countByMp.get(q.merchantProductId) ?? 0) + 1
    );
  }
  let mpId = preferredMerchantProductId ?? null;
  if (!mpId || !countByMp.has(mpId)) {
    mpId = [...countByMp.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  if (!mpId) return null;

  const mp = listMerchantProductsForKeys(
    store,
    new Set(qualified.map((q) => q.merchantKey))
  ).find((m) => m.id === mpId);
  const view = buildIdentityMerchantProductHistoryView(mpId, qualified, mp);
  if (!view || !view.priceHistoryEligible) return null;
  return view;
}

export function buildRawMerchantProductPricePoints(
  rows: readonly QualifiedIdentityObservation[]
): MerchantProductPricePoint[] {
  return rows
    .filter((r) => r.purchaseUnitPrice != null)
    .map((r) => ({
      receiptId: r.receiptId,
      itemSourceIndex: r.itemSourceIndex,
      occurredAt: r.occurredAt,
      rawName: r.rawName,
      merchantKey: r.merchantKey,
      merchantProductId: r.merchantProductId,
      lineTotal: (r.lineTotal as number) ?? 0,
      quantity: (r.quantity as number) ?? 1,
      purchaseUnitPrice: r.purchaseUnitPrice!,
      normalizedUnitPrice: null,
    }));
}

export { buildMerchantProductPriceHistory };
