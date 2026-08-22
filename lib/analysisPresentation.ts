/**
 * Analysis release presentation adapter.
 * Maps existing stats/insights into empty / period_empty / low / ready ViewModels.
 * Does not reimplement spend/category algorithms.
 */

import type { ReceiptRow } from './db';
import { isV1SupportedReceipt } from './merchantType';
import { V1_ACTIVE_PRODUCT_CATEGORIES } from './productCategory';
import { getReceiptItems } from './receiptItems';
import type { WeeklyMonthlyStats, TimeRange } from './statsCalculator';
import type { BuildInsightsOutput, StoryOutput } from './buildInsights';

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
  showLowDataHint: boolean;
  showSwitchToAll: boolean;
  showProSection: boolean;
  showLegacyPriceRadar: boolean;
  showLegacyCategoryIndex: boolean;
};

const ACTIVE_CATEGORY_SET = new Set<string>(V1_ACTIVE_PRODUCT_CATEGORIES);

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

function receiptTimestamp(receipt: ReceiptRow): number {
  return receipt.transaction_at || receipt.created_at || 0;
}

export function filterReceiptsByTimeRange(
  receipts: ReceiptRow[],
  range: TimeRange,
  now = Date.now()
): ReceiptRow[] {
  let cutoff = 0;
  if (range === 'week') cutoff = now - 7 * 24 * 60 * 60 * 1000;
  else if (range === 'month') cutoff = now - 30 * 24 * 60 * 60 * 1000;
  return receipts.filter((receipt) => receiptTimestamp(receipt) >= cutoff);
}

export function countSupportedItemsInRange(
  receipts: ReceiptRow[],
  range: TimeRange,
  now = Date.now()
): number {
  const supported = filterReceiptsByTimeRange(receipts, range, now).filter(
    isV1SupportedReceipt
  );
  let count = 0;
  for (const receipt of supported) {
    count += getReceiptItems(receipt).length;
  }
  return count;
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

export function buildAnalysisCategoryShares(
  stats: WeeklyMonthlyStats
): AnalysisCategoryShare[] {
  const compositionTotal =
    stats.categoryCompositionTotal > 0
      ? stats.categoryCompositionTotal
      : stats.topCategories.reduce((sum, row) => sum + row.amount, 0);
  return stats.topCategories
    .filter((row) => ACTIVE_CATEGORY_SET.has(row.category) || row.category === 'other')
    .map((row) => {
      const pct = categoryCompositionPercent(row.amount, compositionTotal);
      return {
        category: row.category,
        amount: row.amount,
        share: pct == null ? 0 : pct / 100,
      };
    });
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
