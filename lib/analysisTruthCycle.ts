/**
 * Production Analysis truth cycle — one loaded receipt set + one nowMs clock.
 *
 * Input contract: `receipts` must already be duplicate-safe analytics candidates
 * (see app/(tabs)/analysis.tsx load boundary).
 *
 * Invariant: periodStats, itemCount, and insights for a given range all derive
 * from the same selectAnalysisPeriodReceiptSets(..., nowMs) contract.
 */

import type { ReceiptRow } from './db';
import { buildInsights, type BuildInsightsOutput } from './buildInsights';
import {
  countSupportedItemsInEligibleReceipts,
  selectAnalysisEligibleReceipts,
  selectAnalysisPeriodReceiptSets,
} from './analysisEligibility';
import { calculateStats, type TimeRange, type WeeklyMonthlyStats } from './statsCalculator';

/** Loaded Analysis data captured once per focus/reload cycle. */
export type AnalysisLoadedTruth = {
  /** Duplicate-safe analytics receipts from selectAnalyticsReceipts. */
  receipts: ReceiptRow[];
  nowMs: number;
};

export type BuildAnalysisTruthSnapshotInput = {
  receipts: ReceiptRow[];
  range: TimeRange;
  nowMs: number;
};

export type AnalysisTruthSnapshot = {
  nowMs: number;
  range: TimeRange;
  periodStats: WeeklyMonthlyStats;
  itemCount: number;
  insights: BuildInsightsOutput;
};

/**
 * Single production truth snapshot for one range at one clock instant.
 * Overview stats and Insights both consume the same period receipt sets.
 */
export function buildAnalysisTruthSnapshot(
  input: BuildAnalysisTruthSnapshotInput
): AnalysisTruthSnapshot {
  const periodSets = selectAnalysisPeriodReceiptSets(
    input.receipts,
    input.range,
    input.nowMs
  );
  const periodStats = calculateStats(
    periodSets.currentPeriodReceipts,
    'all',
    input.nowMs
  );
  const itemCount = countSupportedItemsInEligibleReceipts(
    periodSets.currentPeriodReceipts
  );
  const insights = buildInsights(input.receipts, input.range, {
    nowMs: input.nowMs,
  });

  return {
    nowMs: input.nowMs,
    range: input.range,
    periodStats,
    itemCount,
    insights,
  };
}

/** All-time supported stats for release stage resolution (range = all WHAT universe). */
export function buildAnalysisAllTimeStats(input: {
  receipts: ReceiptRow[];
  nowMs: number;
}): WeeklyMonthlyStats {
  const eligible = selectAnalysisEligibleReceipts(input.receipts);
  return calculateStats(eligible, 'all', input.nowMs);
}
