/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  aggregateProductMerchantsByAnalyticsKey,
  formatProductSpecification,
  loadProductHistoryWithDb,
  type ProductHistoryDatabase,
} from './productHistory';
import { merchantAnalyticsKey } from './merchantAnalytics';
import type { AggregatableProductDetailTarget } from './productDetailTarget';

type ReceiptFixture = {
  id: string;
  createdAt: number;
  transactionAt: number | null;
  merchantRaw: string;
  merchantNormalized: string;
  currency: string;
};

type ItemFixture = {
  id: string;
  receiptId: string;
  sourceIndex: number;
  rawName: string;
  normalizedFullName: string;
  canonicalProductName: string | null;
  family: string | null;
  skuKey: string | null;
  category: string;
  quantity: number;
  lineTotal: number;
  specSizeValue: number | null;
  specSizeUnit: string | null;
  specPackCount: number | null;
  volumeBaseMl: number | null;
  weightBaseG: number | null;
  countBase: number | null;
  specSourceText: string | null;
};

function bindValues(params: SQLite.SQLiteBindParams): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

class MemoryProductHistoryDb implements ProductHistoryDatabase {
  readonly receipts = new Map<string, ReceiptFixture>();
  readonly items: ItemFixture[] = [];
  readonly queries: string[] = [];

  matching(source: string, params: SQLite.SQLiteBindParams): ItemFixture[] {
    const key = String(bindValues(params)[0]);
    return this.items.filter((item) => {
      if (!this.receipts.has(item.receiptId)) return false;
      if (/receipt_items\.sku_key = \?/i.test(source)) return item.skuKey === key;
      if (/receipt_items\.canonical_product_name = \?/i.test(source)) {
        return item.canonicalProductName === key;
      }
      if (/receipt_items\.product_family_key = \?/i.test(source)) {
        return item.family === key;
      }
      return false;
    });
  }

  purchasedAt(item: ItemFixture): number {
    const receipt = this.receipts.get(item.receiptId)!;
    return receipt.transactionAt ?? receipt.createdAt;
  }

  async getFirstAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T | null> {
    this.queries.push(source);
    const matching = this.matching(source, params);
    if (/COUNT\(\*\) AS purchaseOccurrenceCount/i.test(source)) {
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
      const dates = matching.map((item) => this.purchasedAt(item));
      return {
        purchaseOccurrenceCount: matching.length,
        totalPurchaseQuantity: matching.reduce(
          (sum, item) => sum + item.quantity,
          0
        ),
        firstPurchasedAt: Math.min(...dates),
        lastPurchasedAt: Math.max(...dates),
        canonicalProductCount: new Set(
          matching
            .map((item) => item.canonicalProductName)
            .filter((value) => value != null)
        ).size,
        skuCount: new Set(
          matching.map((item) => item.skuKey).filter((value) => value != null)
        ).size,
      } as T;
    }
    const latest = [...matching].sort(
      (left, right) =>
        this.purchasedAt(right) - this.purchasedAt(left) ||
        left.sourceIndex - right.sourceIndex
    )[0];
    if (!latest) return null;
    return {
      rawName: latest.rawName,
      normalizedFullName: latest.normalizedFullName,
      canonicalProductName: latest.canonicalProductName,
      specSizeValue: latest.specSizeValue,
      specSizeUnit: latest.specSizeUnit,
      specPackCount: latest.specPackCount,
      volumeBaseMl: latest.volumeBaseMl,
      weightBaseG: latest.weightBaseG,
      countBase: latest.countBase,
      specSourceText: latest.specSourceText,
    } as T;
  }

