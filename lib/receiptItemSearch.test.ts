import type * as SQLite from 'expo-sqlite';

/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({ status: 'unauthenticated', userId: null })),
  subscribeAuthState: jest.fn(() => () => undefined),
  ensureAnonAuth: jest.fn(async () => undefined),
}));
jest.mock('./installationId', () => ({
  getOrCreateInstallationId: jest.fn(async () => 'install-test'),
}));
jest.mock('./receiptOwnershipScope', () => {
  const actual = jest.requireActual('./receiptOwnershipScope');
  return {
    ...actual,
    resolveCurrentLocalReceiptOwnerScope: jest.fn(async () => ({
      status: 'owner_unavailable',
    })),
  };
});

import type { ReceiptListRow } from './db';
import {
  normalizeReceiptItemSearchQuery,
  searchHistoryPurchasesWithDb,
  type ReceiptItemSearchDatabase,
  type ReceiptItemSearchResult,
} from './receiptItemSearch';

const USER_SCOPE = {
  status: 'ready' as const,
  ownerKey: 'user:search-test-user',
  receiptWhereSql: 'receipts.user_id = ?',
  itemWhereSql: 'receipts.user_id = ?',
  params: ['search-test-user'],
};

async function searchOwned(
  db: ReceiptItemSearchDatabase,
  query: string,
  options: Parameters<typeof searchHistoryPurchasesWithDb>[2] = {}
) {
  return searchHistoryPurchasesWithDb(db, query, {
    ...options,
    ownerScope: USER_SCOPE,
  });
}

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
  note: string | null = null,
  ownership: { user_id?: string | null; installation_id?: string | null } = {
    user_id: 'search-test-user',
    installation_id: null,
  }
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
    user_id: ownership.user_id ?? null,
    installation_id: ownership.installation_id ?? null,
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

function receiptMatchesOwnerScope(
  candidate: ReceiptListRow,
  source: string,
  binds: Record<string, SQLite.SQLiteBindValue>
): boolean {
  if (source.includes('$ownerScopeUserId')) {
    return candidate.user_id === binds.$ownerScopeUserId;
  }
  if (source.includes('$ownerScopeInstallationId')) {
    return (
      (candidate.user_id == null || candidate.user_id === '') &&
      candidate.installation_id === binds.$ownerScopeInstallationId
    );
  }
  return true;
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
        .filter((candidate) => {
          const matchingReceipt = this.receipts.get(candidate.receiptId)!;
          return receiptMatchesOwnerScope(matchingReceipt, source, binds);
        })
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
        .filter((candidate) => receiptMatchesOwnerScope(candidate, source, binds))
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
      const results = await searchOwned(db, query);
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

    const results = await searchOwned(db, '牛乳');

    expect(results.itemResults.map((result) => result.itemId)).toEqual([
      'new:0',
      'new:1',
      'old:0',
    ]);
    expect(results.itemResults[1].purchaseQuantity).toBe(2);
    expect(
      (await searchOwned(db, '1Ｌ')).itemResults.map(
        (result) => result.itemId
      )
    ).toEqual(['new:1']);
  });

  it('returns sku_key additively for Product Detail target resolution', async () => {
    const results = await searchOwned(db, '900ml');
    expect(results.itemResults[0].skuKey).toBe('meiji-milk-900');
    expect(db.queries[0]).toMatch(/receipt_items\.sku_key AS skuKey/i);
    expect(db.queries[0]).toMatch(/receipts\.user_id = \$ownerScopeUserId/i);
  });

  it('uses receipt-only merchant fallback without returning unrelated items', async () => {
    const results = await searchOwned(db, 'FamilyMart');

    expect(results.itemResults).toEqual([]);
    expect(results.receiptResults.map((result) => result.id)).toEqual(['new']);
  });

  it('returns only current-owner item search results', async () => {
    db.receipts.set(
      'foreign',
      receipt('foreign', 3000, 'ForeignMart', null, {
        user_id: 'foreign-user',
        installation_id: null,
      })
    );
    db.items.set(
      'foreign:0',
      item('foreign', 'foreign:0', '明治 おいしい牛乳 900ml', {
        canonicalProductName: '明治 おいしい牛乳',
        brand: '明治',
        productFamilyKey: 'milk',
        skuKey: 'meiji-milk-900',
      })
    );

    const results = await searchOwned(db, '牛乳');
    expect(results.itemResults.map((result) => result.receiptId)).toEqual([
      'new',
      'old',
    ]);
    expect(results.itemResults.some((result) => result.receiptId === 'foreign')).toBe(
      false
    );
  });

  it('returns only current-owner receipt search results', async () => {
    db.receipts.set(
      'foreign',
      receipt('foreign', 3000, 'ForeignMart', 'secret-note', {
        user_id: 'foreign-user',
        installation_id: null,
      })
    );

    const results = await searchOwned(db, 'secret-note');
    expect(results.receiptResults).toEqual([]);
    expect(results.itemResults).toEqual([]);
  });

  it('owner unavailable returns empty search results', async () => {
    const results = await searchHistoryPurchasesWithDb(db, '牛乳', {
      ownerScope: { status: 'owner_unavailable' },
    });
    expect(results).toEqual({ itemResults: [], receiptResults: [] });
  });

  it('requires INNER JOIN receipts and excludes orphan items', async () => {
    db.items.set(
      'missing:0',
      item('missing', 'missing:0', '孤立商品ABC999')
    );

    const results = await searchOwned(db, '孤立商品ABC999');

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
      (await searchOwned(db, '450ml')).itemResults
    ).toHaveLength(1);
    expect(
      (await searchOwned(db, '900ml')).itemResults.map(
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
      (await searchOwned(db, '500ml')).itemResults
    ).toHaveLength(1);
    expect(
      (await searchOwned(db, '水')).itemResults
    ).toHaveLength(1);
  });

  it('returns empty results for blank or unknown queries without throwing', async () => {
    await expect(searchOwned(db, '   ')).resolves.toEqual({
      itemResults: [],
      receiptResults: [],
    });
    await expect(
      searchOwned(db, '榴莲ABC999')
    ).resolves.toEqual({
      itemResults: [],
      receiptResults: [],
    });
  });
});
