/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import { createEmptyStats } from './analysisHelpers';
import { buildAnalysisReleaseViewModel } from './analysisPresentation';
import {
  buildAnalysisPriceChangeRow,
  buildAnalysisPriceChangesSurface,
  buildAnalysisPriceChangesSurfaceFromRows,
} from './analysisPriceSurfaces';
import {
  collectAnalysisTrustedPriceChangeCandidates,
  rankAnalysisTrustedPriceChangeCandidates,
  selectAnalysisTrustedPriceChangeCandidates,
} from './analysisTrustedPriceChanges';
import {
  makeTrustedG3TestRow,
} from './productPriceHistory.testFixtures';

const SKU_A = 'analysis-sku-a';
const SKU_B = 'analysis-sku-b';
const MS_DAY = 86_400_000;

function trustedSkuRow(
  id: string,
  skuKey: string,
  gross: number,
  overrides: Partial<ReturnType<typeof makeTrustedG3TestRow>> = {}
) {
  return makeTrustedG3TestRow(id, {
    skuKey,
    grossLineAmount: gross,
    lineTotal: gross,
    purchaseQuantity: 1,
    displayName: overrides.displayName ?? `Product ${skuKey}`,
    receiptId: overrides.receiptId ?? `receipt-${id}`,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '')) * MS_DAY,
    ...overrides,
  });
}