  async getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    this.queries.push(source);
    const matching = this.matching(source, params);
    if (/GROUP BY receipts\.currency/i.test(source)) {
      const totals = new Map<string, number>();
      for (const item of matching) {
        const currency = this.receipts.get(item.receiptId)!.currency;
        totals.set(currency, (totals.get(currency) ?? 0) + item.lineTotal);
      }
      return [...totals.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, totalSpend]) => ({ currency, totalSpend })) as T[];
    }
    if (
      /AS merchantRaw/i.test(source) &&
      /AS purchasedAt/i.test(source) &&
      !/AS receiptId/i.test(source)
    ) {
      // R1-B3c: merchant evidence rows; grouping happens via merchantAnalyticsKey in app layer.
      return matching.map((item) => {
        const receipt = this.receipts.get(item.receiptId)!;
        return {
          merchantRaw: receipt.merchantRaw,
          merchantNormalized: receipt.merchantNormalized,
          purchasedAt: this.purchasedAt(item),
        };
      }) as T[];
    }
    if (/GROUP BY\s+receipt_items\.spec_size_value/i.test(source)) {
      const variants = new Map<string, ItemFixture & { count: number }>();
      for (const item of matching) {
        if (
          item.specSizeValue == null &&
          item.volumeBaseMl == null &&
          item.weightBaseG == null &&
          item.countBase == null
        ) {
          continue;
        }
        const key = JSON.stringify([
          item.specSizeValue,
          item.specSizeUnit,
          item.specPackCount,
          item.volumeBaseMl,
          item.weightBaseG,
          item.countBase,
          item.specSourceText,
        ]);
        const current = variants.get(key);
        if (current) current.count += 1;
        else variants.set(key, { ...item, count: 1 });
      }
      return [...variants.values()].map((item) => ({
        sizeValue: item.specSizeValue,
        sizeUnit: item.specSizeUnit,
        packCount: item.specPackCount,
        volumeBaseMl: item.volumeBaseMl,
        weightBaseG: item.weightBaseG,
        countBase: item.countBase,
        sourceText: item.specSourceText,
        purchaseOccurrenceCount: item.count,
      })) as T[];
    }

    const limit = Number(bindValues(params)[1] ?? 30);
    return [...matching]
      .sort(
        (left, right) =>
          this.purchasedAt(right) - this.purchasedAt(left) ||
          left.sourceIndex - right.sourceIndex
      )
      .slice(0, limit)
      .map((item) => {
        const receipt = this.receipts.get(item.receiptId)!;
        return {
          receiptId: item.receiptId,
          itemId: item.id,
          sourceIndex: item.sourceIndex,
          displayName: item.normalizedFullName || item.rawName,
          category: item.category,
          purchaseQuantity: item.quantity,
          lineTotal: item.lineTotal,
          currency: receipt.currency,
          purchasedAt: this.purchasedAt(item),
          merchantRaw: receipt.merchantRaw,
          merchantNormalized: receipt.merchantNormalized,
          specSizeValue: item.specSizeValue,
          specSizeUnit: item.specSizeUnit,
          specPackCount: item.specPackCount,
          volumeBaseMl: item.volumeBaseMl,
          weightBaseG: item.weightBaseG,
          countBase: item.countBase,
          specSourceText: item.specSourceText,
        };
      }) as T[];
  }
}

function addReceipt(
  db: MemoryProductHistoryDb,
  id: string,
  date: number,
  merchant: string,
  transactionAt: number | null = date
): void {
  db.receipts.set(id, {
    id,
    createdAt: date,
    transactionAt,
    merchantRaw: merchant,
    merchantNormalized: merchant,
    currency: 'JPY',
  });
}

function addItem(
  db: MemoryProductHistoryDb,
  receiptId: string,
  id: string,
  input: Partial<ItemFixture> & Pick<ItemFixture, 'rawName'>
): void {
  db.items.push({
    id,
    receiptId,
    sourceIndex: 0,
    normalizedFullName: input.rawName.toLowerCase(),
    canonicalProductName: null,
    family: null,
    skuKey: null,
    category: 'food_ingredients',
    quantity: 1,
    lineTotal: 0,
    specSizeValue: null,
    specSizeUnit: null,
    specPackCount: 1,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    specSourceText: null,
    ...input,
  });
}

