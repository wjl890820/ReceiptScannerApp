import * as fs from 'fs';
import * as path from 'path';

import { createEmptyStats } from './analysisHelpers';
import { buildInsights } from './buildInsights';
import { buildAnalysisReleaseViewModel } from './analysisPresentation';
import type { ReceiptRow } from './db';
import type { BuildInsightsOutput } from './buildInsights';
import type { WeeklyMonthlyStats } from './statsCalculator';
import {
  buildAnalysisCategoryChangeSurface,
  buildAnalysisMerchantChangeSurface,
  buildAnalysisMerchantSurface,
  buildAnalysisSpendChangeSurface,
  hasAvailableAnalysisChanges,
} from './analysisValueSurfaces';

const NOW = Date.parse('2026-08-31T12:00:00+09:00');
const MS_DAY = 24 * 60 * 60 * 1000;

function makeReceipt(
  id: string,
  merchant: string,
  total: number,
  transaction_at: number,
  category = 'food_ingredients'
): ReceiptRow {
  return {
    id,
    created_at: transaction_at,
    transaction_at,
    image_uri: '',
    total,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [{ name: `Item-${id}`, lineTotal: total, quantity: 1, category }],
    }),
    merchant_raw: merchant,
    merchant_normalized: merchant,
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

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
  currentBroadSpend?: number;
  previousBroadSpend?: number;
  includeSpendChange?: boolean;
  extraChanges?: BuildInsightsOutput['changes'];
}): BuildInsightsOutput {
  const currentStats = {
    ...createEmptyStats(),
    totalSpend: options.currentBroadSpend ?? options.currentSpend,
    supportedSpend: options.currentSpend,
    supportedReceiptCount: 5,
  };
  const previousStats = {
    ...createEmptyStats(),
    totalSpend: options.previousBroadSpend ?? options.previousSpend,
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
        ? options.extraChanges ?? []
        : [
            {
              changeKey,
              changeParams: {
                delta: options.delta,
                periodDays: options.periodDays,
              },
            },
            ...(options.extraChanges ?? []),
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

  it('presents supported spend even when broad candidate totals differ', () => {
    expect(
      buildAnalysisSpendChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 1250,
          periodDays: 30,
          currentSpend: 2250,
          previousSpend: 1000,
          currentBroadSpend: 3249,
          previousBroadSpend: 6000,
        })
      )
    ).toEqual({
      status: 'available',
      direction: 'up',
      absoluteDelta: 1250,
      percentDelta: 125,
      periodDays: 30,
      currentSpend: 2250,
      previousSpend: 1000,
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

describe('analysisValueSurfaces category change', () => {
  it('maps categoryShareUp to available / up with composition fields', () => {
    expect(
      buildAnalysisCategoryChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 500,
          periodDays: 30,
          currentSpend: 10000,
          previousSpend: 9500,
          extraChanges: [
            {
              changeKey: 'analysisV2.changes.categoryShareUp',
              changeParams: {
                cat: 'ready_to_eat',
                change: 7,
                from: 28,
                to: 35,
              },
            },
          ],
        })
      )
    ).toEqual({
      status: 'available',
      direction: 'up',
      category: 'ready_to_eat',
      fromPercent: 28,
      toPercent: 35,
      percentagePointChange: 7,
    });
  });

  it('maps categoryShareDown to available / down', () => {
    expect(
      buildAnalysisCategoryChangeSurface(
        insightsWithSpendChange({
          direction: 'down',
          delta: 1240,
          periodDays: 7,
          currentSpend: 5000,
          previousSpend: 6240,
          extraChanges: [
            {
              changeKey: 'analysisV2.changes.categoryShareDown',
              changeParams: {
                cat: 'food_ingredients',
                change: 7,
                from: 42,
                to: 35,
              },
            },
          ],
        })
      )
    ).toEqual({
      status: 'available',
      direction: 'down',
      category: 'food_ingredients',
      fromPercent: 42,
      toPercent: 35,
      percentagePointChange: 7,
    });
  });

  it('fails closed on malformed category params', () => {
    expect(
      buildAnalysisCategoryChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 100,
          periodDays: 30,
          currentSpend: 1000,
          previousSpend: 900,
          extraChanges: [
            {
              changeKey: 'analysisV2.changes.categoryShareUp',
              changeParams: { cat: 'ready_to_eat', change: 'x', from: 10, to: 20 },
            },
          ],
        })
      )
    ).toEqual({ status: 'unavailable' });
  });

  it('fails closed when category endpoints disagree with change magnitude', () => {
    expect(
      buildAnalysisCategoryChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 100,
          periodDays: 30,
          currentSpend: 1000,
          previousSpend: 900,
          extraChanges: [
            {
              changeKey: 'analysisV2.changes.categoryShareUp',
              changeParams: {
                cat: 'ready_to_eat',
                change: 1,
                from: 28,
                to: 30,
              },
            },
          ],
        })
      )
    ).toEqual({ status: 'unavailable' });
  });

  it('is unavailable when no category change is emitted', () => {
    expect(
      buildAnalysisCategoryChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 100,
          periodDays: 30,
          currentSpend: 1000,
          previousSpend: 900,
        })
      )
    ).toEqual({ status: 'unavailable' });
  });
});

