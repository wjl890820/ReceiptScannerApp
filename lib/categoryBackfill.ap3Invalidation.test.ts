/**
 * Category backfill → receipt_items SKU/AP-3 truth invalidation.
 * Behavioral coverage (not source-comment inspection).
 */
/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
}));

import type * as SQLite from 'expo-sqlite';

import { backfillReceiptItemCategories } from './categoryBackfill';
import {
  buildReceiptItemIndexRows,
  rebuildReceiptItemIndex,
} from './receiptItemIndex';
import {
  __resetAnalysisPriceSessionCacheForTests,
  buildAnalysisPriceSnapshotSignature,
  getAnalysisPriceDomainDerivationCount,
  getAnalysisPriceIdentityRevision,
  readAnalysisPriceDomainCache,
  writeAnalysisPriceDomainCache,
} from './analysisPriceSessionCache';
import {
  __resetAnalysisPriceGenerationsForTests,
  createAnalysisPriceGeneration,
} from './analysisPriceScheduler';
import { scheduleDeriveAnalysisPriceDomain } from './analysisPriceDerivation';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';
import { buildSkuKey, resolveProductIdentity } from './productIdentity';
import { logger } from './logger';

type StoredReceipt = {
  id: string;
  analysis_json: string;
  user_items_json: string | null;
};

const MILK_NAME = '明治おいしい牛乳900ML';
/** Legacy enum → maps to household (family-incompatible). */
const LEGACY_CATEGORY_BEFORE = 'daily_goods';
const CATEGORY_AFTER = 'household';

class CategoryBackfillAp3Db {
  rows: StoredReceipt[] = [];
  failUpdates = false;

  reset(category: string = LEGACY_CATEGORY_BEFORE): void {
    this.failUpdates = false;
    this.rows = [
      {
        id: 'receipt-milk-1',
        analysis_json: JSON.stringify({
          items: [
            {
              name: MILK_NAME,
              category,
              lineTotal: 198,
              quantity: 1,
              // No identity_version → rebuild recomputes identity from category.
            },
          ],
        }),
        user_items_json: null,
      },
    ];
  }

  async execAsync(_source: string): Promise<void> {}

  async getAllAsync<T>(source: string): Promise<T[]> {
    if (/PRAGMA table_info/i.test(source)) {
      return [] as T[];
    }
    return this.rows.map((row) => ({ ...row })) as T[];
  }

