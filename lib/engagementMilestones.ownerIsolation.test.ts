/* eslint-disable import/first -- Jest mocks must run before imports. */
import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
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

import * as ExpoSQLite from 'expo-sqlite';
import * as analyticsReceiptSelection from './analyticsReceiptSelection';

import {
  evaluateCurrentEngagementMilestoneWithDb,
  evaluateEngagementMilestonesWithDb,
  evaluateSavedReceiptMilestoneWithDb,
  frequentProductGroups,
  loadEngagementProductInsightContext,
  type EngagementMilestoneDatabase,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';

const DAY_MS = 24 * 60 * 60 * 1000;

type OwnedReceipt = EngagementReceipt & {
  user_id: string | null;
  installation_id: string | null;
};

function item(name: string, category: string, lineTotal: number) {
  return { name, category, lineTotal, quantity: 1 };
}

function receipt(
  id: string,
  overrides: Partial<OwnedReceipt> = {}
): OwnedReceipt {
  const numericId = Number(id.replace(/\D/g, '')) || 1;
  return {
    id,
    created_at: numericId * DAY_MS,
    transaction_at: numericId * DAY_MS,
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    total: 198,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [item('明治おいしい牛乳', 'food_ingredients', 198)],
    }),
    final_total: null,
    user_items_json: null,
    user_id: 'user-a',
    installation_id: null,
    ...overrides,
  };
}

function productRow(
  receiptId: string,
  itemId: string,
  overrides: Partial<EngagementProductRow> = {}
): EngagementProductRow {
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    occurredAt: Number(receiptId.replace(/\D/g, '')) * DAY_MS,
    merchantRaw: 'イオン',
    merchantNormalized: 'イオン',
    merchant_type: 'supermarket',
    analysis_json: '{}',
    displayName: '明治おいしい牛乳',
    currency: 'JPY',
    lineTotal: 198,
    purchaseQuantity: 1,
    canonicalProductName: 'Milk',
    productFamilyKey: null,
    skuKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    grossLineAmount: 198,
    effectiveLineAmount: 198,
    priceObservationVersion: 1,
    itemAmountEvidenceState: 'coherent',
    amountProvenance: 'ocr_observed',
    evidenceCaptureVersion: 1,
    receiptAnalysisJson: JSON.stringify({
      items: [{ name: '明治おいしい牛乳', lineTotal: 198, quantity: 1 }],
      evidenceCaptureVersion: 1,
      reconciliation: { ok: true },
      amount_mismatch: false,
    }),
    ...overrides,
  };
}

function bindValues(params: SQLite.SQLiteBindParams): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

function receiptMatchesOwner(
  row: OwnedReceipt,
  sql: string,
  ownerParam: SQLite.SQLiteBindValue
): boolean {
  if (/receipts\.user_id = \?/i.test(sql) && !/IS NULL/i.test(sql)) {
    return row.user_id === ownerParam;
  }
  if (/user_id IS NULL/i.test(sql) && /installation_id = \?/i.test(sql)) {
    return (
      (row.user_id == null || row.user_id === '') &&
      row.installation_id === ownerParam
    );
  }
  return true;
}

class OwnerIsolationEngagementDb implements EngagementMilestoneDatabase {
  readonly receipts = new Map<string, OwnedReceipt>();
  readonly productRows: EngagementProductRow[] = [];
  readonly queries: { source: string; params: SQLite.SQLiteBindValue[] }[] = [];

  seedReceipt(source: OwnedReceipt): void {
    this.receipts.set(source.id, source);
  }

  seedProductRow(row: EngagementProductRow): void {
    this.productRows.push(row);
  }

  private matchingReceipts(
    sql: string,
    params: SQLite.SQLiteBindParams
  ): OwnedReceipt[] {
    const values = bindValues(params);
    let rows = [...this.receipts.values()];
    if (/WHERE/i.test(sql)) {
      const ownerParam = values[0];
      rows = rows.filter((row) => receiptMatchesOwner(row, sql, ownerParam));
    }
    return rows.sort(
      (left, right) =>
        (left.transaction_at ?? left.created_at) -
          (right.transaction_at ?? right.created_at) ||
        left.id.localeCompare(right.id)
    );
  }

