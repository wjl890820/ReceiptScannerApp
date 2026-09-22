/**
 * Performance Slice 3D.2 — bind analytics generation to receipt READ.
 *
 * Delayed owner-scoped reads must not be relabeled G+1 after mid-flight
 * invalidation. Product Detail stale cancels without fail-open exclusions.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./receiptOwnershipScope', () => ({
  resolveCurrentLocalReceiptOwnerScope: jest.fn(async () => ({
    status: 'ready' as const,
    ownerKey: 'user:slice3d2-owner',
    receiptWhereSql: 'user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: ['slice3d2-owner'],
  })),
}));

import type { ReceiptRow } from './db';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionDataGeneration,
  invalidateAnalyticsReceiptSelection,
} from './analyticsReceiptSelectionCache';
import {
  readWithAnalyticsGeneration,
} from './analyticsReceiptReadProvenance';
import {
  buildCanonicalPurchaseOccurrenceIndex,
  collectNonRepresentativeOccurrenceReceiptIds,
} from './canonicalPurchaseOccurrence';
import {
  __resetCanonicalPurchaseOccurrenceCacheForTests,
  applyOccurrenceRepresentativeUniverseCached,
  getCanonicalPurchaseOccurrenceBuildCount,
} from './canonicalPurchaseOccurrenceCache';
import {
  buildEngagementPreloadedAnalyticsContext,
  evaluateCurrentEngagementMilestoneWithDb,
  type EngagementMilestoneDatabase,
  type EngagementReceipt,
} from './engagementMilestones';
import {
  runProductDetailMainLoad,
  isAnalyticsGenerationStaleError,
} from './productDetailScreenLoad';
import { buildProductDetailExcludedReceiptIds } from './productDetailOccurrenceExclusions';

const TX = Date.parse('2026-06-30T13:36:46+09:00');
const OWNER = 'user:slice3d2-owner';

function liveGen(): number {
  return getAnalyticsReceiptSelectionDataGeneration();
}

function makeReceipt(
  id: string,
  opts: {
    createdAt: number;
    transactionAt?: number;
    precision?: 'second' | 'minute';
    merchant?: string;
    merchantNormalized?: string;
    items?: Array<{ name: string; quantity: number; lineTotal: number }>;
    total?: number;
    tax?: number;
  }
): ReceiptRow {
  const items = opts.items ?? [
    { name: 'フィラー商品', quantity: 1, lineTotal: 100 },
  ];
  const total =
    opts.total ?? items.reduce((s, i) => s + i.lineTotal, 0);
  const precision = opts.precision ?? 'second';
  return {
    id,
    created_at: opts.createdAt,
    transaction_at: opts.transactionAt ?? opts.createdAt,
    transaction_time_precision: precision,
    image_uri: '',
    merchant_raw: opts.merchant ?? 'テスト店',
    merchant_normalized: opts.merchantNormalized ?? opts.merchant ?? 'テスト店',
    merchant_type: 'supermarket',
    total,
    tax: opts.tax ?? 8,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      merchant: opts.merchant ?? 'テスト店',
      total,
      tax: opts.tax ?? 8,
      tax_is_known: true,
      currency: 'JPY',
      is_grocery: true,
      merchant_type: 'supermarket',
      transactionDate:
        precision === 'second' ? '2026-06-30 13:36:46' : '2026-06-30 13:36',
      transaction_time_precision: precision,
      items,
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

function gyomuPair(ids: [string, string]): ReceiptRow[] {
  const items = [
    { name: 'グリーンカレーペースト', quantity: 1, lineTotal: 88 },
    { name: '炭化竹箸天削(袋無)', quantity: 1, lineTotal: 386 },
    { name: '他商品', quantity: 1, lineTotal: 267 },
  ];
  return ids.map((id, index) =>
    makeReceipt(id, {
      createdAt: 1_000 + index,
      transactionAt: TX,
      precision: 'second',
      merchant: index === 0 ? '業務スーパー' : '業務スーパー 一吉店',
      merchantNormalized:
        index === 0 ? '業務スーパー' : '業務スーパー 一吉店',
      items,
      total: 741,
      tax: 61,
    })
  );
}

/** Mutate pair so occurrence splits (same IDs, incompatible merchant/minute). */
function splitOccurrenceTruth(rows: ReceiptRow[]): ReceiptRow[] {
  const liveRows = rows.map((row) => ({ ...row }));
  const liveB = liveRows[1]!;
  liveB.merchant_raw = '別店X';
  liveB.merchant_normalized = '別店X';
  liveB.transaction_time_precision = 'minute';
  const parsed = JSON.parse(liveB.analysis_json);
  parsed.merchant = '別店X';
  parsed.transactionDate = '2026-06-30 13:36';
  parsed.transaction_time_precision = 'minute';
  liveB.analysis_json = JSON.stringify(parsed);
  return liveRows;
}

