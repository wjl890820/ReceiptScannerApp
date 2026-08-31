/**
 * Analysis release presentation adapter.
 * Maps existing stats/insights into empty / period_empty / low / ready ViewModels.
 * Does not reimplement spend/category algorithms.
 */

import type { ReceiptRow } from './db';
import { filterAnalysisReceiptsByTimeRange } from './analysisPeriod';
import {
  countSupportedItemsInEligibleReceipts,
  selectAnalysisPeriodReceiptSets,
} from './analysisEligibility';
import { V1_SPENDING_PRODUCT_CATEGORIES } from './productCategory';
import type { WeeklyMonthlyStats, TimeRange } from './statsCalculator';
import type { BuildInsightsOutput, StoryOutput } from './buildInsights';
import {
  buildAnalysisMerchantSurface,
  buildAnalysisSpendChangeSurface,
  type AnalysisMerchantRow,
  type AnalysisSpendChangeSurface,
} from './analysisValueSurfaces';

export type AnalysisReleaseStage = 'empty' | 'period_empty' | 'low' | 'ready';

export type AnalysisOverviewMetrics = {
  supportedSpend: number;
  supportedReceiptCount: number;
  averageSpendPerReceipt: number;
  itemCount: number;
  /** True when there is at least one supported receipt (even if spend is 0). */
  hasReceipts: boolean;
};

export type AnalysisCategoryShare = {
  category: string;
  amount: number;
  share: number;
};

/** Spending-only conservation check for Analysis category composition. */
export type AnalysisCategoryConservation = {
  categoryCompositionTotal: number;
  activeSpendingCategoryAmountSum: number;
  /** Uncategorized review bucket — not part of spending composition. */
  unresolvedOrSystemAmount: number;
  gap: number;
  conserved: boolean;
};

export type AnalysisInsightPresentation = {
  kind: 'story' | 'top_category' | 'low_data';
  titleKey: string;
  bodyKey: string;
  bodyParams?: Record<string, string | number>;
};

export type AnalysisReleaseViewModel = {
  stage: AnalysisReleaseStage;
  overview: AnalysisOverviewMetrics | null;
  categories: AnalysisCategoryShare[];
  uncategorized: { count: number; total: number } | null;
  insight: AnalysisInsightPresentation | null;
  /** Top merchants from periodStats.topMerchants (selected period only). */
  merchants: AnalysisMerchantRow[];
  /** Matched-period spend change from buildInsights.changes (or unavailable). */
  spendChange: AnalysisSpendChangeSurface;
  showLowDataHint: boolean;
  showSwitchToAll: boolean;
  showProSection: boolean;
  showLegacyPriceRadar: boolean;
  showLegacyCategoryIndex: boolean;
};

/** Spending categories only — uncategorized is a review bucket, not a bar segment. */
const ACTIVE_CATEGORY_SET = new Set<string>(V1_SPENDING_PRODUCT_CATEGORIES);

export function shouldShowAnalysisProSection(options: {
  comingSoon: boolean;
}): boolean {
  return !options.comingSoon;
}

export function shouldShowLegacyPriceRadar(options: {
  migratedToSafePriceHistory: boolean;
}): boolean {
  // Legacy Price Radar remains gated off until Safe Price History migration is complete.
  return Boolean(options.migratedToSafePriceHistory);
}

export function resolveAnalysisReleaseStage(options: {
  periodSupportedCount: number;
  allSupportedCount: number;
}): AnalysisReleaseStage {
  const { periodSupportedCount, allSupportedCount } = options;
  if (periodSupportedCount <= 0) {
    return allSupportedCount > 0 ? 'period_empty' : 'empty';
  }
  if (periodSupportedCount < 3) return 'low';
  return 'ready';
}

export function filterReceiptsByTimeRange(
  receipts: ReceiptRow[],
  range: TimeRange,
  nowMs: number = Date.now()
): ReceiptRow[] {
  return filterAnalysisReceiptsByTimeRange(receipts, range, nowMs);
}

export function countSupportedItemsInRange(
  receipts: ReceiptRow[],
  range: TimeRange,
  nowMs: number = Date.now()
): number {
  const periodSets = selectAnalysisPeriodReceiptSets(
    receipts,
    range,
    nowMs
  );
  return countSupportedItemsInEligibleReceipts(periodSets.currentPeriodReceipts);
}

