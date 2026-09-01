import type { ReceiptRow } from './db';
import {
  ANALYSIS_RELEASE_FORBIDDEN_PHRASES,
  buildAnalysisCategoryConservation,
  buildAnalysisInsightPresentation,
  buildAnalysisOverview,
  buildAnalysisReleaseViewModel,
  countSupportedItemsInRange,
  resolveAnalysisReleaseStage,
  shouldPresentAnalysisReleaseInsight,
  shouldShowAnalysisProSection,
  shouldShowLegacyPriceRadar,
} from './analysisPresentation';
import { createEmptyStats } from './analysisHelpers';
import { buildAnalysisSpendChangeSurface } from './analysisValueSurfaces';
import * as fs from 'fs';
import * as path from 'path';

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow {
  const t = Date.now();
  return {
    id,
    created_at: t,
    transaction_at: t,
    image_uri: '',
    total: 1000,
    tax: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [
        {
          name: `Item ${id}`,
          lineTotal: 1000,
          quantity: 1,
          category: 'food_ingredients',
        },
      ],
    }),
    merchant_raw: `Store ${id}`,
    merchant_normalized: `store ${id}`,
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    ...overrides,
  };
}

describe('analysis release stages', () => {
  it('maps 0 / period-empty / low / ready correctly', () => {
    expect(
      resolveAnalysisReleaseStage({
        periodSupportedCount: 0,
        allSupportedCount: 0,
      })
    ).toBe('empty');
    expect(
      resolveAnalysisReleaseStage({
        periodSupportedCount: 0,
        allSupportedCount: 4,
      })
    ).toBe('period_empty');
    expect(
      resolveAnalysisReleaseStage({
        periodSupportedCount: 1,
        allSupportedCount: 1,
      })
    ).toBe('low');
    expect(
      resolveAnalysisReleaseStage({
        periodSupportedCount: 2,
        allSupportedCount: 2,
      })
    ).toBe('low');
    expect(
      resolveAnalysisReleaseStage({
        periodSupportedCount: 3,
        allSupportedCount: 3,
      })
    ).toBe('ready');
  });
});