describe('analysisValueSurfaces merchant change', () => {
  it('maps share_increased merchantMore with same-entity shares', () => {
    expect(
      buildAnalysisMerchantChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 500,
          periodDays: 30,
          currentSpend: 10000,
          previousSpend: 9500,
          extraChanges: [
            {
              changeKey: 'analysisV2.changes.merchantMore',
              changeParams: {
                merchant: 'Costco',
                kind: 'share_increased',
                currentShare: 32,
                previousShare: 24,
              },
            },
          ],
        })
      )
    ).toEqual({
      status: 'available',
      kind: 'share_increased',
      merchantKey: 'Costco',
      displayName: 'Costco',
      currentShare: 32,
      previousShare: 24,
    });
  });

  it('maps current_period_prominent merchantMore without previousShare', () => {
    expect(
      buildAnalysisMerchantChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 500,
          periodDays: 30,
          currentSpend: 10000,
          previousSpend: 9500,
          extraChanges: [
            {
              changeKey: 'analysisV2.changes.merchantMore',
              changeParams: {
                merchant: 'Aeon',
                kind: 'current_period_prominent',
                currentShare: 25,
              },
            },
          ],
        })
      )
    ).toEqual({
      status: 'available',
      kind: 'current_period_prominent',
      merchantKey: 'Aeon',
      displayName: 'Aeon',
      currentShare: 25,
    });
  });

  it('rejects previousShare on current_period_prominent branch', () => {
    expect(
      buildAnalysisMerchantChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 100,
          periodDays: 30,
          currentSpend: 1000,
          previousSpend: 900,
          extraChanges: [
            {
              changeKey: 'analysisV2.changes.merchantMore',
              changeParams: {
                merchant: 'Aeon',
                kind: 'current_period_prominent',
                currentShare: 25,
                previousShare: 40,
              },
            },
          ],
        })
      )
    ).toEqual({ status: 'unavailable' });
  });

  it('is unavailable when merchantMore is absent', () => {
    expect(
      buildAnalysisMerchantChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 100,
          periodDays: 30,
          currentSpend: 1000,
          previousSpend: 900,
        })
      )
    ).toEqual({ status: 'unavailable' });
  });

  it('fails closed on malformed merchant params', () => {
    expect(
      buildAnalysisMerchantChangeSurface(
        insightsWithSpendChange({
          direction: 'up',
          delta: 100,
          periodDays: 30,
          currentSpend: 1000,
          previousSpend: 900,
          extraChanges: [
            {
              changeKey: 'analysisV2.changes.merchantMore',
              changeParams: { merchant: '' },
            },
          ],
        })
      )
    ).toEqual({ status: 'unavailable' });
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
    expect(vm.categoryChange).toEqual({ status: 'unavailable' });
    expect(vm.merchantChange).toEqual({ status: 'unavailable' });
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
    expect(vm.categoryChange).toEqual({ status: 'unavailable' });
    expect(vm.merchantChange).toEqual({ status: 'unavailable' });
  });

  it('exposes spend, category, and merchant changes when ready and insights provide them', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 11098,
        supportedReceiptCount: 7,
        topCategories: [{ category: 'ready_to_eat', amount: 3000 }],
        topMerchants: [{ merchant: 'Costco', count: 2, total: 5000 }],
      },
      allSupportedCount: 10,
      itemCount: 16,
      insights: insightsWithSpendChange({
        direction: 'up',
        delta: 5598,
        periodDays: 30,
        currentSpend: 11098,
        previousSpend: 5500,
        extraChanges: [
          {
            changeKey: 'analysisV2.changes.categoryShareUp',
            changeParams: {
              cat: 'ready_to_eat',
              change: 7,
              from: 28,
              to: 35,
            },
          },
          {
            changeKey: 'analysisV2.changes.merchantMore',
            changeParams: {
              merchant: 'Costco',
              kind: 'share_increased',
              currentShare: 32,
              previousShare: 24,
            },
          },
        ],
      }),
    });
    expect(vm.stage).toBe('ready');
    expect(vm.spendChange.status).toBe('available');
    expect(vm.categoryChange).toMatchObject({
      status: 'available',
      category: 'ready_to_eat',
      percentagePointChange: 7,
    });
    expect(vm.merchantChange).toMatchObject({
      status: 'available',
      kind: 'share_increased',
      displayName: 'Costco',
    });
    expect(
      hasAvailableAnalysisChanges({
        spendChange: vm.spendChange,
        categoryChange: vm.categoryChange,
        merchantChange: vm.merchantChange,
      })
    ).toBe(true);
  });

  it('exposes only spend change when category and merchant are absent', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 12,
      insights: insightsWithSpendChange({
        direction: 'down',
        delta: 1240,
        periodDays: 7,
        currentSpend: 5000,
        previousSpend: 6240,
      }),
    });
    expect(vm.stage).toBe('ready');
    expect(vm.spendChange.status).toBe('available');
    expect(vm.categoryChange).toEqual({ status: 'unavailable' });
    expect(vm.merchantChange).toEqual({ status: 'unavailable' });
  });

  it('does not surface category or merchant changes on low stage', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 3000,
        supportedReceiptCount: 2,
        topMerchants: [{ merchant: 'lawson', count: 2, total: 3000 }],
      },
      allSupportedCount: 5,
      itemCount: 4,
      insights: insightsWithSpendChange({
        direction: 'up',
        delta: 500,
        periodDays: 30,
        currentSpend: 3000,
        previousSpend: 2500,
        extraChanges: [
          {
            changeKey: 'analysisV2.changes.categoryShareUp',
            changeParams: {
              cat: 'ready_to_eat',
              change: 5,
              from: 20,
              to: 25,
            },
          },
          {
            changeKey: 'analysisV2.changes.merchantMore',
            changeParams: { merchant: 'lawson', kind: 'current_period_prominent', currentShare: 30 },
          },
        ],
      }),
    });
    expect(vm.stage).toBe('low');
    expect(vm.spendChange).toEqual({ status: 'unavailable' });
    expect(vm.categoryChange).toEqual({ status: 'unavailable' });
    expect(vm.merchantChange).toEqual({ status: 'unavailable' });
  });

  it('keeps all change surfaces unavailable when comparison is suppressed', () => {
    const insights = insightsWithSpendChange({
      direction: 'up',
      delta: 100,
      periodDays: 30,
      currentSpend: 5000,
      previousSpend: 4900,
      includeSpendChange: false,
      extraChanges: [
        {
          changeKey: 'analysisV2.changes.categoryShareUp',
          changeParams: {
            cat: 'ready_to_eat',
            change: 5,
            from: 20,
            to: 25,
          },
        },
      ],
    });
    insights.previousStats = null;
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 12,
      insights,
    });
    expect(vm.spendChange).toEqual({ status: 'unavailable' });
    expect(vm.categoryChange).toEqual({ status: 'unavailable' });
    expect(vm.merchantChange).toEqual({ status: 'unavailable' });
  });

  it('fails closed for all-range when insights suppress prior comparison', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 8000,
        supportedReceiptCount: 6,
      },
      allSupportedCount: 6,
      itemCount: 20,
      insights: {
        ...insightsWithSpendChange({
          direction: 'up',
          delta: 100,
          periodDays: 0,
          currentSpend: 8000,
          previousSpend: 0,
          includeSpendChange: false,
        }),
        previousStats: null,
        changes: [],
        periodDays: 0,
      },
    });
    expect(vm.spendChange).toEqual({ status: 'unavailable' });
    expect(vm.categoryChange).toEqual({ status: 'unavailable' });
    expect(vm.merchantChange).toEqual({ status: 'unavailable' });
  });
});

