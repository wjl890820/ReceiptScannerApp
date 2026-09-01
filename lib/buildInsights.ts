/**
 * Analysis v2: structured insights (story, changes, tips, confidence).
 * Pure functions; no i18n. Output uses i18n keys + params for UI to render.
 *
 * Period + eligibility truth is sourced from lib/analysisEligibility.ts so
 * Overview (calculateStats) and Insights share one supported JPY universe.
 */

import type { ReceiptRow } from './db';
import {
  analysisDaysCovered,
  countSupportedItemsInEligibleReceipts,
  isAnalysisStorySufficient,
  selectAnalysisPeriodReceiptSets,
} from './analysisEligibility';
import { calculateStats, type WeeklyMonthlyStats } from './statsCalculator';

const MIN_RECEIPTS = 3;

export type TimeRange = 'week' | 'month' | 'all';

export type BuildInsightsOptions = {
  nowMs?: number;
};

export type StoryOutput =
  | { type: 'full'; conclusionKey: string; conclusionParams: Record<string, string | number>; explanationKey: string }
  | { type: 'fallback'; fallbackKey: string };

export type ChangeOutput = {
  changeKey: string;
  changeParams?: Record<string, string | number>;
};

export type TipOutput = {
  tipKey: string;
  tipParams?: Record<string, string | number>;
};

export type ConfidenceLevel = 'low' | 'med' | 'high';

export type ProTeaserItem = { proTeaserKey: string };

export type BuildInsightsOutput = {
  story: StoryOutput;
  changes: ChangeOutput[];
  tips: TipOutput[];
  confidence: ConfidenceLevel;
  confidenceKey: string;
  proTeaser: ProTeaserItem[];
  /** Current period stats (for UI) */
  currentStats: WeeklyMonthlyStats;
  /** Previous period stats (for UI) */
  previousStats: WeeklyMonthlyStats | null;
  /** Current period supported receipt count (release universe). */
  currentReceiptsCount: number;
  /** Current period supported item row count. */
  currentItemsCount: number;
  /** Days covered in current period (transaction_at only). */
  currentDaysCovered: number;
  /** Period length in days used by the selected comparison contract. */
  periodDays: number;
};

/**
 * Build Analysis v2 insights from duplicate-safe analytics receipts and time range.
 * Reuses calculateStats on shared period receipt sets from analysisEligibility.
 */
export function buildInsights(
  analyticsReceipts: ReceiptRow[],
  timeRange: TimeRange,
  options?: BuildInsightsOptions
): BuildInsightsOutput {
  const nowMs = options?.nowMs ?? Date.now();
  const periodSets = selectAnalysisPeriodReceiptSets(
    analyticsReceipts,
    timeRange,
    nowMs
  );

  const currentStats = calculateStats(
    periodSets.currentPeriodReceipts,
    'all',
    nowMs
  );
  const previousStats =
    periodSets.previousPeriodComparable &&
    periodSets.previousPeriodReceipts.length > 0
      ? calculateStats(periodSets.previousPeriodReceipts, 'all', nowMs)
      : null;

  const currentItemsCount = countSupportedItemsInEligibleReceipts(
    periodSets.currentPeriodReceipts
  );
  const currentDaysCovered = analysisDaysCovered(periodSets.currentPeriodReceipts);
  const supportedReceiptCount = currentStats.supportedReceiptCount;

  const sufficient = isAnalysisStorySufficient({
    supportedReceiptCount,
    supportedItemCount: currentItemsCount,
    supportedSpend: currentStats.supportedSpend,
  });

  const story: StoryOutput = sufficient
    ? buildStory(currentStats)
    : { type: 'fallback', fallbackKey: 'analysisV2.story.fallback' };
  const changes = buildChanges(
    currentStats,
    previousStats,
    periodSets.periodDays,
    periodSets.previousPeriodComparable
  );
  const tips = buildTips(currentStats);
  const { confidence, confidenceKey } = buildConfidence(
    supportedReceiptCount,
    currentItemsCount,
    currentDaysCovered
  );
  const proTeaser: ProTeaserItem[] = [
    { proTeaserKey: 'analysisV2.pro.teaser1' },
    { proTeaserKey: 'analysisV2.pro.teaser2' },
    { proTeaserKey: 'analysisV2.pro.teaser3' },
  ];

  return {
    story,
    changes,
    tips,
    confidence,
    confidenceKey,
    proTeaser,
    currentStats,
    previousStats,
    currentReceiptsCount: supportedReceiptCount,
    currentItemsCount,
    currentDaysCovered,
    periodDays: periodSets.periodDays,
  };
}

function buildStory(stats: WeeklyMonthlyStats): StoryOutput {
  const top = stats.topCategories[0];
  const compositionTotal =
    stats.categoryCompositionTotal > 0
      ? stats.categoryCompositionTotal
      : stats.topCategories.reduce((sum, row) => sum + row.amount, 0);
  if (!top || !(compositionTotal > 0)) {
    return { type: 'fallback', fallbackKey: 'analysisV2.story.fallback' };
  }
  const pct = Math.round((100 * top.amount) / compositionTotal);
  const conclusionKey = 'analysisV2.story.conclusion';
  const conclusionParams = { cat: top.category, pct, amt: Math.round(top.amount) };
  const explanationKey = pickExplanationKey(top.category);
  return { type: 'full', conclusionKey, conclusionParams, explanationKey };
}

