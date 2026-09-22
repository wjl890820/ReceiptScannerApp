/**
 * Performance Slice 3D.3 — Product Detail stale retry state machine.
 *
 * Stale must never surface as noHistory. Auto-retry once; terminal stale →
 * distinct reload UI.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import type { ReceiptRow } from './db';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionDataGeneration,
  invalidateAnalyticsReceiptSelection,
} from './analyticsReceiptSelectionCache';
import { __resetCanonicalPurchaseOccurrenceCacheForTests } from './canonicalPurchaseOccurrenceCache';
import type { ProductHistorySummary } from './productHistory';
import type { ProductPriceHistoryResult } from './productPriceHistory';
import {
  PRODUCT_DETAIL_STALE_AUTO_RETRY_LIMIT,
  runProductDetailMainLoad,
  runProductDetailMainLoadWithStaleRetry,
  type ProductDetailLoadOutcome,
  type ProductDetailMainLoadCallbacks,
  type ProductDetailMainLoadDeps,
} from './productDetailScreenLoad';

const OWNER = 'user:slice3d3-owner';

function liveGen(): number {
  return getAnalyticsReceiptSelectionDataGeneration();
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

function makeReceipt(id: string): ReceiptRow {
  return {
    id,
    created_at: 1_000,
    transaction_at: Date.parse('2026-06-30T13:36:46+09:00'),
    transaction_time_precision: 'second',
    image_uri: '',
    merchant_raw: 'テスト店',
    merchant_normalized: 'テスト店',
    merchant_type: 'supermarket',
    total: 100,
    tax: 8,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      merchant: 'テスト店',
      total: 100,
      tax: 8,
      tax_is_known: true,
      currency: 'JPY',
      is_grocery: true,
      merchant_type: 'supermarket',
      transactionDate: '2026-06-30 13:36:46',
      transaction_time_precision: 'second',
      items: [{ name: '商品', quantity: 1, lineTotal: 100 }],
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

function historyWithPurchases(): ProductHistorySummary {
  return {
    target: { type: 'merchant_product', key: 'mp:3d3' },
    title: '商品A',
    purchaseOccurrenceCount: 2,
    totalPurchaseQuantity: 2,
    totalSpend: 200,
    currency: 'JPY',
    currencyTotals: [{ currency: 'JPY', totalSpend: 200 }],
    firstPurchasedAt: 1,
    lastPurchasedAt: 2,
    merchantCount: 1,
    canonicalProductCount: 1,
    skuCount: 1,
    specificationVariants: [],
    merchants: [],
    recentPurchases: [],
  };
}

function emptyPrice(): ProductPriceHistoryResult {
  return {
    status: 'not_enough_points',
    target: { type: 'merchant_product', key: 'mp:3d3' },
    points: [],
    observations: [],
    currency: null,
    priceKind: 'purchase_unit',
    totalOccurrenceCount: 0,
    comparableOccurrenceCount: 0,
    excludedOccurrenceCount: 0,
    seriesKind: null,
    amountBasis: null,
    canonicalDuplicateSelectionApplied: false,
  };
}

type ScreenState = {
  loading: boolean;
  loadFailed: boolean;
  staleNeedsReload: boolean;
  summary: ProductHistorySummary | null;
  priceHistory: ProductPriceHistoryResult | null;
};

function captureCallbacks(activeRef: { current: boolean }): {
  state: ScreenState;
  callbacks: ProductDetailMainLoadCallbacks;
  calls: {
    setSummary: jest.Mock;
    setLoading: jest.Mock;
    setLoadFailed: jest.Mock;
  };
} {
  const state: ScreenState = {
    loading: true,
    loadFailed: false,
    staleNeedsReload: false,
    summary: null,
    priceHistory: null,
  };
  const setSummary = jest.fn((v: ProductHistorySummary | null) => {
    state.summary = v;
  });
  const setLoading = jest.fn((v: boolean) => {
    state.loading = v;
  });
  const setLoadFailed = jest.fn((v: boolean) => {
    state.loadFailed = v;
  });
  return {
    state,
    calls: { setSummary, setLoading, setLoadFailed },
    callbacks: {
      isActive: () => activeRef.current,
      setSummary,
      setPriceHistory: jest.fn((v) => {
        state.priceHistory = v;
      }),
      setLoadFailed,
      setPriceLoadFailed: jest.fn(),
      setLoading,
      setPriceLoading: jest.fn(),
    },
  };
}

/** Mirrors Product Detail screen terminal handling after WithStaleRetry. */
function applyScreenTerminalOutcome(
  state: ScreenState,
  setLoading: (v: boolean) => void,
  outcome: ProductDetailLoadOutcome
): void {
  if (outcome.status === 'stale') {
    state.staleNeedsReload = true;
    setLoading(false);
  }
}

