import type * as SQLite from 'expo-sqlite';

/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptListRow } from './db';
import {
  normalizeReceiptItemSearchQuery,
  searchHistoryPurchasesWithDb,
  type ReceiptItemSearchDatabase,
  type ReceiptItemSearchResult,
} from './receiptItemSearch';

type SearchItemFixture = Omit<
  ReceiptItemSearchResult,
  | 'displayName'
  | 'transactionAt'
  | 'merchantRaw'
  | 'merchantNormalized'
  | 'merchantType'
>;

function receipt(
  id: string,
  transactionAt: number,
  merchant: string,
  note: string | null = null
): ReceiptListRow {
  return {
    id,
    created_at: transactionAt - 1,
    transaction_at: transactionAt,
    merchant_raw: merchant,
    merchant_normalized: merchant.toLowerCase(),
    merchant_type: 'convenience',
    total: 1000,
    tax: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: [] }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note,
    user_items_json: null,
  };
}

function item(
  receiptId: string,
  itemId: string,
  name: string,
  overrides: Partial<SearchItemFixture> = {}
): SearchItemFixture {
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    rawName: name,
    normalizedName: name.toLocaleLowerCase(),
    normalizedFullName: normalizeReceiptItemSearchQuery(name),
    canonicalProductName: null,
    brand: null,
    productFamilyKey: null,
    skuKey: null,
    category: 'food_ingredients',
    purchaseQuantity: 1,
    lineTotal: 300,
    ...overrides,
  };
}

function namedBinds(
  params: SQLite.SQLiteBindParams
): Record<string, SQLite.SQLiteBindValue> {
  return Array.isArray(params)
    ? {}
    : (params as Record<string, SQLite.SQLiteBindValue>);
}

class MemorySearchDb implements ReceiptItemSearchDatabase {
  readonly receipts = new Map<string, ReceiptListRow>();
  readonly items = new Map<string, SearchItemFixture>();
  readonly queries: string[] = [];

  async getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    this.queries.push(source);
    const binds = namedBinds(params);
    if (/FROM receipt_items/i.test(source)) {
      const query = String(binds.$exact ?? '');
      const limit = Number(binds.$itemLimit ?? 100);
      const searchableFields: (keyof SearchItemFixture)[] = [
        'rawName',
        'normalizedName',
        'normalizedFullName',
        'canonicalProductName',
        'brand',
        'productFamilyKey',
      ];
      return [...this.items.values()]
        .filter((candidate) => this.receipts.has(candidate.receiptId))
        .filter((candidate) =>
          searchableFields.some((field) =>
            normalizeReceiptItemSearchQuery(candidate[field]).includes(query)
          )
        )
        .map((candidate): ReceiptItemSearchResult => {
          const matchingReceipt = this.receipts.get(candidate.receiptId)!;
          return {
            ...candidate,
            displayName:
              candidate.normalizedFullName ||
              candidate.rawName ||
              candidate.canonicalProductName ||
              candidate.normalizedName ||
              '',
            transactionAt:
              matchingReceipt.transaction_at ?? matchingReceipt.created_at,
            merchantRaw: matchingReceipt.merchant_raw,
            merchantNormalized: matchingReceipt.merchant_normalized,
            merchantType: matchingReceipt.merchant_type ?? null,
          };
        })
        .sort(
          (left, right) =>
            right.transactionAt - left.transactionAt ||
            left.sourceIndex - right.sourceIndex
        )
        .slice(0, limit) as T[];
    }

    if (/FROM receipts/i.test(source)) {
      const contains = String(binds.$contains ?? '');
      const query = contains.slice(1, -1).replace(/\\([\\%_])/g, '$1');
      const limit = Number(binds.$receiptLimit ?? 100);
      return [...this.receipts.values()]
        .filter((candidate) =>
          [
            candidate.merchant_raw,
            candidate.merchant_normalized,
            candidate.note,
          ].some((field) =>
            normalizeReceiptItemSearchQuery(field).includes(query)
          )
        )
        .sort(
          (left, right) =>
            (right.transaction_at ?? right.created_at) -
            (left.transaction_at ?? left.created_at)
        )
        .slice(0, limit) as T[];
    }

    throw new Error(`Unexpected query: ${source}`);
  }
}

describe('normalizeReceiptItemSearchQuery', () => {
  it.each([
    ['  牛乳  ', '牛乳'],
    ['ＭＥＩＪＩ', 'meiji'],
    ['900ＭＬ', '900ml'],
    ['  明治   牛乳  ', '明治 牛乳'],
    ['   ', ''],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeReceiptItemSearchQuery(input)).toBe(expected);
  });
});

