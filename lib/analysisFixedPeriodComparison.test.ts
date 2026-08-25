jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({ initIfNeeded: jest.fn(async () => undefined) }));

import { buildAnalysisSpendChangeSurface } from './analysisValueSurfaces';
import { buildInsights } from './buildInsights';
import type { ReceiptRow } from './db';

const MS_DAY = 24 * 60 * 60 * 1000;
const REFERENCE_NOW = Date.parse('2026-08-25T03:00:00.000Z');

function receipt(args: {
  id: string;
  daysAgo?: number;
  transactionAt?: number | null;
  total: number;
  currency?: unknown;
}): ReceiptRow {
  const transactionAt =
    args.transactionAt !== undefined
      ? args.transactionAt
      : REFERENCE_NOW - (args.daysAgo ?? 0) * MS_DAY;
  return {
    id: args.id,
    created_at: REFERENCE_NOW - 1_000,
    transaction_at: transactionAt,
    image_uri: '',
    merchant_raw: 'Store A',
    merchant_normalized: 'Store A',
    merchant_type: 'supermarket',
    store_raw: 'Store A',
    store_normalized: 'Store A',
    total: args.total,
    tax: 0,
    tax_is_known: 0,
    currency: (args.currency ?? 'JPY') as string,
    analysis_json: JSON.stringify({
      merchant: 'Store A',
      merchant_type: 'supermarket',
      total: args.total,
      currency: args.currency ?? 'JPY',
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

describe('Analysis fixed-period comparison contract', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(REFERENCE_NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('compares the Month overview window against the preceding 30 days', () => {
    const receipts = [
      receipt({ id: 'current-5', daysAgo: 5, total: 1_000 }),
      receipt({ id: 'current-15', daysAgo: 15, total: 2_000 }),
      receipt({ id: 'current-25', daysAgo: 25, total: 3_000 }),
      receipt({ id: 'previous-35', daysAgo: 35, total: 500 }),
      receipt({ id: 'previous-45', daysAgo: 45, total: 1_000 }),
      receipt({ id: 'previous-55', daysAgo: 55, total: 1_500 }),
      receipt({
        id: 'missing-date',
        transactionAt: null,
        total: 9_999,
      }),
      receipt({
        id: 'invalid-date',
        transactionAt: Number.NaN,
        total: 9_999,
      }),
      receipt({
        id: 'future-date',
        transactionAt: REFERENCE_NOW + MS_DAY,
        total: 9_999,
      }),
      receipt({
        id: 'current-usd',
        daysAgo: 10,
        total: 9_999,
        currency: 'USD',
      }),
      receipt({
        id: 'previous-usd',
        daysAgo: 40,
        total: 9_999,
        currency: 'USD',
      }),
    ];

    const insights = buildInsights(receipts, 'month');
    expect(insights.periodDays).toBe(30);
    expect(insights.currentStats.supportedReceiptCount).toBe(3);
    expect(insights.currentStats.supportedSpend).toBe(6_000);
    expect(insights.previousStats?.supportedReceiptCount).toBe(3);
    expect(insights.previousStats?.supportedSpend).toBe(3_000);
    expect(buildAnalysisSpendChangeSurface(insights)).toEqual({
      status: 'available',
      direction: 'up',
      absoluteDelta: 3_000,
      percentDelta: 100,
      periodDays: 30,
      currentSpend: 6_000,
      previousSpend: 3_000,
    });
  });

  it('keeps sparse Month data in 30-day membership and suppresses comparison', () => {
    const insights = buildInsights(
      [
        receipt({ id: 'current-5', daysAgo: 5, total: 1_000 }),
        receipt({ id: 'current-20', daysAgo: 20, total: 2_000 }),
        receipt({ id: 'previous-35', daysAgo: 35, total: 500 }),
        receipt({ id: 'previous-45', daysAgo: 45, total: 500 }),
        receipt({ id: 'previous-55', daysAgo: 55, total: 500 }),
      ],
      'month'
    );

    expect(insights.periodDays).toBe(30);
    expect(insights.currentStats.supportedReceiptCount).toBe(2);
    expect(insights.currentStats.supportedSpend).toBe(3_000);
    expect(insights.previousStats?.supportedReceiptCount).toBe(3);
    expect(insights.previousStats?.supportedSpend).toBe(1_500);
    expect(buildAnalysisSpendChangeSurface(insights)).toEqual({
      status: 'unavailable',
    });
  });

  it('does not contract to 14 days even when all sparse current data fits there', () => {
    const insights = buildInsights(
      [
        receipt({ id: 'current-3', daysAgo: 3, total: 1_000 }),
        receipt({ id: 'current-10', daysAgo: 10, total: 2_000 }),
        receipt({ id: 'previous-35', daysAgo: 35, total: 500 }),
        receipt({ id: 'previous-45', daysAgo: 45, total: 500 }),
        receipt({ id: 'previous-55', daysAgo: 55, total: 500 }),
      ],
      'month'
    );

    expect(insights.periodDays).toBe(30);
    expect(insights.currentStats.supportedReceiptCount).toBe(2);
    expect(insights.previousStats?.supportedReceiptCount).toBe(3);
    expect(buildAnalysisSpendChangeSurface(insights)).toEqual({
      status: 'unavailable',
    });
  });

  it('preserves Week as current 7 days versus previous 7 days', () => {
    const insights = buildInsights(
      [
        receipt({ id: 'current-1', daysAgo: 1, total: 300 }),
        receipt({ id: 'current-3', daysAgo: 3, total: 300 }),
        receipt({ id: 'current-6', daysAgo: 6, total: 400 }),
        receipt({ id: 'previous-8', daysAgo: 8, total: 100 }),
        receipt({ id: 'previous-10', daysAgo: 10, total: 200 }),
        receipt({ id: 'previous-13', daysAgo: 13, total: 200 }),
      ],
      'week'
    );

    expect(insights.periodDays).toBe(7);
    expect(insights.currentStats.supportedReceiptCount).toBe(3);
    expect(insights.currentStats.supportedSpend).toBe(1_000);
    expect(insights.previousStats?.supportedReceiptCount).toBe(3);
    expect(insights.previousStats?.supportedSpend).toBe(500);
    expect(buildAnalysisSpendChangeSurface(insights)).toEqual({
      status: 'available',
      direction: 'up',
      absoluteDelta: 500,
      percentDelta: 100,
      periodDays: 7,
      currentSpend: 1_000,
      previousSpend: 500,
    });
  });
});