describe('buildInsights change branches (real)', () => {
  function sameTopMerchantReceipts(): ReceiptRow[] {
    const previous = [
      makeReceipt('p-costco-1', 'costco', 625, NOW - 40 * MS_DAY),
      makeReceipt('p-costco-2', 'costco', 625, NOW - 41 * MS_DAY),
      makeReceipt('p-costco-3', 'costco', 625, NOW - 42 * MS_DAY),
      makeReceipt('p-costco-4', 'costco', 625, NOW - 43 * MS_DAY),
      makeReceipt('p-aeon-1', 'aeon', 1250, NOW - 40 * MS_DAY),
      makeReceipt('p-aeon-2', 'aeon', 1250, NOW - 41 * MS_DAY),
      makeReceipt('p-aeon-3', 'aeon', 1250, NOW - 42 * MS_DAY),
      makeReceipt('p-lawson-1', 'lawson', 1250, NOW - 40 * MS_DAY),
      makeReceipt('p-lawson-2', 'lawson', 1250, NOW - 41 * MS_DAY),
      makeReceipt('p-lawson-3', 'lawson', 1250, NOW - 42 * MS_DAY),
    ];
    const current = [
      makeReceipt('c-costco-1', 'costco', 800, NOW - 5 * MS_DAY),
      makeReceipt('c-costco-2', 'costco', 800, NOW - 6 * MS_DAY),
      makeReceipt('c-costco-3', 'costco', 800, NOW - 7 * MS_DAY),
      makeReceipt('c-costco-4', 'costco', 800, NOW - 8 * MS_DAY),
      makeReceipt('c-aeon-1', 'aeon', 1133, NOW - 5 * MS_DAY),
      makeReceipt('c-aeon-2', 'aeon', 1133, NOW - 6 * MS_DAY),
      makeReceipt('c-aeon-3', 'aeon', 1133, NOW - 7 * MS_DAY),
      makeReceipt('c-lawson-1', 'lawson', 1134, NOW - 5 * MS_DAY),
      makeReceipt('c-lawson-2', 'lawson', 1134, NOW - 6 * MS_DAY),
      makeReceipt('c-lawson-3', 'lawson', 1134, NOW - 7 * MS_DAY),
    ];
    return [...previous, ...current];
  }

  function differentTopMerchantReceipts(): ReceiptRow[] {
    const previous = [
      makeReceipt('p-costco-1', 'costco', 1000, NOW - 40 * MS_DAY),
      makeReceipt('p-costco-2', 'costco', 1000, NOW - 41 * MS_DAY),
      makeReceipt('p-costco-3', 'costco', 1000, NOW - 42 * MS_DAY),
      makeReceipt('p-costco-4', 'costco', 1000, NOW - 43 * MS_DAY),
      makeReceipt('p-aeon-1', 'aeon', 2000, NOW - 40 * MS_DAY),
      makeReceipt('p-aeon-2', 'aeon', 2000, NOW - 41 * MS_DAY),
      makeReceipt('p-aeon-3', 'aeon', 2000, NOW - 42 * MS_DAY),
    ];
    const current = [
      makeReceipt('c-aeon-1', 'aeon', 500, NOW - 5 * MS_DAY),
      makeReceipt('c-aeon-2', 'aeon', 500, NOW - 6 * MS_DAY),
      makeReceipt('c-aeon-3', 'aeon', 500, NOW - 7 * MS_DAY),
      makeReceipt('c-aeon-4', 'aeon', 500, NOW - 8 * MS_DAY),
      makeReceipt('c-aeon-5', 'aeon', 500, NOW - 9 * MS_DAY),
      makeReceipt('c-costco-1', 'costco', 1000, NOW - 5 * MS_DAY),
      makeReceipt('c-costco-2', 'costco', 1000, NOW - 6 * MS_DAY),
      makeReceipt('c-costco-3', 'costco', 1000, NOW - 7 * MS_DAY),
      makeReceipt('c-lawson-1', 'lawson', 1500, NOW - 5 * MS_DAY),
      makeReceipt('c-lawson-2', 'lawson', 1500, NOW - 6 * MS_DAY),
      makeReceipt('c-lawson-3', 'lawson', 1500, NOW - 7 * MS_DAY),
    ];
    return [...previous, ...current];
  }

  it('A — same top merchant emits share_increased with same-entity shares', () => {
    const insights = buildInsights(sameTopMerchantReceipts(), 'month', {
      nowMs: NOW,
    });
    const merchantChange = insights.changes.find(
      (change) => change.changeKey === 'analysisV2.changes.merchantMore'
    );
    expect(merchantChange?.changeParams?.merchant).toBe('costco');
    expect(merchantChange?.changeParams?.kind).toBe('share_increased');
    expect(merchantChange?.changeParams?.previousShare).toBeDefined();
    expect(merchantChange?.changeParams?.previousShare).not.toBe(
      merchantChange?.changeParams?.currentShare
    );

    const surface = buildAnalysisMerchantChangeSurface(insights);
    expect(surface).toMatchObject({
      status: 'available',
      kind: 'share_increased',
      merchantKey: 'costco',
    });
    if (surface.status === 'available' && surface.kind === 'share_increased') {
      expect(surface.currentShare).toBeGreaterThan(surface.previousShare);
      expect(surface.merchantKey).toBe('costco');
    }

    const vm = buildAnalysisReleaseViewModel({
      periodStats: insights.currentStats,
      allSupportedCount: insights.currentStats.supportedReceiptCount,
      itemCount: insights.currentItemsCount,
      insights,
    });
    expect(vm.merchantChange).toMatchObject({
      status: 'available',
      kind: 'share_increased',
      merchantKey: 'costco',
    });
  });

  it('B — different top merchant emits current_period_prominent without previousShare', () => {
    const insights = buildInsights(differentTopMerchantReceipts(), 'month', {
      nowMs: NOW,
    });
    const merchantChange = insights.changes.find(
      (change) => change.changeKey === 'analysisV2.changes.merchantMore'
    );
    expect(merchantChange?.changeParams?.merchant).toBe('aeon');
    expect(merchantChange?.changeParams?.kind).toBe('current_period_prominent');
    expect(merchantChange?.changeParams?.previousShare).toBeUndefined();

    const surface = buildAnalysisMerchantChangeSurface(insights);
    expect(surface).toEqual({
      status: 'available',
      kind: 'current_period_prominent',
      merchantKey: 'aeon',
      displayName: 'aeon',
      currentShare: expect.any(Number),
    });
    if (surface.status === 'available') {
      expect(surface).not.toHaveProperty('previousShare');
    }

    const prevTopShare = Math.round(
      (100 * 4000) /
        insights.previousStats!.topMerchants.reduce((sum, row) => sum + row.total, 0)
    );
    if (surface.status === 'available' && surface.kind === 'current_period_prominent') {
      expect(surface.currentShare).not.toBe(prevTopShare);
    }
  });

  it('category rounding edge keeps abs(to-from) === change through buildInsights', () => {
    const receipts = [
      makeReceipt('p-rte-1', 'aeon', 947, NOW - 40 * MS_DAY, 'ready_to_eat'),
      makeReceipt('p-rte-2', 'aeon', 947, NOW - 41 * MS_DAY, 'ready_to_eat'),
      makeReceipt('p-rte-3', 'aeon', 947, NOW - 42 * MS_DAY, 'ready_to_eat'),
      makeReceipt('p-food-1', 'lawson', 2387, NOW - 40 * MS_DAY, 'food_ingredients'),
      makeReceipt('p-food-2', 'lawson', 2387, NOW - 41 * MS_DAY, 'food_ingredients'),
      makeReceipt('p-food-3', 'lawson', 2387, NOW - 42 * MS_DAY, 'food_ingredients'),
      makeReceipt('c-rte-1', 'aeon', 987, NOW - 5 * MS_DAY, 'ready_to_eat'),
      makeReceipt('c-rte-2', 'aeon', 987, NOW - 6 * MS_DAY, 'ready_to_eat'),
      makeReceipt('c-rte-3', 'aeon', 987, NOW - 7 * MS_DAY, 'ready_to_eat'),
      makeReceipt('c-food-1', 'lawson', 2347, NOW - 5 * MS_DAY, 'food_ingredients'),
      makeReceipt('c-food-2', 'lawson', 2347, NOW - 6 * MS_DAY, 'food_ingredients'),
      makeReceipt('c-food-3', 'lawson', 2346, NOW - 7 * MS_DAY, 'food_ingredients'),
    ];
    const insights = buildInsights(receipts, 'month', { nowMs: NOW });
    const categoryChange = insights.changes.find(
      (change) =>
        change.changeKey === 'analysisV2.changes.categoryShareUp' ||
        change.changeKey === 'analysisV2.changes.categoryShareDown'
    );
    expect(categoryChange).toBeDefined();
    const from = Number(categoryChange!.changeParams?.from);
    const to = Number(categoryChange!.changeParams?.to);
    const change = Number(categoryChange!.changeParams?.change);
    expect(Math.abs(to - from)).toBe(change);
    expect(change).toBeGreaterThan(0);

    const surface = buildAnalysisCategoryChangeSurface(insights);
    expect(surface).toMatchObject({
      status: 'available',
      fromPercent: from,
      toPercent: to,
      percentagePointChange: change,
    });
  });
});

