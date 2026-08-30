/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
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

const mockResolveIdentityConsumerObservations = jest.fn();
jest.mock('./productIdentityConsumer', () => ({
  resolveIdentityConsumerObservations: (...args: unknown[]) =>
    mockResolveIdentityConsumerObservations(...args),
}));

import {
  aggregateProductMerchantsByAnalyticsKey,
  countDistinctPurchaseReceiptIds,
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
  userId?: string | null;
  installationId?: string | null;
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
    const values = bindValues(params);
    let paramIndex = 0;
    let items = this.items.filter((item) => this.receipts.has(item.receiptId));

    if (/receipts\.user_id = \?/i.test(source) && !/IS NULL/i.test(source)) {
      const userId = values[paramIndex++];
      items = items.filter((item) => {
        const receipt = this.receipts.get(item.receiptId)!;
        return (receipt.userId ?? 'history-test-user') === userId;
      });
    } else if (
      /receipts\.user_id IS NULL AND receipts\.installation_id = \?/i.test(
        source
      )
    ) {
      const installationId = values[paramIndex++];
      items = items.filter((item) => {
        const receipt = this.receipts.get(item.receiptId)!;
        const userId = receipt.userId;
        return (
          (userId == null || userId === '') &&
          receipt.installationId === installationId
        );
      });
    }

    if (/receipt_items\.sku_key = \?/i.test(source)) {
      const key = values[paramIndex++];
      items = items.filter((item) => item.skuKey === key);
    } else if (/receipt_items\.canonical_product_name = \?/i.test(source)) {
      const key = values[paramIndex++];
      items = items.filter((item) => item.canonicalProductName === key);
    } else if (/receipt_items\.product_family_key = \?/i.test(source)) {
      const key = values[paramIndex++];
      items = items.filter((item) => item.family === key);
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
    if (
      /COUNT\(DISTINCT receipt_items\.receipt_id\) AS purchaseOccurrenceCount/i.test(
        source
      )
    ) {
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
        purchaseOccurrenceCount: countDistinctPurchaseReceiptIds(
          matching.map((item) => item.receiptId)
        ),
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
      /AS receiptId/i.test(source) &&
      !/AS displayName/i.test(source) &&
      !/GROUP BY/i.test(source)
    ) {
      // R1-B3c + G2-1: merchant evidence rows; grouping via merchantAnalyticsKey in app layer.
      return matching.map((item) => {
        const receipt = this.receipts.get(item.receiptId)!;
        return {
          merchantRaw: receipt.merchantRaw,
          merchantNormalized: receipt.merchantNormalized,
          purchasedAt: this.purchasedAt(item),
          receiptId: item.receiptId,
        };
      }) as T[];
    }
    if (/GROUP BY\s+receipt_items\.spec_size_value/i.test(source)) {
      const variants = new Map<
        string,
        ItemFixture & { receiptIds: Set<string> }
      >();
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
        if (current) current.receiptIds.add(item.receiptId);
        else
          variants.set(key, {
            ...item,
            receiptIds: new Set([item.receiptId]),
          });
      }
      return [...variants.values()].map((item) => ({
        sizeValue: item.specSizeValue,
        sizeUnit: item.specSizeUnit,
        packCount: item.specPackCount,
        volumeBaseMl: item.volumeBaseMl,
        weightBaseG: item.weightBaseG,
        countBase: item.countBase,
        sourceText: item.specSourceText,
        purchaseOccurrenceCount: item.receiptIds.size,
      })) as T[];
    }

    if (/AS receiptId/i.test(source) && /ORDER BY COALESCE\(receipts\.transaction_at/i.test(source)) {
      return [...matching]
        .sort(
          (left, right) =>
            this.purchasedAt(right) - this.purchasedAt(left) ||
            left.sourceIndex - right.sourceIndex
        )
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
            rawName: item.rawName,
          };
        }) as T[];
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
    userId: 'history-test-user',
    installationId: null,
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