function fixtureDb(): MemoryProductHistoryDb {
  const db = new MemoryProductHistoryDb();
  addReceipt(db, 'r1', 100, 'York');
  addReceipt(db, 'r2', 200, 'York');
  addReceipt(db, 'r3', 150, 'York');
  addReceipt(db, 'r4', 300, 'FamilyMart');
  addReceipt(db, 'r5', 250, 'FamilyMart', null);
  addReceipt(db, 'r6', 50, 'AEON');
  addReceipt(db, 'water', 400, 'AEON');

  addItem(db, 'r1', 'r1:0', {
    rawName: '明治 おいしい牛乳 900ml',
    canonicalProductName: '明治 おいしい牛乳',
    family: 'milk',
    skuKey: 'meiji-900',
    quantity: 2,
    lineTotal: 238,
    specSizeValue: 900,
    specSizeUnit: 'ml',
    volumeBaseMl: 900,
    specSourceText: '900ml',
  });
  addItem(db, 'r2', 'r2:0', {
    rawName: '明治 おいしい牛乳 900ml',
    canonicalProductName: '明治 おいしい牛乳',
    family: 'milk',
    skuKey: 'meiji-900',
    quantity: 1,
    lineTotal: 476,
    specSizeValue: 900,
    specSizeUnit: 'ml',
    volumeBaseMl: 900,
    specSourceText: '900ml',
  });
  addItem(db, 'r4', 'r4:0', {
    rawName: '明治 おいしい牛乳 450ml',
    canonicalProductName: '明治 おいしい牛乳',
    family: 'milk',
    skuKey: 'meiji-450',
    lineTotal: 250,
    specSizeValue: 450,
    specSizeUnit: 'ml',
    volumeBaseMl: 450,
    specSourceText: '450ml',
  });
  addItem(db, 'r3', 'r3:0', {
    rawName: '雪印 メグミルク 1L',
    canonicalProductName: '雪印 メグミルク',
    family: 'milk',
    skuKey: 'snow-1l',
    lineTotal: 220,
    specSizeValue: 1,
    specSizeUnit: 'l',
    volumeBaseMl: 1000,
    specSourceText: '1L',
  });
  addItem(db, 'r5', 'r5:0', {
    rawName: 'TOPVALU 牛乳 1000ml',
    canonicalProductName: 'TOPVALU 牛乳',
    family: 'milk',
    skuKey: 'topvalu-1000',
    lineTotal: 180,
    specSizeValue: 1000,
    specSizeUnit: 'ml',
    volumeBaseMl: 1000,
    specSourceText: '1000ml',
  });
  addItem(db, 'r6', 'r6:0', {
    rawName: '雪印 メグミルク 500ml',
    canonicalProductName: '雪印 メグミルク',
    family: 'milk',
    skuKey: 'snow-500',
    lineTotal: 150,
    specSizeValue: 500,
    specSizeUnit: 'ml',
    volumeBaseMl: 500,
    specSourceText: '500ml',
  });
  addItem(db, 'water', 'water:0', {
    rawName: '水 500ml',
    canonicalProductName: null,
    family: 'water',
    skuKey: null,
    lineTotal: 100,
  });
  addItem(db, 'missing', 'missing:0', {
    rawName: 'orphan milk',
    canonicalProductName: '明治 おいしい牛乳',
    family: 'milk',
    skuKey: 'meiji-900',
    lineTotal: 9999,
  });
  return db;
}

async function load(
  db: MemoryProductHistoryDb,
  target: AggregatableProductDetailTarget
) {
  const result = await loadProductHistoryWithDb(db, target);
  expect(result).not.toBeNull();
  return result!;
}