function showsNoHistory(state: ScreenState): boolean {
  return (
    !state.loading &&
    !state.staleNeedsReload &&
    !state.loadFailed &&
    state.summary == null
  );
}

function showsStaleReload(state: ScreenState): boolean {
  return !state.loading && state.staleNeedsReload;
}

function readyOwnerScope() {
  return {
    status: 'ready' as const,
    ownerKey: OWNER,
    predicates: { ownerKey: OWNER },
  };
}

describe('Slice 3D.3 — Product Detail stale retry state machine', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetCanonicalPurchaseOccurrenceCacheForTests();
  });

  describe('source contracts', () => {
    it('screen uses WithStaleRetry and gates noHistory behind staleNeedsReload', () => {
      const screen = fs.readFileSync(
        path.resolve(__dirname, '../app/product/[targetType].tsx'),
        'utf8'
      );
      expect(screen).toContain('runProductDetailMainLoadWithStaleRetry');
      expect(screen).toContain('staleNeedsReload');
      expect(screen).toContain('productDetail.dataUpdatedReload');
      expect(screen).toMatch(
        /staleNeedsReload[\s\S]*?loadFailed \|\| !target \|\| !summary/
      );
      expect(PRODUCT_DETAIL_STALE_AUTO_RETRY_LIMIT).toBe(1);
    });
  });

  describe('mounted delayed-read stale → automatic retry', () => {
    it('no noHistory; history/PPH skip stale rows; retry uses fresh G+1', async () => {
      const activeRef = { current: true };
      const { state, callbacks, calls } = captureCallbacks(activeRef);
      const generationG = liveGen();
      const deferredG = defer<ReceiptRow[]>();
      let listCalls = 0;
      const loadHistory = jest.fn(async () => historyWithPurchases());
      const loadPrice = jest.fn(async () => emptyPrice());
      const gRows = [makeReceipt('d3-a'), makeReceipt('d3-b')];
      const g1Rows = [makeReceipt('d3-a'), makeReceipt('d3-b')];

      const cyclePromise = (async () => {
        const outcome = await runProductDetailMainLoadWithStaleRetry(
          { type: 'merchant_product', key: 'mp:3d3' },
          'zh',
          callbacks,
          {
            listReceiptsForAnalysis: async () => {
              listCalls += 1;
              if (listCalls === 1) {
                return deferredG.promise;
              }
              expect(liveGen()).toBe(generationG + 1);
              return g1Rows;
            },
            resolveOwnerScope: async () => readyOwnerScope() as never,
            loadProductHistory: loadHistory,
            loadProductPriceHistory: loadPrice,
          }
        );
        applyScreenTerminalOutcome(state, callbacks.setLoading, outcome);
        return outcome;
      })();

      await Promise.resolve();
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      // During stale + retry-in-flight, loading must stay true → not noHistory.
      expect(state.loading).toBe(true);
      expect(showsNoHistory(state)).toBe(false);
      expect(loadHistory).not.toHaveBeenCalled();
      expect(loadPrice).not.toHaveBeenCalled();

      deferredG.resolve(gRows);
      const outcome = await cyclePromise;

      expect(outcome).toEqual({ status: 'success' });
      expect(listCalls).toBe(2);
      expect(loadHistory).toHaveBeenCalledTimes(1);
      expect(loadPrice).toHaveBeenCalledTimes(1);
      expect(calls.setSummary).toHaveBeenCalledWith(
        expect.objectContaining({ purchaseOccurrenceCount: 2 })
      );
      expect(showsNoHistory(state)).toBe(false);
      expect(showsStaleReload(state)).toBe(false);
      expect(state.loading).toBe(false);
      expect(state.summary?.title).toBe('商品A');
    });
  });

  describe('mounted owner-resolution stale → automatic retry', () => {
    it('cancels old G; no noHistory; retries from fresh receipt read', async () => {
      const activeRef = { current: true };
      const { state, callbacks } = captureCallbacks(activeRef);
      const generationG = liveGen();
      const deferredOwner = defer<ReturnType<typeof readyOwnerScope>>();
      let listCalls = 0;
      let ownerCalls = 0;
      const loadHistory = jest.fn(async () => historyWithPurchases());
      const rows = [makeReceipt('own-a')];

      const cyclePromise = (async () => {
        const outcome = await runProductDetailMainLoadWithStaleRetry(
          { type: 'merchant_product', key: 'mp:own' },
          'zh',
          callbacks,
          {
            listReceiptsForAnalysis: async () => {
              listCalls += 1;
              return rows;
            },
            resolveOwnerScope: async () => {
              ownerCalls += 1;
              if (ownerCalls === 1) {
                return deferredOwner.promise as never;
              }
              return readyOwnerScope() as never;
            },
            loadProductHistory: loadHistory,
            loadProductPriceHistory: async () => emptyPrice(),
          }
        );
        applyScreenTerminalOutcome(state, callbacks.setLoading, outcome);
        return outcome;
      })();

      await Promise.resolve();
      await Promise.resolve();
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      expect(state.loading).toBe(true);
      expect(showsNoHistory(state)).toBe(false);
      expect(loadHistory).not.toHaveBeenCalled();

      deferredOwner.resolve(readyOwnerScope());
      const outcome = await cyclePromise;

      expect(outcome).toEqual({ status: 'success' });
      expect(listCalls).toBe(2);
      expect(ownerCalls).toBe(2);
      expect(loadHistory).toHaveBeenCalledTimes(1);
      expect(showsNoHistory(state)).toBe(false);
      expect(state.summary).not.toBeNull();
    });
  });

  describe('double-stale → terminal reload UI', () => {
    it('no infinite loop; no noHistory; distinct stale reload state', async () => {
      const activeRef = { current: true };
      const { state, callbacks, calls } = captureCallbacks(activeRef);
      let listCalls = 0;
      const loadHistory = jest.fn(async () => historyWithPurchases());

      const outcome = await runProductDetailMainLoadWithStaleRetry(
        { type: 'merchant_product', key: 'mp:dbl' },
        'zh',
        callbacks,
        {
          listReceiptsForAnalysis: async () => {
            listCalls += 1;
            // Every attempt: capture G then bump before resolve → always stale.
            const deferred = defer<ReceiptRow[]>();
            const g = liveGen();
            queueMicrotask(() => {
              invalidateAnalyticsReceiptSelection('receipt_updated');
              expect(liveGen()).toBe(g + 1);
              deferred.resolve([makeReceipt(`dbl-${listCalls}`)]);
            });
            return deferred.promise;
          },
          resolveOwnerScope: async () => readyOwnerScope() as never,
          loadProductHistory: loadHistory,
          loadProductPriceHistory: async () => emptyPrice(),
        }
      );
      applyScreenTerminalOutcome(state, callbacks.setLoading, outcome);

      expect(outcome).toEqual({ status: 'stale' });
      expect(listCalls).toBe(PRODUCT_DETAIL_STALE_AUTO_RETRY_LIMIT + 1);
      expect(loadHistory).not.toHaveBeenCalled();
      expect(calls.setSummary).not.toHaveBeenCalled();
      expect(showsNoHistory(state)).toBe(false);
      expect(showsStaleReload(state)).toBe(true);
      expect(state.loading).toBe(false);

      // Manual reload starts another full cycle (fresh attempts).
      state.staleNeedsReload = false;
      state.loading = true;
      const manual = await runProductDetailMainLoadWithStaleRetry(
        { type: 'merchant_product', key: 'mp:dbl' },
        'zh',
        callbacks,
        {
          listReceiptsForAnalysis: async () => [makeReceipt('manual')],
          resolveOwnerScope: async () => readyOwnerScope() as never,
          loadProductHistory: loadHistory,
          loadProductPriceHistory: async () => emptyPrice(),
        }
      );
      applyScreenTerminalOutcome(state, callbacks.setLoading, manual);
      expect(manual).toEqual({ status: 'success' });
      expect(loadHistory).toHaveBeenCalled();
      expect(showsStaleReload(state)).toBe(false);
    });
  });

  describe('legitimate no-history / history', () => {
    it('authoritative null history still reaches noHistory', async () => {
      const activeRef = { current: true };
      const { state, callbacks } = captureCallbacks(activeRef);
      const outcome = await runProductDetailMainLoadWithStaleRetry(
        { type: 'merchant_product', key: 'mp:empty' },
        'zh',
        callbacks,
        {
          listReceiptsForAnalysis: async () => [makeReceipt('empty')],
          resolveOwnerScope: async () => readyOwnerScope() as never,
          loadProductHistory: async () => null,
          loadProductPriceHistory: async () => emptyPrice(),
        }
      );
      applyScreenTerminalOutcome(state, callbacks.setLoading, outcome);
      expect(outcome).toEqual({ status: 'success' });
      expect(state.summary).toBeNull();
      expect(state.loadFailed).toBe(false);
      expect(state.staleNeedsReload).toBe(false);
      expect(state.loading).toBe(false);
      expect(showsNoHistory(state)).toBe(true);
    });

    it('authoritative history renders without retry UI', async () => {
      const activeRef = { current: true };
      const { state, callbacks } = captureCallbacks(activeRef);
      const outcome = await runProductDetailMainLoadWithStaleRetry(
        { type: 'merchant_product', key: 'mp:ok' },
        'zh',
        callbacks,
        {
          listReceiptsForAnalysis: async () => [makeReceipt('ok')],
          resolveOwnerScope: async () => readyOwnerScope() as never,
          loadProductHistory: async () => historyWithPurchases(),
          loadProductPriceHistory: async () => emptyPrice(),
        }
      );
      applyScreenTerminalOutcome(state, callbacks.setLoading, outcome);
      expect(outcome).toEqual({ status: 'success' });
      expect(state.summary?.purchaseOccurrenceCount).toBe(2);
      expect(showsStaleReload(state)).toBe(false);
      expect(showsNoHistory(state)).toBe(false);
    });
  });

  describe('single-attempt stale does not clear loading', () => {
    it('runProductDetailMainLoad stale keeps loading true (no false noHistory)', async () => {
      const activeRef = { current: true };
      const { state, callbacks, calls } = captureCallbacks(activeRef);
      const deferred = defer<ReceiptRow[]>();
      const loadHistory = jest.fn(async () => historyWithPurchases());
      const g = liveGen();

      const p = runProductDetailMainLoad(
        { type: 'merchant_product', key: 'mp:keep' },
        'zh',
        callbacks,
        {
          listReceiptsForAnalysis: async () => deferred.promise,
          resolveOwnerScope: async () => readyOwnerScope() as never,
          loadProductHistory: loadHistory,
          loadProductPriceHistory: async () => emptyPrice(),
        }
      );

      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(g + 1);
      deferred.resolve([makeReceipt('keep')]);
      const outcome = await p;

      expect(outcome).toEqual({ status: 'stale' });
      expect(loadHistory).not.toHaveBeenCalled();
      expect(calls.setLoading).not.toHaveBeenCalledWith(false);
      expect(state.loading).toBe(true);
      expect(showsNoHistory(state)).toBe(false);
    });
  });

  describe('personal product shares state machine', () => {
    it('stale personal load auto-retries and applies fresh core', async () => {
      const activeRef = { current: true };
      const { state, callbacks } = captureCallbacks(activeRef);
      const generationG = liveGen();
      const deferred = defer<ReceiptRow[]>();
      let listCalls = 0;
      const loadPersonalProgressive = jest.fn(
        async (
          _key: string,
          _opts: unknown,
          progressive: {
            onCore: (core: {
              ok: true;
              history: ProductHistorySummary;
            }) => void;
            onPrice: (
              r: PromiseSettledResult<ProductPriceHistoryResult>
            ) => void;
          }
        ) => {
          progressive.onCore({
            ok: true,
            history: {
              ...historyWithPurchases(),
              target: { type: 'personal_product', key: 'pp:1' },
              title: '个人商品',
            },
          });
          progressive.onPrice({
            status: 'fulfilled',
            value: emptyPrice(),
          });
        }
      );

      const cyclePromise = (async () => {
        const outcome = await runProductDetailMainLoadWithStaleRetry(
          { type: 'personal_product', key: 'pp:1' },
          'zh',
          callbacks,
          {
            listReceiptsForAnalysis: async () => {
              listCalls += 1;
              if (listCalls === 1) return deferred.promise;
              return [makeReceipt('pp-a')];
            },
            resolveOwnerScope: async () => readyOwnerScope() as never,
            loadPersonalProgressive: loadPersonalProgressive as never,
          }
        );
        applyScreenTerminalOutcome(state, callbacks.setLoading, outcome);
        return outcome;
      })();

      await Promise.resolve();
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);
      expect(showsNoHistory(state)).toBe(false);

      deferred.resolve([makeReceipt('pp-stale')]);
      const outcome = await cyclePromise;

      expect(outcome).toEqual({ status: 'success' });
      expect(listCalls).toBe(2);
      expect(loadPersonalProgressive).toHaveBeenCalledTimes(1);
      expect(state.summary?.title).toBe('个人商品');
      expect(showsNoHistory(state)).toBe(false);
    });
  });
});