export function buildAnalysisOverview(
  stats: WeeklyMonthlyStats,
  itemCount: number
): AnalysisOverviewMetrics | null {
  if (stats.supportedReceiptCount <= 0) return null;
  return {
    supportedSpend: stats.supportedSpend,
    supportedReceiptCount: stats.supportedReceiptCount,
    averageSpendPerReceipt:
      stats.supportedReceiptCount > 0
        ? stats.supportedSpend / stats.supportedReceiptCount
        : 0,
    itemCount,
    hasReceipts: true,
  };
}

/**
 * Shared category-composition percentage (integer 0–100).
 * Uses the full eligible category universe as denominator — not receipt.total,
 * and not the truncated top-N display list alone.
 */
export function categoryCompositionPercent(
  amount: number,
  compositionTotal: number
): number | null {
  if (!(compositionTotal > 0) || !Number.isFinite(compositionTotal)) return null;
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round((100 * amount) / compositionTotal);
}

/**
 * Resolve the full eligible category breakdown for Analysis UI / diagnostics.
 * Prefers `categoryBreakdown`; falls back to `topCategories` for older fixtures.
 */
export function resolveAnalysisCategoryBreakdown(
  stats: WeeklyMonthlyStats
): Array<{ category: string; amount: number }> {
  if (
    Array.isArray(stats.categoryBreakdown) &&
    stats.categoryBreakdown.length > 0
  ) {
    return stats.categoryBreakdown;
  }
  return stats.topCategories;
}

/**
 * Category bars: all V1 spending categories with amount > 0 from the full
 * breakdown (not top-3), sorted by amount descending. Denominator remains
 * `categoryCompositionTotal` (authoritative — never redefined as visible sum).
 */
export function buildAnalysisCategoryShares(
  stats: WeeklyMonthlyStats
): AnalysisCategoryShare[] {
  const breakdown = resolveAnalysisCategoryBreakdown(stats);
  const compositionTotal =
    stats.categoryCompositionTotal > 0
      ? stats.categoryCompositionTotal
      : breakdown.reduce((sum, row) => sum + row.amount, 0);
  return breakdown
    .filter(
      (row) =>
        row.amount > 0 &&
        (ACTIVE_CATEGORY_SET.has(row.category) || row.category === 'other')
    )
    .sort((a, b) => b.amount - a.amount)
    .map((row) => {
      const pct = categoryCompositionPercent(row.amount, compositionTotal);
      return {
        category: row.category,
        amount: row.amount,
        share: pct == null ? 0 : pct / 100,
      };
    });
}

/**
 * Full 7-bucket spending amounts for diagnostics / conservation.
 * Includes zero-amount V1 spending categories so windows always enumerate
 * the taxonomy; sum of amounts must equal categoryCompositionTotal when
 * breakdown only contains V1 spending categories.
 */
export function buildAnalysisCategoryBucketAmounts(
  stats: WeeklyMonthlyStats
): Array<{ category: string; amount: number }> {
  const breakdown = resolveAnalysisCategoryBreakdown(stats);
  const amountByCategory = new Map<string, number>();
  for (const row of breakdown) {
    if (!ACTIVE_CATEGORY_SET.has(row.category) && row.category !== 'other') {
      continue;
    }
    amountByCategory.set(
      row.category,
      (amountByCategory.get(row.category) ?? 0) + row.amount
    );
  }
  return V1_SPENDING_PRODUCT_CATEGORIES.map((category) => ({
    category,
    amount: amountByCategory.get(category) ?? 0,
  }));
}

export function buildAnalysisCategoryConservation(
  stats: WeeklyMonthlyStats
): AnalysisCategoryConservation {
  const buckets = buildAnalysisCategoryBucketAmounts(stats);
  const activeSpendingCategoryAmountSum = buckets.reduce(
    (sum, row) => sum + row.amount,
    0
  );
  const categoryCompositionTotal = stats.categoryCompositionTotal;
  const gap = categoryCompositionTotal - activeSpendingCategoryAmountSum;
  return {
    categoryCompositionTotal,
    activeSpendingCategoryAmountSum,
    unresolvedOrSystemAmount: stats.uncategorizedTotal,
    gap,
    conserved: gap === 0,
  };
}