describe('Product History grouping', () => {
  it('SKU detail includes only the exact sku and separates count from quantity', async () => {
    const db = fixtureDb();
    const summary = await load(db, { type: 'sku', key: 'meiji-900' });

    expect(summary.recentPurchases.map((row) => row.itemId)).toEqual([
      'r2:0',
      'r1:0',
    ]);
    expect(summary.purchaseOccurrenceCount).toBe(2);
    expect(summary.totalPurchaseQuantity).toBe(3);
    expect(summary.totalSpend).toBe(714);
    expect(summary.title).toBe('明治 おいしい牛乳 900ml');
  });

  it('canonical detail includes multiple specs but excludes other canonical products', async () => {
    const db = fixtureDb();
    const summary = await load(db, {
      type: 'canonical',
      key: '明治 おいしい牛乳',
    });

    expect(summary.recentPurchases.map((row) => row.itemId)).toEqual([
      'r4:0',
      'r2:0',
      'r1:0',
    ]);
    expect(summary.totalSpend).toBe(964);
    expect(
      summary.specificationVariants.map((variant) =>
        formatProductSpecification(variant, 'ja')
      )
    ).toEqual(expect.arrayContaining(['900ml', '450ml']));
  });

  it('family detail includes distinct products and excludes water', async () => {
    const db = fixtureDb();
    const summary = await load(db, { type: 'family', key: 'milk' });

    expect(summary.purchaseOccurrenceCount).toBe(6);
    expect(summary.canonicalProductCount).toBe(3);
    expect(summary.recentPurchases.some((row) => row.receiptId === 'water')).toBe(
      false
    );
  });

  it('aggregates merchants by occurrence count then latest purchase', async () => {
    const summary = await load(fixtureDb(), { type: 'family', key: 'milk' });

    expect(summary.merchants.map((merchant) => merchant.merchantName)).toEqual([
      'York',
      'FamilyMart',
      'AEON',
    ]);
    expect(
      summary.merchants.map((merchant) => merchant.purchaseOccurrenceCount)
    ).toEqual([3, 2, 1]);
  });

  it('collapses raw OCR merchant variants that share merchant_normalized', async () => {
    const db = fixtureDb();
    // Mutate two York receipts to different raw spellings with same normalized identity.
    const yorkIds = ['r1', 'r2', 'r3'];
    for (const id of yorkIds) {
      const receipt = db.receipts.get(id)!;
      db.receipts.set(id, {
        ...receipt,
        merchantRaw: id === 'r1' ? 'York Benimaru Furukawa' : 'YORK BENIMARU',
        merchantNormalized: 'York',
      });
    }
    const summary = await load(db, { type: 'family', key: 'milk' });
    // Display uses latest observation's raw||normalized (r2), not the analytics key.
    expect(summary.merchants.map((merchant) => merchant.merchantName)).toEqual([
      'YORK BENIMARU',
      'FamilyMart',
      'AEON',
    ]);
    expect(
      summary.merchants.map((merchant) => merchant.purchaseOccurrenceCount)
    ).toEqual([3, 2, 1]);
  });

  it('orders recent rows by transaction date with created_at fallback', async () => {
    const summary = await load(fixtureDb(), { type: 'family', key: 'milk' });
    expect(summary.recentPurchases.map((row) => row.receiptId)).toEqual([
      'r4',
      'r5',
      'r2',
      'r3',
      'r1',
      'r6',
    ]);
  });

  it('excludes orphan rows through INNER JOIN for every user-visible query', async () => {
    const db = fixtureDb();
    const summary = await load(db, { type: 'sku', key: 'meiji-900' });

    expect(summary.totalSpend).toBe(714);
    expect(db.queries).not.toHaveLength(0);
    expect(db.queries.every((sql) => /INNER JOIN receipts/i.test(sql))).toBe(true);
    expect(db.queries.join('\n')).toMatch(
      /typeof\(receipt_items\.line_total\) IN \('integer', 'real'\)/i
    );
    expect(db.queries.join('\n')).not.toMatch(/purchase_unit_price/i);
  });

  it('keeps currencies separate instead of performing implicit FX conversion', async () => {
    const db = fixtureDb();
    db.receipts.get('r2')!.currency = 'USD';
    const summary = await load(db, { type: 'sku', key: 'meiji-900' });

    expect(summary.totalSpend).toBeNull();
    expect(summary.currency).toBeNull();
    expect(summary.currencyTotals).toEqual([
      { currency: 'JPY', totalSpend: 238 },
      { currency: 'USD', totalSpend: 476 },
    ]);
  });

  it('returns null for occurrence targets without issuing aggregate queries', async () => {
    const db = fixtureDb();
    await expect(
      loadProductHistoryWithDb(db, {
        type: 'occurrence',
        receiptId: 'r1',
        itemId: 'r1:0',
      })
    ).resolves.toBeNull();
    expect(db.queries).toEqual([]);
  });

  it('returns null rather than throwing when an identity has no indexed history', async () => {
    await expect(
      loadProductHistoryWithDb(fixtureDb(), {
        type: 'family',
        key: 'eggs',
      })
    ).resolves.toBeNull();
  });
});

describe('formatProductSpecification', () => {
  it('formats volume, multipack, and localized count without price semantics', () => {
    expect(
      formatProductSpecification({
        sizeValue: 900,
        sizeUnit: 'ml',
        packCount: 1,
        countBase: null,
        sourceText: '900ml',
      })
    ).toBe('900ml');
    expect(
      formatProductSpecification({
        sizeValue: 500,
        sizeUnit: 'ml',
        packCount: 6,
        countBase: null,
        sourceText: '500ml×6',
      })
    ).toBe('500ml × 6');
    expect(
      formatProductSpecification({
        sizeValue: 10,
        sizeUnit: 'count',
        packCount: 1,
        countBase: 10,
        sourceText: '10個',
      }, 'ja')
    ).toBe('10個');
  });
});

