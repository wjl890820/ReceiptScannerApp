import * as fs from 'fs';
import * as path from 'path';

import { createEmptyStats } from './analysisHelpers';
import { buildAnalysisReleaseViewModel } from './analysisPresentation';
import type { BuildInsightsOutput } from './buildInsights';
import type { WeeklyMonthlyStats } from './statsCalculator';
import {
  buildAnalysisMerchantSurface,
  buildAnalysisSpendChangeSurface,
} from './analysisValueSurfaces';

function statsWithMerchants(
  merchants: Array<{ merchant: string; count: number; total: number }>
): WeeklyMonthlyStats {
  return {
    ...createEmptyStats(),
    supportedSpend: merchants.reduce((sum, row) => sum + row.total, 0),
    supportedReceiptCount: merchants.reduce((sum, row) => sum + row.count, 0),
    topMerchants: merchants,
  };
}

function insightsWithSpendChange(options: {
  direction: 'up' | 'down';
  delta: number;
  periodDays: number;
  currentSpend: number;
  previousSpend: number;
  includeSpendChange?: boolean;
}): BuildInsightsOutput {
  const currentStats = {
    ...createEmptyStats(),
    totalSpend: options.currentSpend,
    supportedSpend: options.currentSpend,
    supportedReceiptCount: 5,
  };
  const previousStats = {
    ...createEmptyStats(),
    totalSpend: options.previousSpend,
    supportedSpend: options.previousSpend,
    supportedReceiptCount: 5,
  };
  const changeKey =
    options.direction === 'up'
      ? 'analysisV2.changes.spendUp'
      : 'analysisV2.changes.spendDown';
  return {
    story: { type: 'fallback', fallbackKey: 'analysisV2.story.fallback' },
    changes:
      options.includeSpendChange === false
        ? []
        : [
            {
              changeKey,
              changeParams: {
                delta: options.delta,
                periodDays: options.periodDays,
              },
            },
          ],
    tips: [],
    confidence: 'med',
    confidenceKey: 'analysisV2.confidence.med',
    proTeaser: [],
    currentStats,
    previousStats,
    currentReceiptsCount: 5,
    currentItemsCount: 20,
    currentDaysCovered: options.periodDays,
    periodDays: options.periodDays,
  };
}

describe('analysisValueSurfaces merchants', () => {
  it('preserves production topMerchants values and order (top 3)', () => {
    const stats = statsWithMerchants([
      { merchant: 'aeon', count: 5, total: 12000 },
      { merchant: 'seven', count: 4, total: 8000 },
      { merchant: 'family', count: 3, total: 5000 },
      { merchant: 'ignored', count: 2, total: 1000 },
    ]);
    expect(buildAnalysisMerchantSurface(stats, 3)).toEqual([
      {
        merchantKey: 'aeon',
        displayName: 'aeon',
        visitCount: 5,
        spend: 12000,
      },
      {
        merchantKey: 'seven',
        displayName: 'seven',
        visitCount: 4,
        spend: 8000,
      },
      {
        merchantKey: 'family',
        displayName: 'family',
        visitCount: 3,
        spend: 5000,
      },
    ]);
  });

  it('returns empty when period has no merchant rows', () => {
    expect(buildAnalysisMerchantSurface(createEmptyStats())).toEqual([]);
  });

  it('does not import retailer identity modules', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'analysisValueSurfaces.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /from '\.\/retailerIdentity'|from '\.\/retailerProfile'/
    );
  });
});

describe('analysisValueSurfaces spend change', () => {
  it('preserves existing spend-change direction and absolute delta', () => {
    expect(
      buildAnalysisSpendChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 1500,
          periodDays: 30,
          currentSpend: 10000,
          previousSpend: 8500,
        })
      )
    ).toEqual({
      status: 'available',
      direction: 'up',
      absoluteDelta: 1500,
      percentDelta: 18,
      periodDays: 30,
      currentSpend: 10000,
      previousSpend: 8500,
    });
  });

  it('marks unavailable when insights suppress matched comparison', () => {
    expect(buildAnalysisSpendChangeSurface(null)).toEqual({
      status: 'unavailable',
    });
    expect(
      buildAnalysisSpendChangeSurface(
        insightsWithSpendChange({
          direction: 'down',
          delta: 100,
          periodDays: 7,
          currentSpend: 1000,
          previousSpend: 1100,
          includeSpendChange: false,
        })
      )
    ).toEqual({ status: 'unavailable' });
  });

  it('does not invent ALL comparison when previousStats is null', () => {
    const insights = insightsWithSpendChange({
      direction: 'up',
      delta: 100,
      periodDays: 0,
      currentSpend: 5000,
      previousSpend: 0,
    });
    insights.previousStats = null;
    insights.changes = [];
    expect(buildAnalysisSpendChangeSurface(insights)).toEqual({
      status: 'unavailable',
    });
  });
});

describe('analysis release view model surfaces', () => {
  it('uses the same selected-period topMerchants on the release view model', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: statsWithMerchants([
        { merchant: 'lawson', count: 2, total: 3000 },
      ]),
      allSupportedCount: 5,
      itemCount: 8,
      insights: null,
    });
    expect(vm.stage).toBe('low');
    expect(vm.merchants).toEqual([
      {
        merchantKey: 'lawson',
        displayName: 'lawson',
        visitCount: 2,
        spend: 3000,
      },
    ]);
    expect(vm.spendChange.status).toBe('unavailable');
  });

  it('keeps empty stages free of invented merchant/change rows', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: createEmptyStats(),
      allSupportedCount: 0,
      itemCount: 0,
      insights: null,
    });
    expect(vm.stage).toBe('empty');
    expect(vm.merchants).toEqual([]);
    expect(vm.spendChange).toEqual({ status: 'unavailable' });
  });
});