beforeEach(() => {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
    status: 'ready',
    ownerKey: 'user:history-test-user',
    receiptWhereSql: 'receipts.user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: ['history-test-user'],
  });
});

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
        receiptId: 'r-a',
      },
      {
        merchantRaw: 'セブン-イレブン',
        merchantNormalized: 'セブン-イレブン',
        purchasedAt: 2,
        receiptId: 'r-b',
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
        receiptId: 'r-gyomu-f',
      },
      {
        merchantRaw: '業務スーパー仙台',
        merchantNormalized: '業務スーパー仙台',
        purchasedAt: 2,
        receiptId: 'r-gyomu-s',
      },
      {
        merchantRaw: 'ヨークベニマル古川店',
        merchantNormalized: 'ヨークベニマル古川店',
        purchasedAt: 3,
        receiptId: 'r-york',
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
        receiptId: 'r-fm-a',
      },
      {
        merchantRaw: 'ファミリーマート 駅前店',
        merchantNormalized: 'ファミリーマート',
        purchasedAt: 3,
        receiptId: 'r-fm-b',
      },
      {
        merchantRaw: 'ローソン',
        merchantNormalized: 'ローソン',
        purchasedAt: 2,
        receiptId: 'r-lawson',
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
        receiptId: 'r-york-display',
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
        receiptId: 'r-seven-a',
      },
      {
        merchantRaw: 'セブンイレブン 渋谷店',
        merchantNormalized: 'セブン-イレブン',
        purchasedAt: 11,
        receiptId: 'r-seven-b',
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

  it('dedupes multiple item rows on the same receipt into one purchase event', () => {
    const merchants = aggregateProductMerchantsByAnalyticsKey([
      {
        merchantRaw: 'York',
        merchantNormalized: 'York',
        purchasedAt: 1,
        receiptId: 'r1',
      },
      {
        merchantRaw: 'York',
        merchantNormalized: 'York',
        purchasedAt: 2,
        receiptId: 'r1',
      },
      {
        merchantRaw: 'York',
        merchantNormalized: 'York',
        purchasedAt: 3,
        receiptId: 'r2',
      },
    ]);
    expect(merchants).toHaveLength(1);
    expect(merchants[0].purchaseOccurrenceCount).toBe(2);
  });
});

function g2PurchaseEventCoreFixture(): MemoryProductHistoryDb {
  const db = new MemoryProductHistoryDb();
  addReceipt(db, 'r1', 100, 'York');
  addReceipt(db, 'r2', 200, 'York');

  const shared = {
    rawName: 'Product A 900ml',
    canonicalProductName: 'Product A',
    family: 'product-a',
    skuKey: 'sku-a-900',
    specSizeValue: 900,
    specSizeUnit: 'ml',
    volumeBaseMl: 900,
    specSourceText: '900ml',
  };

  addItem(db, 'r1', 'r1:0', { ...shared, sourceIndex: 0, quantity: 1, lineTotal: 100 });
  addItem(db, 'r1', 'r1:1', { ...shared, sourceIndex: 1, quantity: 2, lineTotal: 200 });
  addItem(db, 'r2', 'r2:0', { ...shared, sourceIndex: 0, quantity: 3, lineTotal: 300 });
  return db;
}

function g2MultiRowSameProductFixture(): MemoryProductHistoryDb {
  const db = g2PurchaseEventCoreFixture();
  addReceipt(db, 'r3', 150, 'FamilyMart');
  addItem(db, 'r3', 'r3:0', {
    rawName: 'Product A 900ml',
    canonicalProductName: 'Product A',
    family: 'product-a',
    skuKey: 'sku-a-900',
    sourceIndex: 0,
    quantity: 1,
    lineTotal: 110,
    specSizeValue: 900,
    specSizeUnit: 'ml',
    volumeBaseMl: 900,
    specSourceText: '900ml',
  });
  return db;
}