describe('R1-B3c product merchant grouping via merchantAnalyticsKey', () => {
  it('applies normalizeMerchantName so trailing 店 / case collapse', () => {
    const merchants = aggregateProductMerchantsByAnalyticsKey([
      {
        merchantRaw: 'セブン-イレブン渋谷店',
        merchantNormalized: 'セブン-イレブン',
        purchasedAt: 1,
      },
      {
        merchantRaw: 'セブン-イレブン',
        merchantNormalized: 'セブン-イレブン',
        purchasedAt: 2,
      },
    ]);
    expect(merchants).toHaveLength(1);
    expect(merchants[0].purchaseOccurrenceCount).toBe(2);
    // Same SSOT as Analysis.
    expect(
      merchantAnalyticsKey({
        merchant_raw: 'セブン-イレブン渋谷店',
        merchant_normalized: 'セブン-イレブン',
      })
    ).toBe(
      merchantAnalyticsKey({
        merchant_raw: 'セブン-イレブン',
        merchant_normalized: 'セブン-イレブン',
      })
    );
  });

  it('keeps Gyomu / York branch-looking analytics keys distinct', () => {
    const furukawa = merchantAnalyticsKey({
      merchant_raw: '業務スーパー古川',
      merchant_normalized: '業務スーパー古川',
    });
    const sendai = merchantAnalyticsKey({
      merchant_raw: '業務スーパー仙台',
      merchant_normalized: '業務スーパー仙台',
    });
    expect(furukawa).not.toBe(sendai);

    const merchants = aggregateProductMerchantsByAnalyticsKey([
      {
        merchantRaw: '業務スーパー古川',
        merchantNormalized: '業務スーパー古川',
        purchasedAt: 1,
      },
      {
        merchantRaw: '業務スーパー仙台',
        merchantNormalized: '業務スーパー仙台',
        purchasedAt: 2,
      },
      {
        merchantRaw: 'ヨークベニマル古川店',
        merchantNormalized: 'ヨークベニマル古川店',
        purchasedAt: 3,
      },
    ]);
    expect(merchants).toHaveLength(3);
    expect(merchants.map((m) => m.merchantName).sort()).toEqual(
      [
        '業務スーパー古川',
        '業務スーパー仙台',
        'ヨークベニマル古川店',
      ].sort()
    );
  });

  it('groups same-key observations and keeps different keys separate', () => {
    const merchants = aggregateProductMerchantsByAnalyticsKey([
      {
        merchantRaw: 'FamilyMart A',
        merchantNormalized: 'ファミリーマート',
        purchasedAt: 1,
      },
      {
        merchantRaw: 'ファミリーマート 駅前店',
        merchantNormalized: 'ファミリーマート',
        purchasedAt: 3,
      },
      {
        merchantRaw: 'ローソン',
        merchantNormalized: 'ローソン',
        purchasedAt: 2,
      },
    ]);
    expect(merchants).toHaveLength(2);
    const family = merchants.find((m) =>
      (m.merchantName ?? '').includes('ファミリー')
    );
    expect(family?.purchaseOccurrenceCount).toBe(2);
    expect(family?.merchantName).toBe('ファミリーマート 駅前店'); // latest display
  });

  it('display can differ from merchantAnalyticsKey', () => {
    const merchants = aggregateProductMerchantsByAnalyticsKey([
      {
        merchantRaw: 'ヨークベニマル古川店',
        merchantNormalized: 'ヨークベニマル',
        purchasedAt: 5,
      },
    ]);
    const key = merchantAnalyticsKey({
      merchant_raw: 'ヨークベニマル古川店',
      merchant_normalized: 'ヨークベニマル',
    });
    expect(merchants[0].merchantName).toBe('ヨークベニマル古川店');
    expect(merchants[0].merchantName).not.toBe(key);
  });

  it('B3b-edited merchant evidence composes into Product Detail grouping', () => {
    // Simulate persisted fields after B3b edit to セブン-イレブン.
    const edited = {
      merchant_raw: 'セブン-イレブン',
      merchant_normalized: 'セブン-イレブン',
    };
    const key = merchantAnalyticsKey(edited);
    const merchants = aggregateProductMerchantsByAnalyticsKey([
      {
        merchantRaw: edited.merchant_raw,
        merchantNormalized: edited.merchant_normalized,
        purchasedAt: 10,
      },
      {
        merchantRaw: 'セブンイレブン 渋谷店',
        merchantNormalized: 'セブン-イレブン',
        purchasedAt: 11,
      },
    ]);
    expect(merchants).toHaveLength(1);
    expect(
      merchantAnalyticsKey({
        merchant_raw: merchants[0].merchantName,
        merchant_normalized: 'セブン-イレブン',
      })
    ).toBe(key);
  });
});
