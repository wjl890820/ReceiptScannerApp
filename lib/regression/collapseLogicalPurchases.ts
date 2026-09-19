/**
 * Phase 2 — analytics duplicate collapse via production SSOT.
 * Does NOT use evaluateExactTransactionReceiptCollision.
 *
 * Terminology:
 * - analyticsRetainedReceipts = HC survivors (may still include partial rescans)
 * - canonicalPurchaseOccurrences = purchase-event semantic unit for Repeat/PPH/visit
 */

import {
  filterProductRowsByExcludedReceiptIds,
  selectAnalyticsReceipts,
  type AnalyticsReceiptSelection,
} from '../analyticsReceiptSelection';
import {
  buildCanonicalPurchaseOccurrenceIndex,
  retainOccurrenceRepresentativeReceipts,
  type CanonicalPurchaseOccurrenceIndex,
} from '../canonicalPurchaseOccurrence';
import type { ReceiptRow } from '../db';
import type { ProductPriceHistoryRow } from '../productPriceHistory';
import type { HistoricalItemObservation } from './buildHistoricalIndex';

export type LogicalPurchaseCollapseResult = {
  selection: AnalyticsReceiptSelection;
  includedReceiptIds: string[];
  excludedDuplicateReceiptIds: string[];
  /** @deprecated Prefer analyticsRetainedReceiptCount. */
  logicalPurchaseCount: number;
  /** HC-retained receipt rows (not yet occurrence-collapsed). */
  analyticsRetainedReceiptCount: number;
  /** Distinct canonical purchase occurrences among analytics-retained receipts. */
  canonicalPurchaseOccurrenceCount: number;
  purchaseOccurrenceIndex: CanonicalPurchaseOccurrenceIndex;
  /** One representative receipt per canonical occurrence (visit/spend universe). */
  occurrenceRepresentativeReceipts: ReceiptRow[];
  duplicateRowCount: number;
  duplicateGroups: Array<{
    confidence: string;
    representativeReceiptId: string;
    receiptIds: string[];
    excludedReceiptIds: string[];
  }>;
  analyticsItemRows: HistoricalItemObservation[];
  analyticsPriceHistoryRows: ProductPriceHistoryRow[];
};

/**
 * Collapse stored receipts once; filter item/PPH rows to analytics-retained IDs.
 * Also builds canonical purchase-occurrence index over analytics survivors.
 */
export function collapseLogicalPurchases(input: {
  rawReceiptRows: ReceiptRow[];
  rawItemRows: HistoricalItemObservation[];
  rawPriceHistoryRows: ProductPriceHistoryRow[];
}): LogicalPurchaseCollapseResult {
  const selection = selectAnalyticsReceipts(input.rawReceiptRows);
  const excluded = selection.excludedDuplicateReceiptIds;
  const includedReceiptIds = selection.analyticsReceipts.map((r) => r.id);
  const excludedDuplicateReceiptIds = [...excluded].sort((a, b) =>
    a.localeCompare(b)
  );

  const purchaseOccurrenceIndex = buildCanonicalPurchaseOccurrenceIndex(
    selection.analyticsReceipts
  );
  const canonicalPurchaseOccurrenceCount = purchaseOccurrenceIndex.groups.length;
  const occurrenceRepresentativeReceipts =
    retainOccurrenceRepresentativeReceipts(
      selection.analyticsReceipts,
      purchaseOccurrenceIndex
    );

  const duplicateGroups = selection.highConfidenceDuplicateGroups.map((g) => ({
    confidence: g.confidence,
    representativeReceiptId: g.representativeReceiptId,
    receiptIds: [...g.receiptIds].sort((a, b) => a.localeCompare(b)),
    excludedReceiptIds: g.receiptIds
      .filter((id) => id !== g.representativeReceiptId && excluded.has(id))
      .sort((a, b) => a.localeCompare(b)),
  }));

  const analyticsRetainedReceiptCount =
    selection.analyticsPurchaseCandidateCount;

  return {
    selection,
    includedReceiptIds,
    excludedDuplicateReceiptIds,
    logicalPurchaseCount: analyticsRetainedReceiptCount,
    analyticsRetainedReceiptCount,
    canonicalPurchaseOccurrenceCount,
    purchaseOccurrenceIndex,
    occurrenceRepresentativeReceipts,
    duplicateRowCount: excluded.size,
    duplicateGroups,
    analyticsItemRows: filterProductRowsByExcludedReceiptIds(
      input.rawItemRows,
      excluded
    ),
    analyticsPriceHistoryRows: filterProductRowsByExcludedReceiptIds(
      input.rawPriceHistoryRows,
      excluded
    ),
  };
}
