/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  buildProductPriceHistory,
  loadProductPriceHistoryWithDb,
  type ProductPriceHistoryDatabase,
  type ProductPriceHistoryRow,
} from './productPriceHistory';

function row(
  id: string,
  overrides: Partial<ProductPriceHistoryRow> = {}
): ProductPriceHistoryRow {
  return {
    receiptId: `receipt-${id}`,
    itemId: `item-${id}`,
    sourceIndex: 0,
    occurredAt: Number(id.replace(/\D/g, '')) || 1,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    displayName: `Product ${id}`,
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    productFamilyKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    ...overrides,
  };
}

describe('SKU price history', () => {
  it('uses purchase-unit prices for the exact SKU', () => {
    const result = buildProductPriceHistory(
      { type: 'sku', key: 'meiji-900' },
      [
        row('1', { lineTotal: 238 }),
        row('2', { lineTotal: 248 }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.priceKind).toBe('purchase_unit');
    expect(result.points.map((point) => point.priceValue)).toEqual([238, 248]);
  });

  it('divides line total by purchase quantity defensively', () => {
    const result = buildProductPriceHistory(
      { type: 'sku', key: 'meiji-900' },
      [
        row('1', { lineTotal: 476, purchaseQuantity: 2 }),
        row('2', { lineTotal: 238, purchaseQuantity: 1 }),
      ]
    );

    expect(result.points.map((point) => point.priceValue)).toEqual([238, 238]);
  });
});

describe('canonical normalized price history', () => {
  it('normalizes compatible volume variants to price per liter', () => {
    const result = buildProductPriceHistory(
      { type: 'canonical', key: '明治 おいしい牛乳' },
      [
        row('1', {
          lineTotal: 238,
          volumeBaseMl: 900,
          productFamilyKey: 'milk',
        }),
        row('2', {
          lineTotal: 138,
          volumeBaseMl: 450,
          productFamilyKey: 'milk',
        }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.priceKind).toBe('per_liter');
    expect(result.points[0].priceValue).toBeCloseTo(264.44, 2);
    expect(result.points[1].priceValue).toBeCloseTo(306.67, 2);
  });

  it('refuses to combine conflicting dimensions', () => {
    const result = buildProductPriceHistory(
      { type: 'canonical', key: 'ambiguous product' },
      [
        row('1', { volumeBaseMl: 900 }),
        row('2', { weightBaseG: 450 }),
      ]
    );

    expect(result.status).toBe('ambiguous_dimension');
    expect(result.points).toEqual([]);
    expect(result.excludedOccurrenceCount).toBe(2);
  });

  it('does not treat an unvalidated numeric name fragment as specification', () => {
    const result = buildProductPriceHistory(
      { type: 'canonical', key: '午後の紅茶' },
      [
        row('1', { displayName: '午後の紅茶 500' }),
        row('2', { displayName: '午後の紅茶 500' }),
      ]
    );

    expect(result.status).toBe('no_comparable_spec');
  });
});

describe('family allowlist and formulas', () => {
  it('normalizes milk brands by volume only', () => {
    const result = buildProductPriceHistory(
      { type: 'family', key: 'milk' },
      [
        row('1', { lineTotal: 238, volumeBaseMl: 900, productFamilyKey: 'milk' }),
        row('2', { lineTotal: 248, volumeBaseMl: 1000, productFamilyKey: 'milk' }),
        row('3', { lineTotal: 218, volumeBaseMl: 1000, productFamilyKey: 'milk' }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.points.map((point) => point.priceValue)).toEqual([
      expect.closeTo(264.44, 2),
      248,
      218,
    ]);
  });

  it('uses total multipack volume and purchase quantity', () => {
    const result = buildProductPriceHistory(
      { type: 'family', key: 'water' },
      [
        row('1', {
          lineTotal: 1200,
          purchaseQuantity: 2,
          volumeBaseMl: 3000,
          productFamilyKey: 'water',
        }),
        row('2', {
          lineTotal: 600,
          volumeBaseMl: 3000,
          productFamilyKey: 'water',
        }),
      ]
    );

    expect(result.points.map((point) => point.priceValue)).toEqual([200, 200]);
  });

  it('normalizes eggs per individual item across multiple boxes', () => {
    const result = buildProductPriceHistory(
      { type: 'family', key: 'eggs' },
      [
        row('1', {
          lineTotal: 250,
          countBase: 10,
          productFamilyKey: 'eggs',
        }),
        row('2', {
          lineTotal: 500,
          purchaseQuantity: 2,
          countBase: 10,
          productFamilyKey: 'eggs',
        }),
      ]
    );

    expect(result.priceKind).toBe('per_item');
    expect(result.points.map((point) => point.priceValue)).toEqual([25, 25]);
  });

  it('normalizes rice per 100 grams', () => {
    const result = buildProductPriceHistory(
      { type: 'family', key: 'rice' },
      [
        row('1', {
          lineTotal: 2000,
          weightBaseG: 5000,
          productFamilyKey: 'rice',
        }),
        row('2', {
          lineTotal: 4000,
          purchaseQuantity: 2,
          weightBaseG: 5000,
          productFamilyKey: 'rice',
        }),
      ]
    );

    expect(result.priceKind).toBe('per_100g');
    expect(result.points.map((point) => point.priceValue)).toEqual([40, 40]);
  });

  it.each(['tofu', 'yogurt', 'bread', 'onigiri', 'bento'])(
    'does not compare unsupported family %s',
    (family) => {
      const result = buildProductPriceHistory(
        { type: 'family', key: family },
        [row('1', { weightBaseG: 100 }), row('2', { weightBaseG: 100 })]
      );
      expect(result.status).toBe('unsupported_family');
      expect(result.points).toEqual([]);
    }
  );

  it('accepts coffee volume and excludes coffee weight', () => {
    const result = buildProductPriceHistory(
      { type: 'family', key: 'coffee' },
      [
        row('1', {
          lineTotal: 120,
          volumeBaseMl: 185,
          productFamilyKey: 'coffee',
        }),
        row('2', {
          lineTotal: 130,
          volumeBaseMl: 185,
          productFamilyKey: 'coffee',
        }),
        row('3', {
          lineTotal: 140,
          weightBaseG: 185,
          productFamilyKey: 'coffee',
        }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.comparableOccurrenceCount).toBe(2);
    expect(result.excludedOccurrenceCount).toBe(1);
    expect(result.points.every((point) => point.priceKind === 'per_liter')).toBe(
      true
    );
  });
});

describe('currency, validity, coverage, and ordering', () => {
  it('never combines multiple currencies', () => {
    const result = buildProductPriceHistory(
      { type: 'sku', key: 'sku' },
      [row('1', { currency: 'JPY' }), row('2', { currency: 'USD' })]
    );

    expect(result.status).toBe('mixed_currency');
    expect(result.points).toEqual([]);
  });

  it('does not default missing or unknown currency to JPY', () => {
    const result = buildProductPriceHistory(
      { type: 'sku', key: 'sku' },
      [
        row('1', { currency: null }),
        row('2', { currency: 'unknown' }),
      ]
    );

    expect(result.status).toBe('unknown_currency');
    expect(result.currency).toBeNull();
    expect(result.points).toEqual([]);
  });

  it('requires two comparable points and reports excluded occurrences', () => {
    const result = buildProductPriceHistory(
      { type: 'family', key: 'milk' },
      [
        row('5', { occurredAt: 500, volumeBaseMl: 1000, lineTotal: 200 }),
        row('1', { occurredAt: 100, volumeBaseMl: 0 }),
        row('2', { occurredAt: 200, lineTotal: 0, volumeBaseMl: 1000 }),
      ]
    );

    expect(result.status).toBe('not_enough_points');
    expect(result.comparableOccurrenceCount).toBe(1);
    expect(result.excludedOccurrenceCount).toBe(2);
  });

  it('excludes zero, negative, and non-finite amounts and quantities', () => {
    const result = buildProductPriceHistory(
      { type: 'sku', key: 'sku' },
      [
        row('1', { lineTotal: 238 }),
        row('2', { lineTotal: 248 }),
        row('3', { lineTotal: -1 }),
        row('4', { lineTotal: Number.NaN }),
        row('5', { purchaseQuantity: 0 }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.comparableOccurrenceCount).toBe(2);
    expect(result.excludedOccurrenceCount).toBe(3);
  });

  it('orders every occurrence chronologically without daily aggregation', () => {
    const result = buildProductPriceHistory(
      { type: 'sku', key: 'sku' },
      [
        row('3', { occurredAt: 300 }),
        row('2', { occurredAt: 100, receiptId: 'receipt-b' }),
        row('1', { occurredAt: 100, receiptId: 'receipt-a' }),
      ]
    );

    expect(result.points.map((point) => point.receiptId)).toEqual([
      'receipt-a',
      'receipt-b',
      'receipt-3',
    ]);
  });
});

describe('Price History query safety', () => {
  it('uses the exact target filter, bound params, and INNER JOIN', async () => {
    const calls: { source: string; params: SQLite.SQLiteBindParams }[] = [];
    const db: ProductPriceHistoryDatabase = {
      async getAllAsync<T>(source: string, params: SQLite.SQLiteBindParams) {
        calls.push({ source, params });
        return [
          row('1', { lineTotal: 238 }),
          row('2', { lineTotal: 248 }),
        ] as T[];
      },
    };

    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: 'meiji-900',
    });

    expect(result.status).toBe('ready');
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toMatch(
      /FROM receipt_items\s+INNER JOIN receipts/i
    );
    expect(calls[0].source).toMatch(/receipt_items\.sku_key = \?/i);
    expect(calls[0].source).not.toMatch(/analysis_json|purchase_unit_price/i);
    expect(calls[0].params).toEqual(['meiji-900']);
  });

  it.each([
    ['canonical', '明治 おいしい牛乳', /canonical_product_name = \?/i],
    ['family', 'milk', /product_family_key = \?/i],
  ] as const)(
    'uses a bound exact filter for %s targets',
    async (type, key, expectedFilter) => {
      const calls: { source: string; params: SQLite.SQLiteBindParams }[] = [];
      const db: ProductPriceHistoryDatabase = {
        async getAllAsync<T>(source: string, params: SQLite.SQLiteBindParams) {
          calls.push({ source, params });
          return [] as T[];
        },
      };

      await loadProductPriceHistoryWithDb(db, { type, key });
      expect(calls[0].source).toMatch(expectedFilter);
      expect(calls[0].params).toEqual([key]);
    }
  );

  it('models orphan exclusion at the INNER JOIN boundary', async () => {
    const joinedReceiptIds = new Set(['receipt-1', 'receipt-2']);
    const indexedRows = [
      row('1', { lineTotal: 238 }),
      row('2', { lineTotal: 248 }),
      row('orphan', {
        receiptId: 'missing-receipt',
        lineTotal: 9999,
      }),
    ];
    const db: ProductPriceHistoryDatabase = {
      async getAllAsync<T>(source: string) {
        expect(source).toMatch(/INNER JOIN receipts/i);
        return indexedRows.filter((item) =>
          joinedReceiptIds.has(item.receiptId)
        ) as T[];
      },
    };

    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: 'sku',
    });
    expect(result.totalOccurrenceCount).toBe(2);
    expect(result.points.map((point) => point.lineTotal)).toEqual([238, 248]);
  });
});
