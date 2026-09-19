/**
 * Phase 2 — offline PPH / comparability replay via production pure builders.
 */

import { prepareAnalysisPriceInsightContext } from '../analysisPricePreparedContext';
import {
  buildMerchantProductPriceHistoryFromRows,
  buildProductPriceHistory,
  type ProductPriceHistoryResult,
  type ProductPriceHistoryRow,
  type ProductPriceHistoryStatus,
} from '../productPriceHistory';

export type PphTargetReplayReport = {
  targetKey: string;
  targetKind: 'merchant_product' | 'sku';
  membershipRows: number;
  identityRows: number;
  totalObservations: number;
  level2EligibleObservations: number;
  rejectedObservations: number;
  comparablePoints: number;
  totalOccurrenceCount: number;
  status: ProductPriceHistoryStatus;
  comparabilityLevel: string | null;
  strategy: string | null;
  priceBasis: string | null;
  currency: string | null;
  currentPoint: {
    receiptId: string;
    occurredAt: number;
    priceValue: number;
    grossLineAmount: number;
    purchaseQuantity: number;
  } | null;
  /** All comparable points (for downstream inflation audits). */
  points: Array<{
    receiptId: string;
    occurredAt: number;
    priceValue: number;
    grossLineAmount: number;
    purchaseQuantity: number;
  }>;
  historicalPointCount: number;
  rejectionReasonCounts: Record<string, number>;
  amountBasis: string | null;
  seriesKind: 'gross' | null;
};

export type PriceHistoryReplayResult = {
  targets: PphTargetReplayReport[];
  targetCount: number;
  ready: number;
  notEnoughPoints: number;
  otherStatuses: Record<string, number>;
  comparablePointDistribution: Record<string, number>;
  comparabilityLevelCounts: Record<string, number>;
  rejectionReasonCounts: Record<string, number>;
  personalProduct: { status: 'unsupported_offline_phase2_v1' };
};

function tallyReasons(
  into: Record<string, number>,
  reasons: readonly string[]
): void {
  for (const reason of reasons) {
    into[reason] = (into[reason] ?? 0) + 1;
  }
}

function summarizeHistory(
  targetKind: 'merchant_product' | 'sku',
  targetKey: string,
  membershipRows: number,
  identityRows: number,
  history: ProductPriceHistoryResult
): PphTargetReplayReport {
  const rejectionReasonCounts: Record<string, number> = {};
  let level2EligibleObservations = 0;
  let rejectedObservations = 0;
  for (const obs of history.observations) {
    if (obs.level2Eligible) {
      level2EligibleObservations += 1;
    } else {
      rejectedObservations += 1;
      tallyReasons(rejectionReasonCounts, obs.level2RejectReasons);
    }
  }

  const points = history.points;
  const current =
    points.length > 0
      ? points.reduce((best, p) =>
          p.occurredAt > best.occurredAt ||
          (p.occurredAt === best.occurredAt &&
            p.receiptId.localeCompare(best.receiptId) > 0)
            ? p
            : best
        )
      : null;

  return {
    targetKey,
    targetKind,
    membershipRows,
    identityRows,
    totalObservations: history.observations.length,
    level2EligibleObservations,
    rejectedObservations,
    comparablePoints: history.comparableOccurrenceCount,
    totalOccurrenceCount: history.totalOccurrenceCount,
    status: history.status,
    comparabilityLevel:
      history.identityPresentation?.strategy ??
      (targetKind === 'sku' ? 'sku_exact' : null),
    strategy: history.identityPresentation?.strategy ?? null,
    priceBasis: history.priceKind,
    currency: history.currency,
    currentPoint: current
      ? {
          receiptId: current.receiptId,
          occurredAt: current.occurredAt,
          priceValue: current.priceValue,
          grossLineAmount: current.grossLineAmount,
          purchaseQuantity: current.purchaseQuantity,
        }
      : null,
    points: points.map((p) => ({
      receiptId: p.receiptId,
      occurredAt: p.occurredAt,
      priceValue: p.priceValue,
      grossLineAmount: p.grossLineAmount,
      purchaseQuantity: p.purchaseQuantity,
    })),
    historicalPointCount: Math.max(0, points.length - (current ? 1 : 0)),
    rejectionReasonCounts,
    amountBasis: history.amountBasis,
    seriesKind: history.seriesKind,
  };
}

/**
 * Enumerate MP + SKU targets from production prepareAnalysisPriceInsightContext
 * (full-universe seed = all analytics receipt ids). personal_product unsupported.
 */