describe('analysis release change copy semantics', () => {
  const localesDir = path.join(__dirname, '../locales');

  function readLocale(name: string): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(localesDir, `${name}.json`), 'utf8')
    ) as Record<string, unknown>;
  }

  function releaseString(locale: string, key: string): string {
    const data = readLocale(locale);
    const release = (data.analysis as Record<string, unknown>).release as Record<
      string,
      string
    >;
    return release[key];
  }

  it('uses percentage-point wording for category changes in zh/ja/en', () => {
    expect(releaseString('zh', 'categoryChangeUp')).toContain('个百分点');
    expect(releaseString('ja', 'categoryChangeUp')).toContain('ポイント');
    expect(releaseString('en', 'categoryChangeUp')).toMatch(/pts/i);
    for (const locale of ['zh', 'ja', 'en'] as const) {
      expect(releaseString(locale, 'categoryChangeUp')).not.toMatch(/¥|yen|円/i);
      expect(releaseString(locale, 'categoryChangeDown')).not.toMatch(/¥|yen|円/i);
    }
  });

  it('does not claim merchant visit-frequency or price superiority', () => {
    for (const locale of ['zh', 'ja', 'en'] as const) {
      const currentCopy = releaseString(locale, 'merchantChangeCurrentShare');
      expect(currentCopy).not.toMatch(
        /花得更多|spending more|支出が多め|more visits|次数|回数増|更高|上升|增加|比上期|更多|larger|rose|increased|more than|compared with/i
      );
      expect(currentCopy).not.toMatch(/最便宜|cheapest|最安/i);
    }
  });

  it('allows temporal from/to only on same-merchant share_increased copy', () => {
    for (const locale of ['zh', 'ja', 'en'] as const) {
      const increased = releaseString(locale, 'merchantChangeShareIncreased');
      expect(increased).toMatch(/fromPercent|from|%|到|から|to/i);
      const currentOnly = releaseString(locale, 'merchantChangeCurrentShare');
      expect(currentOnly).not.toMatch(
        /更高|上升|增加|比上期|更多|rose|increased|more than|compared with|から.*に上昇|升至|增至/i
      );
    }
  });

  it('uses reason-neutral unavailable wording', () => {
    for (const locale of ['zh', 'ja', 'en'] as const) {
      const copy = releaseString(locale, 'changesUnavailable');
      expect(copy).not.toMatch(/不足|not enough records|足りません|receipt count/i);
    }
  });

  it('uses preceding-window Japanese comparison wording', () => {
    expect(releaseString('ja', 'changesCompared')).toBe('前の{days}日間と比較');
  });

  it('uses rolling-day comparison wording, not calendar month', () => {
    expect(releaseString('zh', 'changesCompared')).toContain('{days}');
    expect(releaseString('zh', 'changesCompared')).not.toMatch(/本月|这个月/);
    expect(releaseString('ja', 'changesCompared')).not.toMatch(/今月/);
    expect(releaseString('en', 'changesCompared')).not.toMatch(/this month/i);
  });

  it('does not surface health advice or AP-3 driver language in release keys', () => {
    const analysisScreen = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(analysisScreen).not.toContain('analysisV2.tips');
    expect(analysisScreen).not.toContain('confidenceKey');
    expect(analysisScreen).not.toContain('changeKey');
    for (const locale of ['zh', 'ja', 'en'] as const) {
      const release = readLocale(locale).analysis as Record<string, unknown>;
      const releaseObj = release.release as Record<string, unknown>;
      for (const value of Object.values(releaseObj)) {
        if (typeof value !== 'string') continue;
        expect(value).not.toMatch(/主要来自|caused by|导致了|driver/i);
      }
    }
  });

  it('defines changes section keys in all locales', () => {
    for (const locale of ['zh', 'ja', 'en'] as const) {
      expect(releaseString(locale, 'changesTitle').length).toBeGreaterThan(0);
      expect(releaseString(locale, 'changesUnavailable').length).toBeGreaterThan(0);
      expect(
        releaseString(locale, 'merchantChangeShareIncreased').length
      ).toBeGreaterThan(0);
      expect(
        releaseString(locale, 'merchantChangeCurrentShare').length
      ).toBeGreaterThan(0);
    }
  });
});
