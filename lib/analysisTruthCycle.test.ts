import type { ReceiptRow } from './db';
import { buildAnalysisSpendChangeSurface } from './analysisValueSurfaces';
import {
  buildAnalysisAllTimeStats,
  buildAnalysisTruthSnapshot,
} from './analysisTruthCycle';
import { selectAnalysisPeriodReceiptSets } from './analysisEligibility';
import * as analysisEligibility from './analysisEligibility';
import * as buildInsightsModule from './buildInsights';
import * as statsCalculator from './statsCalculator';

const NOW = Date.parse('2026-08-31T12:00:00+09:00');
const MS_DAY = 24 * 60 * 60 * 1000;

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> & { transaction_at?: number | null } = {}
): ReceiptRow {
  const transaction_at = overrides.transaction_at ?? NOW;
  return {
    id,
    created_at: overrides.created_at ?? NOW + 999_999,
    transaction_at,
    image_uri: '',
    total: overrides.total ?? 1000,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [
        {
          name: `Item-${id}`,
          lineTotal: overrides.total ?? 1000,
          quantity: 1,
          category: 'food_ingredients',
        },
      ],
    }),
    merchant_raw: overrides.merchant_raw ?? `Store-${id}`,
    merchant_normalized: overrides.merchant_normalized ?? `store-${id}`,
    merchant_type: overrides.merchant_type ?? 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    ...overrides,
  } as ReceiptRow;
}

describe('analysisTruthCycle production contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes the same nowMs to period stats, item count, and insights', () => {
    const periodSpy = jest.spyOn(
      analysisEligibility,
      'selectAnalysisPeriodReceiptSets'
    );
    const statsSpy = jest.spyOn(statsCalculator, 'calculateStats');
    const insightsSpy = jest.spyOn(buildInsightsModule, 'buildInsights');

    const rows = [
      receipt('a', { transaction_at: NOW - 1 * MS_DAY, total: 1500 }),
      receipt('b', { transaction_at: NOW - 5 * MS_DAY, total: 1500 }),
      receipt('c', { transaction_at: NOW - 10 * MS_DAY, total: 1500 }),
    ];

    buildAnalysisTruthSnapshot({
      receipts: rows,
      range: 'month',
      nowMs: NOW,
    });

    expect(periodSpy).toHaveBeenCalledWith(rows, 'month', NOW);
    expect(statsSpy).toHaveBeenCalledWith(expect.any(Array), 'all', NOW);
    expect(insightsSpy).toHaveBeenCalledWith(rows, 'month', {
      nowMs: NOW,
    });
  });

  it('keeps overview, item count, and insights aligned at an exact boundary', () => {
    const atStart = receipt('boundary', {
      transaction_at: NOW - 30 * MS_DAY,
      total: 2000,
    });
    const rows = [atStart];

    const snapshot = buildAnalysisTruthSnapshot({
      receipts: rows,
      range: 'month',
      nowMs: NOW,
    });

    expect(snapshot.periodStats.supportedReceiptCount).toBe(1);
    expect(snapshot.itemCount).toBe(1);
    expect(snapshot.insights.currentStats.supportedReceiptCount).toBe(1);
    expect(snapshot.insights.currentItemsCount).toBe(snapshot.itemCount);
    expect(snapshot.insights.currentStats.supportedSpend).toBe(
      snapshot.periodStats.supportedSpend
    );
  });

  it('expects duplicate-safe analytics receipts at the production boundary', () => {
    const keep = receipt('keep', {
      transaction_at: NOW - 1 * MS_DAY,
      total: 198,
    });
    const drop = receipt('drop', {
      transaction_at: NOW - 1 * MS_DAY,
      total: 198,
    });

    // Production passes selectAnalyticsReceipts(...).analyticsReceipts — simulate canonical only.
    const analyticsReceipts = [keep];
    const snapshot = buildAnalysisTruthSnapshot({
      receipts: analyticsReceipts,
      range: 'month',
      nowMs: NOW,
    });

    expect(snapshot.periodStats.supportedReceiptCount).toBe(1);
    expect(snapshot.insights.currentStats.supportedReceiptCount).toBe(1);
    expect([keep, drop].length).toBe(2);
  });
});

describe('all-range invalid transaction_at contract', () => {
  it('includes timestamp-invalid supported JPY in WHAT but suppresses unsafe CHANGE', () => {
    const valid = receipt('valid', {
      transaction_at: NOW - 10 * MS_DAY,
      total: 2000,
      created_at: NOW - 10 * MS_DAY,
    });
    const noTimestamp = receipt('no-ts', {
      transaction_at: null,
      total: 500,
      created_at: NOW - 1 * MS_DAY,
    });
    const unsupported = receipt('other', {
      transaction_at: NOW - 2 * MS_DAY,
      total: 9000,
      merchant_type: 'other',
    });
    const usd = receipt('usd', {
      transaction_at: NOW - 2 * MS_DAY,
      currency: 'USD',
      total: 100,
    });

    const rows = [valid, noTimestamp, unsupported, usd];
    const periodSets = selectAnalysisPeriodReceiptSets(rows, 'all', NOW);
    const allStats = buildAnalysisAllTimeStats({
      receipts: rows,
      nowMs: NOW,
    });
    const snapshot = buildAnalysisTruthSnapshot({
      receipts: rows,
      range: 'all',
      nowMs: NOW,
    });

    expect(periodSets.currentPeriodReceipts.map((r) => r.id).sort()).toEqual([
      'no-ts',
      'valid',
    ]);
    expect(allStats.supportedReceiptCount).toBe(2);
    expect(allStats.supportedSpend).toBe(2500);
    expect(snapshot.periodStats.supportedSpend).toBe(2500);
    expect(snapshot.itemCount).toBe(2);
    expect(snapshot.insights.currentStats.supportedSpend).toBe(2500);
    expect(snapshot.insights.previousStats).toBeNull();
    expect(
      buildAnalysisSpendChangeSurface(snapshot.insights).status
    ).toBe('unavailable');
  });
});