export function replayPriceHistory(input: {
  analyticsPriceHistoryRows: readonly ProductPriceHistoryRow[];
  purchaseOccurrenceIndex?: import('../canonicalPurchaseOccurrence').CanonicalPurchaseOccurrenceIndex | null;
}): PriceHistoryReplayResult {
  const rows = [...input.analyticsPriceHistoryRows];
  const seedReceiptIds = new Set(rows.map((r) => r.receiptId));
  const prepared = prepareAnalysisPriceInsightContext(rows, seedReceiptIds);
  const occurrenceOptions = input.purchaseOccurrenceIndex
    ? { purchaseOccurrenceIndex: input.purchaseOccurrenceIndex }
    : {};

  const targets: PphTargetReplayReport[] = [];
  const globalRejection: Record<string, number> = {};
  const comparabilityLevelCounts: Record<string, number> = {};
  const comparablePointDistribution: Record<string, number> = {};
  const otherStatuses: Record<string, number> = {};
  let ready = 0;
  let notEnoughPoints = 0;

  const mpIds = [...prepared.seededMerchantProductIds].sort((a, b) =>
    a.localeCompare(b)
  );
  for (const mpId of mpIds) {
    const membershipRows = prepared.merchantProductBuckets.get(mpId) ?? [];
    const identityView =
      prepared.merchantProductIdentityViews.get(mpId) ?? null;
    const identityRows = identityView?.targetMembershipRowKeys.length ?? 0;

    const bucketMetadata = new Map();
    for (const row of membershipRows) {
      const key = `${row.receiptId}:${row.sourceIndex}`;
      const meta = prepared.rowIdentityMetadata.get(key);
      if (meta) bucketMetadata.set(key, meta);
    }

    const history = identityView
      ? buildMerchantProductPriceHistoryFromRows(mpId, [...membershipRows], {
          receiptEvidenceCache: prepared.receiptEvidenceCache,
          canonicalDuplicateSelectionApplied: true,
          preparedMerchantProductIdentityView: identityView,
          preparedRowIdentityMetadata: bucketMetadata,
          ...occurrenceOptions,
        })
      : buildProductPriceHistory(
          { type: 'merchant_product', key: mpId },
          [...membershipRows],
          {
            receiptEvidenceCache: prepared.receiptEvidenceCache,
            canonicalDuplicateSelectionApplied: true,
            preparedRowIdentityMetadata: bucketMetadata,
            ...occurrenceOptions,
          }
        );

    const report = summarizeHistory(
      'merchant_product',
      mpId,
      membershipRows.length,
      identityRows,
      history
    );
    targets.push(report);

    if (report.status === 'ready') ready += 1;
    else if (report.status === 'not_enough_points') notEnoughPoints += 1;
    else {
      otherStatuses[report.status] = (otherStatuses[report.status] ?? 0) + 1;
    }
    const levelKey = report.comparabilityLevel ?? 'none';
    comparabilityLevelCounts[levelKey] =
      (comparabilityLevelCounts[levelKey] ?? 0) + 1;
    const cpKey = String(report.comparablePoints);
    comparablePointDistribution[cpKey] =
      (comparablePointDistribution[cpKey] ?? 0) + 1;
    for (const [reason, count] of Object.entries(report.rejectionReasonCounts)) {
      globalRejection[reason] = (globalRejection[reason] ?? 0) + count;
    }
  }

  const skuKeys = [...prepared.seededSkuKeys].sort((a, b) => a.localeCompare(b));
  for (const sku of skuKeys) {
    const membershipRows = prepared.skuBuckets.get(sku) ?? [];
    const history = buildProductPriceHistory(
      { type: 'sku', key: sku },
      [...membershipRows],
      {
        receiptEvidenceCache: prepared.receiptEvidenceCache,
        canonicalDuplicateSelectionApplied: true,
        preparedRowIdentityMetadata: prepared.rowIdentityMetadata as Map<
          string,
          import('../productPriceHistory').ProductPriceHistoryRowIdentityMetadata
        >,
        ...occurrenceOptions,
      }
    );
    const report = summarizeHistory(
      'sku',
      sku,
      membershipRows.length,
      membershipRows.length,
      history
    );
    targets.push(report);

    if (report.status === 'ready') ready += 1;
    else if (report.status === 'not_enough_points') notEnoughPoints += 1;
    else {
      otherStatuses[report.status] = (otherStatuses[report.status] ?? 0) + 1;
    }
    const levelKey = report.comparabilityLevel ?? 'none';
    comparabilityLevelCounts[levelKey] =
      (comparabilityLevelCounts[levelKey] ?? 0) + 1;
    const cpKey = String(report.comparablePoints);
    comparablePointDistribution[cpKey] =
      (comparablePointDistribution[cpKey] ?? 0) + 1;
    for (const [reason, count] of Object.entries(report.rejectionReasonCounts)) {
      globalRejection[reason] = (globalRejection[reason] ?? 0) + count;
    }
  }

  targets.sort((a, b) => {
    if (a.targetKind !== b.targetKind) {
      return a.targetKind.localeCompare(b.targetKind);
    }
    return a.targetKey.localeCompare(b.targetKey);
  });

  return {
    targets,
    targetCount: targets.length,
    ready,
    notEnoughPoints,
    otherStatuses,
    comparablePointDistribution,
    comparabilityLevelCounts,
    rejectionReasonCounts: globalRejection,
    personalProduct: { status: 'unsupported_offline_phase2_v1' },
  };
}