describe('analysisTrustedPriceChanges', () => {
  it('surfaces trusted comparable price increase', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, {
        receiptId: 'r1',
        occurredAt: 1 * MS_DAY,
        displayName: 'Milk',
      }),
      trustedSkuRow('2', SKU_A, 150, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        displayName: 'Milk',
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows,
      seedReceiptIds: new Set(['r2']),
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items[0]).toMatchObject({
        displayName: 'Milk',
        direction: 'up',
        deltaAmount: 50,
        currency: 'JPY',
        targetType: 'sku',
        targetKey: SKU_A,
      });
    }
  });

  it('surfaces trusted comparable price decrease', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 200, {
        receiptId: 'r1',
        occurredAt: 1 * MS_DAY,
        displayName: 'Eggs',
      }),
      trustedSkuRow('2', SKU_A, 150, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        displayName: 'Eggs',
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows,
      seedReceiptIds: new Set(['r2']),
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items[0]?.direction).toBe('down');
      expect(surface.items[0]?.deltaAmount).toBe(50);
    }
  });

  it('returns unavailable with insufficient observations', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1' }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r1']),
      })
    ).toEqual({ status: 'unavailable' });
  });

  it('rejects suspected anomaly observations', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      trustedSkuRow('2', SKU_A, 500, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
      }),
    ];
    const surface = buildAnalysisPriceChangesSurface(
      collectAnalysisTrustedPriceChangeCandidates({
        rows,
        seedReceiptIds: new Set(['r2']),
        interpretChange: () => ({
          status: 'unavailable',
          reasonCodes: ['quality_not_trusted'],
        }),
      })
    );
    expect(surface.status).toBe('unavailable');
  });

  it('rejects currency mismatch observations', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, {
        receiptId: 'r1',
        currency: 'JPY',
        receiptCurrency: 'JPY',
      }),
      trustedSkuRow('2', SKU_A, 150, {
        receiptId: 'r2',
        currency: 'USD',
        receiptCurrency: 'USD',
      }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
      }).status
    ).toBe('unavailable');
  });

  it('rejects incompatible quantity observations', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, {
        receiptId: 'r1',
        purchaseQuantity: 1,
      }),
      trustedSkuRow('2', SKU_A, 200, {
        receiptId: 'r2',
        purchaseQuantity: 0,
      }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
      }).status
    ).toBe('unavailable');
  });

  it('rejects duplicate-scan observations when duplicate selection is unconfirmed', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      trustedSkuRow('2', SKU_A, 150, { receiptId: 'r2', occurredAt: 2 * MS_DAY }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
        canonicalDuplicateSelectionApplied: false,
      }).status
    ).toBe('unavailable');
  });

  it('does not claim exact price change for family-only identity rows', () => {
    const rows = [
      makeTrustedG3TestRow('1', {
        productFamilyKey: 'milk',
        grossLineAmount: 100,
        lineTotal: 100,
        receiptId: 'r1',
        occurredAt: MS_DAY,
      }),
      makeTrustedG3TestRow('2', {
        productFamilyKey: 'milk',
        grossLineAmount: 150,
        lineTotal: 150,
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
      }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
      })
    ).toEqual({ status: 'unavailable' });
  });

  it('ranks by absolute delta, then recency, deterministically', () => {
    const rowsA = [
      trustedSkuRow('a1', SKU_A, 100, {
        receiptId: 'ra1',
        occurredAt: MS_DAY,
        displayName: 'Small change',
      }),
      trustedSkuRow('a2', SKU_A, 130, {
        receiptId: 'ra2',
        occurredAt: 10 * MS_DAY,
        displayName: 'Small change',
      }),
    ];
    const rowsB = [
      trustedSkuRow('b1', SKU_B, 100, {
        receiptId: 'rb1',
        occurredAt: MS_DAY,
        displayName: 'Large change',
      }),
      trustedSkuRow('b2', SKU_B, 250, {
        receiptId: 'rb2',
        occurredAt: 5 * MS_DAY,
        displayName: 'Large change',
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows: [...rowsA, ...rowsB],
      seedReceiptIds: new Set(['ra2', 'rb2']),
      limit: 2,
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items.map((item) => item.displayName)).toEqual([
        'Large change',
        'Small change',
      ]);
    }
  });

  it('delegates comparison to interpretProductPriceChange', () => {
    const interpretChange = jest.fn(() => ({
      status: 'unavailable' as const,
      reasonCodes: ['history_not_ready' as const],
    }));
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1' }),
      trustedSkuRow('2', SKU_A, 150, { receiptId: 'r2' }),
    ];
    collectAnalysisTrustedPriceChangeCandidates({
      rows,
      seedReceiptIds: new Set(['r2']),
      interpretChange,
    });
    expect(interpretChange).toHaveBeenCalled();
  });

  it('preserves promo transition via resolveProductPriceChangePresentation', () => {
    const candidate = {
      target: { type: 'sku' as const, key: SKU_A },
      displayName: 'Milk',
      interpretation: {
        status: 'available' as const,
        grossDelta: 50,
        grossDirection: 'increased' as const,
        promoTransition: 'ended' as const,
        current: { occurredAt: 2, currency: 'JPY' },
      },
      comparableOccurrenceCount: 2,
      latestOccurredAt: 2,
    } as any;
    expect(buildAnalysisPriceChangeRow(candidate)).toMatchObject({
      direction: 'up',
      deltaAmount: 50,
      promoBodyKey: 'priceHistory.promo.ended',
    });
  });

  it('surfaces promo started alongside purchase price increase', () => {
    const interpretChange = jest.fn(() => ({
      status: 'available' as const,
      grossDelta: 20,
      grossDirection: 'increased' as const,
      promoTransition: 'started' as const,
      current: { occurredAt: 2 * MS_DAY, currency: 'JPY' },
    }));
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      trustedSkuRow('2', SKU_A, 120, { receiptId: 'r2', occurredAt: 2 * MS_DAY }),
    ];
    const surface = buildAnalysisPriceChangesSurface(
      collectAnalysisTrustedPriceChangeCandidates({
        rows,
        seedReceiptIds: new Set(['r2']),
        interpretChange: interpretChange as any,
      })
    );
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items[0]?.promoBodyKey).toBe('priceHistory.promo.started');
    }
  });

  it('skips SKUs when candidate construction throws', () => {
    const buildHistory = jest.fn(() => {
      throw new Error('history build failed');
    });
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1' }),
      trustedSkuRow('2', SKU_A, 150, { receiptId: 'r2' }),
    ];
    expect(
      collectAnalysisTrustedPriceChangeCandidates({
        rows,
        seedReceiptIds: new Set(['r2']),
        buildHistory,
      })
    ).toEqual([]);
  });

  it('excludes foreign-owner seed rows from candidate discovery', () => {
    const ownRows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'own-1' }),
      trustedSkuRow('2', SKU_A, 150, { receiptId: 'own-2' }),
    ];
    const foreignOnlySeed = new Set(['foreign-1']);
    expect(
      collectAnalysisTrustedPriceChangeCandidates({
        rows: ownRows,
        seedReceiptIds: foreignOnlySeed,
      })
    ).toEqual([]);
  });
});

describe('analysis release price change visibility', () => {
  const availableSurface = {
    status: 'available' as const,
    items: [
      {
        displayName: 'Milk',
        direction: 'up' as const,
        deltaAmount: 20,
        currency: 'JPY',
        targetType: 'sku' as const,
        targetKey: SKU_A,
        promoBodyKey: null,
      },
    ],
  };

  it('shows price changes only on ready stage', () => {
    const ready = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
      priceChanges: availableSurface,
    });
    expect(ready.stage).toBe('ready');
    expect(ready.priceChanges.status).toBe('available');

    const low = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 1000,
        supportedReceiptCount: 2,
      },
      allSupportedCount: 5,
      itemCount: 4,
      insights: null,
      priceChanges: availableSurface,
    });
    expect(low.priceChanges).toEqual({ status: 'unavailable' });

    const empty = buildAnalysisReleaseViewModel({
      periodStats: createEmptyStats(),
      allSupportedCount: 0,
      itemCount: 0,
      insights: null,
      priceChanges: availableSurface,
    });
    expect(empty.priceChanges).toEqual({ status: 'unavailable' });
  });

  it('keeps legacy Price Radar and Category Index gated off', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
      priceChanges: availableSurface,
      priceRadarMigrated: false,
    });
    expect(vm.showLegacyPriceRadar).toBe(false);
    expect(vm.showLegacyCategoryIndex).toBe(false);
  });
});

