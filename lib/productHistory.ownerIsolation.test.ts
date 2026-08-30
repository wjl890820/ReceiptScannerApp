/* eslint-disable import/first -- Jest mocks must run before imports. */
import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

const mockResolveIdentityConsumerObservations = jest.fn();
jest.mock('./productIdentityConsumer', () => ({
  resolveIdentityConsumerObservations: (...args: unknown[]) =>
    mockResolveIdentityConsumerObservations(...args),
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

import {
  loadProductHistoryWithDb,
  type ProductHistoryDatabase,
} from './productHistory';

type ReceiptRow = {
  id: string;
  userId: string | null;
  installationId: string | null;
  createdAt: number;
  transactionAt: number;
  merchantRaw: string;
  merchantNormalized: string;
  currency: string;
};

type ItemRow = {
  id: string;
  receiptId: string;
  sourceIndex: number;
  rawName: string;
  normalizedFullName: string;
  canonicalProductName: string | null;
  family: string | null;
  skuKey: string | null;
  quantity: number;
  lineTotal: number;
};

function bindValues(params: SQLite.SQLiteBindParams): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

function rowMatchesOwner(
  receipt: ReceiptRow,
  sql: string,
  ownerParam: SQLite.SQLiteBindValue
): boolean {
  if (/receipts\.user_id = \?/i.test(sql) && !/IS NULL/i.test(sql)) {
    return receipt.userId === ownerParam;
  }
  if (/installation_id = \?/i.test(sql) && /user_id IS NULL/i.test(sql)) {
    return (
      (receipt.userId == null || receipt.userId === '') &&
      receipt.installationId === ownerParam
    );
  }
  return true;
}

class OwnerIsolationHistoryDb implements ProductHistoryDatabase {
  readonly receipts = new Map<string, ReceiptRow>();
  readonly items: ItemRow[] = [];
  readonly queries: string[] = [];

  seedReceipt(receipt: ReceiptRow): void {
    this.receipts.set(receipt.id, receipt);
  }

  seedItem(item: ItemRow): void {
    this.items.push(item);
  }

  matching(source: string, params: SQLite.SQLiteBindParams): ItemRow[] {
    const values = bindValues(params);
    let items = this.items.filter((item) => this.receipts.has(item.receiptId));

    const hasOwner = /receipts\.user_id/i.test(source);
    if (/receipts\.user_id = \?/i.test(source) && !/IS NULL/i.test(source)) {
      const userId = values[0];
      items = items.filter(
        (item) => this.receipts.get(item.receiptId)!.userId === userId
      );
    } else if (/user_id IS NULL/i.test(source) && /installation_id = \?/i.test(source)) {
      const installationId = values[0];
      items = items.filter((item) => {
        const receipt = this.receipts.get(item.receiptId)!;
        return (
          (receipt.userId == null || receipt.userId === '') &&
          receipt.installationId === installationId
        );
      });
    }

    const targetParamIndex = hasOwner ? 1 : 0;
    if (/receipt_items\.sku_key = \?/i.test(source)) {
      items = items.filter((item) => item.skuKey === values[targetParamIndex]);
    } else if (/canonical_product_name = \?/i.test(source)) {
      items = items.filter(
        (item) => item.canonicalProductName === values[targetParamIndex]
      );
    } else if (/product_family_key = \?/i.test(source)) {
      items = items.filter((item) => item.family === values[targetParamIndex]);
    }

    const notInMatch = source.match(
      /receipt_items\.receipt_id NOT IN \(([^)]*)\)/i
    );
    const excludedCount = notInMatch
      ? (notInMatch[1].match(/\?/g) || []).length
      : 0;
    if (excludedCount > 0) {
      const limitOffset = /LIMIT \?/i.test(source) ? 1 : 0;
      const excluded = new Set(
        values
          .slice(
            values.length - excludedCount - limitOffset,
            values.length - limitOffset
          )
          .map(String)
      );
      items = items.filter((item) => !excluded.has(item.receiptId));
    }

    return items;
  }

  async getFirstAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T | null> {
    this.queries.push(source);
    const matching = this.matching(source, params);
    if (/COUNT\(DISTINCT receipt_items\.receipt_id\)/i.test(source)) {
      if (matching.length === 0) {
        return {
          purchaseOccurrenceCount: 0,
          totalPurchaseQuantity: 0,
          firstPurchasedAt: null,
          lastPurchasedAt: null,
          canonicalProductCount: 0,
          skuCount: 0,
        } as T;
      }
      return {
        purchaseOccurrenceCount: new Set(matching.map((row) => row.receiptId))
          .size,
        totalPurchaseQuantity: matching.reduce((sum, row) => sum + row.quantity, 0),
        firstPurchasedAt: 1,
        lastPurchasedAt: 2,
        canonicalProductCount: 1,
        skuCount: 1,
      } as T;
    }
    const latest = matching[0];
    if (!latest) return null;
    return {
      rawName: latest.rawName,
      normalizedFullName: latest.normalizedFullName,
      canonicalProductName: latest.canonicalProductName,
      specSizeValue: null,
      specSizeUnit: null,
      specPackCount: null,
      volumeBaseMl: null,
      weightBaseG: null,
      countBase: null,
      specSourceText: null,
    } as T;
  }

  async getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    this.queries.push(source);
    const matching = this.matching(source, params);
    if (/AS merchantRaw/i.test(source) && /AS receiptId/i.test(source)) {
      return matching.map((item) => {
        const receipt = this.receipts.get(item.receiptId)!;
        return {
          merchantRaw: receipt.merchantRaw,
          merchantNormalized: receipt.merchantNormalized,
          purchasedAt: receipt.transactionAt,
          receiptId: item.receiptId,
        };
      }) as T[];
    }
    if (/AS displayName/i.test(source)) {
      return matching.map((item) => ({
        receiptId: item.receiptId,
        itemId: item.id,
        sourceIndex: item.sourceIndex,
        displayName: item.rawName,
        category: null,
        purchaseQuantity: item.quantity,
        lineTotal: item.lineTotal,
        currency: 'JPY',
        purchasedAt: this.receipts.get(item.receiptId)!.transactionAt,
        merchantRaw: this.receipts.get(item.receiptId)!.merchantRaw,
        merchantNormalized: this.receipts.get(item.receiptId)!.merchantNormalized,
        rawName: item.rawName,
        specSizeValue: null,
        specSizeUnit: null,
        specPackCount: null,
        volumeBaseMl: null,
        weightBaseG: null,
        countBase: null,
        specSourceText: null,
      })) as T[];
    }
    if (/GROUP BY receipts\.currency/i.test(source)) {
      return [{ currency: 'JPY', totalSpend: matching.reduce((s, r) => s + r.lineTotal, 0) }] as T[];
    }
    return [] as T[];
  }
}

function setUserScope(userId: string) {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
    status: 'ready',
    ownerKey: `user:${userId}`,
    receiptWhereSql: 'receipts.user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: [userId],
  });
}