export function buildAnalysisInsightPresentation(
  stage: AnalysisReleaseStage,
  stats: WeeklyMonthlyStats,
  story: StoryOutput | null
): AnalysisInsightPresentation | null {
  if (stage === 'empty' || stage === 'period_empty' || stage === 'low') {
    return null;
  }

  const compositionTotal =
    stats.categoryCompositionTotal > 0
      ? stats.categoryCompositionTotal
      : stats.topCategories.reduce((sum, row) => sum + row.amount, 0);

  if (story?.type === 'full') {
    const storyPct = Number(story.conclusionParams.pct ?? NaN);
    const cat = String(story.conclusionParams.cat ?? '');
    const topMatch = stats.topCategories.find((row) => row.category === cat);
    const pct =
      topMatch != null
        ? categoryCompositionPercent(topMatch.amount, compositionTotal)
        : Number.isFinite(storyPct)
          ? Math.round(storyPct)
          : null;
    if (pct == null) return null;
    return {
      kind: 'story',
      titleKey: 'analysis.release.insightTitle',
      bodyKey: 'analysis.release.topCategoryInsight',
      bodyParams: {
        category: cat,
        pct,
      },
    };
  }

  const top = stats.topCategories[0];
  const pct =
    top != null ? categoryCompositionPercent(top.amount, compositionTotal) : null;
  if (top && pct != null) {
    return {
      kind: 'top_category',
      titleKey: 'analysis.release.insightTitle',
      bodyKey: 'analysis.release.topCategoryInsight',
      bodyParams: {
        category: top.category,
        pct,
      },
    };
  }

  return null;
}

export function buildAnalysisReleaseViewModel(input: {
  periodStats: WeeklyMonthlyStats;
  allSupportedCount: number;
  itemCount: number;
  insights: BuildInsightsOutput | null;
  /** Release freeze: coming-soon Pro stays hidden. */
  proComingSoon?: boolean;
  /** Release freeze: legacy Price Radar stays hidden until Safe History migration. */
  priceRadarMigrated?: boolean;
}): AnalysisReleaseViewModel {
  const stage = resolveAnalysisReleaseStage({
    periodSupportedCount: input.periodStats.supportedReceiptCount,
    allSupportedCount: input.allSupportedCount,
  });
  const overview = buildAnalysisOverview(input.periodStats, input.itemCount);
  const categories = buildAnalysisCategoryShares(input.periodStats);
  const story = input.insights?.story ?? null;

  const merchants =
    stage === 'low' || stage === 'ready'
      ? buildAnalysisMerchantSurface(input.periodStats, 3)
      : [];
  const spendChange =
    stage === 'low' || stage === 'ready'
      ? buildAnalysisSpendChangeSurface(input.insights)
      : { status: 'unavailable' as const };

  return {
    stage,
    overview,
    categories,
    uncategorized:
      input.periodStats.uncategorizedCount > 0
        ? {
            count: input.periodStats.uncategorizedCount,
            total: input.periodStats.uncategorizedTotal,
          }
        : null,
    insight: buildAnalysisInsightPresentation(stage, input.periodStats, story),
    merchants,
    spendChange,
    showLowDataHint: stage === 'low',
    showSwitchToAll: stage === 'period_empty',
    showProSection: shouldShowAnalysisProSection({
      comingSoon: input.proComingSoon ?? true,
    }),
    showLegacyPriceRadar: shouldShowLegacyPriceRadar({
      migratedToSafePriceHistory: input.priceRadarMigrated ?? false,
    }),
    showLegacyCategoryIndex: shouldShowLegacyPriceRadar({
      migratedToSafePriceHistory: input.priceRadarMigrated ?? false,
    }),
  };
}

/** Tokens / AI voice phrases banned from Analysis release copy. */
export const ANALYSIS_RELEASE_FORBIDDEN_PHRASES = [
  '我先',
  '我认为',
  '结论仅供参考',
  'I think',
  'for reference only',
] as const;
