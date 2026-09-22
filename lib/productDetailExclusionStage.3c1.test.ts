/**
 * Performance Slice 3C.1 — Product Detail exclusion stage instrumentation.
 * Observational only: cacheState + subphase timings; no truth changes.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  invalidateAnalyticsReceiptSelection,
} from './analyticsReceiptSelectionCache';
import * as canonicalPurchaseOccurrence from './canonicalPurchaseOccurrence';
import {
  __resetCanonicalPurchaseOccurrenceCacheForTests,
} from './canonicalPurchaseOccurrenceCache';
import {
  beginProductDetailLoadTimingCapture,
  enableProductDetailLoadTimingsForTests,
  endProductDetailLoadTimingCapture,
  measureProductDetailLoadStageSync,
} from './productDetailLoadTimings';
import {
  buildProductDetailExcludedReceiptIds,
  buildProductDetailExcludedReceiptIdsUncached,
  selectProductDetailAnalyticsReceipts,
} from './productDetailOccurrenceExclusions';

const TX = Date.parse('2026-06-30T13:36:46+09:00');
const OWNER = 'user:slice3c1-owner';

function sortedIds(set: ReadonlySet<string>): string[] {
  return [...set].sort((a, b) => a.localeCompare(b));
}

function makeReceipt(
  id: string,
  opts: {
    createdAt: number;
    transactionAt?: number;
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
  return {
    id,
    created_at: opts.createdAt,
    transaction_at: opts.transactionAt ?? opts.createdAt,
    transaction_time_precision: 'second',
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
      transactionDate: '2026-06-30 13:36:46',
      transaction_time_precision: 'second',
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
      merchant: index === 0 ? '業務スーパー' : '業務スーパー 一吉店',
      merchantNormalized:
        index === 0 ? '業務スーパー' : '業務スーパー 一吉店',
      items,
      total: 741,
      tax: 61,
    })
  );
}

describe('Slice 3C.1 — exclusion stage instrumentation', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetCanonicalPurchaseOccurrenceCacheForTests();
    enableProductDetailLoadTimingsForTests(true);
    beginProductDetailLoadTimingCapture();
  });

  afterEach(() => {
    endProductDetailLoadTimingCapture();
    enableProductDetailLoadTimingsForTests(false);
    jest.restoreAllMocks();
  });

  describe('cacheState authority', () => {
    it('A — valid owner + cold cache → miss', () => {
      const rows = gyomuPair(['csa-a', 'csa-b']);
      expect(
        selectProductDetailAnalyticsReceipts(rows, { ownerKey: OWNER })
          .cacheState
      ).toBe('miss');
    });

    it('B — same owner/generation/set second call → hit', () => {
      const rows = gyomuPair(['csb-a', 'csb-b']);
      expect(
        selectProductDetailAnalyticsReceipts(rows, { ownerKey: OWNER })
          .cacheState
      ).toBe('miss');
      expect(
        selectProductDetailAnalyticsReceipts(rows, { ownerKey: OWNER })
          .cacheState
      ).toBe('hit');
    });

    it('C — missing/unusable ownerKey → direct', () => {
      const rows = gyomuPair(['csc-a', 'csc-b']);
      expect(selectProductDetailAnalyticsReceipts(rows).cacheState).toBe(
        'direct'
      );
      expect(
        selectProductDetailAnalyticsReceipts(rows, { ownerKey: '' }).cacheState
      ).toBe('direct');
      expect(
        selectProductDetailAnalyticsReceipts(rows, { ownerKey: '   ' })
          .cacheState
      ).toBe('direct');
    });

    it('D — generation invalidation → next call miss', () => {
      const rows = gyomuPair(['csd-a', 'csd-b']);
      expect(
        selectProductDetailAnalyticsReceipts(rows, { ownerKey: OWNER })
          .cacheState
      ).toBe('miss');
      expect(
        selectProductDetailAnalyticsReceipts(rows, { ownerKey: OWNER })
          .cacheState
      ).toBe('hit');
      invalidateAnalyticsReceiptSelection('receipt_saved');
      expect(
        selectProductDetailAnalyticsReceipts(rows, { ownerKey: OWNER })
          .cacheState
      ).toBe('miss');
    });

    it('E — owner change → next call miss', () => {
      const rows = gyomuPair(['cse-a', 'cse-b']);
      expect(
        selectProductDetailAnalyticsReceipts(rows, {
          ownerKey: 'user:owner-a',
        }).cacheState
      ).toBe('miss');
      expect(
        selectProductDetailAnalyticsReceipts(rows, {
          ownerKey: 'user:owner-b',
        }).cacheState
      ).toBe('miss');
    });

    it('F — receipt-set change → next call miss', () => {
      const base = gyomuPair(['csf-a', 'csf-b']);
      const withExtra = [
        ...base,
        makeReceipt('csf-extra', {
          createdAt: 9_000,
          transactionAt: TX + 86_400_000,
          merchant: 'Extra',
          merchantNormalized: 'Extra',
        }),
      ];
      expect(
        selectProductDetailAnalyticsReceipts(base, { ownerKey: OWNER })
          .cacheState
      ).toBe('miss');
      expect(
        selectProductDetailAnalyticsReceipts(withExtra, { ownerKey: OWNER })
          .cacheState
      ).toBe('miss');
    });
  });

  describe('timing boundaries', () => {
    it('A/C — analytics sample recorded before occurrence; parent wraps both', () => {
      const rows = gyomuPair(['tba-a', 'tba-b']);
      beginProductDetailLoadTimingCapture();
      measureProductDetailLoadStageSync('productDetail.exclusionBuild', () =>
        buildProductDetailExcludedReceiptIds(rows, {
          ownerKey: OWNER,
          targetType: 'merchant_product',
        })
      );
      const samples = endProductDetailLoadTimingCapture();
      const stages = samples.map((s) => s.stage);
      const analyticsIdx = stages.indexOf(
        'productDetail.exclusionAnalyticsSelection'
      );
      const occurrenceIdx = stages.indexOf(
        'productDetail.exclusionOccurrence'
      );
      const parentIdx = stages.indexOf('productDetail.exclusionBuild');
      expect(analyticsIdx).toBeGreaterThanOrEqual(0);
      expect(occurrenceIdx).toBeGreaterThan(analyticsIdx);
      expect(parentIdx).toBeGreaterThan(occurrenceIdx);
      expect(samples[analyticsIdx]!.cacheState).toBe('miss');
    });

    it('B — occurrence timing wraps buildCanonicalPurchaseOccurrenceIndex on MISS', () => {
      const rows = gyomuPair(['tbb-a', 'tbb-b']);
      const original =
        canonicalPurchaseOccurrence.buildCanonicalPurchaseOccurrenceIndex;
      let calledDuringBuild = false;
      const buildSpy = jest
        .spyOn(
          canonicalPurchaseOccurrence,
          'buildCanonicalPurchaseOccurrenceIndex'
        )
        .mockImplementation((...args) => {
          calledDuringBuild = true;
          return original(...args);
        });

      beginProductDetailLoadTimingCapture();
      buildProductDetailExcludedReceiptIds(rows, { ownerKey: OWNER });
      const samples = endProductDetailLoadTimingCapture();

      expect(calledDuringBuild).toBe(true);
      expect(buildSpy).toHaveBeenCalled();
      expect(
        samples.some((s) => s.stage === 'productDetail.exclusionOccurrence')
      ).toBe(true);
      expect(
        samples.find((s) => s.stage === 'productDetail.exclusionOccurrence')
          ?.cacheState
      ).toBe('miss');
    });

    it('D — analytics HIT still executes occurrence stage (may HIT occurrence too)', () => {
      const rows = gyomuPair(['tbd-a', 'tbd-b']);
      buildProductDetailExcludedReceiptIds(rows, { ownerKey: OWNER });
      endProductDetailLoadTimingCapture();

      beginProductDetailLoadTimingCapture();
      const excluded = buildProductDetailExcludedReceiptIds(rows, {
        ownerKey: OWNER,
      });
      const samples = endProductDetailLoadTimingCapture();

      expect(
        samples.find(
          (s) => s.stage === 'productDetail.exclusionAnalyticsSelection'
        )?.cacheState
      ).toBe('hit');
      expect(
        samples.some((s) => s.stage === 'productDetail.exclusionOccurrence')
      ).toBe(true);
      expect(
        samples.find((s) => s.stage === 'productDetail.exclusionOccurrence')
          ?.cacheState
      ).toBe('hit');
      expect(excluded.size).toBe(1);
    });

    it('E — direct analytics still executes occurrence stage', () => {
      const rows = gyomuPair(['tbe-a', 'tbe-b']);
      beginProductDetailLoadTimingCapture();
      buildProductDetailExcludedReceiptIds(rows);
      const samples = endProductDetailLoadTimingCapture();

      expect(
        samples.find(
          (s) => s.stage === 'productDetail.exclusionAnalyticsSelection'
        )?.cacheState
      ).toBe('direct');
      expect(
        samples.some((s) => s.stage === 'productDetail.exclusionOccurrence')
      ).toBe(true);
      expect(
        samples.find((s) => s.stage === 'productDetail.exclusionOccurrence')
          ?.cacheState
      ).toBe('direct');
    });

    it('F — analytics MISS still executes occurrence stage', () => {
      const rows = gyomuPair(['tbf-a', 'tbf-b']);
      beginProductDetailLoadTimingCapture();
      buildProductDetailExcludedReceiptIds(rows, { ownerKey: OWNER });
      const samples = endProductDetailLoadTimingCapture();

      expect(
        samples.find(
          (s) => s.stage === 'productDetail.exclusionAnalyticsSelection'
        )?.cacheState
      ).toBe('miss');
      expect(
        samples.some((s) => s.stage === 'productDetail.exclusionOccurrence')
      ).toBe(true);
      expect(
        samples.find((s) => s.stage === 'productDetail.exclusionOccurrence')
          ?.cacheState
      ).toBe('miss');
    });
  });

  describe('output equivalence under instrumentation', () => {
    it('instrumented path matches uncached excluded IDs (miss/hit/direct)', () => {
      const rows = [
        ...gyomuPair(['eq-a', 'eq-b']),
        makeReceipt('eq-solo', {
          createdAt: 5_000,
          transactionAt: TX + 86_400_000,
          merchant: '別店',
          merchantNormalized: '別店',
          total: 200,
        }),
      ];
      const uncached = buildProductDetailExcludedReceiptIdsUncached(rows);
      const miss = buildProductDetailExcludedReceiptIds(rows, {
        ownerKey: OWNER,
      });
      const hit = buildProductDetailExcludedReceiptIds(rows, {
        ownerKey: OWNER,
      });
      const direct = buildProductDetailExcludedReceiptIds(rows);
      expect(sortedIds(miss)).toEqual(sortedIds(uncached));
      expect(sortedIds(hit)).toEqual(sortedIds(uncached));
      expect(sortedIds(direct)).toEqual(sortedIds(uncached));
    });
  });

  describe('privacy metadata', () => {
    it('analytics sample exposes only allowed fields', () => {
      const rows = gyomuPair(['priv-a', 'priv-b']);
      beginProductDetailLoadTimingCapture();
      buildProductDetailExcludedReceiptIds(rows, {
        ownerKey: OWNER,
        targetType: 'merchant_product',
      });
      const analytics = endProductDetailLoadTimingCapture().find(
        (s) => s.stage === 'productDetail.exclusionAnalyticsSelection'
      )!;
      expect(analytics).toEqual(
        expect.objectContaining({
          stage: 'productDetail.exclusionAnalyticsSelection',
          targetType: 'merchant_product',
          cacheState: 'miss',
          receiptCount: 2,
        })
      );
      expect(analytics).not.toHaveProperty('ownerKey');
      expect(analytics).not.toHaveProperty('identityKey');
      const serialized = JSON.stringify(analytics);
      expect(serialized).not.toMatch(/業務スーパー/);
      expect(serialized).not.toMatch(/ownerKey/);
    });
  });
});