function defer<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function emptyHistory() {
  return {
    target: { type: 'merchant_product' as const, key: 'mp:3d2' },
    title: 'T',
    purchaseOccurrenceCount: 0,
    totalPurchaseQuantity: 0,
    totalSpend: null,
    currency: null,
    currencyTotals: [],
    firstPurchasedAt: null,
    lastPurchasedAt: null,
    merchantCount: 0,
    canonicalProductCount: 0,
    skuCount: 0,
    specificationVariants: [],
    merchants: [],
    recentPurchases: [],
  };
}

function emptyPrice() {
  return {
    status: 'not_enough_points' as const,
    target: { type: 'merchant_product' as const, key: 'mp:3d2' },
    points: [],
    observations: [],
    currency: null,
    priceKind: 'purchase_unit' as const,
    totalOccurrenceCount: 0,
    comparableOccurrenceCount: 0,
    excludedOccurrenceCount: 0,
    seriesKind: null,
    amountBasis: null,
    canonicalDuplicateSelectionApplied: false,
  };
}

describe('Slice 3D.2 — receipt-read generation provenance', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetCanonicalPurchaseOccurrenceCacheForTests();
  });

  describe('exact delayed-read poisoning', () => {
    it('mid-read invalidation: old rows not tagged G+1; no occurrence write', async () => {
      const gRows = gyomuPair(['d2-a', 'd2-b']);
      expect(buildCanonicalPurchaseOccurrenceIndex(gRows).groups.length).toBe(
        1
      );
      const generationG = liveGen();
      const deferred = defer<ReceiptRow[]>();

      const readPromise = readWithAnalyticsGeneration(() => deferred.promise);

      const liveRows = splitOccurrenceTruth(gRows);
      expect(
        buildCanonicalPurchaseOccurrenceIndex(liveRows).groups.length
      ).toBeGreaterThanOrEqual(2);
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      deferred.resolve(gRows);
      const result = await readPromise;
      expect(result).toEqual({ ok: false, stale: true });
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);

      // Fresh G+1 path carries current truth (two occurrences).
      const fresh = applyOccurrenceRepresentativeUniverseCached(
        liveRows,
        new Set(),
        { ownerKey: OWNER, analyticsGeneration: liveGen() }
      );
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      expect(fresh.cacheState).toBe('miss');
      expect(fresh.occurrenceIndex.groups.length).toBeGreaterThanOrEqual(2);
      expect(
        collectNonRepresentativeOccurrenceReceiptIds(
          liveRows,
          fresh.occurrenceIndex
        ).size
      ).toBe(0);
    });
  });

  describe('Home preloaded production path', () => {
    it('deferred owner receipt read + mid-flight bump → null, no prewarm write', async () => {
      const gRows = gyomuPair(['home-d2-a', 'home-d2-b']);
      const generationG = liveGen();
      const deferred = defer<EngagementReceipt[]>();

      const buildPromise = buildEngagementPreloadedAnalyticsContext({
        ownerKey: OWNER,
        loadReceipts: async () => deferred.promise,
      });

      // Allow readWith to capture G and park on deferred load.
      await Promise.resolve();
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      deferred.resolve(gRows as EngagementReceipt[]);
      const preloaded = await buildPromise;
      expect(preloaded).toBeNull();
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);
    });

    it('stable read under G still builds preloaded context with G', async () => {
      const gRows = gyomuPair(['home-ok-a', 'home-ok-b']);
      const generationG = liveGen();
      const preloaded = await buildEngagementPreloadedAnalyticsContext({
        ownerKey: OWNER,
        loadReceipts: async () => gRows as EngagementReceipt[],
      });
      expect(preloaded).not.toBeNull();
      expect(preloaded!.analyticsGeneration).toBe(generationG);
      expect(preloaded!.analyticsReceipts.length).toBeGreaterThan(0);
    });
  });

  describe('Home non-preloaded engagement path', () => {
    it('deferred receipt read + mid-flight bump rejects old rows', async () => {
      const gRows = gyomuPair(['eng-d2-a', 'eng-d2-b']);
      const generationG = liveGen();
      const deferred = defer<EngagementReceipt[]>();
      const getAllAsync = jest.fn(() => deferred.promise);
      const db = { getAllAsync } as unknown as EngagementMilestoneDatabase;

      const evalPromise = evaluateCurrentEngagementMilestoneWithDb(db, {
        generatedAt: 1,
      });

      await Promise.resolve();
      await Promise.resolve();
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      deferred.resolve(gRows as EngagementReceipt[]);
      const result = await evalPromise;
      expect(result.currentResult).toBeNull();
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);
    });

    it('rows at G then generation bump before selection continuation → reject', async () => {
      const gRows = gyomuPair(['eng-async-a', 'eng-async-b']);
      const generationG = liveGen();
      const selectionCache = jest.requireActual(
        './analyticsReceiptSelectionCache'
      ) as typeof import('./analyticsReceiptSelectionCache');
      const originalSelect = selectionCache.selectAnalyticsReceiptsCached;
      const spy = jest
        .spyOn(selectionCache, 'selectAnalyticsReceiptsCached')
        .mockImplementation((input) => {
          // Simulate G→G+1 across the selection async boundary.
          invalidateAnalyticsReceiptSelection('receipt_updated');
          expect(liveGen()).toBe(generationG + 1);
          return originalSelect(input);
        });

      try {
        const preloaded = await buildEngagementPreloadedAnalyticsContext({
          ownerKey: OWNER,
          loadReceipts: async () => gRows as EngagementReceipt[],
        });
        expect(preloaded).toBeNull();
        expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('non-preloaded evaluate: selection-boundary bump rejects carried G rows', async () => {
      const gRows = gyomuPair(['eng-np-a', 'eng-np-b']);
      const generationG = liveGen();
      const selectionCache = jest.requireActual(
        './analyticsReceiptSelectionCache'
      ) as typeof import('./analyticsReceiptSelectionCache');
      const originalSelect = selectionCache.selectAnalyticsReceiptsCached;
      const spy = jest
        .spyOn(selectionCache, 'selectAnalyticsReceiptsCached')
        .mockImplementation((input) => {
          invalidateAnalyticsReceiptSelection('receipt_updated');
          expect(liveGen()).toBe(generationG + 1);
          return originalSelect(input);
        });
      const db = {
        getAllAsync: jest.fn(async () => gRows),
      } as unknown as EngagementMilestoneDatabase;

      try {
        const result = await evaluateCurrentEngagementMilestoneWithDb(db);
        expect(result.currentResult).toBeNull();
        expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('Product Detail delayed receipt read', () => {
    it('stale read cancels; no fail-open undefined exclusions; fresh G+1 ok', async () => {
      const gRows = gyomuPair(['pd-d2-a', 'pd-d2-b']);
      const generationG = liveGen();
      const deferred = defer<ReceiptRow[]>();
      const setSummary = jest.fn();
      const setLoadFailed = jest.fn();
      const setLoading = jest.fn();
      const setPriceLoading = jest.fn();
      const buildSpy = jest.fn(
        (
          receipts: readonly ReceiptRow[],
          options?: { analyticsGeneration?: number; ownerKey?: string | null }
        ) => buildProductDetailExcludedReceiptIds(receipts, options)
      );
      const loadHistory = jest.fn(async () => emptyHistory());
      const loadPrice = jest.fn(async () => emptyPrice());

      const loadPromise = runProductDetailMainLoad(
        { type: 'merchant_product', key: 'mp:3d2' },
        'zh',
        {
          isActive: () => true,
          setSummary,
          setPriceHistory: jest.fn(),
          setLoadFailed,
          setPriceLoadFailed: jest.fn(),
          setLoading,
          setPriceLoading,
        },
        {
          listReceiptsForAnalysis: async () => deferred.promise,
          buildProductDetailExcludedReceiptIds: buildSpy,
          resolveOwnerScope: async () =>
            ({
              status: 'ready',
              ownerKey: OWNER,
              predicates: { ownerKey: OWNER },
            }) as never,
          loadProductHistory: loadHistory,
          loadProductPriceHistory: loadPrice,
        }
      );

      const liveRows = splitOccurrenceTruth(gRows);
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      deferred.resolve(gRows);
      await loadPromise;

      expect(buildSpy).not.toHaveBeenCalled();
      expect(loadHistory).not.toHaveBeenCalled();
      expect(setSummary).not.toHaveBeenCalled();
      expect(setLoadFailed).not.toHaveBeenCalled();
      // Slice 3D.3: stale must not clear loading into false noHistory.
      expect(setLoading).not.toHaveBeenCalledWith(false);
      expect(setPriceLoading).toHaveBeenCalledWith(false);
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);

      // Fresh G+1 load with current truth.
      const setSummary2 = jest.fn();
      await runProductDetailMainLoad(
        { type: 'merchant_product', key: 'mp:3d2' },
        'zh',
        {
          isActive: () => true,
          setSummary: setSummary2,
          setPriceHistory: jest.fn(),
          setLoadFailed: jest.fn(),
          setPriceLoadFailed: jest.fn(),
          setLoading: jest.fn(),
          setPriceLoading: jest.fn(),
        },
        {
          listReceiptsForAnalysis: async () => liveRows,
          resolveOwnerScope: async () =>
            ({
              status: 'ready',
              ownerKey: OWNER,
              predicates: { ownerKey: OWNER },
            }) as never,
          loadProductHistory: async (_t, opts) => {
            expect(opts?.excludedReceiptIds).toBeDefined();
            expect(opts!.excludedReceiptIds!.size).toBe(0);
            return {
              ...emptyHistory(),
              purchaseOccurrenceCount: 2,
            };
          },
          loadProductPriceHistory: async () => emptyPrice(),
        }
      );
      expect(setSummary2).toHaveBeenCalled();
    });
  });

  describe('Product Detail owner-resolution drift', () => {
    it('valid G read then owner resolve bump → cancel before selection', async () => {
      const gRows = gyomuPair(['pd-own-a', 'pd-own-b']);
      const generationG = liveGen();
      const deferredOwner = defer<never>();
      const buildSpy = jest.fn();
      const setSummary = jest.fn();
      const setLoadFailed = jest.fn();

      const loadPromise = runProductDetailMainLoad(
        { type: 'merchant_product', key: 'mp:own' },
        'zh',
        {
          isActive: () => true,
          setSummary,
          setPriceHistory: jest.fn(),
          setLoadFailed,
          setPriceLoadFailed: jest.fn(),
          setLoading: jest.fn(),
          setPriceLoading: jest.fn(),
        },
        {
          listReceiptsForAnalysis: async () => gRows,
          buildProductDetailExcludedReceiptIds: buildSpy,
          resolveOwnerScope: async () => deferredOwner.promise,
          loadProductHistory: async () => emptyHistory(),
          loadProductPriceHistory: async () => emptyPrice(),
        }
      );

      await Promise.resolve();
      await Promise.resolve();
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      deferredOwner.resolve({
        status: 'ready',
        ownerKey: OWNER,
        predicates: { ownerKey: OWNER },
      } as never);
      await loadPromise;

      expect(buildSpy).not.toHaveBeenCalled();
      expect(setSummary).not.toHaveBeenCalled();
      expect(setLoadFailed).not.toHaveBeenCalled();
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);
    });
  });

  describe('stale vs failure', () => {
    it('stale exclusion error abandons without fail-open history', async () => {
      const gRows = gyomuPair(['pd-stale-a', 'pd-stale-b']);
      const setSummary = jest.fn();
      const setLoadFailed = jest.fn();
      const loadHistory = jest.fn(async () => emptyHistory());

      await runProductDetailMainLoad(
        { type: 'merchant_product', key: 'mp:stale' },
        'zh',
        {
          isActive: () => true,
          setSummary,
          setPriceHistory: jest.fn(),
          setLoadFailed,
          setPriceLoadFailed: jest.fn(),
          setLoading: jest.fn(),
          setPriceLoading: jest.fn(),
        },
        {
          listReceiptsForAnalysis: async () => gRows,
          buildProductDetailExcludedReceiptIds: () => {
            const { AnalyticsGenerationStaleError } = jest.requireActual(
              './analyticsReceiptReadProvenance'
            ) as typeof import('./analyticsReceiptReadProvenance');
            throw new AnalyticsGenerationStaleError('forced_stale');
          },
          resolveOwnerScope: async () =>
            ({
              status: 'ready',
              ownerKey: OWNER,
              predicates: { ownerKey: OWNER },
            }) as never,
          loadProductHistory: loadHistory,
          loadProductPriceHistory: async () => emptyPrice(),
        }
      );

      expect(loadHistory).not.toHaveBeenCalled();
      expect(setSummary).not.toHaveBeenCalled();
      expect(setLoadFailed).not.toHaveBeenCalled();
    });

    it('isAnalyticsGenerationStaleError distinguishes stale', () => {
      const { AnalyticsGenerationStaleError } = jest.requireActual(
        './analyticsReceiptReadProvenance'
      ) as typeof import('./analyticsReceiptReadProvenance');
      expect(
        isAnalyticsGenerationStaleError(new AnalyticsGenerationStaleError())
      ).toBe(true);
      expect(isAnalyticsGenerationStaleError(new Error('boom'))).toBe(false);
    });
  });
});