describe('analysis price surfaces module boundaries', () => {
  it('does not import legacy priceRadar or unsafe comparison helpers', () => {
    for (const file of [
      'analysisPriceSurfaces.ts',
      'analysisTrustedPriceChanges.ts',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/from '\.\/priceRadar'/);
      expect(source).not.toMatch(/computeCheapestMerchants|compareWithMinPrice/);
    }
  });

  it('analysis screen wires safe loader with optional soft-fail boundary', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('loadAnalysisTrustedPriceChangesSurface');
    expect(source).not.toContain('buildPriceRadarData');
    expect(source).not.toContain('buildCategoryIndexData');
    expect(source).toContain('priceRadarMigrated: false');
    expect(source).not.toMatch(
      /Promise\.all\([\s\S]*loadAnalysisTrustedPriceChangesSurface/
    );
    expect(source).toContain("setPriceChanges({ status: 'unavailable' })");
    expect(source).toContain('priceChangesContext');
    expect(source).toContain('promoBodyKey');
  });
});

describe('analysis price change i18n', () => {
  const localesDir = path.join(__dirname, '../locales');

  function releaseString(locale: string, key: string): string {
    const data = JSON.parse(
      fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8')
    ) as Record<string, unknown>;
    const release = (data.analysis as Record<string, unknown>).release as Record<
      string,
      string
    >;
    return release[key];
  }

  it('defines zh / ja / en purchase-event price change copy without recommendation tone', () => {
    const expected = {
      zh: {
        priceChangesTitle: '购买价格变化',
        priceChangesContext: '基于最近两次可比购买记录',
        priceChangeUp: '最近一次购买价比上次高 {amount}',
        priceChangeDown: '最近一次购买价比上次低 {amount}',
      },
      ja: {
        priceChangesTitle: '購入価格の変化',
        priceChangesContext: '直近2回の比較可能な購入記録に基づきます',
        priceChangeUp: '直近の購入価格は前回より{amount}高い',
        priceChangeDown: '直近の購入価格は前回より{amount}安い',
      },
      en: {
        priceChangesTitle: 'Purchase price changes',
        priceChangesContext:
          'Based on the two most recent comparable purchases',
        priceChangeUp:
          'Latest purchase was {amount} higher than the previous one',
        priceChangeDown:
          'Latest purchase was {amount} lower than the previous one',
      },
    } as const;

    for (const locale of ['zh', 'ja', 'en'] as const) {
      for (const key of [
        'priceChangesTitle',
        'priceChangesContext',
        'priceChangeUp',
        'priceChangeDown',
      ] as const) {
        const copy = releaseString(locale, key);
        expect(copy).toBe(expected[locale][key]);
        expect(copy).not.toMatch(/建议|推荐|囤货|预测|recommend|predict|stock up/i);
        expect(copy).not.toMatch(
          /近期价格上涨|最近の価格が.*上昇|Recent price increased/i
        );
      }
    }
  });
});

describe('analysisTrustedPriceChanges ranking helpers', () => {
  it('selectAnalysisTrustedPriceChangeCandidates respects limit', () => {
    const candidates = [
      {
        target: { type: 'sku' as const, key: 'a' },
        displayName: 'A',
        interpretation: {
          status: 'available' as const,
          grossDelta: 10,
          grossDirection: 'increased' as const,
          current: { occurredAt: 1, currency: 'JPY' },
        },
        comparableOccurrenceCount: 2,
        latestOccurredAt: 1,
      },
      {
        target: { type: 'sku' as const, key: 'b' },
        displayName: 'B',
        interpretation: {
          status: 'available' as const,
          grossDelta: 30,
          grossDirection: 'increased' as const,
          current: { occurredAt: 2, currency: 'JPY' },
        },
        comparableOccurrenceCount: 2,
        latestOccurredAt: 2,
      },
    ] as any;
    expect(
      selectAnalysisTrustedPriceChangeCandidates(candidates, 1).map(
        (row) => row.displayName
      )
    ).toEqual(['B']);
    expect(rankAnalysisTrustedPriceChangeCandidates(candidates)[0]?.displayName).toBe(
      'B'
    );
  });
});
