/**
 * Round 7 A2 — full-history engagement preloaded path.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./env', () => ({
  isAnonAuthEnabled: () => false,
  getExtra: () => ({}),
}));
jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({ status: 'unauthenticated', userId: null })),
  subscribeAuthState: jest.fn(() => () => undefined),
  ensureAnonAuth: jest.fn(async () => undefined),
}));
jest.mock('./currentItemMonetaryTruth', () => ({
  enrichProductRowsWithCurrentItemMonetaryTruth: async (rows: unknown[]) => rows,
  applyCurrentItemMonetaryTruthToAnalysisItems: (
    _analysisJson: unknown,
    items: unknown[]
  ) => items,
}));
jest.mock('./productPriceHistory', () => ({
  buildProductPriceHistory: jest.fn(),
}));

const mockResolveCurrentLocalReceiptOwnerScope = jest.fn();
jest.mock('./receiptOwnershipScope', () => {
  const actual = jest.requireActual('./receiptOwnershipScope');
  return {
    ...actual,
    resolveCurrentLocalReceiptOwnerScope: (...args: unknown[]) =>
      mockResolveCurrentLocalReceiptOwnerScope(...args),
  };
});

import * as analyticsReceiptSelection from './analyticsReceiptSelection';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  selectAnalyticsReceiptsCached,
} from './analyticsReceiptSelectionCache';
import {
  evaluateCurrentEngagementMilestoneWithDb,
  loadEngagementProductInsightContextWithDb,
  type EngagementMilestoneDatabase,
  type EngagementPreloadedAnalyticsContext,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';

void analyticsReceiptSelection;

const OWNER_A = 'user:owner-a';
const OWNER_B = 'user:owner-b';

function ownerScope(ownerKey: string, userId: string) {
  return {
    status: 'ready' as const,
    ownerKey,
    receiptWhereSql: 'user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: [userId],
  };
}

function receipt(id: string, createdAt: number): EngagementReceipt {
  return {
    id,
    created_at: createdAt,
    transaction_at: createdAt,
    merchant_raw: 'Lawson',
    merchant_normalized: 'lawson',
    merchant_type: 'convenience',
    total: 100,
    tax: 0,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      total: 100,
      items: [{ name: 'A', quantity: 1, unitPrice: 100, lineTotal: 100 }],
    }),
    final_total: null,
    user_items_json: null,
    user_edited: 0,
    note: null,
  };
}

function duplicatePair(
  keepId: string,
  dropId: string,
  at: number
): EngagementReceipt[] {
  const body = JSON.stringify({
    total: 198,
    items: [
      {
        name: '明治おいしい牛乳',
        quantity: 1,
        unitPrice: 198,
        lineTotal: 198,
      },
    ],
  });
  return [
    {
      ...receipt(keepId, at),
      total: 198,
      analysis_json: body,
    },
    {
      ...receipt(dropId, at + 1),
      total: 198,
      transaction_at: at,
      analysis_json: body,
    },
  ];
}

class MemoryEngagementDb implements EngagementMilestoneDatabase {
  constructor(
    readonly receipts: EngagementReceipt[],
    readonly productRows: EngagementProductRow[] = []
  ) {}

  async getAllAsync<T>(source: string): Promise<T[]> {
    if (/FROM receipts/i.test(source) && !/receipt_items/i.test(source)) {
      return [...this.receipts] as T[];
    }
    if (/receipt_items/i.test(source)) {
      return [...this.productRows] as T[];
    }
    return [];
  }
}

describe('Round 7 A2 full-history engagement preloaded', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue(
      ownerScope(OWNER_A, 'owner-a')
    );
  });

  it('T5 >200 receipt equivalence: preloaded matches standalone', async () => {
    const rows = Array.from({ length: 205 }, (_, i) =>
      receipt(`r${i}`, Date.parse('2026-08-22T12:00:00+09:00') + i * 60_000)
    );
    const db = new MemoryEngagementDb(rows);
    const standalone = await evaluateCurrentEngagementMilestoneWithDb(db);

    const decision = selectAnalyticsReceiptsCached({
      ownerKey: OWNER_A,
      receipts: rows as never,
    })!;
    const preloaded: EngagementPreloadedAnalyticsContext = {
      ownerKey: OWNER_A,
      receipts: rows,
      analyticsReceipts: decision.analyticsReceipts as EngagementReceipt[],
      excludedDuplicateReceiptIds: decision.excludedDuplicateReceiptIds,
      precomputedSelection: true,
      sharedProductInsight: Promise.resolve({
        rows: [],
        queryFailed: false,
      }),
    };
    const preloadedEval = await evaluateCurrentEngagementMilestoneWithDb(db, {
      preloaded,
    });
    expect(preloadedEval.status.supportedReceiptCount).toBe(
      standalone.status.supportedReceiptCount
    );
    expect(preloadedEval.status.currentMilestone).toBe(
      standalone.status.currentMilestone
    );
    expect(preloadedEval.status.supportedReceiptCount).toBe(205);
  });

  it('T6 duplicate outside latest 200 uses full-history exclusion', async () => {
    const newest = Array.from({ length: 200 }, (_, i) =>
      receipt(`new${i}`, Date.parse('2026-08-22T12:00:00+09:00') + i * 60_000)
    );
    const at = Date.parse('2025-01-15T15:30:00+09:00');
    const [keep, drop] = duplicatePair('old-keep', 'old-drop', at);
    const productRows = [
      {
        receiptId: drop.id,
        itemId: 'item-drop',
        sourceIndex: 0,
        occurredAt: at,
        merchantRaw: 'Lawson',
        displayName: '明治おいしい牛乳',
        rawName: '明治おいしい牛乳',
        normalizedName: '明治おいしい牛乳',
        quantity: 1,
        unitPrice: 198,
        lineTotal: 198,
        currency: 'JPY',
        merchant_type: 'convenience',
        canonicalProductName: null,
        productFamilyKey: null,
        skuKey: null,
        transaction_at: at,
        created_at: at + 1,
      } as unknown as EngagementProductRow,
    ];
    const full = [...newest, keep, drop];
    const db = new MemoryEngagementDb(full, productRows);

    const selection = selectAnalyticsReceiptsCached({
      ownerKey: OWNER_A,
      receipts: full as never,
    })!;
    expect(selection.excludedDuplicateReceiptIds.has(drop.id)).toBe(true);

    const preloaded: EngagementPreloadedAnalyticsContext = {
      ownerKey: OWNER_A,
      receipts: full,
      analyticsReceipts: selection.analyticsReceipts as EngagementReceipt[],
      excludedDuplicateReceiptIds: selection.excludedDuplicateReceiptIds,
      precomputedSelection: true,
    };
    const insight = await loadEngagementProductInsightContextWithDb(db, {
      preloaded,
    });
    expect(insight.rows.every((row) => row.receiptId !== drop.id)).toBe(true);
  });

  it('T7 owner mismatch rejects preloaded context', async () => {
    const rows = [receipt('r1', 1), receipt('r2', 2), receipt('r3', 3)];
    const db = new MemoryEngagementDb(rows);
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue(
      ownerScope(OWNER_B, 'owner-b')
    );
    const getAllAsync = jest.spyOn(db, 'getAllAsync');
    const preloaded: EngagementPreloadedAnalyticsContext = {
      ownerKey: OWNER_A,
      receipts: rows,
      analyticsReceipts: rows,
      excludedDuplicateReceiptIds: new Set(),
      precomputedSelection: true,
      sharedProductInsight: Promise.resolve({
        rows: [{ receiptId: 'poison' } as EngagementProductRow],
        queryFailed: false,
      }),
    };
    const evaluation = await evaluateCurrentEngagementMilestoneWithDb(db, {
      preloaded,
    });
    expect(getAllAsync).toHaveBeenCalled();
    expect(evaluation.status.supportedReceiptCount).toBe(3);
  });

  it('T8 display slice independence: engagement can count >200 while display is 200', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const homeSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    expect(homeSource).toContain('loadEngagementOwnerReceiptsWithDb');
    expect(homeSource).toContain('listReceipts()');
    expect(homeSource).toContain('fullHistoryCount=');
  });
});
