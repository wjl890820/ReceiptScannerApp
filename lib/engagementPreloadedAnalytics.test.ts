/**
 * Round 6/7 — Home engagement preloaded path unit behavior.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    getAllAsync: jest.fn(async () => []),
  })),
}));
jest.mock('./env', () => ({
  isAnonAuthEnabled: () => false,
  getExtra: () => ({}),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./receiptOwnershipScope', () => ({
  resolveCurrentLocalReceiptOwnerScope: jest.fn(async () => ({
    status: 'ready',
    ownerKey: 'user:owner-a',
    receiptWhereSql: 'user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: ['owner-a'],
  })),
}));
jest.mock('./analyticsReceiptSelectionCache', () => {
  const actual = jest.requireActual('./analyticsReceiptSelectionCache');
  return {
    ...actual,
    selectAnalyticsReceiptsCached: jest.fn(() => {
      throw new Error('standalone_selection_should_not_run_when_preloaded');
    }),
  };
});

import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionBuildCount,
  getAnalyticsReceiptSelectionDataGeneration,
} from './analyticsReceiptSelectionCache';
import {
  evaluateCurrentEngagementMilestoneWithDb,
  loadEngagementProductInsightContextWithDb,
  type EngagementMilestoneDatabase,
  type EngagementPreloadedAnalyticsContext,
  type EngagementReceipt,
} from './engagementMilestones';

function receipt(id: string): EngagementReceipt {
  return {
    id,
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_000_000,
    transaction_time_precision: 'second',
    merchant_raw: 'Lawson',
    merchant_normalized: 'lawson',
    merchant_type: 'convenience',
    total: 100,
    tax: 0,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      total: 100,
      transactionDate: '2023-11-14 22:13:20',
      transaction_time_precision: 'second',
      items: [{ name: 'A', quantity: 1, unitPrice: 100, lineTotal: 100 }],
    }),
    final_total: null,
    user_items_json: null,
  };
}

describe('Round 6/7 engagement preloaded path', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
  });

  it('preloaded milestone does not query receipts table', async () => {
    const getAllAsync = jest.fn(async () => []);
    const db = { getAllAsync } as unknown as EngagementMilestoneDatabase;
    const rows = [receipt('r1'), receipt('r2')];
    const preloaded: EngagementPreloadedAnalyticsContext = {
      ownerKey: 'user:owner-a',
      receipts: rows,
      analyticsReceipts: rows,
      excludedDuplicateReceiptIds: new Set(),
      analyticsGeneration: getAnalyticsReceiptSelectionDataGeneration(),
      precomputedSelection: true,
      sharedProductInsight: Promise.resolve({
        rows: [],
        queryFailed: false,
      }),
    };
    const result = await evaluateCurrentEngagementMilestoneWithDb(db, {
      preloaded,
    });
    expect(result.status.supportedReceiptCount).toBeGreaterThanOrEqual(0);
    expect(getAllAsync).not.toHaveBeenCalled();
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(0);
  });

  it('shared product insight is awaited once for product context loader', async () => {
    let loads = 0;
    const shared = (async () => {
      loads += 1;
      return { rows: [], queryFailed: false };
    })();
    const db = {
      getAllAsync: jest.fn(async () => {
        throw new Error('should_not_query');
      }),
    } as unknown as EngagementMilestoneDatabase;
    const preloaded: EngagementPreloadedAnalyticsContext = {
      ownerKey: 'user:owner-a',
      receipts: [receipt('r1')],
      analyticsReceipts: [receipt('r1')],
      excludedDuplicateReceiptIds: new Set(),
      analyticsGeneration: getAnalyticsReceiptSelectionDataGeneration(),
      sharedProductInsight: shared,
    };
    const a = await loadEngagementProductInsightContextWithDb(db, { preloaded });
    const b = await loadEngagementProductInsightContextWithDb(db, { preloaded });
    expect(a).toBe(b);
    expect(loads).toBe(1);
  });
});
