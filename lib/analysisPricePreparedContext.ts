/**
 * AP-3 prepared price-insight context — one-pass identity + evidence + buckets.
 *
 * Full-universe identity consumer resolution and receipt evidence happen once
 * per derivation. Candidate history receives only its membership/SKU bucket.
 */

import {
  buildIdentityMerchantProductHistoryView,
  identityObservationsFromPriceHistoryRows,
  resolveIdentityConsumerObservations,
  resolveIdentityConsumerObservationsAsync,
  resolveMerchantProductTargetMembershipRowKeys,
  type IdentityMerchantProductHistoryView,
  type QualifiedIdentityObservation,
} from './productIdentityConsumer';
import {
  buildReceiptEvidenceCache,
  priceHistoryRowObservationKey,
  type ProductPriceHistoryRow,
  type ProductPriceHistoryRowIdentityMetadata,
  type ReceiptEvidenceCache,
} from './productPriceHistory';

export type AnalysisPriceWorkCounters = {
  /** Authoritative full-universe resolveIdentityConsumerObservations calls. */
  fullUniverseIdentityResolves: number;
  /** buildReceiptEvidenceCache calls during preparation. */
  evidenceCacheBuilds: number;
  /** Rows passed into each buildProductPriceHistory call (bucket sizes). */
  historyInputRowCounts: number[];
};

let activeWorkCounters: AnalysisPriceWorkCounters | null = null;

/** Test seam: begin counting AP-3 preparation/history work. */
export function beginAnalysisPriceWorkCounting(): AnalysisPriceWorkCounters {
  activeWorkCounters = {
    fullUniverseIdentityResolves: 0,
    evidenceCacheBuilds: 0,
    historyInputRowCounts: [],
  };
  return activeWorkCounters;
}

export function getAnalysisPriceWorkCounters(): AnalysisPriceWorkCounters | null {
  return activeWorkCounters;
}

export function endAnalysisPriceWorkCounting(): AnalysisPriceWorkCounters | null {
  const snapshot = activeWorkCounters;
  activeWorkCounters = null;
  return snapshot;
}

export function recordAnalysisPriceHistoryInputSize(rowCount: number): void {
  activeWorkCounters?.historyInputRowCounts.push(rowCount);
}

export type PreparedAnalysisPriceInsightContext = {
  rows: readonly ProductPriceHistoryRow[];
  seedReceiptIds: ReadonlySet<string>;
  qualified: readonly QualifiedIdentityObservation[];
  rowByKey: ReadonlyMap<string, ProductPriceHistoryRow>;
  rowIdentityMetadata: ReadonlyMap<
    string,
    ProductPriceHistoryRowIdentityMetadata
  >;
  receiptEvidenceCache: ReceiptEvidenceCache;
  skuBuckets: ReadonlyMap<string, ProductPriceHistoryRow[]>;
  merchantProductBuckets: ReadonlyMap<string, ProductPriceHistoryRow[]>;
  merchantProductIdentityViews: ReadonlyMap<
    string,
    IdentityMerchantProductHistoryView
  >;
  seededSkuKeys: ReadonlySet<string>;
  seededMerchantProductIds: ReadonlySet<string>;
};

function buildRowIdentityMetadataFromQualified(
  qualified: readonly QualifiedIdentityObservation[],
  rowByKey: ReadonlyMap<string, ProductPriceHistoryRow>
): Map<string, ProductPriceHistoryRowIdentityMetadata> {
  const metadata = new Map<string, ProductPriceHistoryRowIdentityMetadata>();
  for (const observation of qualified) {
    const key = `${observation.receiptId}:${observation.itemSourceIndex}`;
    const row = rowByKey.get(key);
    metadata.set(key, {
      skuKey: row?.skuKey?.trim() || null,
      merchantProductId: observation.merchantProductId,
      identityLevel: observation.identityLevel,
      identityConfidence: observation.identityConfidence,
      identitySource: observation.identitySource,
      merchantScopeKey: observation.merchantScopeKey,
    });
  }
  return metadata;
}

/**
 * Membership keys for one merchant_product from a prepared full-universe
 * qualified observation set — equivalent to
 * resolveMerchantProductTargetMembershipRowKeys(allRows, id) without re-resolve.
 */