function pickExplanationKey(category: string): string {
  switch (category) {
    case 'ready_to_eat':
      return 'analysisV2.story.explainQuickMeals';
    case 'snacks_drinks':
      return 'analysisV2.story.explainSnacks';
    case 'food_ingredients':
    case 'household':
    case 'other':
      return 'analysisV2.story.explainDefault';
    default:
      return 'analysisV2.story.explainDefault';
  }
}

function buildChanges(
  current: WeeklyMonthlyStats,
  previous: WeeklyMonthlyStats | null,
  periodDays: number,
  previousPeriodComparable: boolean
): ChangeOutput[] {
  const out: ChangeOutput[] = [];
  if (!previous || !previousPeriodComparable) return out;
  if (
    current.supportedReceiptCount < MIN_RECEIPTS ||
    previous.supportedReceiptCount < MIN_RECEIPTS
  ) {
    return out;
  }

  const spendDiff = current.supportedSpend - previous.supportedSpend;
  const spendKey = spendDiff >= 0 ? 'analysisV2.changes.spendUp' : 'analysisV2.changes.spendDown';
  out.push({
    changeKey: spendKey,
    changeParams: { delta: Math.abs(Math.round(spendDiff)), periodDays },
  });

  const topNow = current.topCategories[0];
  const topPrev = previous.topCategories[0];
  const compositionNow =
    current.categoryCompositionTotal > 0
      ? current.categoryCompositionTotal
      : current.topCategories.reduce((sum, row) => sum + row.amount, 0);
  const compositionPrev =
    previous.categoryCompositionTotal > 0
      ? previous.categoryCompositionTotal
      : previous.topCategories.reduce((sum, row) => sum + row.amount, 0);
  if (topNow && topPrev && compositionNow > 0 && compositionPrev > 0) {
    const pctNow = (100 * topNow.amount) / compositionNow;
    const pctPrev = (100 * topPrev.amount) / compositionPrev;
    const sameCat = topNow.category === topPrev.category;
    if (sameCat) {
      const diff = pctNow - pctPrev;
      if (Math.abs(diff) >= 1) {
        const key = diff >= 0 ? 'analysisV2.changes.categoryShareUp' : 'analysisV2.changes.categoryShareDown';
        const displayFrom = Math.round(pctPrev);
        const displayTo = Math.round(pctNow);
        const displayPointChange = Math.abs(displayTo - displayFrom);
        out.push({
          changeKey: key,
          changeParams: {
            cat: topNow.category,
            change: displayPointChange,
            from: displayFrom,
            to: displayTo,
          },
        });
      }
    }
  }

  const topMNow = current.topMerchants[0];
  const topMPrev = previous.topMerchants[0];
  if (topMNow && topMPrev && current.supportedSpend > 0 && previous.supportedSpend > 0) {
    const shareNow = (100 * topMNow.total) / current.supportedSpend;
    const sharePrev = (100 * topMPrev.total) / previous.supportedSpend;
    const sameMerchant = topMNow.merchant === topMPrev.merchant;
    if (sameMerchant && shareNow >= 20 && shareNow - sharePrev >= 5) {
      out.push({
        changeKey: 'analysisV2.changes.merchantMore',
        changeParams: {
          merchant: topMNow.merchant,
          kind: 'share_increased',
          currentShare: Math.round(shareNow),
          previousShare: Math.round(sharePrev),
        },
      });
    } else if (!sameMerchant && shareNow >= 15) {
      out.push({
        changeKey: 'analysisV2.changes.merchantMore',
        changeParams: {
          merchant: topMNow.merchant,
          kind: 'current_period_prominent',
          currentShare: Math.round(shareNow),
        },
      });
    }
  }

  return out.slice(0, 3);
}

function buildTips(stats: WeeklyMonthlyStats): TipOutput[] {
  const tips: TipOutput[] = [];
  const compositionTotal =
    stats.categoryCompositionTotal > 0
      ? stats.categoryCompositionTotal
      : stats.topCategories.reduce((sum, row) => sum + row.amount, 0);
  if (!(compositionTotal > 0) || stats.supportedReceiptCount < MIN_RECEIPTS) return tips;

  const byCat = new Map<string, number>();
  for (const c of stats.topCategories) byCat.set(c.category, c.amount);
  const pct = (cat: string) => (100 * (byCat.get(cat) ?? 0)) / compositionTotal;

  const readyPct = pct('ready_to_eat');
  const snacksDrinksPct = pct('snacks_drinks');

  if (readyPct + snacksDrinksPct >= 25 && tips.length < 2) {
    tips.push({ tipKey: 'analysisV2.tips.saveQuick' });
  }
  if (snacksDrinksPct >= 20 && tips.length < 2) {
    tips.push({ tipKey: 'analysisV2.tips.healthSnacksDrinks' });
  }
  if (readyPct >= 20 && tips.length < 2) {
    tips.push({ tipKey: 'analysisV2.tips.timeQuick' });
  }

  return tips.slice(0, 2);
}

function buildConfidence(
  supportedReceiptsCount: number,
  itemsCount: number,
  daysCovered: number
): { confidence: ConfidenceLevel; confidenceKey: string } {
  const score =
    supportedReceiptsCount +
    Math.min(itemsCount / 10, 10) +
    Math.min(daysCovered / 7, 4);
  if (score < 8) return { confidence: 'low', confidenceKey: 'analysisV2.confidence.low' };
  if (score < 15) return { confidence: 'med', confidenceKey: 'analysisV2.confidence.med' };
  return { confidence: 'high', confidenceKey: 'analysisV2.confidence.high' };
}
