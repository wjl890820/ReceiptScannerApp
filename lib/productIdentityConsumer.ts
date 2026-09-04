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
  leaveOneOutPeerStats,
  preparePeerPriceBucket,
  resolveQuantityOcrCorroboration,
  type PreparedPeerPriceBucket,
  type PriceObservationQualityLevel,
} from './productIdentityPriceObservationQuality';
import { resolveMerchantProductDisplayName } from './productIdentityPresentationContract';
import type { ProductIdentityLevel } from './productIdentityContract';
import {
  isUnknownMerchantScopeKey,
  resolveReceiptItemIdentity,
  scopeMerchantKeyForIdentity,
} from './productIdentityResolver';
import { classifyLineKind } from './receiptOcrNormalize';
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
  /** Discount/tax/subtotal/payment — never frequent/history. */
  isNonProductRow?: boolean;
  /**
   * Independent quantity-OCR mismatch evidence (never inferred from price ratio alone).
   * When absent/false, low-side reciprocal prices stay usable_with_caution (V1 safe).
   */
  quantityOcrCorroborated?: boolean;
  /** Optional provenance: only 'ocr' + mismatchEvidence may corroborate. */
  quantitySource?: 'ocr' | 'user' | 'default' | null;
  quantityMismatchEvidence?: boolean;
};

export type QualifiedIdentityObservation = IdentityConsumerObservation & {
  merchantProductId: string;
  purchaseUnitPrice: number | null;
  quality: PriceObservationQualityLevel;
  includeInHistory: boolean;
  includeInTrend: boolean;
  suspectedIntegerMultiple: number | null;
  identityLevel: ProductIdentityLevel;
  identityConfidence: number;
  identitySource: string;
  merchantScopeKey: string;
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
  /** All qualified identity rows belonging to this merchant product target (Level-1 scope). */
  targetMembershipRowKeys: Array<{ receiptId: string; itemSourceIndex: number }>;
};

export type IdentityFrequentProductGroup = {
  groupingType: 'merchant_product';
  key: string;
  displayName: string;
  merchantKey: string;
  /** Distinct receipt purchase occasions (Frequent card purchase count). */
  distinctReceiptCount: number;
  /**
   * Cumulative purchase quantity across identity-linked item rows for this MP.
   * Same positive-quantity sum rule as Product Detail merchant_product history.
   */
  totalPurchaseQuantity: number;
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


function observationIsNonProductRow(obs: IdentityConsumerObservation): boolean {
  if (obs.isNonProductRow === true) return true;
  const kind = classifyLineKind(obs.rawName || '', Number(obs.lineTotal) || 0);
  return kind !== 'item';
}

type IdentityDraft = IdentityConsumerObservation & {
  merchantProductId: string | null;
  purchaseUnitPrice: number | null;
  identityLevel: ProductIdentityLevel;
  identityConfidence: number;
  identitySource: string;
  merchantScopeKey: string;
};

function pushIdentityDraft(
  draft: IdentityDraft[],
  obs: IdentityConsumerObservation,
  store: ProductIdentityStore
): void {
  const name = (obs.rawName || '').trim();
  if (!name) return;
  const merchantScopeKey = scopeMerchantKeyForIdentity(
    obs.merchantKey || 'unknown_merchant',
    obs.receiptId
  );
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
    identityLevel: result.link.identityLevel,
    identityConfidence: result.link.identityConfidence,
    identitySource: result.link.identitySource,
    merchantScopeKey,
  });
}

function preparePeerBucketsFromDraft(
  draft: readonly IdentityDraft[]
): Map<string, PreparedPeerPriceBucket> {
  const peersByMp = new Map<string, number[]>();
  for (const row of draft) {
    if (!row.merchantProductId || row.purchaseUnitPrice == null) continue;
    const list = peersByMp.get(row.merchantProductId) ?? [];
    list.push(row.purchaseUnitPrice);
    peersByMp.set(row.merchantProductId, list);
  }

  const preparedPeersByMp = new Map<string, PreparedPeerPriceBucket>();
  for (const [mpId, prices] of peersByMp) {
    preparedPeersByMp.set(mpId, preparePeerPriceBucket(prices));
  }
  return preparedPeersByMp;
}