export function merchantProductMembershipKeysFromQualified(
  qualified: readonly QualifiedIdentityObservation[],
  merchantProductId: string
): Array<{ receiptId: string; itemSourceIndex: number }> {
  return qualified
    .filter((row) => row.merchantProductId === merchantProductId)
    .map((row) => ({
      receiptId: row.receiptId,
      itemSourceIndex: row.itemSourceIndex,
    }));
}

/**
 * Assert prepared bucket membership matches legacy resolver membership.
 */
export function merchantProductBucketMatchesLegacyMembership(
  rows: readonly ProductPriceHistoryRow[],
  merchantProductId: string,
  bucketRows: readonly ProductPriceHistoryRow[]
): boolean {
  const legacyKeys = new Set(
    resolveMerchantProductTargetMembershipRowKeys(
      [...rows],
      merchantProductId
    ).map((key) => `${key.receiptId}:${key.itemSourceIndex}`)
  );
  const bucketKeys = new Set(
    bucketRows.map((row) => priceHistoryRowObservationKey(row))
  );
  if (legacyKeys.size !== bucketKeys.size) return false;
  for (const key of legacyKeys) {
    if (!bucketKeys.has(key)) return false;
  }
  return true;
}

export function prepareAnalysisPriceInsightContext(
  rows: readonly ProductPriceHistoryRow[],
  seedReceiptIds: ReadonlySet<string>
): PreparedAnalysisPriceInsightContext {
  const rowByKey = new Map<string, ProductPriceHistoryRow>();
  for (const row of rows) {
    rowByKey.set(priceHistoryRowObservationKey(row), row);
  }

  if (activeWorkCounters) {
    activeWorkCounters.fullUniverseIdentityResolves += 1;
  }
  const { qualified } = resolveIdentityConsumerObservations(
    identityObservationsFromPriceHistoryRows([...rows])
  );

  if (activeWorkCounters) {
    activeWorkCounters.evidenceCacheBuilds += 1;
  }
  const receiptEvidenceCache = buildReceiptEvidenceCache(rows);

  return finalizePreparedAnalysisPriceInsightContext({
    rows,
    seedReceiptIds,
    qualified,
    rowByKey,
    receiptEvidenceCache,
  });
}

function finalizePreparedAnalysisPriceInsightContext(input: {
  rows: readonly ProductPriceHistoryRow[];
  seedReceiptIds: ReadonlySet<string>;
  qualified: readonly QualifiedIdentityObservation[];
  rowByKey: Map<string, ProductPriceHistoryRow>;
  receiptEvidenceCache: ReceiptEvidenceCache;
}): PreparedAnalysisPriceInsightContext {
  const { rows, seedReceiptIds, qualified, rowByKey, receiptEvidenceCache } =
    input;
  const rowIdentityMetadata = buildRowIdentityMetadataFromQualified(
    qualified,
    rowByKey
  );

  const skuBuckets = new Map<string, ProductPriceHistoryRow[]>();
  for (const row of rows) {
    const sku = row.skuKey?.trim();
    if (!sku) continue;
    const list = skuBuckets.get(sku) ?? [];
    list.push(row);
    skuBuckets.set(sku, list);
  }

  const qualifiedByMp = new Map<string, QualifiedIdentityObservation[]>();
  for (const observation of qualified) {
    const mpId = observation.merchantProductId?.trim();
    if (!mpId) continue;
    const list = qualifiedByMp.get(mpId) ?? [];
    list.push(observation);
    qualifiedByMp.set(mpId, list);
  }

  const merchantProductBuckets = new Map<string, ProductPriceHistoryRow[]>();
  const merchantProductIdentityViews = new Map<
    string,
    IdentityMerchantProductHistoryView
  >();
  for (const [mpId, mpQualified] of qualifiedByMp) {
    const bucket: ProductPriceHistoryRow[] = [];
    for (const observation of mpQualified) {
      const row = rowByKey.get(
        `${observation.receiptId}:${observation.itemSourceIndex}`
      );
      if (row) bucket.push(row);
    }
    merchantProductBuckets.set(mpId, bucket);
    const view = buildIdentityMerchantProductHistoryView(mpId, mpQualified);
    if (view) {
      merchantProductIdentityViews.set(mpId, view);
    }
  }

  const seededSkuKeys = new Set<string>();
  for (const row of rows) {
    if (!seedReceiptIds.has(row.receiptId)) continue;
    const sku = row.skuKey?.trim();
    if (sku) seededSkuKeys.add(sku);
  }

  const seededMerchantProductIds = new Set<string>();
  for (const observation of qualified) {
    if (!seedReceiptIds.has(observation.receiptId)) continue;
    const mpId = observation.merchantProductId?.trim();
    if (mpId) seededMerchantProductIds.add(mpId);
  }

  return {
    rows,
    seedReceiptIds,
    qualified,
    rowByKey,
    rowIdentityMetadata,
    receiptEvidenceCache,
    skuBuckets,
    merchantProductBuckets,
    merchantProductIdentityViews,
    seededSkuKeys,
    seededMerchantProductIds,
  };
}

