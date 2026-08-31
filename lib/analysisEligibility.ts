/**
 * Analysis V1 eligibility pipeline — PURE truth helpers.
 *
 * Input contract: receipts are already duplicate-safe analytics candidates
 * (production applies selectAnalyticsReceipts at the load boundary).
 *
 * Pipeline:
 *   analyticsReceipts
 *   → V1 supported retail
 *   → JPY monetary eligibility
 *   → transaction-time period windows
 *
 * Monetary Analysis spend uses supportedSpend (receipt.total on supported receipts).
 * Category share denominators use categoryCompositionTotal (classified merchandise
 * via itemAmountForAnalytics). These are intentionally different.
 */

import type { ReceiptRow } from './db';
import { filterAnalysisJpyReceipts } from './analysisCurrency';
import {
  filterAnalysisReceiptsByTransactionWindow,
  validAnalysisTransactionAt,
  type AnalysisPeriodRange,
} from './analysisPeriod';
import { isV1SupportedReceipt } from './merchantType';
import { getReceiptItems } from './receiptItems';

/** Full-story / insight sufficiency gates (release universe). */
export const ANALYSIS_STORY_MIN_SUPPORTED_RECEIPTS = 3;
export const ANALYSIS_STORY_MIN_ITEMS = 10;
export const ANALYSIS_STORY_MIN_SUPPORTED_SPEND_JPY = 2000;

export type AnalysisPeriodReceiptSets = {
  range: AnalysisPeriodRange;
  /** Comparison window length in days (0 when indeterminate). */
  periodDays: number;
  /** V1 supported JPY receipts in the current analysis window. */
  currentPeriodReceipts: ReceiptRow[];
  /** V1 supported JPY receipts in the matched previous window (may be empty). */
  previousPeriodReceipts: ReceiptRow[];
  /** False when prior matched window cannot be formed safely (e.g. all-range). */
  previousPeriodComparable: boolean;
};

/**
 * Pure eligibility: V1 supported + JPY on duplicate-safe analytics receipts.
 * Does not apply time-window filtering or duplicate canonicalization.
 */
export function selectAnalysisEligibleReceipts(
  analyticsReceipts: readonly ReceiptRow[]
): ReceiptRow[] {
  return filterAnalysisJpyReceipts(analyticsReceipts).filter(isV1SupportedReceipt);
}

/**
 * ALL-range WHAT universe: full eligible historical set.
 * Missing/invalid transaction_at does NOT remove a receipt from all-history totals.
 */
export function selectAnalysisAllCurrentReceipts(
  analyticsReceipts: readonly ReceiptRow[]
): ReceiptRow[] {
  return selectAnalysisEligibleReceipts(analyticsReceipts);
}

/** Count item rows inside an already-eligible supported receipt set. */
export function countSupportedItemsInEligibleReceipts(
  eligibleReceipts: readonly ReceiptRow[]
): number {
  let count = 0;
  for (const receipt of eligibleReceipts) {
    count += getReceiptItems(receipt).length;
  }
  return count;
}

export function isAnalysisStorySufficient(options: {
  supportedReceiptCount: number;
  supportedItemCount: number;
  supportedSpend: number;
}): boolean {
  return (
    options.supportedReceiptCount >= ANALYSIS_STORY_MIN_SUPPORTED_RECEIPTS &&
    options.supportedItemCount >= ANALYSIS_STORY_MIN_ITEMS &&
    options.supportedSpend >= ANALYSIS_STORY_MIN_SUPPORTED_SPEND_JPY
  );
}

/**
 * Resolve current + matched previous period receipt sets for week / month / all.
 * Uses transaction_at only (no created_at substitution).
 */
export function selectAnalysisPeriodReceiptSets(
  analyticsReceipts: readonly ReceiptRow[],
  range: AnalysisPeriodRange,
  nowMs: number = Date.now()
): AnalysisPeriodReceiptSets {
  const eligible = selectAnalysisEligibleReceipts(analyticsReceipts);

  if (range === 'week' || range === 'month') {
    const periodDays = range === 'week' ? 7 : 30;
    const ms = periodDays * 24 * 60 * 60 * 1000;
    const currentStart = nowMs - ms;
    const previousStart = nowMs - 2 * ms;

    const currentPeriodReceipts = filterAnalysisReceiptsByTransactionWindow(
      eligible,
      currentStart,
      nowMs,
      { includeEnd: true }
    );
    const previousPeriodReceipts = filterAnalysisReceiptsByTransactionWindow(
      eligible,
      previousStart,
      currentStart
    );

    return {
      range,
      periodDays,
      currentPeriodReceipts,
      previousPeriodReceipts,
      previousPeriodComparable: true,
    };
  }

  // all WHAT: full eligible history (timestamp not required for membership).
  const currentPeriodReceipts = selectAnalysisAllCurrentReceipts(
    analyticsReceipts
  );

  // all CHANGE: only temporally valid receipts may establish comparison windows.
  const temporallyValid = currentPeriodReceipts.filter(
    (receipt) => validAnalysisTransactionAt(receipt) != null
  );
  const sortedTemporal = [...temporallyValid].sort(
    (a, b) => validAnalysisTransactionAt(a)! - validAnalysisTransactionAt(b)!
  );

  if (sortedTemporal.length < 2) {
    return {
      range,
      periodDays: sortedTemporal.length === 1 ? 1 : 0,
      currentPeriodReceipts,
      previousPeriodReceipts: [],
      previousPeriodComparable: false,
    };
  }

  const firstTx = validAnalysisTransactionAt(sortedTemporal[0])!;
  const lastTx = validAnalysisTransactionAt(
    sortedTemporal[sortedTemporal.length - 1]
  )!;
  const spanMs = Math.max(0, lastTx - firstTx);
  const periodDays = Math.max(
    1,
    Math.ceil(spanMs / (24 * 60 * 60 * 1000)) || 1
  );
  const previousEnd = firstTx;
  const previousStart = previousEnd - spanMs;

  const previousPeriodReceipts = filterAnalysisReceiptsByTransactionWindow(
    currentPeriodReceipts,
    previousStart,
    previousEnd
  );

  return {
    range,
    periodDays,
    currentPeriodReceipts,
    previousPeriodReceipts,
    previousPeriodComparable: previousPeriodReceipts.length > 0,
  };
}

/** Days spanned by valid transaction_at timestamps within eligible receipts. */
export function analysisDaysCovered(
  eligibleReceipts: readonly ReceiptRow[]
): number {
  const times = eligibleReceipts
    .map((receipt) => validAnalysisTransactionAt(receipt))
    .filter((t): t is number => t != null);
  if (times.length === 0) return 0;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const MS_DAY = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((max - min) / MS_DAY));
}