describe('analysis release view model', () => {
  it('uses empty presentation without ¥0 dashboard flags', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: createEmptyStats(),
      allSupportedCount: 0,
      itemCount: 0,
      insights: null,
    });
    expect(vm.stage).toBe('empty');
    expect(vm.overview).toBeNull();
    expect(vm.showProSection).toBe(false);
    expect(vm.showLegacyPriceRadar).toBe(false);
    expect(vm.showLegacyCategoryIndex).toBe(false);
  });

  it('offers switching to all when only the current period is empty', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: createEmptyStats(),
      allSupportedCount: 5,
      itemCount: 0,
      insights: null,
    });
    expect(vm.stage).toBe('period_empty');
    expect(vm.showSwitchToAll).toBe(true);
  });

  it('builds factual overview for one receipt including real ¥0 spend', () => {
    const stats = {
      ...createEmptyStats(),
      supportedSpend: 0,
      supportedReceiptCount: 1,
      topCategories: [],
    };
    const overview = buildAnalysisOverview(stats, 2);
    expect(overview).toEqual({
      supportedSpend: 0,
      supportedReceiptCount: 1,
      averageSpendPerReceipt: 0,
      itemCount: 2,
      hasReceipts: true,
    });
    const vm = buildAnalysisReleaseViewModel({
      periodStats: stats,
      allSupportedCount: 1,
      itemCount: 2,
      insights: null,
    });
    expect(vm.stage).toBe('low');
    expect(vm.overview?.supportedSpend).toBe(0);
    expect(vm.showLowDataHint).toBe(true);
    expect(vm.insight).toBeNull();
  });

  it('counts supported items and ignores other/unknown merchants', () => {
    const now = Date.now();
    const rows = [
      receipt('s1', {
        merchant_type: 'supermarket',
        transaction_at: now,
        analysis_json: JSON.stringify({
          items: [
            { name: 'A', lineTotal: 100, quantity: 1, category: 'food_ingredients' },
            { name: 'B', lineTotal: 200, quantity: 1, category: 'snacks_drinks' },
          ],
        }),
      }),
      receipt('c1', {
        merchant_type: 'convenience',
        transaction_at: now,
        analysis_json: JSON.stringify({
          items: [
            { name: 'C', lineTotal: 300, quantity: 1, category: 'ready_to_eat' },
          ],
        }),
      }),
      receipt('other', {
        merchant_type: 'other',
        transaction_at: now,
        analysis_json: JSON.stringify({
          items: [
            { name: 'X', lineTotal: 999, quantity: 1, category: 'other' },
          ],
        }),
      }),
    ];
    expect(countSupportedItemsInRange(rows, 'all', now)).toBe(3);
  });

  it('keeps Pro and legacy Price Radar hidden in release', () => {
    expect(shouldShowAnalysisProSection({ comingSoon: true })).toBe(false);
    expect(
      shouldShowLegacyPriceRadar({ migratedToSafePriceHistory: false })
    ).toBe(false);
  });

  it('hides redundant top-category insight in ready stage', () => {
    const stats = {
      ...createEmptyStats(),
      supportedSpend: 5000,
      supportedReceiptCount: 5,
      categoryCompositionTotal: 5000,
      topCategories: [{ category: 'food_ingredients', amount: 3000 }],
    };
    expect(
      shouldPresentAnalysisReleaseInsight('ready', {
        type: 'full',
        conclusionKey: 'analysisV2.story.conclusion',
        conclusionParams: { cat: 'food_ingredients', pct: 60, amt: 3000 },
        explanationKey: 'analysisV2.story.explainDefault',
      }, stats)
    ).toBe(false);
    expect(
      buildAnalysisInsightPresentation('ready', stats, {
        type: 'full',
        conclusionKey: 'analysisV2.story.conclusion',
        conclusionParams: { cat: 'food_ingredients', pct: 60, amt: 3000 },
        explanationKey: 'analysisV2.story.explainDefault',
      })
    ).toBeNull();
  });

  it('shows period-change section only in ready stage', () => {
    const ready = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
    });
    expect(ready.stage).toBe('ready');
    expect(ready.showPeriodChangesSection).toBe(true);

    const low = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 1000,
        supportedReceiptCount: 2,
      },
      allSupportedCount: 5,
      itemCount: 4,
      insights: null,
    });
    expect(low.stage).toBe('low');
    expect(low.showPeriodChangesSection).toBe(false);
  });

  it('uses supported-universe overview label contract in release locales', () => {
    for (const [file, expected] of [
      ['zh.json', '超市·便利店支出'],
      ['ja.json', 'スーパー・コンビニ支出'],
      ['en.json', 'Supermarket & convenience spend'],
    ] as const) {
      const json = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../locales/${file}`), 'utf8')
      );
      expect(json.analysis.release.totalSpend).toBe(expected);
    }
  });

  it('conserves category composition totals', () => {
    const stats = {
      ...createEmptyStats(),
      categoryCompositionTotal: 1000,
      categoryBreakdown: [
        { category: 'food_ingredients', amount: 600 },
        { category: 'snacks_drinks', amount: 400 },
      ],
      topCategories: [
        { category: 'food_ingredients', amount: 600 },
        { category: 'snacks_drinks', amount: 400 },
      ],
    };
    expect(buildAnalysisCategoryConservation(stats)).toMatchObject({
      conserved: true,
      gap: 0,
    });
  });

  it('exposes spend change only when insights provide comparable periods', () => {
    expect(
      buildAnalysisSpendChangeSurface({
        changes: [],
        periodDays: 7,
        previousStats: null,
      } as any).status
    ).toBe('unavailable');
  });
});

describe('analysis release copy contract', () => {
  it('avoids assistant voice in Analysis release locale strings', () => {
    const localeFiles = ['zh.json', 'ja.json', 'en.json'].map((name) =>
      path.resolve(__dirname, `../locales/${name}`)
    );
    for (const file of localeFiles) {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const blob = JSON.stringify(json.analysis?.release ?? {});
      for (const phrase of ANALYSIS_RELEASE_FORBIDDEN_PHRASES) {
        expect(blob).not.toContain(phrase);
      }
      expect(blob).not.toMatch(/\bAI\b/i);
    }
  });

  it('does not mount Pro locks or Price Radar in the Analysis screen JSX', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('buildAnalysisReleaseViewModel');
    expect(source).toContain('AnalysisEmptyState');
    expect(source).not.toContain('buildPriceRadarData(');
    expect(source).not.toContain('analysisV2.pro');
    expect(source).not.toContain('analysis.priceRadar');
    expect(source).toContain('lib/priceRadar.ts');
  });
});