function setInstallationScope(installationId: string) {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
    status: 'ready',
    ownerKey: `installation:${installationId}`,
    receiptWhereSql:
      'receipts.user_id IS NULL AND receipts.installation_id = ?',
    itemWhereSql:
      'receipts.user_id IS NULL AND receipts.installation_id = ?',
    params: [installationId],
  });
}

describe('Product History owner isolation (Privacy-H3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUserScope('user-a');
    mockResolveIdentityConsumerObservations.mockImplementation(
      (observations: Array<{ receiptId: string; itemSourceIndex: number }>) => ({
        store: {},
        qualified: observations.map((obs) => ({
          ...obs,
          merchantProductId: 'mp-shared',
          purchaseUnitPrice: 100,
          quality: 'trusted',
          includeInHistory: true,
          includeInTrend: true,
          suspectedIntegerMultiple: null,
        })),
      })
    );
  });

  it('sku history uses only current user rows', async () => {
    const db = new OwnerIsolationHistoryDb();
    db.seedReceipt({
      id: 'a1',
      userId: 'user-a',
      installationId: null,
      createdAt: 1,
      transactionAt: 1,
      merchantRaw: 'A',
      merchantNormalized: 'a',
      currency: 'JPY',
    });
    db.seedReceipt({
      id: 'b1',
      userId: 'user-b',
      installationId: null,
      createdAt: 1,
      transactionAt: 1,
      merchantRaw: 'B',
      merchantNormalized: 'b',
      currency: 'JPY',
    });
    db.seedItem({
      id: 'a1:0',
      receiptId: 'a1',
      sourceIndex: 0,
      rawName: 'Milk',
      normalizedFullName: 'milk',
      canonicalProductName: null,
      family: null,
      skuKey: 'sku-x',
      quantity: 1,
      lineTotal: 100,
    });
    db.seedItem({
      id: 'b1:0',
      receiptId: 'b1',
      sourceIndex: 0,
      rawName: 'Milk',
      normalizedFullName: 'milk',
      canonicalProductName: null,
      family: null,
      skuKey: 'sku-x',
      quantity: 5,
      lineTotal: 900,
    });

    const summary = await loadProductHistoryWithDb(db, {
      type: 'sku',
      key: 'sku-x',
    });

    expect(summary).not.toBeNull();
    expect(summary!.purchaseOccurrenceCount).toBe(1);
    expect(summary!.totalPurchaseQuantity).toBe(1);
    expect(summary!.recentPurchases.map((row) => row.receiptId)).toEqual(['a1']);
    expect(db.queries.every((sql) => /receipts\.user_id = \?/i.test(sql))).toBe(
      true
    );
  });

  it('installation owner sees only NULL user_id + matching installation_id', async () => {
    setInstallationScope('install-i1');
    const db = new OwnerIsolationHistoryDb();
    const rows: ReceiptRow[] = [
      {
        id: 'owned',
        userId: null,
        installationId: 'install-i1',
        createdAt: 1,
        transactionAt: 1,
        merchantRaw: 'A',
        merchantNormalized: 'a',
        currency: 'JPY',
      },
      {
        id: 'other-install',
        userId: null,
        installationId: 'install-i2',
        createdAt: 1,
        transactionAt: 1,
        merchantRaw: 'B',
        merchantNormalized: 'b',
        currency: 'JPY',
      },
      {
        id: 'user-row',
        userId: 'user-u1',
        installationId: 'install-i1',
        createdAt: 1,
        transactionAt: 1,
        merchantRaw: 'C',
        merchantNormalized: 'c',
        currency: 'JPY',
      },
      {
        id: 'double-null',
        userId: null,
        installationId: null,
        createdAt: 1,
        transactionAt: 1,
        merchantRaw: 'D',
        merchantNormalized: 'd',
        currency: 'JPY',
      },
    ];
    for (const receipt of rows) {
      db.seedReceipt(receipt);
      db.seedItem({
        id: `${receipt.id}:0`,
        receiptId: receipt.id,
        sourceIndex: 0,
        rawName: 'Milk',
        normalizedFullName: 'milk',
        canonicalProductName: null,
        family: 'milk',
        skuKey: null,
        quantity: 1,
        lineTotal: 100,
      });
    }

    const summary = await loadProductHistoryWithDb(db, {
      type: 'family',
      key: 'milk',
    });

    expect(summary).not.toBeNull();
    expect(summary!.recentPurchases.map((row) => row.receiptId)).toEqual(['owned']);
  });

  it('owner unavailable returns null without querying', async () => {
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
      status: 'owner_unavailable',
    });
    const db = new OwnerIsolationHistoryDb();
    db.seedReceipt({
      id: 'a1',
      userId: 'user-a',
      installationId: null,
      createdAt: 1,
      transactionAt: 1,
      merchantRaw: 'A',
      merchantNormalized: 'a',
      currency: 'JPY',
    });
    db.seedItem({
      id: 'a1:0',
      receiptId: 'a1',
      sourceIndex: 0,
      rawName: 'Milk',
      normalizedFullName: 'milk',
      canonicalProductName: 'Milk',
      family: null,
      skuKey: null,
      quantity: 1,
      lineTotal: 100,
    });

    await expect(
      loadProductHistoryWithDb(db, { type: 'canonical', key: 'Milk' })
    ).resolves.toBeNull();
    expect(db.queries).toEqual([]);
  });

  it('merchant_product broad fetch is owner-bounded before identity consumer', async () => {
    const mpId = 'mp-shared';
    const db = new OwnerIsolationHistoryDb();
    for (const [id, userId, total] of [
      ['a1', 'user-a', 100],
      ['b1', 'user-b', 500],
    ] as const) {
      db.seedReceipt({
        id,
        userId,
        installationId: null,
        createdAt: 1,
        transactionAt: 1,
        merchantRaw: 'Store',
        merchantNormalized: 'store',
        currency: 'JPY',
      });
      db.seedItem({
        id: `${id}:0`,
        receiptId: id,
        sourceIndex: 0,
        rawName: 'Cola',
        normalizedFullName: 'cola',
        canonicalProductName: null,
        family: null,
        skuKey: null,
        quantity: 1,
        lineTotal: total,
      });
    }

    const summary = await loadProductHistoryWithDb(db, {
      type: 'merchant_product',
      key: mpId,
    });

    expect(summary).not.toBeNull();
    expect(summary!.purchaseOccurrenceCount).toBe(1);
    expect(summary!.recentPurchases.map((row) => row.receiptId)).toEqual(['a1']);
    expect(db.queries[0]).toMatch(/receipts\.user_id = \?/i);
    expect(db.queries[0]).toMatch(/\(receipts\.user_id = \?\)/i);
  });

  it('owner SQL and duplicate exclusion are independently applied', async () => {
    const db = new OwnerIsolationHistoryDb();
    for (const [id, userId] of [
      ['a1', 'user-a'],
      ['a2', 'user-a'],
      ['b1', 'user-b'],
    ] as const) {
      db.seedReceipt({
        id,
        userId,
        installationId: null,
        createdAt: 1,
        transactionAt: 1,
        merchantRaw: 'A',
        merchantNormalized: 'a',
        currency: 'JPY',
      });
      db.seedItem({
        id: `${id}:0`,
        receiptId: id,
        sourceIndex: 0,
        rawName: 'Milk',
        normalizedFullName: 'milk',
        canonicalProductName: 'Milk',
        family: null,
        skuKey: null,
        quantity: 1,
        lineTotal: 100,
      });
    }

    const summary = await loadProductHistoryWithDb(
      db,
      { type: 'canonical', key: 'Milk' },
      { excludedReceiptIds: new Set(['a2']) }
    );

    expect(summary).not.toBeNull();
    expect(summary!.recentPurchases.map((row) => row.receiptId)).toEqual(['a1']);
  });
});