function qualifyIdentityDraftRow(
  row: IdentityDraft,
  preparedPeersByMp: ReadonlyMap<string, PreparedPeerPriceBucket>
): QualifiedIdentityObservation | null {
  if (!row.merchantProductId) return null;
  const bucket = preparedPeersByMp.get(row.merchantProductId);
  const preparedPeerStats =
    bucket != null
      ? leaveOneOutPeerStats(bucket, row.purchaseUnitPrice)
      : null;
  const attrs = normalizeProductForIdentity(row.rawName).attributes;
  const quality = evaluatePriceObservationQuality({
    lineTotal: row.lineTotal,
    quantity: row.quantity,
    preparedPeerStats,
    attributes: attrs,
    rawName: row.rawName,
    isNonProductRow: observationIsNonProductRow(row),
    quantityOcrCorroborated: resolveQuantityOcrCorroboration(row),
  });
  return {
    ...row,
    merchantProductId: row.merchantProductId,
    purchaseUnitPrice: quality.rawPurchaseUnitPrice,
    quality: quality.quality,
    includeInHistory: quality.includeInHistory,
    includeInTrend: quality.includeInTrend,
    suspectedIntegerMultiple: quality.suspectedIntegerMultiple,
    identityLevel: row.identityLevel,
    identityConfidence: row.identityConfidence,
    identitySource: row.identitySource,
    merchantScopeKey: row.merchantScopeKey,
  };
}

function qualifyIdentityDraft(
  draft: readonly IdentityDraft[]
): QualifiedIdentityObservation[] {
  const preparedPeersByMp = preparePeerBucketsFromDraft(draft);
  const qualified: QualifiedIdentityObservation[] = [];
  for (const row of draft) {
    const q = qualifyIdentityDraftRow(row, preparedPeersByMp);
    if (q) qualified.push(q);
  }
  return qualified;
}

export function resolveIdentityConsumerObservations(
  observations: readonly IdentityConsumerObservation[],
  store: ProductIdentityStore = createMemoryProductIdentityStore()
): {
  store: ProductIdentityStore;
  qualified: QualifiedIdentityObservation[];
} {
  const draft: IdentityDraft[] = [];
  for (const obs of observations) {
    pushIdentityDraft(draft, obs, store);
  }
  return { store, qualified: qualifyIdentityDraft(draft) };
}

export type ResolveIdentityConsumerObservationsAsyncOptions = {
  shouldCancel?: () => boolean;
  /** Yield after this many identity resolves. Default 64. */
  rowsPerChunk?: number;
  yieldFn?: () => Promise<void>;
};

/**
 * Same semantics as resolveIdentityConsumerObservations, with cooperative yields
 * between identity-resolve chunks so AP-3 preparation does not monopolize JS.
 */