describe('searchHistoryPurchasesWithDb', () => {
  let db: MemorySearchDb;

  beforeEach(() => {
    db = new MemorySearchDb();
    db.receipts.set('new', receipt('new', 2000, 'FamilyMart'));
    db.receipts.set('old', receipt('old', 1000, 'Supermarket'));
    db.items.set(
      'new:0',
      item('new', 'new:0', '明治 おいしい牛乳 900ml', {
        canonicalProductName: '明治 おいしい牛乳',
        brand: '明治',
        productFamilyKey: 'milk',
        skuKey: 'meiji-milk-900',
      })
    );
    db.items.set(
      'old:0',
      item('old', 'old:0', '明治 おいしい牛乳 900ml', {
        canonicalProductName: '明治 おいしい牛乳',
        brand: '明治',
        productFamilyKey: 'milk',
        skuKey: 'meiji-milk-900',
      })
    );
  });

  it.each(['牛乳', '明治', '900ml', '900ＭＬ', 'milk'])(
    'matches indexed identity field: %s',
    async (query) => {
      const results = await searchHistoryPurchasesWithDb(db, query);
      expect(results.itemResults.map((result) => result.itemId)).toEqual([
        'new:0',
        'old:0',
      ]);
    }
  );

  it('returns recent purchases first and preserves one row per occurrence', async () => {
    db.items.set(
      'new:1',
      item('new', 'new:1', '別の牛乳 1L', {
        sourceIndex: 1,
        purchaseQuantity: 2,
      })
    );

    const results = await searchHistoryPurchasesWithDb(db, '牛乳');

    expect(results.itemResults.map((result) => result.itemId)).toEqual([
      'new:0',
      'new:1',
      'old:0',
    ]);
    expect(results.itemResults[1].purchaseQuantity).toBe(2);
    expect(
      (await searchHistoryPurchasesWithDb(db, '1Ｌ')).itemResults.map(
        (result) => result.itemId
      )
    ).toEqual(['new:1']);
  });

  it('returns sku_key additively for Product Detail target resolution', async () => {
    const results = await searchHistoryPurchasesWithDb(db, '900ml');
    expect(results.itemResults[0].skuKey).toBe('meiji-milk-900');
    expect(db.queries[0]).toMatch(/receipt_items\.sku_key AS skuKey/i);
  });

  it('uses receipt-only merchant fallback without returning unrelated items', async () => {
    const results = await searchHistoryPurchasesWithDb(db, 'FamilyMart');

    expect(results.itemResults).toEqual([]);
    expect(results.receiptResults.map((result) => result.id)).toEqual(['new']);
  });

  it('requires INNER JOIN receipts and excludes orphan items', async () => {
    db.items.set(
      'missing:0',
      item('missing', 'missing:0', '孤立商品ABC999')
    );

    const results = await searchHistoryPurchasesWithDb(db, '孤立商品ABC999');

    expect(results.itemResults).toEqual([]);
    expect(db.queries[0]).toMatch(
      /FROM receipt_items\s+INNER JOIN receipts/i
    );
  });

  it('reflects a user-edited reindex and removes the stale occurrence', async () => {
    db.items.set(
      'new:0',
      item('new', 'new:0', '明治 おいしい牛乳 450ml', {
        canonicalProductName: '明治 おいしい牛乳',
        brand: '明治',
        productFamilyKey: 'milk',
      })
    );

    expect(
      (await searchHistoryPurchasesWithDb(db, '450ml')).itemResults
    ).toHaveLength(1);
    expect(
      (await searchHistoryPurchasesWithDb(db, '900ml')).itemResults.map(
        (result) => result.itemId
      )
    ).toEqual(['old:0']);
  });

  it('matches multipack names without stripping their specification', async () => {
    db.items.set(
      'new:0',
      item('new', 'new:0', '水 500ml×6本', {
        productFamilyKey: 'water',
      })
    );

    expect(
      (await searchHistoryPurchasesWithDb(db, '500ml')).itemResults
    ).toHaveLength(1);
    expect(
      (await searchHistoryPurchasesWithDb(db, '水')).itemResults
    ).toHaveLength(1);
  });

  it('returns empty results for blank or unknown queries without throwing', async () => {
    await expect(searchHistoryPurchasesWithDb(db, '   ')).resolves.toEqual({
      itemResults: [],
      receiptResults: [],
    });
    await expect(
      searchHistoryPurchasesWithDb(db, '榴莲ABC999')
    ).resolves.toEqual({
      itemResults: [],
      receiptResults: [],
    });
  });
});