describe('G2-1 purchase event truth', () => {
  it('A — same receipt split across two rows counts as one purchase event', async () => {
    const db = new MemoryProductHistoryDb();
    addReceipt(db, 'r1', 100, 'York');
    addItem(db, 'r1', 'r1:0', {
      rawName: 'Product A',
      canonicalProductName: 'Product A',
      skuKey: 'sku-a',
      sourceIndex: 0,
      quantity: 1,
      lineTotal: 100,
    });
    addItem(db, 'r1', 'r1:1', {
      rawName: 'Product A',
      canonicalProductName: 'Product A',
      skuKey: 'sku-a',
      sourceIndex: 1,
      quantity: 2,
      lineTotal: 200,
    });

    const summary = await load(db, { type: 'sku', key: 'sku-a' });
    expect(summary.purchaseOccurrenceCount).toBe(1);
    expect(summary.totalPurchaseQuantity).toBe(3);
    expect(summary.totalSpend).toBe(300);
  });

  it('B/C/D — required multi-row fixture: events, units, merchant, and spec variant', async () => {
    const db = g2PurchaseEventCoreFixture();
    const summary = await load(db, { type: 'sku', key: 'sku-a-900' });

    expect(summary.purchaseOccurrenceCount).toBe(2);
    expect(summary.totalPurchaseQuantity).toBe(6);
    expect(summary.totalSpend).toBe(600);

    const york = summary.merchants.find((m) => m.merchantName === 'York');
    expect(york?.purchaseOccurrenceCount).toBe(2);

    const variant900 = summary.specificationVariants.find(
      (v) => formatProductSpecification(v, 'en') === '900ml'
    );
    expect(variant900?.purchaseOccurrenceCount).toBe(2);
  });

  it('merchant grouping stays distinct across analytics keys', async () => {
    const summary = await load(g2MultiRowSameProductFixture(), {
      type: 'sku',
      key: 'sku-a-900',
    });
    expect(summary.merchants.map((m) => m.merchantName)).toEqual(
      expect.arrayContaining(['York', 'FamilyMart'])
    );
    const familyMart = summary.merchants.find((m) => m.merchantName === 'FamilyMart');
    expect(familyMart?.purchaseOccurrenceCount).toBe(1);
  });

  it('F — excluded duplicate receipt does not add purchase events or quantity', async () => {
    const canonical = await load(g2PurchaseEventCoreFixture(), {
      type: 'sku',
      key: 'sku-a-900',
    });
    const db = g2PurchaseEventCoreFixture();
    addReceipt(db, 'r-dup', 250, 'York');
    addItem(db, 'r-dup', 'r-dup:0', {
      rawName: 'Product A 900ml',
      canonicalProductName: 'Product A',
      family: 'product-a',
      skuKey: 'sku-a-900',
      sourceIndex: 0,
      quantity: 5,
      lineTotal: 500,
      specSizeValue: 900,
      specSizeUnit: 'ml',
      volumeBaseMl: 900,
      specSourceText: '900ml',
    });

    const withDuplicate = await loadProductHistoryWithDb(db, {
      type: 'sku',
      key: 'sku-a-900',
    });
    const excluded = await loadProductHistoryWithDb(
      db,
      { type: 'sku', key: 'sku-a-900' },
      { excludedReceiptIds: new Set(['r-dup']) }
    );

    expect(withDuplicate!.purchaseOccurrenceCount).toBe(
      canonical.purchaseOccurrenceCount + 1
    );
    expect(excluded).not.toBeNull();
    expect(excluded!.purchaseOccurrenceCount).toBe(canonical.purchaseOccurrenceCount);
    expect(excluded!.totalPurchaseQuantity).toBe(canonical.totalPurchaseQuantity);
    expect(excluded!.totalSpend).toBe(canonical.totalSpend);
    expect(excluded!.merchants).toHaveLength(1);
    expect(excluded!.merchants[0]!.purchaseOccurrenceCount).toBe(2);
  });

  it('G — ordinary one-row-per-receipt fixtures remain unchanged', async () => {
    const summary = await load(fixtureDb(), { type: 'family', key: 'milk' });
    expect(summary.purchaseOccurrenceCount).toBe(6);
    expect(summary.merchants.map((m) => m.purchaseOccurrenceCount)).toEqual([
      3, 2, 1,
    ]);
  });

  it('countDistinctPurchaseReceiptIds helper matches frozen definition', () => {
    expect(countDistinctPurchaseReceiptIds(['r1', 'r1', 'r2'])).toBe(2);
  });
});

