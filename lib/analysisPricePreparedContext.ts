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