export async function resolveIdentityConsumerObservationsAsync(
  observations: readonly IdentityConsumerObservation[],
  store: ProductIdentityStore = createMemoryProductIdentityStore(),
  options: ResolveIdentityConsumerObservationsAsyncOptions = {}
): Promise<{
  store: ProductIdentityStore;
  qualified: QualifiedIdentityObservation[];
} | null> {
  const shouldCancel = options.shouldCancel ?? (() => false);
  const rowsPerChunk = Math.max(1, options.rowsPerChunk ?? 64);
  const yieldFn =
    options.yieldFn ??
    (async () => {
      const { yieldAnalysisPriceChunk } = await import('./analysisPriceScheduler');
      await yieldAnalysisPriceChunk();
    });

  if (shouldCancel()) return null;
  const draft: IdentityDraft[] = [];
  let sinceYield = 0;
  let chunkStarted = Date.now();
  for (const obs of observations) {
    if (shouldCancel()) return null;
    pushIdentityDraft(draft, obs, store);
    sinceYield += 1;
    if (sinceYield >= rowsPerChunk) {
      const chunkMs = Date.now() - chunkStarted;
      try {
        const { recordAnalysisPriceChunkTiming } = await import(
          './analysisPriceScheduler'
        );
        recordAnalysisPriceChunkTiming('identity:rows', chunkMs);
      } catch {
        // ignore
      }
      sinceYield = 0;
      await yieldFn();
      if (shouldCancel()) return null;
      chunkStarted = Date.now();
    }
  }
  if (sinceYield > 0) {
    try {
      const { recordAnalysisPriceChunkTiming } = await import(
        './analysisPriceScheduler'
      );
      recordAnalysisPriceChunkTiming(
        'identity:rows',
        Date.now() - chunkStarted
      );
    } catch {
      // ignore
    }
  }

  // Peer prepare once per MP bucket, then qualify in bounded row chunks.
  await yieldFn();
  if (shouldCancel()) return null;
  const prepareStarted = Date.now();
  const preparedPeersByMp = preparePeerBucketsFromDraft(draft);
  try {
    const { recordAnalysisPriceChunkTiming } = await import(
      './analysisPriceScheduler'
    );
    recordAnalysisPriceChunkTiming(
      'identity:peerPrepare',
      Date.now() - prepareStarted
    );
  } catch {
    // ignore
  }
  await yieldFn();
  if (shouldCancel()) return null;

  const qualified: QualifiedIdentityObservation[] = [];
  let qualifySinceYield = 0;
  let qualifyChunkStarted = Date.now();
  for (const row of draft) {
    if (shouldCancel()) return null;
    const q = qualifyIdentityDraftRow(row, preparedPeersByMp);
    if (q) qualified.push(q);
    qualifySinceYield += 1;
    if (qualifySinceYield >= rowsPerChunk) {
      try {
        const { recordAnalysisPriceChunkTiming } = await import(
          './analysisPriceScheduler'
        );
        recordAnalysisPriceChunkTiming(
          'identity:qualify',
          Date.now() - qualifyChunkStarted
        );
      } catch {
        // ignore
      }
      qualifySinceYield = 0;
      await yieldFn();
      if (shouldCancel()) return null;
      qualifyChunkStarted = Date.now();
    }
  }
  if (qualifySinceYield > 0) {
    try {
      const { recordAnalysisPriceChunkTiming } = await import(
        './analysisPriceScheduler'
      );
      recordAnalysisPriceChunkTiming(
        'identity:qualify',
        Date.now() - qualifyChunkStarted
      );
    } catch {
      // ignore
    }
  }
  await yieldFn();
  if (shouldCancel()) return null;
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
  if (isUnknownMerchantScopeKey(rows[0]?.merchantKey)) {
    return null;
  }

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
      merchantProductId: r.merchantProductId,
      identityLevel: r.identityLevel,
      identityConfidence: r.identityConfidence,
      identitySource: r.identitySource,
      merchantScopeKey: r.merchantScopeKey,
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
    targetMembershipRowKeys: rows.map((r) => ({
      receiptId: r.receiptId,
      itemSourceIndex: r.itemSourceIndex,
    })),
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
    if (isUnknownMerchantScopeKey(rows[0]?.merchantKey)) continue;
    if (rows.every((r) => observationIsNonProductRow(r))) continue;
    const purchaseRows = rows.filter(
      (r) => r.quality !== 'invalid' && !observationIsNonProductRow(r)
    );
    if (purchaseRows.length < 2) continue;

    const receiptIds = new Set(purchaseRows.map((r) => r.receiptId));
    if (receiptIds.size < 2) continue;
    const sorted = [...purchaseRows].sort(
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
    // Quantity aggregate: all identity-linked product rows for this MP (not SKU
    // fields). Matches Product Detail merchant_product totalPurchaseQuantity rule.
    const quantityRows = rows.filter((r) => !observationIsNonProductRow(r));
    const totalPurchaseQuantity = quantityRows.reduce((sum, r) => {
      const q =
        typeof r.quantity === 'number' && Number.isFinite(r.quantity)
          ? r.quantity
          : 0;
      return sum + (q > 0 ? q : 0);
    }, 0);
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
      totalPurchaseQuantity,
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

export function resolveMerchantProductTargetMembershipRowKeys(
  rows: Parameters<typeof identityObservationsFromPriceHistoryRows>[0],
  merchantProductId: string
): Array<{ receiptId: string; itemSourceIndex: number }> {
  const { qualified } = resolveIdentityConsumerObservations(
    identityObservationsFromPriceHistoryRows(rows)
  );
  return qualified
    .filter((row) => row.merchantProductId === merchantProductId)
    .map((row) => ({
      receiptId: row.receiptId,
      itemSourceIndex: row.itemSourceIndex,
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
    .filter(
      (r) =>
        r.purchaseUnitPrice != null &&
        typeof r.quantity === 'number' &&
        Number.isFinite(r.quantity) &&
        r.quantity > 0
    )
    .map((r) => ({
      receiptId: r.receiptId,
      itemSourceIndex: r.itemSourceIndex,
      occurredAt: r.occurredAt,
      rawName: r.rawName,
      merchantKey: r.merchantKey,
      merchantProductId: r.merchantProductId,
      lineTotal: (r.lineTotal as number) ?? 0,
      quantity: r.quantity as number,
      purchaseUnitPrice: r.purchaseUnitPrice!,
      normalizedUnitPrice: null,
    }));
}

export { buildMerchantProductPriceHistory };