describe('G2-1 merchant_product purchase event truth', () => {
  beforeEach(() => {
    mockResolveIdentityConsumerObservations.mockReset();
    mockResolveIdentityConsumerObservations.mockImplementation(
      (observations: Array<{ receiptId: string; itemSourceIndex: number }>) => ({
        store: {},
        qualified: observations
          .filter((obs) => obs.receiptId === 'r1' || obs.receiptId === 'r2')
          .map((obs) => ({
            ...obs,
            merchantProductId: 'mp_g2_test',
            purchaseUnitPrice: 100,
            quality: 'trusted',
            includeInHistory: true,
            includeInTrend: true,
            suspectedIntegerMultiple: null,
          })),
      })
    );
  });

  it('E — merchant_product counts distinct receipts, not item rows', async () => {
    const db = g2PurchaseEventCoreFixture();
    const summary = await loadProductHistoryWithDb(db, {
      type: 'merchant_product',
      key: 'mp_g2_test',
    });
    expect(summary).not.toBeNull();
    expect(summary!.purchaseOccurrenceCount).toBe(2);
    expect(summary!.totalPurchaseQuantity).toBe(6);
    expect(summary!.merchants.find((m) => m.merchantName === 'York')?.purchaseOccurrenceCount).toBe(
      2
    );
  });
});

