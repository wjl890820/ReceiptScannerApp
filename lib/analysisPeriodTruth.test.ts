jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({ initIfNeeded: jest.fn(async () => undefined) }));

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildInsights } from './buildInsights';
import type { ReceiptRow } from './db';
import { parseReceiptDateTime } from './dateParser';
import {
  countSupportedItemsInRange,
  filterReceiptsByTimeRange,
} from './analysisPresentation';
import { buildAnalysisSpendChangeSurface } from './analysisValueSurfaces';
import { calculateStats } from './statsCalculator';

const REFERENCE_NOW = Date.parse('2026-08-25T03:00:00.000Z');

const EXPECTED = {
  storedReceipts: 13,
  duplicateExtras: 1,
  purchaseCandidates: 12,
  allSupportedPurchases: 11,
  allSpend: 5350,
  allItemRows: 12,
  monthSupportedPurchases: 5,
  monthSpend: 2250,
  monthItemRows: 6,
  weekSupportedPurchases: 4,
  weekSpend: 2030,
  weekItemRows: 5,
  previousMonthSupportedPurchases: 3,
  previousMonthSpend: 1000,
  comparisonDelta: 1250,
  comparisonPercent: 125,
} as const;

type FixtureOptions = {
  createdAt?: number;
  transactionAt?: number | null;
  merchant?: string | null;
  merchantType?: ReceiptRow['merchant_type'];
  total: number;
  tax?: number;
  items: Array<Record<string, unknown>>;
  discounts?: Array<{ label: string; amount: number }>;
};

function receipt(id: string, options: FixtureOptions): ReceiptRow {
  const merchant = options.merchant === undefined ? 'Store A' : options.merchant;
  const createdAt = options.createdAt ?? REFERENCE_NOW - 60_000;
  return {
    id,
    created_at: createdAt,
    transaction_at: options.transactionAt ?? null,
    image_uri: '',
    merchant_raw: merchant,
    merchant_normalized: merchant,
    merchant_type: options.merchantType ?? 'supermarket',
    store_raw: merchant,
    store_normalized: merchant,
    total: options.total,
    tax: options.tax ?? 0,
    tax_is_known: options.tax == null ? 0 : 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      merchant,
      merchant_type: options.merchantType ?? 'supermarket',
      total: options.total,
      tax: options.tax ?? 0,
      items: options.items,
      discounts: options.discounts ?? [],
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    transaction_source: null,
    ocr_request_id: null,
  };
}

function item(
  name: string,
  category: string,
  lineTotal: number,
  quantity: number | null = 1
): Record<string, unknown> {
  return {
    name,
    category,
    classification_status: category === 'uncategorized' ? 'failed' : 'ok',
    lineTotal,
    quantity,
  };
}

