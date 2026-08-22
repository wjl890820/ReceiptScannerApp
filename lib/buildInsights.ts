/**
 * Analysis v2: structured insights (story, changes, tips, confidence).
 * Pure functions; no i18n. Output uses i18n keys + params for UI to render.
 */

import type { ReceiptRow } from './db';
import { getReceiptItems } from './receiptItems';
import { calculateStats, type WeeklyMonthlyStats } from './statsCalculator';

const MS_DAY = 24 * 60 * 60 * 1000;
const MIN_RECEIPTS = 3;
const MIN_ITEMS = 10;
const MIN_TOTAL_JPY = 2000;
const PERIOD_30_DAYS = 30 * MS_DAY;
const PERIOD_14_DAYS = 14 * MS_DAY;
const PERIOD_7_DAYS = 7 * MS_DAY;

function ts(r: ReceiptRow): number {
  return r.transaction_at ?? r.created_at;
}

function filterByRange(receipts: ReceiptRow[], startMs: number, endMs: number): ReceiptRow[] {
  return receipts.filter((r) => {
    const t = ts(r);
    return t >= startMs && t < endMs;
  });
}

function countItems(receipts: ReceiptRow[]): number {
  let n = 0;
  for (const r of receipts) {
    n += getReceiptItems(r).length;
  }
  return n;
}

function daysCovered(receipts: ReceiptRow[]): number {
  if (receipts.length === 0) return 0;
  const times = receipts.map(ts);
  const min = Math.min(...times);
  const max = Math.max(...times);
  return Math.max(0, Math.ceil((max - min) / MS_DAY));
}

export type TimeRange = 'week' | 'month' | 'all';

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
  /** Current period receipts count */
  currentReceiptsCount: number;
  /** Current period items count */
  currentItemsCount: number;
  /** Days covered in current period */
  currentDaysCovered: number;
  /** Period length in days (30 or 14 or 7) */
  periodDays: number;
};

/**
 * Build Analysis v2 insights from receipts and time range.
 * Reuses calculateStats; computes current vs previous period.
 */
export function buildInsights(
  receipts: ReceiptRow[],
  timeRange: TimeRange
): BuildInsightsOutput {
  const now = Date.now();
  let periodDays = timeRange === 'week' ? 7 : 30;
  let currentStart = now - periodDays * MS_DAY;
  let currentEnd = now;
  let previousStart = currentStart - periodDays * MS_DAY;
  let previousEnd = currentStart;

  let currentReceipts = filterByRange(receipts, currentStart, currentEnd);
  let previousReceipts = filterByRange(receipts, previousStart, previousEnd);

  if (timeRange === 'all') {
    // Keep insight universe aligned with Analysis "all" overview (no silent 30d shrink).
    // Period-over-period changes use a matched trailing window of equal length when possible.
    currentReceipts = [...receipts].sort((a, b) => ts(a) - ts(b));
    previousReceipts = [];
    if (currentReceipts.length >= 2) {
      const spanMs = Math.max(0, ts(currentReceipts[currentReceipts.length - 1]) - ts(currentReceipts[0]));
      periodDays = Math.max(1, Math.ceil(spanMs / MS_DAY) || 1);
      // Matched prior window immediately before first receipt — only if we have prior data.
      previousEnd = ts(currentReceipts[0]);
      previousStart = previousEnd - spanMs;
      previousReceipts = filterByRange(receipts, previousStart, previousEnd);
      // If no matched prior data, suppress period comparison (avoid partial vs full mismatch).
      if (previousReceipts.length === 0) {
        previousReceipts = [];
      }
    } else {
      periodDays = 0;
    }
    currentStart = currentReceipts.length ? ts(currentReceipts[0]) : now;
    currentEnd = now;
  } else if (periodDays === 30 && currentReceipts.length < MIN_RECEIPTS) {
    periodDays = 14;
    currentStart = now - PERIOD_14_DAYS;
    currentEnd = now;
    previousStart = currentStart - PERIOD_14_DAYS;
    previousEnd = currentStart;
    currentReceipts = filterByRange(receipts, currentStart, currentEnd);
    previousReceipts = filterByRange(receipts, previousStart, previousEnd);
  }

  const currentStats = calculateStats(currentReceipts, 'all');
  const previousStats = previousReceipts.length > 0 ? calculateStats(previousReceipts, 'all') : null;
  const currentItemsCount = countItems(currentReceipts);
  const currentDaysCovered = daysCovered(currentReceipts);

  const sufficient =
    currentReceipts.length >= MIN_RECEIPTS &&
    currentItemsCount >= MIN_ITEMS &&
    currentStats.totalSpend >= MIN_TOTAL_JPY;

  const story: StoryOutput = sufficient ? buildStory(currentStats) : { type: 'fallback', fallbackKey: 'analysisV2.story.fallback' };
  const changes = buildChanges(currentStats, previousStats, periodDays);
  const tips = buildTips(currentStats);
  const { confidence, confidenceKey } = buildConfidence(
    currentReceipts.length,
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
    currentReceiptsCount: currentReceipts.length,
    currentItemsCount,
    currentDaysCovered,
    periodDays,
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
  periodDays: number
): ChangeOutput[] {
  const out: ChangeOutput[] = [];
  if (!previous) return out;
  // Both windows need enough V1 receipts before claiming a trend.
  if (
    current.supportedReceiptCount < MIN_RECEIPTS ||
    previous.supportedReceiptCount < MIN_RECEIPTS
  ) {
    return out;
  }

  const spendDiff = current.totalSpend - previous.totalSpend;
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
        out.push({
          changeKey: key,
          changeParams: {
            cat: topNow.category,
            change: Math.abs(Math.round(diff)),
            from: Math.round(pctPrev),
            to: Math.round(pctNow),
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
        changeParams: { merchant: topMNow.merchant },
      });
    } else if (!sameMerchant && shareNow >= 15) {
      out.push({
        changeKey: 'analysisV2.changes.merchantMore',
        changeParams: { merchant: topMNow.merchant },
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
  // Require meaningful composition + enough V1 receipts (same gate as story).
  if (!(compositionTotal > 0) || stats.supportedReceiptCount < 3) return tips;

  const byCat = new Map<string, number>();
  for (const c of stats.topCategories) byCat.set(c.category, c.amount);
  const pct = (cat: string) => (100 * (byCat.get(cat) ?? 0)) / compositionTotal;

  // V1 active keys only — legacy quick_meals / snacks_sweets never match.
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
  receiptsCount: number,
  itemsCount: number,
  daysCovered: number
): { confidence: ConfidenceLevel; confidenceKey: string } {
  const score = receiptsCount + Math.min(itemsCount / 10, 10) + Math.min(daysCovered / 7, 4);
  if (score < 8) return { confidence: 'low', confidenceKey: 'analysisV2.confidence.low' };
  if (score < 15) return { confidence: 'med', confidenceKey: 'analysisV2.confidence.med' };
  return { confidence: 'high', confidenceKey: 'analysisV2.confidence.high' };
}