  private matchingProductRows(
    sql: string,
    params: SQLite.SQLiteBindParams
  ): EngagementProductRow[] {
    const values = bindValues(params);
    let rows = this.productRows.filter((row) => this.receipts.has(row.receiptId));
    if (/WHERE/i.test(sql)) {
      const ownerParam = values[0];
      rows = rows.filter((row) => {
        const receiptRow = this.receipts.get(row.receiptId)!;
        return receiptMatchesOwner(receiptRow, sql, ownerParam);
      });
    }
    return rows.sort(
      (left, right) =>
        left.occurredAt - right.occurredAt ||
        left.receiptId.localeCompare(right.receiptId) ||
        left.sourceIndex - right.sourceIndex
    );
  }

  async getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    this.queries.push({ source, params: bindValues(params) });
    if (/FROM receipts/i.test(source)) {
      return this.matchingReceipts(source, params) as T[];
    }
    if (/FROM receipt_items/i.test(source)) {
      return this.matchingProductRows(source, params) as T[];
    }
    return [] as T[];
  }
}

function userOwnerScope(userId: string) {
  return {
    status: 'ready' as const,
    ownerKey: `user:${userId}`,
    receiptWhereSql: 'receipts.user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: [userId],
  };
}

function installationOwnerScope(installationId: string) {
  return {
    status: 'ready' as const,
    ownerKey: `installation:${installationId}`,
    receiptWhereSql:
      'receipts.user_id IS NULL AND receipts.installation_id = ?',
    itemWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
    params: [installationId],
  };
}

beforeEach(() => {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue(
    userOwnerScope('user-a')
  );
  (ExpoSQLite.openDatabaseAsync as jest.Mock).mockImplementation(
    async () => activeEngagementDb
  );
});

afterEach(() => {
  jest.restoreAllMocks();
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue(
    userOwnerScope('user-a')
  );
});

let activeEngagementDb: OwnerIsolationEngagementDb;

