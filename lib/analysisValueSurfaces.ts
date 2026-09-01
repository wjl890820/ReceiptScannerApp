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

/** Category composition share movement (percentage points, not yen). */
export type AnalysisCategoryChangeSurface =
  | {
      status: 'available';
      direction: 'up' | 'down';
      category: string;
      fromPercent: number;
      toPercent: number;
      percentagePointChange: number;
    }
  | { status: 'unavailable' };

/** Leading-merchant change already emitted by buildInsights. */
export type AnalysisMerchantChangeSurface =
  | {
      status: 'available';
      kind: 'share_increased';
      merchantKey: string;
      displayName: string;
      previousShare: number;
      currentShare: number;
    }
  | {
      status: 'available';
      kind: 'current_period_prominent';
      merchantKey: string;
      displayName: string;
      currentShare: number;
    }
  | { status: 'unavailable' };

const SPEND_UP_KEY = 'analysisV2.changes.spendUp';
const SPEND_DOWN_KEY = 'analysisV2.changes.spendDown';
const CATEGORY_SHARE_UP_KEY = 'analysisV2.changes.categoryShareUp';
const CATEGORY_SHARE_DOWN_KEY = 'analysisV2.changes.categoryShareDown';
const MERCHANT_MORE_KEY = 'analysisV2.changes.merchantMore';

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

/**
 * Top-category composition share change already produced by buildInsights.
 * "change" in source params is percentage-point movement, not yen spend.
 */
export function buildAnalysisCategoryChangeSurface(
  insights: BuildInsightsOutput | null
): AnalysisCategoryChangeSurface {
  if (!insights?.previousStats) {
    return { status: 'unavailable' };
  }

  const categoryChange = insights.changes.find(
    (change) =>
      change.changeKey === CATEGORY_SHARE_UP_KEY ||
      change.changeKey === CATEGORY_SHARE_DOWN_KEY
  );
  if (!categoryChange) {
    return { status: 'unavailable' };
  }

  const category = String(categoryChange.changeParams?.cat ?? '').trim();
  const fromPercent = Number(categoryChange.changeParams?.from);
  const toPercent = Number(categoryChange.changeParams?.to);
  const percentagePointChange = Number(categoryChange.changeParams?.change);
  const direction =
    categoryChange.changeKey === CATEGORY_SHARE_UP_KEY ? 'up' : 'down';
  const signedEndpointDelta = toPercent - fromPercent;

  if (
    !category ||
    !Number.isFinite(fromPercent) ||
    !Number.isFinite(toPercent) ||
    !Number.isFinite(percentagePointChange) ||
    percentagePointChange <= 0 ||
    Math.abs(signedEndpointDelta) !== percentagePointChange ||
    (direction === 'up' && signedEndpointDelta <= 0) ||
    (direction === 'down' && signedEndpointDelta >= 0)
  ) {
    return { status: 'unavailable' };
  }

  return {
    status: 'available',
    direction,
    category,
    fromPercent,
    toPercent,
    percentagePointChange,
  };
}

/**
 * Leading-merchant prominence change already produced by buildInsights.
 * Does not infer visit-frequency or price claims beyond emitted params.
 */
export function buildAnalysisMerchantChangeSurface(
  insights: BuildInsightsOutput | null
): AnalysisMerchantChangeSurface {
  if (!insights?.previousStats) {
    return { status: 'unavailable' };
  }

  const merchantChange = insights.changes.find(
    (change) => change.changeKey === MERCHANT_MORE_KEY
  );
  if (!merchantChange) {
    return { status: 'unavailable' };
  }

  const merchant = String(merchantChange.changeParams?.merchant ?? '').trim();
  if (!merchant) {
    return { status: 'unavailable' };
  }

  const kindParam = String(merchantChange.changeParams?.kind ?? '').trim();
  const currentShare = Number(merchantChange.changeParams?.currentShare);
  const previousShareRaw = merchantChange.changeParams?.previousShare;

  if (kindParam === 'share_increased') {
    const previousShare = Number(previousShareRaw);
    if (
      !Number.isFinite(currentShare) ||
      !Number.isFinite(previousShare) ||
      previousShareRaw == null
    ) {
      return { status: 'unavailable' };
    }
    return {
      status: 'available',
      kind: 'share_increased',
      merchantKey: merchant,
      displayName: merchant,
      previousShare,
      currentShare,
    };
  }

  if (kindParam === 'current_period_prominent') {
    if (!Number.isFinite(currentShare) || previousShareRaw != null) {
      return { status: 'unavailable' };
    }
    return {
      status: 'available',
      kind: 'current_period_prominent',
      merchantKey: merchant,
      displayName: merchant,
      currentShare,
    };
  }

  return { status: 'unavailable' };
}

/** True when at least one matched-period change surface is available. */
export function hasAvailableAnalysisChanges(options: {
  spendChange: AnalysisSpendChangeSurface;
  categoryChange: AnalysisCategoryChangeSurface;
  merchantChange: AnalysisMerchantChangeSurface;
}): boolean {
  return (
    options.spendChange.status === 'available' ||
    options.categoryChange.status === 'available' ||
    options.merchantChange.status === 'available'
  );
}

/** Period length label for the Changes section (from spend surface or insights). */
export function resolveAnalysisChangesPeriodDays(
  spendChange: AnalysisSpendChangeSurface,
  insights: BuildInsightsOutput | null
): number | null {
  if (spendChange.status === 'available' && spendChange.periodDays > 0) {
    return spendChange.periodDays;
  }
  const periodDays = insights?.periodDays ?? 0;
  return periodDays > 0 ? periodDays : null;
}