function goldenAnalysisReceipts(): ReceiptRow[] {
  const purchaseA = receipt('a', {
    createdAt: Date.parse('2026-08-24T01:01:00.000Z'),
    transactionAt: Date.parse('2026-08-24T01:00:00.000Z'),
    total: 1000,
    tax: 100,
    items: [
      item('Food multipack', 'food_ingredients', 700, 2),
      item('Drink', 'snacks_drinks', 400),
    ],
    discounts: [{ label: 'Receipt coupon', amount: -200 }],
  });

  return [
    purchaseA,
    {
      ...purchaseA,
      id: 'a-duplicate',
      created_at: Date.parse('2026-08-24T01:02:00.000Z'),
    },
    receipt('same-day-second', {
      transactionAt: Date.parse('2026-08-24T06:00:00.000Z'),
      total: 500,
      items: [item('Ready meal', 'ready_to_eat', 500)],
    }),
    receipt('date-only', {
      merchant: 'Store B',
      transactionAt: Date.parse('2026-08-19T15:00:00.000Z'),
      total: 330,
      tax: 30,
      items: [item('Household', 'household', 300)],
    }),
    receipt('cross-month', {
      transactionAt: Date.parse('2026-07-31T01:00:00.000Z'),
      total: 220,
      tax: 20,
      items: [item('Cross-month food', 'food_ingredients', 200)],
    }),
    receipt('previous-1', {
      transactionAt: Date.parse('2026-07-20T01:00:00.000Z'),
      total: 400,
      items: [item('Personal care', 'personal_care', 400)],
    }),
    receipt('previous-2', {
      merchant: 'Store B',
      transactionAt: Date.parse('2026-07-10T01:00:00.000Z'),
      total: 300,
      items: [item('Previous food', 'food_ingredients', 300)],
    }),
    receipt('previous-3', {
      merchant: 'Store C',
      transactionAt: Date.parse('2026-07-01T01:00:00.000Z'),
      total: 300,
      items: [item('Previous drink', 'snacks_drinks', 300)],
    }),
    receipt('unsupported', {
      merchant: 'Unsupported Store',
      merchantType: 'other',
      transactionAt: Date.parse('2026-08-23T01:00:00.000Z'),
      total: 999,
      items: [item('Unsupported item', 'other', 999)],
    }),
    receipt('missing-merchant', {
      merchant: null,
      transactionAt: Date.parse('2026-08-22T01:00:00.000Z'),
      total: 200,
      items: [item('Uncategorized item', 'uncategorized', 200)],
    }),
    receipt('missing-transaction', {
      createdAt: Date.parse('2026-08-24T02:00:00.000Z'),
      transactionAt: null,
      total: 600,
      items: [item('Missing date', 'food_ingredients', 600)],
    }),
    receipt('invalid-transaction', {
      createdAt: Date.parse('2026-08-24T03:00:00.000Z'),
      transactionAt: Number.NaN,
      total: 700,
      items: [item('Invalid date', 'snacks_drinks', 700)],
    }),
    receipt('future-transaction', {
      transactionAt: REFERENCE_NOW + 60 * 60 * 1000,
      total: 800,
      items: [item('Future date', 'ready_to_eat', 800)],
    }),
  ];
}