describe('Engagement Milestones owner isolation (Privacy-H4)', () => {
  it('milestone count uses only current user receipts', async () => {
    const db = new OwnerIsolationEngagementDb();
    activeEngagementDb = db;
    for (let index = 1; index <= 2; index += 1) {
      db.seedReceipt(receipt(`a${index}`, { user_id: 'user-a' }));
    }
    for (let index = 1; index <= 8; index += 1) {
      db.seedReceipt(receipt(`b${index}`, { user_id: 'user-b' }));
    }

    const evaluation = await evaluateCurrentEngagementMilestoneWithDb(db);

    expect(evaluation.status.supportedReceiptCount).toBe(2);
    expect(evaluation.status.currentMilestone).toBe(1);
    expect(evaluation.status.nextMilestone).toBe(3);
    expect(db.queries[0].source).toMatch(/WHERE receipts\.user_id = \?/i);
    expect(db.queries[0].params).toEqual(['user-a']);
  });

  it('installation owner matrix hides foreign and legacy rows', async () => {
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue(
      installationOwnerScope('install-i1')
    );
    const db = new OwnerIsolationEngagementDb();
    db.seedReceipt(
      receipt('visible', {
        user_id: null,
        installation_id: 'install-i1',
      })
    );
    db.seedReceipt(
      receipt('foreign-install', {
        user_id: null,
        installation_id: 'install-i2',
      })
    );
    db.seedReceipt(
      receipt('foreign-user', {
        user_id: 'user-u1',
        installation_id: 'install-i1',
      })
    );
    db.seedReceipt(
      receipt('double-null', {
        user_id: null,
        installation_id: null,
      })
    );

    const evaluation = await evaluateCurrentEngagementMilestoneWithDb(db);

    expect(evaluation.status.supportedReceiptCount).toBe(1);
    expect(db.queries[0].source).toMatch(/installation_id = \?/i);
    expect(db.queries[0].params).toEqual(['install-i1']);
  });

  it('owner unavailable performs zero DB reads and returns empty semantics', async () => {
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
      status: 'owner_unavailable',
    });
    const getAllAsync = jest.fn();
    const db: EngagementMilestoneDatabase = { getAllAsync };

    const current = await evaluateCurrentEngagementMilestoneWithDb(db);
    const saved = await evaluateSavedReceiptMilestoneWithDb(db, 'any');
    const milestones = await evaluateEngagementMilestonesWithDb(db, {
      beforeSupportedReceiptCount: 2,
    });
    const context = await loadEngagementProductInsightContext();

    expect(getAllAsync).not.toHaveBeenCalled();
    expect(current.status.supportedReceiptCount).toBe(0);
    expect(current.currentResult).toBeNull();
    expect(saved.status.supportedReceiptCount).toBe(0);
    expect(saved.unlockedResult).toBeNull();
    expect(milestones.status.supportedReceiptCount).toBe(0);
    expect(context).toEqual({ rows: [], queryFailed: false });
  });

  it('duplicate selection runs inside owner universe only', async () => {
    const duplicateAt = DAY_MS;
    const db = new OwnerIsolationEngagementDb();
    const duplicateLikeItems = [item('明治おいしい牛乳', 'food_ingredients', 198)];
    db.seedReceipt(
      receipt('A1', {
        user_id: 'user-a',
        created_at: duplicateAt,
        transaction_at: duplicateAt,
        analysis_json: JSON.stringify({ items: duplicateLikeItems }),
      })
    );
    db.seedReceipt(
      receipt('B1', {
        user_id: 'user-b',
        created_at: duplicateAt + 1,
        transaction_at: duplicateAt,
        analysis_json: JSON.stringify({ items: duplicateLikeItems }),
      })
    );

    const selectSpy = jest.spyOn(
      analyticsReceiptSelection,
      'selectAnalyticsReceipts'
    );

    const evaluation = await evaluateCurrentEngagementMilestoneWithDb(db);

    expect(selectSpy).toHaveBeenCalled();
    const duplicateSelectorInputIds = selectSpy.mock.calls[0][0].map(
      (row) => row.id
    );
    expect(duplicateSelectorInputIds).toEqual(['A1']);
    expect(duplicateSelectorInputIds).not.toContain('B1');
    expect(evaluation.status.supportedReceiptCount).toBe(1);
    expect(
      evaluation.currentResult &&
        'receiptId' in evaluation.currentResult &&
        evaluation.currentResult.receiptId
    ).toBe('A1');
  });

  it('same-owner duplicate exclusion still applies after owner SQL', async () => {
    const duplicateAt = DAY_MS;
    const db = new OwnerIsolationEngagementDb();
    db.seedReceipt(
      receipt('a1', {
        user_id: 'user-a',
        created_at: duplicateAt,
        transaction_at: duplicateAt,
      })
    );
    db.seedReceipt(
      receipt('a2', {
        user_id: 'user-a',
        created_at: duplicateAt + 1,
        transaction_at: duplicateAt,
      })
    );

    const evaluation = await evaluateCurrentEngagementMilestoneWithDb(db);

    expect(evaluation.status.supportedReceiptCount).toBe(1);
  });

  it('product insight rows exclude foreign owner and apply duplicate exclusion', async () => {
    const duplicateAt = DAY_MS;
    const db = new OwnerIsolationEngagementDb();
    activeEngagementDb = db;
    const duplicateLikeItems = [item('明治おいしい牛乳', 'food_ingredients', 198)];
    db.seedReceipt(
      receipt('A1', {
        user_id: 'user-a',
        created_at: duplicateAt,
        transaction_at: duplicateAt,
        analysis_json: JSON.stringify({ items: duplicateLikeItems }),
      })
    );
    db.seedReceipt(
      receipt('A2', {
        user_id: 'user-a',
        created_at: duplicateAt + 1,
        transaction_at: duplicateAt,
        analysis_json: JSON.stringify({ items: duplicateLikeItems }),
      })
    );
    db.seedReceipt(
      receipt('B1', {
        user_id: 'user-b',
        created_at: duplicateAt + 2,
        transaction_at: duplicateAt + 2,
        analysis_json: JSON.stringify({
          items: [item('Foreign Milk', 'food_ingredients', 2000)],
        }),
      })
    );
    db.seedProductRow(
      productRow('A1', 'a1-item', {
        canonicalProductName: 'Milk',
        displayName: 'Milk',
        lineTotal: 100,
        grossLineAmount: 100,
        effectiveLineAmount: 100,
        purchaseQuantity: 1,
      })
    );
    db.seedProductRow(
      productRow('A2', 'a2-item', {
        canonicalProductName: 'Milk',
        displayName: 'Milk',
        lineTotal: 900,
        grossLineAmount: 900,
        effectiveLineAmount: 900,
        purchaseQuantity: 9,
      })
    );
    db.seedProductRow(
      productRow('B1', 'b1-item', {
        canonicalProductName: 'ForeignMilk',
        displayName: 'Foreign Milk',
        lineTotal: 2000,
        grossLineAmount: 2000,
        effectiveLineAmount: 2000,
        purchaseQuantity: 20,
      })
    );

    const context = await loadEngagementProductInsightContext();

    expect(context.queryFailed).toBe(false);
    expect(context.rows.map((row) => row.receiptId)).toEqual(['A1']);
    expect(context.rows).toHaveLength(1);
    expect(context.rows.some((row) => row.receiptId === 'A2')).toBe(false);
    expect(context.rows.some((row) => row.receiptId === 'B1')).toBe(false);
    expect(context.rows[0]).toMatchObject({
      receiptId: 'A1',
      canonicalProductName: 'Milk',
      lineTotal: 100,
      purchaseQuantity: 1,
    });

    const totalQuantity = context.rows.reduce(
      (sum, row) => sum + (row.purchaseQuantity ?? 0),
      0
    );
    const totalLineTotal = context.rows.reduce(
      (sum, row) => sum + (row.lineTotal ?? 0),
      0
    );
    expect(totalQuantity).toBe(1);
    expect(totalLineTotal).toBe(100);

    const groups = frequentProductGroups(
      [receipt('A1', { user_id: 'user-a' })],
      context
    );
    expect(groups.frequentProducts).toHaveLength(0);
    expect(
      context.rows.some((row) => row.canonicalProductName === 'ForeignMilk')
    ).toBe(false);
    expect(
      db.queries.some(
        (query) =>
          /FROM receipt_items/i.test(query.source) &&
          /WHERE receipts\.user_id = \?/i.test(query.source)
      )
    ).toBe(true);
  });

  it('foreign product rows cannot change frequent-product ranking', async () => {
    const db = new OwnerIsolationEngagementDb();
    for (let index = 1; index <= 5; index += 1) {
      db.seedReceipt(receipt(`a${index}`, { user_id: 'user-a' }));
    }
    for (let index = 1; index <= 5; index += 1) {
      db.seedReceipt(receipt(`b${index}`, { user_id: 'user-b' }));
    }
    db.seedProductRow(
      productRow('a1', 'a1-milk', { canonicalProductName: 'OwnerMilk' })
    );
    db.seedProductRow(
      productRow('a2', 'a2-milk', { canonicalProductName: 'OwnerMilk' })
    );
    for (let index = 1; index <= 5; index += 1) {
      db.seedProductRow(
        productRow(`b${index}`, `b${index}-milk`, {
          canonicalProductName: 'ForeignMilk',
        })
      );
    }

    const evaluation = await evaluateCurrentEngagementMilestoneWithDb(db);
    const milestone =
      evaluation.currentResult?.milestone === 5
        ? evaluation.currentResult
        : null;

    expect(milestone?.frequentProducts.map((product) => product.key)).toEqual([
      'OwnerMilk',
    ]);
    expect(milestone?.frequentProducts[0]?.purchaseOccurrenceCount).toBe(2);
    expect(
      milestone?.frequentProducts.some((product) => product.key === 'ForeignMilk')
    ).toBe(false);
  });

  it('saved foreign receipt ID cannot unlock milestone for current owner', async () => {
    const db = new OwnerIsolationEngagementDb();
    db.seedReceipt(receipt('a1', { user_id: 'user-a' }));
    db.seedReceipt(receipt('a2', { user_id: 'user-a' }));
    for (let index = 1; index <= 8; index += 1) {
      db.seedReceipt(receipt(`b${index}`, { user_id: 'user-b' }));
    }

    const evaluation = await evaluateSavedReceiptMilestoneWithDb(db, 'b1');

    expect(evaluation.status.supportedReceiptCount).toBe(2);
    expect(evaluation.status.justUnlocked).toBeNull();
    expect(evaluation.unlockedResult).toBeNull();
  });

  it('current owner saved receipt unlock remains correct', async () => {
    const db = new OwnerIsolationEngagementDb();
    db.seedReceipt(receipt('a1', { user_id: 'user-a' }));
    db.seedReceipt(receipt('a2', { user_id: 'user-a' }));
    db.seedReceipt(receipt('a3', { user_id: 'user-a' }));
    for (let index = 1; index <= 8; index += 1) {
      db.seedReceipt(receipt(`b${index}`, { user_id: 'user-b' }));
    }

    const evaluation = await evaluateSavedReceiptMilestoneWithDb(db, 'a3', {
      generatedAt: 777,
    });

    expect(evaluation.status).toMatchObject({
      supportedReceiptCount: 3,
      justUnlocked: 3,
    });
    expect(evaluation.unlockedResult).toMatchObject({
      milestone: 3,
      generatedAt: 777,
    });
  });
});
