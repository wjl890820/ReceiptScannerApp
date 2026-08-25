jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({ initIfNeeded: jest.fn(async () => undefined) }));

import {
  isAnalysisJpyCurrency,
  isAnalysisJpyReceipt,
} from './analysisCurrency';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  countSupportedItemsInRange,
} from './analysisPresentation';
import { buildAnalysisSpendChangeSurface } from './analysisValueSurfaces';
import { buildInsights } from './buildInsights';
import type { ReceiptRow } from './db';
import { isV1SupportedReceipt } from './merchantType';
import { calculateStats } from './statsCalculator';

const REFERENCE_NOW = Date.parse('2026-08-25T03:00:00.000Z');

const EXPECTED = {
  storedReceipts: 11,
  duplicateExtras: 1,
  purchaseCandidates: 10,
  allJpyPurchases: 6,
  allJpySpend: 2_750,
  allJpyItemRows: 6,
  currentJpyPurchases: 3,
  currentJpySpend: 1_750,
  previousJpyPurchases: 3,
  previousJpySpend: 1_000,
  delta: 750,
  percent: 75,
} as const;

function receipt(args: {
  id: string;
  transactionAt: number;
  total: number;
  currency: unknown;
}): ReceiptRow {
  return {
    id: args.id,
    created_at: args.transactionAt + 1_000,
    transaction_at: args.transactionAt,
    image_uri: '',
    merchant_raw: 'Store A',
    merchant_normalized: 'Store A',
    merchant_type: 'supermarket',
    store_raw: 'Store A',
    store_normalized: 'Store A',
    total: args.total,
    tax: 0,
    tax_is_known: 0,
    currency: args.currency as string,
    analysis_json: JSON.stringify({
      merchant: 'Store A',
      merchant_type: 'supermarket',
      total: args.total,
      currency: args.currency,
      items: [
        {
          name: args.id,
          category: 'food_ingredients',
          classification_status: 'ok',
          lineTotal: args.total,
          quantity: 1,
        },
      ],
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

function goldenCurrencyReceipts(): ReceiptRow[] {
  const usdCurrent = receipt({
    id: 'current-usd',
    transactionAt: Date.parse('2026-08-21T01:00:00.000Z'),
    total: 9_999,
    currency: 'USD',
  });

  return [
    receipt({
      id: 'current-jpy',
      transactionAt: Date.parse('2026-08-24T01:00:00.000Z'),
      total: 1_000,
      currency: 'JPY',
    }),
    receipt({
      id: 'current-jpy-lowercase',
      transactionAt: Date.parse('2026-08-23T01:00:00.000Z'),
      total: 500,
      currency: ' jpy ',
    }),
    receipt({
      id: 'current-missing-currency',
      transactionAt: Date.parse('2026-08-22T01:00:00.000Z'),
      total: 250,
      currency: undefined,
    }),
    usdCurrent,
    {
      ...usdCurrent,
      id: 'current-usd-duplicate',
      created_at: usdCurrent.created_at + 1,
    },
    receipt({
      id: 'current-eur',
      transactionAt: Date.parse('2026-08-20T01:00:00.000Z'),
      total: 8_888,
      currency: 'EUR',
    }),
    receipt({
      id: 'current-malformed',
      transactionAt: Date.parse('2026-08-19T01:00:00.000Z'),
      total: 7_777,
      currency: 'YEN?',
    }),
    receipt({
      id: 'previous-jpy',
      transactionAt: Date.parse('2026-07-20T01:00:00.000Z'),
      total: 400,
      currency: 'JPY',
    }),
    receipt({
      id: 'previous-yen-symbol',
      transactionAt: Date.parse('2026-07-15T01:00:00.000Z'),
      total: 300,
      currency: '¥',
    }),
    receipt({
      id: 'previous-fullwidth-yen',
      transactionAt: Date.parse('2026-07-10T01:00:00.000Z'),
      total: 300,
      currency: '￥',
    }),
    receipt({
      id: 'previous-usd',
      transactionAt: Date.parse('2026-07-05T01:00:00.000Z'),
      total: 9_000,
      currency: 'USD',
    }),
  ];
}

describe('Analysis V1 currency contract', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(REFERENCE_NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recognizes only established JPY representations', () => {
    expect(isAnalysisJpyCurrency('JPY')).toBe(true);
    expect(isAnalysisJpyCurrency(' jpy ')).toBe(true);
    expect(isAnalysisJpyCurrency('¥')).toBe(true);
    expect(isAnalysisJpyCurrency('￥')).toBe(true);
    expect(isAnalysisJpyCurrency(undefined)).toBe(true);
    expect(isAnalysisJpyCurrency(null)).toBe(true);
    expect(isAnalysisJpyCurrency('')).toBe(true);

    expect(isAnalysisJpyCurrency('USD')).toBe(false);
    expect(isAnalysisJpyCurrency('EUR')).toBe(false);
    expect(isAnalysisJpyCurrency('unknown')).toBe(false);
    expect(isAnalysisJpyCurrency('YEN?')).toBe(false);
    expect(isAnalysisJpyCurrency(392)).toBe(false);
    expect(isAnalysisJpyReceipt({ currency: 'USD' })).toBe(false);

    const usdReceipt = goldenCurrencyReceipts().find(
      (row) => row.id === 'current-usd'
    )!;
    expect(isV1SupportedReceipt(usdReceipt)).toBe(true);
    expect(isAnalysisJpyReceipt(usdReceipt)).toBe(false);
  });

  it('keeps foreign values out of all JPY Analysis money and count surfaces', () => {
    const selection = selectAnalyticsReceipts(goldenCurrencyReceipts());
    const allStats = calculateStats(selection.analyticsReceipts, 'all');
    const monthStats = calculateStats(selection.analyticsReceipts, 'month');

    expect(selection.storedReceipts).toHaveLength(EXPECTED.storedReceipts);
    expect(selection.highConfidenceDuplicateExtras).toBe(
      EXPECTED.duplicateExtras
    );
    expect(selection.analyticsReceipts).toHaveLength(
      EXPECTED.purchaseCandidates
    );
    expect(allStats.supportedReceiptCount).toBe(EXPECTED.allJpyPurchases);
    expect(allStats.totalSpend).toBe(EXPECTED.allJpySpend);
    expect(allStats.supportedSpend).toBe(EXPECTED.allJpySpend);
    expect(allStats.categoryBreakdown).toEqual([
      { category: 'food_ingredients', amount: EXPECTED.allJpySpend },
    ]);
    expect(allStats.topMerchants).toEqual([
      {
        merchant: 'store a',
        count: EXPECTED.allJpyPurchases,
        total: EXPECTED.allJpySpend,
      },
    ]);
    expect(
      countSupportedItemsInRange(
        selection.analyticsReceipts,
        'all',
        REFERENCE_NOW
      )
    ).toBe(EXPECTED.allJpyItemRows);
    expect(monthStats.supportedReceiptCount).toBe(
      EXPECTED.currentJpyPurchases
    );
    expect(monthStats.supportedSpend).toBe(EXPECTED.currentJpySpend);
  });

  it('excludes foreign current and previous values from spend change', () => {
    const selection = selectAnalyticsReceipts(goldenCurrencyReceipts());
    const insights = buildInsights(selection.analyticsReceipts, 'month');
    const surface = buildAnalysisSpendChangeSurface(insights);

    expect(insights.currentStats.supportedReceiptCount).toBe(
      EXPECTED.currentJpyPurchases
    );
    expect(insights.currentStats.supportedSpend).toBe(
      EXPECTED.currentJpySpend
    );
    expect(insights.previousStats?.supportedReceiptCount).toBe(
      EXPECTED.previousJpyPurchases
    );
    expect(insights.previousStats?.supportedSpend).toBe(
      EXPECTED.previousJpySpend
    );
    expect(surface).toEqual({
      status: 'available',
      direction: 'up',
      absoluteDelta: EXPECTED.delta,
      percentDelta: EXPECTED.percent,
      periodDays: 30,
      currentSpend: EXPECTED.currentJpySpend,
      previousSpend: EXPECTED.previousJpySpend,
    });
  });
});