export type PrepareAnalysisPriceInsightContextAsyncOptions = {
  shouldCancel?: () => boolean;
  rowsPerChunk?: number;
};

/**
 * Cooperative prepare — same result as sync prepare, yields during identity.
 */
export async function prepareAnalysisPriceInsightContextAsync(
  rows: readonly ProductPriceHistoryRow[],
  seedReceiptIds: ReadonlySet<string>,
  options: PrepareAnalysisPriceInsightContextAsyncOptions = {}
): Promise<PreparedAnalysisPriceInsightContext | null> {
  const { yieldAnalysisPriceChunk, recordAnalysisPriceChunkTiming } =
    await import('./analysisPriceScheduler');
  const shouldCancel = options.shouldCancel ?? (() => false);
  if (shouldCancel()) return null;

  const rowByKey = new Map<string, ProductPriceHistoryRow>();
  for (const row of rows) {
    rowByKey.set(priceHistoryRowObservationKey(row), row);
  }
  await yieldAnalysisPriceChunk();
  if (shouldCancel()) return null;

  if (activeWorkCounters) {
    activeWorkCounters.fullUniverseIdentityResolves += 1;
  }
  const resolved = await resolveIdentityConsumerObservationsAsync(
    identityObservationsFromPriceHistoryRows([...rows]),
    undefined,
    {
      shouldCancel,
      rowsPerChunk: options.rowsPerChunk ?? 64,
      yieldFn: yieldAnalysisPriceChunk,
    }
  );
  if (resolved == null || shouldCancel()) return null;

  await yieldAnalysisPriceChunk();
  if (shouldCancel()) return null;

  if (activeWorkCounters) {
    activeWorkCounters.evidenceCacheBuilds += 1;
  }
  // Evidence is O(unique receipts) linear. Chunk unique-receipt batches so a
  // 1000+ receipt universe does not monopolize JS in one helper call.
  const uniqueReceiptRows: ProductPriceHistoryRow[] = [];
  const seenReceiptIds = new Set<string>();
  for (const row of rows) {
    if (seenReceiptIds.has(row.receiptId)) continue;
    seenReceiptIds.add(row.receiptId);
    uniqueReceiptRows.push(row);
  }
  const receiptEvidenceCache: ReceiptEvidenceCache = new Map();
  const chunkSize = options.rowsPerChunk ?? 64;
  for (let i = 0; i < uniqueReceiptRows.length; i += chunkSize) {
    if (shouldCancel()) return null;
    const evidenceStarted = Date.now();
    const slice = uniqueReceiptRows.slice(i, i + chunkSize);
    const partial = buildReceiptEvidenceCache(slice);
    for (const [receiptId, evidence] of partial) {
      receiptEvidenceCache.set(receiptId, evidence);
    }
    recordAnalysisPriceChunkTiming(
      'prepare:evidence',
      Date.now() - evidenceStarted
    );
    await yieldAnalysisPriceChunk();
  }
  if (shouldCancel()) return null;

  // Finalize is O(I + MP); yield between merchant-product view builds when large.
  const finalizeStarted = Date.now();
  const prepared = finalizePreparedAnalysisPriceInsightContext({
    rows,
    seedReceiptIds,
    qualified: resolved.qualified,
    rowByKey,
    receiptEvidenceCache,
  });
  recordAnalysisPriceChunkTiming(
    'prepare:finalize',
    Date.now() - finalizeStarted
  );
  // Finalize currently builds all MP views synchronously. It is linear in
  // identity observations + MP count; identity/qualify already yielded. If
  // finalize timings dominate later, split MP view construction similarly.
  return prepared;
}