describe('G4-2B personal_product product history', () => {
  it('aggregates cross-store authorized rows and canonicalizes target to anchor', async () => {
    const {
      buildPersonalProductEndpointInventory,
    } = await import('./personalProductEndpointInventory');
    const { buildPersonalMerchantProductEndpointV1 } = await import(
      './personalProductIdentityContract'
    );
    const { buildProductAttributes } = await import('./productIdentityContract');
    const { createMemoryProductIdentityStore } = await import('./productIdentityStore');
    const { resolvePersonalProductTargetFromInventory } = await import(
      './personalProductTargetResolver'
    );
    const { selectAuthorizedPersonalProductHistoryRows } = await import(
      './productHistory'
    );

    const store = createMemoryProductIdentityStore();

    const preliminary = buildPersonalProductEndpointInventory({
      ownerKey: 'user:history-owner',
      sourceRows: [
        {
          receiptId: 'r-aeon',
          itemId: 'r-aeon:0',
          sourceIndex: 0,
          occurredAt: 1,
          merchantRaw: 'AEON',
          merchantNormalized: 'aeon',
          displayName: 'AEON Cola',
          rawName: 'AEON Cola',
          lineTotal: 100,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
        {
          receiptId: 'r-york',
          itemId: 'r-york:0',
          sourceIndex: 0,
          occurredAt: 2,
          merchantRaw: 'York',
          merchantNormalized: 'york',
          displayName: 'York Cola',
          rawName: 'York Cola',
          lineTotal: 120,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
      ],
      receipts: [
        {
          id: 'r-aeon',
          created_at: 1,
          transaction_at: 1,
          image_uri: '',
          merchant_raw: 'AEON',
          merchant_normalized: 'aeon',
          merchant_type: 'convenience',
          total: 100,
          tax: 0,
          tax_is_known: 0,
          currency: 'JPY',
          analysis_json: '{}',
          user_edited: 0,
          final_total: null,
          final_category: null,
          note: null,
          user_items_json: null,
          user_id: 'history-owner',
          installation_id: null,
        },
        {
          id: 'r-york',
          created_at: 2,
          transaction_at: 2,
          image_uri: '',
          merchant_raw: 'York',
          merchant_normalized: 'york',
          merchant_type: 'convenience',
          total: 120,
          tax: 0,
          tax_is_known: 0,
          currency: 'JPY',
          analysis_json: '{}',
          user_edited: 0,
          final_total: null,
          final_category: null,
          note: null,
          user_items_json: null,
          user_id: 'history-owner',
          installation_id: null,
        },
      ],
      decisionRows: [],
      store,
    });
    expect(preliminary.status).toBe('ready');
    if (preliminary.status !== 'ready') return;
    const [mpA, mpB] = [...preliminary.inventory.endpointsById.keys()].sort();
    const leftEndpoint = preliminary.inventory.endpointsById.get(mpA!)!;
    const rightEndpoint = preliminary.inventory.endpointsById.get(mpB!)!;

    const inventoryResult = buildPersonalProductEndpointInventory({
      ownerKey: 'user:history-owner',
      sourceRows: [
        {
          receiptId: 'r-aeon',
          itemId: 'r-aeon:0',
          sourceIndex: 0,
          occurredAt: 1,
          merchantRaw: 'AEON',
          merchantNormalized: 'aeon',
          displayName: 'AEON Cola',
          rawName: 'AEON Cola',
          lineTotal: 100,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
        {
          receiptId: 'r-york',
          itemId: 'r-york:0',
          sourceIndex: 0,
          occurredAt: 2,
          merchantRaw: 'York',
          merchantNormalized: 'york',
          displayName: 'York Cola',
          rawName: 'York Cola',
          lineTotal: 120,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
      ],
      receipts: preliminary.inventory.receiptsById
        ? [...preliminary.inventory.receiptsById.values()]
        : [],
      decisionRows: [
        {
          ownerKey: 'user:history-owner',
          leftMerchantProductId: mpA!,
          rightMerchantProductId: mpB!,
          leftMerchantScopeKey: leftEndpoint.merchantScopeKey,
          rightMerchantScopeKey: rightEndpoint.merchantScopeKey,
          leftComparisonKey: leftEndpoint.comparisonKey,
          rightComparisonKey: rightEndpoint.comparisonKey,
          leftStructuralSignature: leftEndpoint.structuralSignature,
          rightStructuralSignature: rightEndpoint.structuralSignature,
          identityPipelineVersion: leftEndpoint.identityPipelineVersion,
          decision: 'same_product',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      store,
    });
    expect(inventoryResult.status).toBe('ready');
    if (inventoryResult.status !== 'ready') return;

    const resolved = resolvePersonalProductTargetFromInventory(
      mpB!,
      inventoryResult.inventory
    );
    expect(resolved.status).toBe('ready');
    if (resolved.status !== 'ready') return;

    const selected = selectAuthorizedPersonalProductHistoryRows(resolved.resolved, [
      {
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        sourceIndex: 0,
        displayName: 'AEON Cola',
        category: null,
        purchaseQuantity: 1,
        lineTotal: 100,
        currency: 'JPY',
        purchasedAt: 1,
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
        rawName: 'AEON Cola',
        specSizeValue: null,
        specSizeUnit: null,
        specPackCount: null,
        volumeBaseMl: null,
        weightBaseG: null,
        countBase: null,
        specSourceText: null,
      },
      {
        receiptId: 'r-york',
        itemId: 'r-york:0',
        sourceIndex: 0,
        displayName: 'York Cola',
        category: null,
        purchaseQuantity: 1,
        lineTotal: 120,
        currency: 'JPY',
        purchasedAt: 2,
        merchantRaw: 'York',
        merchantNormalized: 'york',
        rawName: 'York Cola',
        specSizeValue: null,
        specSizeUnit: null,
        specPackCount: null,
        volumeBaseMl: null,
        weightBaseG: null,
        countBase: null,
        specSourceText: null,
      },
    ]);

    expect(selected).toHaveLength(2);
    expect(
      countDistinctPurchaseReceiptIds(selected.map((row) => row.receiptId))
    ).toBe(2);

    const db: ProductHistoryDatabase = {
      async getAllAsync(source) {
        if (/receipts\.user_id = \?/i.test(source)) {
          return selected as never;
        }
        return [] as never;
      },
      async getFirstAsync() {
        return null;
      },
    };

    const summary = await loadProductHistoryWithDb(
      db,
      { type: 'personal_product', key: mpB! },
      { personalProductContext: resolved.resolved }
    );
    expect(summary).not.toBeNull();
    expect(summary!.target).toEqual({ type: 'personal_product', key: mpA });
    expect(summary!.purchaseOccurrenceCount).toBe(2);
    expect(summary!.merchantCount).toBe(2);
  });
});
