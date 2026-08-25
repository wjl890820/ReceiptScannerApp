/**
 * Analysis release value surfaces (R2-B2).
 *
 * Pure adapters over existing periodStats.topMerchants and buildInsights.changes.
 * Does not recalculate merchant spend, invent comparison windows, or touch
 * retailer identity / profile modules.
 */

import type { BuildInsightsOutput } from './buildInsights';
import type { WeeklyMonthlyStats } from './statsCalculator';

export type AnalysisMerchantRow = {
  /** merchantAnalyticsKey — React key / identity only; not labeled as an internal id in UI. */
  merchantKey: string;
  /** Human-readable label already carried by production topMerchants.merchant. */
  displayName: string;
  visitCount: number;
  spend: number;
};

export type AnalysisSpendChangeSurface =
  | {
      status: 'available';
      direction: 'up' | 'down' | 'flat';
      absoluteDelta: number;
      /** Presentational % from the same current/previous totals already on insights. */
      percentDelta: number | null;
      periodDays: number;
      currentSpend: number;
      previousSpend: number;
    }
  | { status: 'unavailable' };

const SPEND_UP_KEY = 'analysisV2.changes.spendUp';
const SPEND_DOWN_KEY = 'analysisV2.changes.spendDown';

/**
 * Top merchants for the selected Analysis period.
 * Preserves production topMerchants order; does not re-rank.
 */
export function buildAnalysisMerchantSurface(
  stats: Pick<WeeklyMonthlyStats, 'topMerchants'>,
  limit = 3
): AnalysisMerchantRow[] {
  const rows = Array.isArray(stats.topMerchants) ? stats.topMerchants : [];
  return rows.slice(0, Math.max(0, limit)).map((row) => ({
    merchantKey: row.merchant,
    displayName: row.merchant,
    visitCount: row.count,
    spend: row.total,
  }));
}

/**
 * Matched-period spending change already produced by buildInsights.
 * Respects suppression: no spend change entry → unavailable (no invented ALL comparison).
 */
export function buildAnalysisSpendChangeSurface(
  insights: BuildInsightsOutput | null
): AnalysisSpendChangeSurface {
  if (!insights || !insights.previousStats) {
    return { status: 'unavailable' };
  }

  const spendChange = insights.changes.find(
    (change) =>
      change.changeKey === SPEND_UP_KEY || change.changeKey === SPEND_DOWN_KEY
  );
  if (!spendChange) {
    return { status: 'unavailable' };
  }

  const periodDays = Number(
    spendChange.changeParams?.periodDays ?? insights.periodDays ?? 0
  );
  const absoluteDelta = Math.abs(
    Number(spendChange.changeParams?.delta ?? 0)
  );
  const currentSpend = insights.currentStats.supportedSpend;
  const previousSpend = insights.previousStats.supportedSpend;

  let direction: 'up' | 'down' | 'flat' = 'flat';
  if (absoluteDelta === 0 || currentSpend === previousSpend) {
    direction = 'flat';
  } else if (spendChange.changeKey === SPEND_UP_KEY) {
    direction = 'up';
  } else {
    direction = 'down';
  }

  const percentDelta =
    previousSpend > 0
      ? Math.round((100 * (currentSpend - previousSpend)) / previousSpend)
      : null;

  return {
    status: 'available',
    direction,
    absoluteDelta,
    percentDelta,
    periodDays:
      Number.isFinite(periodDays) && periodDays > 0
        ? periodDays
        : insights.periodDays,
    currentSpend,
    previousSpend,
  };
}