describe('Golden Analysis Dataset — period purchase-date truth', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(REFERENCE_NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('has manually reconciled purchase truth before period filtering', () => {
    const selection = selectAnalyticsReceipts(goldenAnalysisReceipts());
    const allStats = calculateStats(selection.analyticsReceipts, 'all');

    expect(selection.storedReceipts).toHaveLength(EXPECTED.storedReceipts);
    expect(selection.highConfidenceDuplicateExtras).toBe(
      EXPECTED.duplicateExtras
    );
    expect(selection.analyticsReceipts).toHaveLength(
      EXPECTED.purchaseCandidates
    );
    expect(allStats.supportedReceiptCount).toBe(EXPECTED.allSupportedPurchases);
    expect(allStats.supportedSpend).toBe(EXPECTED.allSpend);
    expect(
      countSupportedItemsInRange(
        selection.analyticsReceipts,
        'all',
        REFERENCE_NOW
      )
    ).toBe(EXPECTED.allItemRows);
    expect(allStats.categoryBreakdown).toEqual([
      { category: 'food_ingredients', amount: 1800 },
      { category: 'snacks_drinks', amount: 1400 },
      { category: 'ready_to_eat', amount: 1300 },
      { category: 'personal_care', amount: 400 },
      { category: 'household', amount: 300 },
    ]);
    expect(allStats.uncategorizedCount).toBe(1);
    expect(allStats.uncategorizedTotal).toBe(200);
  });

  it('uses only valid non-future purchase dates for rolling month and week', () => {
    const selection = selectAnalyticsReceipts(goldenAnalysisReceipts());
    const monthStats = calculateStats(selection.analyticsReceipts, 'month');
    const weekStats = calculateStats(selection.analyticsReceipts, 'week');

    expect(monthStats.supportedReceiptCount).toBe(
      EXPECTED.monthSupportedPurchases
    );
    expect(monthStats.supportedSpend).toBe(EXPECTED.monthSpend);
    expect(
      countSupportedItemsInRange(
        selection.analyticsReceipts,
        'month',
        REFERENCE_NOW
      )
    ).toBe(EXPECTED.monthItemRows);
    expect(weekStats.supportedReceiptCount).toBe(
      EXPECTED.weekSupportedPurchases
    );
    expect(weekStats.supportedSpend).toBe(EXPECTED.weekSpend);
    expect(
      countSupportedItemsInRange(
        selection.analyticsReceipts,
        'week',
        REFERENCE_NOW
      )
    ).toBe(EXPECTED.weekItemRows);

    const monthIds = filterReceiptsByTimeRange(
      selection.analyticsReceipts,
      'month',
      REFERENCE_NOW
    ).map((row) => row.id);
    expect(monthIds).toContain('a');
    expect(monthIds).toContain('same-day-second');
    expect(monthIds).toContain('date-only');
    expect(monthIds).toContain('cross-month');
    expect(monthIds).not.toContain('a-duplicate');
    expect(monthIds).not.toContain('missing-transaction');
    expect(monthIds).not.toContain('invalid-transaction');
    expect(monthIds).not.toContain('future-transaction');
  });

  it('keeps missing, invalid, and future transaction dates in all history', () => {
    const selection = selectAnalyticsReceipts(goldenAnalysisReceipts());
    const allIds = filterReceiptsByTimeRange(
      selection.analyticsReceipts,
      'all',
      REFERENCE_NOW
    ).map((row) => row.id);

    expect(allIds).toContain('missing-transaction');
    expect(allIds).toContain('invalid-transaction');
    expect(allIds).toContain('future-transaction');
  });

  it('preserves Tokyo date-only parsing and same-day purchase separation', () => {
    expect(
      parseReceiptDateTime('2026-08-20', {
        nowMs: REFERENCE_NOW,
        fallbackToNow: false,
      })
    ).toBe(Date.parse('2026-08-19T15:00:00.000Z'));

    const selection = selectAnalyticsReceipts(goldenAnalysisReceipts());
    const weekIds = filterReceiptsByTimeRange(
      selection.analyticsReceipts,
      'week',
      REFERENCE_NOW
    ).map((row) => row.id);
    expect(weekIds).toEqual(
      expect.arrayContaining(['a', 'same-day-second', 'date-only'])
    );
  });

  it('uses valid transaction dates consistently in current and previous insights', () => {
    const selection = selectAnalyticsReceipts(goldenAnalysisReceipts());
    const insights = buildInsights(selection.analyticsReceipts, 'month');

    expect(insights.currentStats.supportedReceiptCount).toBe(
      EXPECTED.monthSupportedPurchases
    );
    expect(insights.currentStats.supportedSpend).toBe(EXPECTED.monthSpend);
    expect(insights.previousStats?.supportedReceiptCount).toBe(
      EXPECTED.previousMonthSupportedPurchases
    );
    expect(insights.previousStats?.supportedSpend).toBe(
      EXPECTED.previousMonthSpend
    );
  });

  it('keeps unsupported current and previous purchases out of spend change', () => {
    const receipts = [
      ...goldenAnalysisReceipts(),
      receipt('unsupported-previous', {
        merchant: 'Unsupported Previous Store',
        merchantType: 'other',
        transactionAt: Date.parse('2026-07-15T01:00:00.000Z'),
        total: 5000,
        items: [item('Unsupported previous item', 'other', 5000)],
      }),
    ];
    const selection = selectAnalyticsReceipts(receipts);
    const insights = buildInsights(selection.analyticsReceipts, 'month');
    const surface = buildAnalysisSpendChangeSurface(insights);

    expect(insights.currentStats.supportedReceiptCount).toBe(
      EXPECTED.monthSupportedPurchases
    );
    expect(insights.previousStats?.supportedReceiptCount).toBe(
      EXPECTED.previousMonthSupportedPurchases
    );
    expect(insights.currentStats.supportedSpend).toBe(EXPECTED.monthSpend);
    expect(insights.previousStats?.supportedSpend).toBe(
      EXPECTED.previousMonthSpend
    );
    expect(insights.currentStats.totalSpend).toBe(3249);
    expect(insights.previousStats?.totalSpend).toBe(6000);
    expect(surface).toEqual({
      status: 'available',
      direction: 'up',
      absoluteDelta: EXPECTED.comparisonDelta,
      percentDelta: EXPECTED.comparisonPercent,
      periodDays: 30,
      currentSpend: EXPECTED.monthSpend,
      previousSpend: EXPECTED.previousMonthSpend,
    });
  });
});
