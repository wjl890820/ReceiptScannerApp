/**
 * Central analytics receipt selection boundary (D2-A3).
 *
 * Stored receipts remain untouched. Analytics consumers that count real-world
 * purchases should use analyticsReceipts / excludedDuplicateReceiptIds from
 * this module rather than reimplementing duplicate detection.
 *
 * V1 excludes CONTENT_EXACT + STRUCTURAL_EXACT + RECONCILED_STRUCTURAL_EXACT extras.
 * Optional keepSeparateReceiptIds is a future KEEP_SEPARATE override.
 */

import {
  buildHighConfidenceDuplicateGroups,
  summarizeReceiptForDuplicateAudit,
  type AnalysisDDuplicateGroup,
} from './analysisDDuplicateAudit';
import type { ReceiptRow } from './db';

export type AnalyticsReceiptSelectionOpts = {
  /** Future KEEP_SEPARATE — never drop these receipt ids from analytics. */
  keepSeparateReceiptIds?: ReadonlySet<string>;
};

export type AnalyticsReceiptSelection = {
  storedReceipts: ReceiptRow[];
  analyticsReceipts: ReceiptRow[];
  excludedDuplicateReceiptIds: ReadonlySet<string>;
  contentExactDuplicateExtras: number;
  structuralExactDuplicateExtras: number;
  reconciledStructuralExactDuplicateExtras: number;
  probableDuplicateExtras: number;
  /**
   * Authoritative high-confidence excluded count = excludedDuplicateReceiptIds.size.
   * Includes CONTENT + STRUCTURAL + RECONCILED extras actually dropped from analytics.
   * Do not re-sum confidence buckets independently for this field.
   */
  highConfidenceDuplicateExtras: number;
  highConfidenceDuplicateGroups: AnalysisDDuplicateGroup[];
  analyticsPurchaseCandidateCount: number;
  keepSeparateReceiptIds: ReadonlySet<string>;
};

/**
 * Select receipts for purchase-occurrence analytics.
 * High-confidence duplicate extras are excluded; PROBABLE is not.
 */
export function selectAnalyticsReceipts(
  receipts: ReceiptRow[],
  opts?: AnalyticsReceiptSelectionOpts
): AnalyticsReceiptSelection {
  const keepSeparateReceiptIds = opts?.keepSeparateReceiptIds ?? new Set<string>();
  const summaries = receipts.map(summarizeReceiptForDuplicateAudit);
  const highConfidenceDuplicateGroups =
    buildHighConfidenceDuplicateGroups(summaries, receipts);

  let contentExactDuplicateExtras = 0;
  let structuralExactDuplicateExtras = 0;
  let reconciledStructuralExactDuplicateExtras = 0;
  const excluded = new Set<string>();

  for (const g of highConfidenceDuplicateGroups) {
    const extras = Math.max(0, g.receiptIds.length - 1);
    if (g.confidence === 'CONTENT_EXACT_DUPLICATE') {
      contentExactDuplicateExtras += extras;
    } else if (g.confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE') {
      reconciledStructuralExactDuplicateExtras += extras;
    } else {
      structuralExactDuplicateExtras += extras;
    }
    for (const id of g.receiptIds) {
      if (id === g.representativeReceiptId) continue;
      if (keepSeparateReceiptIds.has(id)) continue;
      excluded.add(id);
    }
  }

  // keepSeparate may re-include extras; recount candidates from final set
  const analyticsReceipts = receipts.filter((r) => !excluded.has(r.id));

  // Single source of truth: actual excluded receipt set size (includes reconciled).
  const highConfidenceDuplicateExtras = excluded.size;

  return {
    storedReceipts: receipts,
    analyticsReceipts,
    excludedDuplicateReceiptIds: excluded,
    contentExactDuplicateExtras,
    structuralExactDuplicateExtras,
    reconciledStructuralExactDuplicateExtras,
    probableDuplicateExtras: 0,
    highConfidenceDuplicateExtras,
    highConfidenceDuplicateGroups,
    analyticsPurchaseCandidateCount: analyticsReceipts.length,
    keepSeparateReceiptIds,
  };
}

/** Filter productRows (or any { receiptId }) by excluded duplicate receipt ids. */
export function filterProductRowsByExcludedReceiptIds<
  T extends { receiptId: string },
>(rows: readonly T[], excludedIds: ReadonlySet<string>): T[] {
  if (excludedIds.size === 0) return [...rows];
  return rows.filter((row) => !excludedIds.has(row.receiptId));
}
