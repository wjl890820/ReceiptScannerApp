/**
 * Performance Slice 3A/3B — Product Detail load timings + progressive PPH gate.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  getReceiptsDatabase: jest.fn(),
  listReceiptsForAnalysis: jest.fn(async () => []),
}));
jest.mock('./receiptOwnershipScope', () => ({
  resolveCurrentLocalReceiptOwnerScope: jest.fn(async () => ({
    status: 'owner_unavailable' as const,
  })),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  getDiagnosticSnapshot,
  internalDiagnostics,
  flushDiagnosticsPersistence,
} from './internalDiagnostics';
import { setInternalDiagnosticsEnabledForTests } from './internalDiagnosticsGate';
import { loadPersonalProductDetailDataWithDb } from './productDetailPersonalLoader';
import {
  PRODUCT_DETAIL_DIAGNOSTICS_SCREEN,
  beginProductDetailLoadTimingCapture,
  enableProductDetailLoadTimingsForTests,
  endProductDetailLoadTimingCapture,
  measureProductDetailLoadStage,
  measureProductDetailLoadStageSync,
  recordProductDetailLoadTiming,
  type ProductDetailLoadTimingSample,
} from './productDetailLoadTimings';
import { runProductDetailMainLoad } from './productDetailScreenLoad';
import type { ProductHistorySummary } from './productHistory';
import type { ProductPriceHistoryResult } from './productPriceHistory';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    setItemCalls: 0,
    async getItem(key: string) {
      return store.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      this.setItemCalls += 1;
      store.set(key, value);
    },
    async removeItem(key: string) {
      store.delete(key);
    },
  };
}

function emptyHistory(
  type: 'merchant_product' | 'personal_product' = 'merchant_product'
): ProductHistorySummary {
  return {
    target: { type, key: 'k' },
    title: 'Core Title',
    purchaseOccurrenceCount: 2,
    totalPurchaseQuantity: 2,
    totalSpend: null,
    currency: null,
    currencyTotals: [],
    firstPurchasedAt: 1,
    lastPurchasedAt: 2,
    merchantCount: 0,
    canonicalProductCount: 0,
    skuCount: 0,
    specificationVariants: [],
    merchants: [],
    recentPurchases: [],
  };
}

function emptyPrice(
  type: 'merchant_product' | 'personal_product' = 'merchant_product',
  overrides: Partial<ProductPriceHistoryResult> = {}
): ProductPriceHistoryResult {
  return {
    status: 'not_enough_points',
    target: { type, key: 'k' },
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
    ...overrides,
  };
}

function captureCallbacks(activeRef: { current: boolean }) {
  const calls = {
    setSummary: jest.fn(),
    setPriceHistory: jest.fn(),
    setLoadFailed: jest.fn(),
    setPriceLoadFailed: jest.fn(),
    setLoading: jest.fn(),
    setPriceLoading: jest.fn(),
  };
  return {
    calls,
    callbacks: {
      isActive: () => activeRef.current,
      ...calls,
    },
  };
}

function totalsOnly(
  samples: ProductDetailLoadTimingSample[]
): ProductDetailLoadTimingSample[] {
  return samples.filter((s) => s.stage === 'productDetail.total');
}

function stageIndex(
  samples: ProductDetailLoadTimingSample[],
  stage: ProductDetailLoadTimingSample['stage']
): number {
  return samples.findIndex((s) => s.stage === stage);
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  attempts = 80
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

describe('Performance Slice 3B — progressive Product Detail PPH', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    enableProductDetailLoadTimingsForTests(true);
    beginProductDetailLoadTimingCapture();
    internalDiagnostics.resetForTests(memoryStorage());
  });

  afterEach(async () => {
    enableProductDetailLoadTimingsForTests(false);
    setInternalDiagnosticsEnabledForTests(null);
    endProductDetailLoadTimingCapture();
    await flushDiagnosticsPersistence();
  });

  it('A — history first / PPH pending → core visible, price still loading', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolvePrice!: (v: ProductPriceHistoryResult) => void;
    const pricePending = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolvePrice = resolve;
    });

    const loadPromise = runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:a' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => emptyHistory(),
        loadProductPriceHistory: async () => pricePending,
      }
    );

    await waitFor(() => calls.setLoading.mock.calls.length > 0, 'core visible');

    expect(calls.setSummary).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Core Title' })
    );
    expect(calls.setLoading).toHaveBeenCalledWith(false);
    expect(calls.setPriceHistory).not.toHaveBeenCalled();
    expect(calls.setPriceLoading).toHaveBeenCalledWith(true);
    expect(totalsOnly(endProductDetailLoadTimingCapture())).toHaveLength(1);

    beginProductDetailLoadTimingCapture();
    resolvePrice(emptyPrice('merchant_product', { comparableOccurrenceCount: 3 }));
    await loadPromise;
    expect(calls.setPriceHistory).toHaveBeenCalled();
    expect(calls.setPriceLoading).toHaveBeenCalledWith(false);
  });

  it('B — PPH later resolves → price updates; core summary unchanged', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    const history = emptyHistory();
    let resolvePrice!: (v: ProductPriceHistoryResult) => void;
    const pricePending = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolvePrice = resolve;
    });

    const loadPromise = runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:b' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => history,
        loadProductPriceHistory: async () => pricePending,
      }
    );

    await waitFor(() => calls.setSummary.mock.calls.length > 0, 'summary set');
    const summaryAtCore = calls.setSummary.mock.calls[0]![0];
    const price = emptyPrice('merchant_product', {
      comparableOccurrenceCount: 5,
      points: [{ occurredAt: 1 } as never],
    });
    resolvePrice(price);
    await loadPromise;

    expect(calls.setSummary).toHaveBeenCalledTimes(1);
    expect(calls.setSummary).toHaveBeenCalledWith(summaryAtCore);
    expect(calls.setPriceHistory).toHaveBeenCalledWith(price);
  });

  it('C — history ok, PPH rejects → core remains; price failure only', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    await runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:c' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => emptyHistory(),
        loadProductPriceHistory: async () => {
          throw new Error('pph boom');
        },
      }
    );
    expect(calls.setLoading).toHaveBeenCalledWith(false);
    expect(calls.setLoadFailed).not.toHaveBeenCalled();
    expect(calls.setSummary).toHaveBeenCalled();
    expect(calls.setPriceLoadFailed).toHaveBeenCalledWith(true);
    expect(calls.setPriceHistory).not.toHaveBeenCalled();
  });

  it('D — history fails → PPH cannot create valid core', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    await runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:d' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => {
          throw new Error('history boom');
        },
        loadProductPriceHistory: async () => emptyPrice(),
      }
    );
    expect(calls.setLoadFailed).toHaveBeenCalledWith(true);
    expect(calls.setSummary).not.toHaveBeenCalled();
    expect(calls.setLoading).toHaveBeenCalledWith(false);
    // PPH may still settle, but core failed — no manufactured success summary.
    expect(calls.setSummary).toHaveBeenCalledTimes(0);
  });

  it('E — PPH resolves before history → full-screen still waits for history', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolveHistory!: (v: ProductHistorySummary) => void;
    const historyPending = new Promise<ProductHistorySummary>((resolve) => {
      resolveHistory = resolve;
    });
    let priceStarted = false;

    const loadPromise = runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:e' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => historyPending,
        loadProductPriceHistory: async () => {
          priceStarted = true;
          return emptyPrice();
        },
      }
    );

    await waitFor(() => priceStarted, 'pph started');
    expect(calls.setLoading).not.toHaveBeenCalled();
    expect(calls.setPriceHistory).not.toHaveBeenCalled();

    resolveHistory(emptyHistory());
    await loadPromise;

    expect(calls.setLoading).toHaveBeenCalledWith(false);
    expect(calls.setSummary).toHaveBeenCalled();
    expect(calls.setPriceHistory).toHaveBeenCalled();
    const samples = endProductDetailLoadTimingCapture();
    const totalIdx = stageIndex(samples, 'productDetail.total');
    const historyIdx = stageIndex(samples, 'productDetail.historyLoad');
    expect(totalIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeGreaterThan(-1);
    // total is recorded at core reveal, after history settles.
    expect(totalIdx).toBeGreaterThan(historyIdx);
  });

  it('F — stale PPH from superseded target → no UI write', async () => {
    const activeA = { current: true };
    const a = captureCallbacks(activeA);
    let resolveAPrice!: (v: ProductPriceHistoryResult) => void;
    const aPrice = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolveAPrice = resolve;
    });

    const loadA = runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:a' },
      'zh',
      a.callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => emptyHistory(),
        loadProductPriceHistory: async () => aPrice,
      }
    );

    await waitFor(
      () => a.calls.setLoading.mock.calls.length > 0,
      'A core visible'
    );
    // Core of A may have revealed; then supersede before PPH.
    activeA.current = false;
    a.calls.setLoading.mockClear();
    a.calls.setPriceHistory.mockClear();

    resolveAPrice(emptyPrice());
    await loadA;

    expect(a.calls.setPriceHistory).not.toHaveBeenCalled();
    expect(a.calls.setPriceLoadFailed).not.toHaveBeenCalled();
  });

  it('G — personal_product progressive: history first, PPH later', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolvePrice!: (v: ProductPriceHistoryResult) => void;
    const pricePending = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolvePrice = resolve;
    });
    const resolved = {
      canonicalTarget: { type: 'personal_product' as const, key: 'pp-g' },
    };

    const loadPromise = runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-g' },
      'ja',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({ status: 'ready', resolved }) as never,
          loadHistory: async () => emptyHistory('personal_product'),
          loadPriceHistory: async () => pricePending,
        },
      }
    );

    await waitFor(() => calls.setLoading.mock.calls.length > 0, 'personal core');

    expect(calls.setSummary).toHaveBeenCalled();
    expect(calls.setLoading).toHaveBeenCalledWith(false);
    expect(calls.setLoadFailed).not.toHaveBeenCalled();
    expect(calls.setPriceHistory).not.toHaveBeenCalled();

    resolvePrice(emptyPrice('personal_product'));
    await loadPromise;
    expect(calls.setPriceHistory).toHaveBeenCalled();
  });

  it('A — personal history null → loadFailed (not noHistory)', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    await runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-null' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({
              status: 'ready',
              resolved: {
                canonicalTarget: {
                  type: 'personal_product',
                  key: 'pp-null',
                },
              },
            }) as never,
          loadHistory: async () => null,
          loadPriceHistory: async () => emptyPrice('personal_product'),
        },
      }
    );
    expect(calls.setLoadFailed).toHaveBeenCalledWith(true);
    expect(calls.setPriceLoadFailed).toHaveBeenCalledWith(true);
    expect(calls.setSummary).not.toHaveBeenCalled();
    expect(calls.setLoading).toHaveBeenCalledWith(false);
    // loadFailed without summary ⇒ UI loadFailed, not noHistory
    expect(calls.setLoadFailed.mock.calls.length).toBeGreaterThan(0);
  });

  it('B — personal history rejects → history_load_failed authority', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    await runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-rej' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({
              status: 'ready',
              resolved: {
                canonicalTarget: {
                  type: 'personal_product',
                  key: 'pp-rej',
                },
              },
            }) as never,
          loadHistory: async () => {
            throw new Error('history rejected');
          },
          loadPriceHistory: async () => emptyPrice('personal_product'),
        },
      }
    );
    expect(calls.setLoadFailed).toHaveBeenCalledWith(true);
    expect(calls.setSummary).not.toHaveBeenCalled();
    expect(calls.setLoading).toHaveBeenCalledWith(false);
  });

  it('C — personal history failure + later PPH success cannot reinterpret core', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolvePrice!: (v: ProductPriceHistoryResult) => void;
    const pricePending = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolvePrice = resolve;
    });

    const loadPromise = runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-c' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({
              status: 'ready',
              resolved: {
                canonicalTarget: { type: 'personal_product', key: 'pp-c' },
              },
            }) as never,
          loadHistory: async () => null,
          loadPriceHistory: async () => pricePending,
        },
      }
    );

    await waitFor(() => calls.setLoadFailed.mock.calls.length > 0, 'core fail');
    expect(calls.setSummary).not.toHaveBeenCalled();
    const totalsAtFail = totalsOnly(endProductDetailLoadTimingCapture());
    expect(totalsAtFail).toHaveLength(1);

    beginProductDetailLoadTimingCapture();
    resolvePrice(emptyPrice('personal_product'));
    await loadPromise;

    expect(calls.setSummary).not.toHaveBeenCalled();
    expect(calls.setPriceHistory).not.toHaveBeenCalled();
    expect(calls.setLoadFailed).toHaveBeenCalledWith(true);
    expect(totalsOnly(endProductDetailLoadTimingCapture())).toHaveLength(0);
  });

  it('D — personal history success + PPH failure → core visible, price only fails', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    await runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-d' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({
              status: 'ready',
              resolved: {
                canonicalTarget: { type: 'personal_product', key: 'pp-d' },
              },
            }) as never,
          loadHistory: async () => emptyHistory('personal_product'),
          loadPriceHistory: async () => {
            throw new Error('pph fail');
          },
        },
      }
    );
    expect(calls.setSummary).toHaveBeenCalled();
    expect(calls.setLoadFailed).not.toHaveBeenCalled();
    expect(calls.setLoading).toHaveBeenCalledWith(false);
    expect(calls.setPriceLoadFailed).toHaveBeenCalledWith(true);
    expect(calls.setPriceHistory).not.toHaveBeenCalled();
  });

  it('E — personal history success + PPH pending → core visible progressively', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolvePrice!: (v: ProductPriceHistoryResult) => void;
    const pricePending = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolvePrice = resolve;
    });
    const loadPromise = runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-e' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({
              status: 'ready',
              resolved: {
                canonicalTarget: { type: 'personal_product', key: 'pp-e' },
              },
            }) as never,
          loadHistory: async () => emptyHistory('personal_product'),
          loadPriceHistory: async () => pricePending,
        },
      }
    );
    await waitFor(() => calls.setLoading.mock.calls.length > 0, 'E core');
    expect(calls.setSummary).toHaveBeenCalled();
    expect(calls.setPriceHistory).not.toHaveBeenCalled();
    resolvePrice(emptyPrice('personal_product'));
    await loadPromise;
    expect(calls.setPriceHistory).toHaveBeenCalled();
  });

  it('F — PPH first + personal history pending → full-screen waits for history', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolveHistory!: (v: ProductHistorySummary | null) => void;
    const historyPending = new Promise<ProductHistorySummary | null>(
      (resolve) => {
        resolveHistory = resolve;
      }
    );
    let priceStarted = false;
    const loadPromise = runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-f' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({
              status: 'ready',
              resolved: {
                canonicalTarget: { type: 'personal_product', key: 'pp-f' },
              },
            }) as never,
          loadHistory: async () => historyPending,
          loadPriceHistory: async () => {
            priceStarted = true;
            return emptyPrice('personal_product');
          },
        },
      }
    );
    await waitFor(() => priceStarted, 'personal pph started');
    expect(calls.setLoading).not.toHaveBeenCalled();
    resolveHistory(emptyHistory('personal_product'));
    await loadPromise;
    expect(calls.setLoading).toHaveBeenCalledWith(false);
    expect(calls.setSummary).toHaveBeenCalled();
  });

  it('G2 — stale personal PPH after supersede → no write', async () => {
    const activeA = { current: true };
    const a = captureCallbacks(activeA);
    let resolveAPrice!: (v: ProductPriceHistoryResult) => void;
    const aPrice = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolveAPrice = resolve;
    });
    const loadA = runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-stale' },
      'zh',
      a.callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({
              status: 'ready',
              resolved: {
                canonicalTarget: {
                  type: 'personal_product',
                  key: 'pp-stale',
                },
              },
            }) as never,
          loadHistory: async () => emptyHistory('personal_product'),
          loadPriceHistory: async () => aPrice,
        },
      }
    );
    await waitFor(
      () => a.calls.setLoading.mock.calls.length > 0,
      'personal A core'
    );
    activeA.current = false;
    a.calls.setPriceHistory.mockClear();
    resolveAPrice(emptyPrice('personal_product'));
    await loadA;
    expect(a.calls.setPriceHistory).not.toHaveBeenCalled();
  });

  it('H2 — exactly one productDetail.total on valid personal completion', async () => {
    const activeRef = { current: true };
    const { callbacks } = captureCallbacks(activeRef);
    await runProductDetailMainLoad(
      { type: 'personal_product', key: 'pp-h' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        personalLoadDeps: {
          getDatabase: async () => ({}) as never,
          resolveTarget: async () =>
            ({
              status: 'ready',
              resolved: {
                canonicalTarget: { type: 'personal_product', key: 'pp-h' },
              },
            }) as never,
          loadHistory: async () => emptyHistory('personal_product'),
          loadPriceHistory: async () => emptyPrice('personal_product'),
        },
      }
    );
    expect(totalsOnly(endProductDetailLoadTimingCapture())).toHaveLength(1);
  });

  it('H — productDetail.total fires at core visible point', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolvePrice!: (v: ProductPriceHistoryResult) => void;
    const pricePending = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolvePrice = resolve;
    });

    const loadPromise = runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:h' },
      'en',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => emptyHistory(),
        loadProductPriceHistory: async () => pricePending,
      }
    );

    await waitFor(() => calls.setLoading.mock.calls.length > 0, 'H core');

    const totals = totalsOnly(endProductDetailLoadTimingCapture());
    expect(totals).toHaveLength(1);
    expect(totals[0]!.targetType).toBe('merchant_product');
    expect(calls.setLoading).toHaveBeenCalledWith(false);
    expect(getDiagnosticSnapshot().events.filter((e) => e.name === 'productDetail.total')).toHaveLength(
      1
    );
    expect(
      getDiagnosticSnapshot().events.find((e) => e.name === 'productDetail.total')!
        .screen
    ).toBe(PRODUCT_DETAIL_DIAGNOSTICS_SCREEN);

    resolvePrice(emptyPrice());
    await loadPromise;
  });

  it('I — productDetail.pphLoad may occur after total', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolvePrice!: (v: ProductPriceHistoryResult) => void;
    const pricePending = new Promise<ProductPriceHistoryResult>((resolve) => {
      resolvePrice = resolve;
    });

    const loadPromise = runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:i' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => emptyHistory(),
        loadProductPriceHistory: async () => pricePending,
      }
    );

    await waitFor(() => calls.setLoading.mock.calls.length > 0, 'I core');
    const mid = endProductDetailLoadTimingCapture();
    expect(stageIndex(mid, 'productDetail.total')).toBeGreaterThan(-1);
    expect(stageIndex(mid, 'productDetail.pphLoad')).toBe(-1);

    beginProductDetailLoadTimingCapture();
    resolvePrice(emptyPrice());
    await loadPromise;
    const after = endProductDetailLoadTimingCapture();
    expect(stageIndex(after, 'productDetail.pphLoad')).toBeGreaterThan(-1);
    expect(stageIndex(after, 'productDetail.total')).toBe(-1);
  });

  it('J — existing history/PPH values unchanged (pass-through)', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    const history = emptyHistory();
    const price = emptyPrice('merchant_product', {
      comparableOccurrenceCount: 9,
    });
    await runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:j' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => history,
        loadProductPriceHistory: async () => price,
      }
    );
    expect(calls.setSummary).toHaveBeenCalledWith(history);
    expect(calls.setPriceHistory).toHaveBeenCalledWith(price);
  });

  it('personal DB rejection still does not force setLoading(false)', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    await expect(
      runProductDetailMainLoad(
        { type: 'personal_product', key: 'pp-x' },
        'zh',
        callbacks,
        {
          listReceiptsForAnalysis: async () => [] as never,
          buildProductDetailExcludedReceiptIds: () => new Set(),
          personalLoadDeps: {
            getDatabase: async () => {
              throw new Error('sqlite unavailable');
            },
          },
        }
      )
    ).rejects.toThrow('sqlite unavailable');
    expect(calls.setLoading).not.toHaveBeenCalled();
    expect(totalsOnly(endProductDetailLoadTimingCapture())).toHaveLength(0);
  });

  it('disposed load resolves later → no total / no UI', async () => {
    const activeRef = { current: true };
    const { calls, callbacks } = captureCallbacks(activeRef);
    let resolveHistory!: (v: ProductHistorySummary) => void;
    const historyPending = new Promise<ProductHistorySummary>((resolve) => {
      resolveHistory = resolve;
    });

    const loadPromise = runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:stale' },
      'zh',
      callbacks,
      {
        listReceiptsForAnalysis: async () => [] as never,
        buildProductDetailExcludedReceiptIds: () => new Set(),
        loadProductHistory: async () => historyPending,
        loadProductPriceHistory: async () => emptyPrice(),
      }
    );

    activeRef.current = false;
    resolveHistory(emptyHistory());
    await loadPromise;

    expect(calls.setSummary).not.toHaveBeenCalled();
    expect(calls.setLoading).not.toHaveBeenCalled();
    expect(totalsOnly(endProductDetailLoadTimingCapture())).toHaveLength(0);
  });

  it('UI keeps PPH local loading primitive (no full-body redesign)', () => {
    const screen = read('app/product/[targetType].tsx');
    expect(screen).toContain('priceLoading');
    expect(screen).toContain("t('productDetail.loading')");
    expect(screen).toContain("t('priceHistory.loadFailed')");
    expect(screen).toContain('ProductPriceHistoryChart');
  });

  it('privacy payload still safe', () => {
    recordProductDetailLoadTiming({
      stage: 'productDetail.total',
      durationMs: 9,
      targetType: 'merchant_product',
      success: true,
    });
    const event = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'productDetail.total'
    );
    expect(event!.meta).not.toHaveProperty('identityKey');
    expect(event!.meta).not.toHaveProperty('key');
  });

  it('subphase helpers still emit', async () => {
    await measureProductDetailLoadStage(
      'productDetail.ownerReceiptUniverse',
      async () => [1],
      (rows) => ({ receiptCount: rows.length })
    );
    measureProductDetailLoadStageSync(
      'productDetail.exclusionBuild',
      () => new Set(['a']),
      (ex) => ({ excludedCount: ex.size })
    );
    const result = await loadPersonalProductDetailDataWithDb(
      'pp-missing',
      { locale: 'zh' },
      {
        getDatabase: async () => ({}) as never,
        resolveTarget: async () => ({ status: 'personal_product_not_found' }),
        loadHistory: async () => null,
        loadPriceHistory: async () => emptyPrice('personal_product'),
      }
    );
    expect(result.ok).toBe(false);
    const stages = endProductDetailLoadTimingCapture().map((s) => s.stage);
    expect(stages).toEqual(
      expect.arrayContaining([
        'productDetail.ownerReceiptUniverse',
        'productDetail.exclusionBuild',
        'productDetail.personalResolve',
      ])
    );
  });
});