  async getFirstAsync<T>(
    _source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T | null> {
    const values = Array.isArray(params) ? params : [];
    const row = this.rows.find((candidate) => candidate.id === String(values[0]));
    return (row ? { ...row } : null) as T | null;
  }

  async runAsync(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<{ changes: number }> {
    const values = Array.isArray(params) ? params : [];
    if (!/UPDATE receipts/i.test(source)) return { changes: 0 };
    if (this.failUpdates) {
      throw new Error('forced update failure');
    }
    const id = String(values[values.length - 1]);
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return { changes: 0 };
    let valueIndex = 0;
    if (/analysis_json = \?/i.test(source)) {
      row.analysis_json = String(values[valueIndex++]);
    }
    if (/user_items_json = \?/i.test(source)) {
      row.user_items_json = String(values[valueIndex]);
    }
    return { changes: 1 };
  }
}

const mockDatabase = new CategoryBackfillAp3Db();

jest.mock('./receiptItemIndex', () => {
  const actual = jest.requireActual('./receiptItemIndex') as typeof import('./receiptItemIndex');
  return {
    ...actual,
    rebuildReceiptItemIndex: jest.fn(async (db: CategoryBackfillAp3Db, receipt: StoredReceipt) => {
      // Exercise real row projection after category mutation (SKU may change).
      actual.buildReceiptItemIndexRows(receipt);
      return undefined;
    }),
  };
});

const mockRebuild = rebuildReceiptItemIndex as jest.MockedFunction<
  typeof rebuildReceiptItemIndex
>;

function skuForCategory(category: string): string | null {
  const identity = resolveProductIdentity({
    rawName: MILK_NAME,
    category,
  });
  return buildSkuKey(identity);
}

function indexSkuForReceipt(receipt: StoredReceipt): string | null {
  const rows = buildReceiptItemIndexRows(receipt);
  return rows[0]?.sku_key ?? null;
}

describe('categoryBackfill AP-3 truth invalidation', () => {
  beforeEach(() => {
    mockDatabase.reset();
    jest.clearAllMocks();
    mockRebuild.mockClear();
    __resetAnalysisPriceSessionCacheForTests();
    __resetAnalysisPriceGenerationsForTests();
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('proves real SKU membership change: daily_goods → household', () => {
    const beforeSku = skuForCategory(LEGACY_CATEGORY_BEFORE);
    const afterSku = skuForCategory(CATEGORY_AFTER);
    expect(beforeSku).toBeTruthy();
    expect(afterSku).toBeNull();
    expect(beforeSku).not.toBe(afterSku);

    const beforeRows = buildReceiptItemIndexRows({
      id: 'r',
      analysis_json: JSON.stringify({
        items: [{ name: MILK_NAME, category: LEGACY_CATEGORY_BEFORE, lineTotal: 198 }],
      }),
      user_items_json: null,
    });
    const afterRows = buildReceiptItemIndexRows({
      id: 'r',
      analysis_json: JSON.stringify({
        items: [{ name: MILK_NAME, category: CATEGORY_AFTER, lineTotal: 198 }],
      }),
      user_items_json: null,
    });
    expect(beforeRows[0]?.sku_key).toBe(beforeSku);
    expect(afterRows[0]?.sku_key).toBeNull();
    expect(beforeRows[0]?.product_family_key).toBe('milk');
    expect(afterRows[0]?.product_family_key).toBeNull();
  });

  it('successful category backfill invalidates AP-3 cache and SKU membership', async () => {
    const beforeReceipt = { ...mockDatabase.rows[0]! };
    const beforeSku = indexSkuForReceipt(beforeReceipt);
    expect(beforeSku).toBeTruthy();

    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'installation:test',
      seedReceiptIds: ['receipt-milk-1'],
      receiptFingerprints: ['receipt-milk-1::1'],
      insightRowCount: 1,
    });
    writeAnalysisPriceDomainCache({
      signature,
      candidates: [],
      generationMatches: true,
    });
    expect(readAnalysisPriceDomainCache(signature)).not.toBeNull();
    const generationBefore = createAnalysisPriceGeneration();
    expect(generationBefore.isCanceled()).toBe(false);
    const derivationBefore = getAnalysisPriceDomainDerivationCount();

    const result = await backfillReceiptItemCategories();
    // Allow async notify import to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(result.fixedReceipts).toBeGreaterThan(0);
    expect(result.fixedItems).toBeGreaterThan(0);
    expect(mockRebuild).toHaveBeenCalled();

    const afterCategory = JSON.parse(mockDatabase.rows[0]!.analysis_json).items[0]
      .category;
    expect(afterCategory).toBe(CATEGORY_AFTER);
    expect(indexSkuForReceipt(mockDatabase.rows[0]!)).toBeNull();
    expect(indexSkuForReceipt(mockDatabase.rows[0]!)).not.toBe(beforeSku);

    // Invalidation runs after rebuild attempts for fixed receipts.
    expect(readAnalysisPriceDomainCache(signature)).toBeNull();
    expect(generationBefore.isCanceled()).toBe(true);
    expect(getAnalysisPriceDomainDerivationCount()).toBe(derivationBefore);

    // Re-request AP-3: previous cache must not be reused (fresh derive).
    const rows = [
      makeTrustedG3TestRow('1', {
        receiptId: 'receipt-milk-1',
        displayName: MILK_NAME,
        skuKey: null,
        grossLineAmount: 198,
        lineTotal: 198,
        occurredAt: 1,
      }),
      makeTrustedG3TestRow('2', {
        receiptId: 'receipt-milk-2',
        displayName: MILK_NAME,
        skuKey: null,
        grossLineAmount: 220,
        lineTotal: 220,
        occurredAt: 2,
      }),
    ];
    const derived = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts: [{ id: 'receipt-milk-1' } as any],
      rows,
      receiptFingerprints: ['receipt-milk-1::1'],
      deferUntilPaint: false,
    }).promise;
    expect(derived.cacheHit).toBe(false);
    expect(getAnalysisPriceDomainDerivationCount()).toBe(derivationBefore + 1);
  });

  it('zero-change category backfill does not invalidate AP-3', async () => {
    // Already-normalized category: no fix.
    mockDatabase.reset(CATEGORY_AFTER);
    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'installation:test',
      seedReceiptIds: ['receipt-milk-1'],
      receiptFingerprints: ['receipt-milk-1::1'],
      insightRowCount: 1,
    });
    writeAnalysisPriceDomainCache({
      signature,
      candidates: [],
      generationMatches: true,
    });
    const generation = createAnalysisPriceGeneration();
    const revision = getAnalysisPriceIdentityRevision();

    const result = await backfillReceiptItemCategories();
    await Promise.resolve();
    await Promise.resolve();

    expect(result.fixedReceipts).toBe(0);
    expect(result.fixedItems).toBe(0);
    expect(mockRebuild).not.toHaveBeenCalled();
    expect(readAnalysisPriceDomainCache(signature)).not.toBeNull();
    expect(generation.isCanceled()).toBe(false);
    expect(getAnalysisPriceIdentityRevision()).toBe(revision);
  });

  it('failed receipt updates do not invalidate AP-3', async () => {
    mockDatabase.reset(LEGACY_CATEGORY_BEFORE);
    mockDatabase.failUpdates = true;
    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'installation:test',
      seedReceiptIds: ['receipt-milk-1'],
      receiptFingerprints: ['receipt-milk-1::1'],
      insightRowCount: 1,
    });
    writeAnalysisPriceDomainCache({
      signature,
      candidates: [],
      generationMatches: true,
    });
    const generation = createAnalysisPriceGeneration();

    const result = await backfillReceiptItemCategories();
    await Promise.resolve();
    await Promise.resolve();

    expect(result.fixedReceipts).toBe(0);
    expect(mockRebuild).not.toHaveBeenCalled();
    expect(readAnalysisPriceDomainCache(signature)).not.toBeNull();
    expect(generation.isCanceled()).toBe(false);
  });
});
