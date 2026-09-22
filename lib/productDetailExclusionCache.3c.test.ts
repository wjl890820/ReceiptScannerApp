/**
 * Performance Slice 3C — Product Detail exclusion reuses analytics selection cache.
 *
 * Equivalence: uncached path ≡ cached MISS ≡ cached HIT (final excluded ID sets).
 * Occurrence representative union remains post-selection (uncached).
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionBuildCount,
  getAnalyticsReceiptSelectionDataGeneration,
  invalidateAnalyticsReceiptSelection,
} from './analyticsReceiptSelectionCache';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { applyOccurrenceRepresentativeUniverse } from './canonicalPurchaseOccurrence';
import { __resetCanonicalPurchaseOccurrenceCacheForTests } from './canonicalPurchaseOccurrenceCache';
import {
  buildProductDetailExcludedReceiptIds,
  buildProductDetailExcludedReceiptIdsUncached,
} from './productDetailOccurrenceExclusions';
import { runProductDetailMainLoad } from './productDetailScreenLoad';

const TX = Date.parse('2026-06-30T13:36:46+09:00');
const OWNER = 'user:slice3c-owner';

function sortedIds(set: ReadonlySet<string>): string[] {
  return [...set].sort((a, b) => a.localeCompare(b));
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
  } = { createdAt: 1_000 }
): ReceiptRow {
  const items = opts.items ?? [
    { name: 'フィラー商品', quantity: 1, lineTotal: 100 },
  ];
  const total =
    opts.total ?? items.reduce((s, i) => s + i.lineTotal, 0);
  const precision = opts.precision ?? 'second';
  const txAt = opts.transactionAt ?? opts.createdAt;
  const txDate =
    precision === 'second'
      ? '2026-06-30 13:36:46'
      : '2026-06-30 13:36';
  return {
    id,
    created_at: opts.createdAt,
    transaction_at: txAt,
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
      transactionDate: txDate,
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

/** Receipt078-shaped gyomu curry pair (second precision → one occurrence). */
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

describe('Slice 3C — Product Detail analytics selection cache reuse', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetCanonicalPurchaseOccurrenceCacheForTests();
  });

  it('A/B/C equivalence: uncached ≡ cached MISS ≡ cached HIT (incl. occurrence)', () => {
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
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(0);

    const miss = buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: OWNER,
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);

    const hit = buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: OWNER,
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);

    expect(sortedIds(miss)).toEqual(sortedIds(uncached));
    expect(sortedIds(hit)).toEqual(sortedIds(uncached));

    // Explicit: occurrence non-rep is in the final set (not only HC).
    const selection = selectAnalyticsReceipts(rows);
    const universe = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    expect(sortedIds(hit)).toEqual(sortedIds(universe.excludedReceiptIds));
    const reps = universe.representativeReceipts.filter((r) =>
      r.id.startsWith('eq-')
    );
    const gyomuReps = reps.filter((r) => r.id === 'eq-a' || r.id === 'eq-b');
    expect(gyomuReps).toHaveLength(1);
    const nonRep = gyomuReps[0]!.id === 'eq-a' ? 'eq-b' : 'eq-a';
    expect(hit.has(nonRep)).toBe(true);
    expect(hit.has(gyomuReps[0]!.id)).toBe(false);
  });

  it('A — cold cache MISS builds once and yields correct exclusions', () => {
    const rows = gyomuPair(['miss-a', 'miss-b']);
    const excluded = buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: OWNER,
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    expect(excluded.size).toBe(1);
  });

  it('B — same owner/generation/set → HIT, no second HC rebuild', () => {
    const rows = gyomuPair(['hit-a', 'hit-b']);
    const first = buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: OWNER,
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    const second = buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: OWNER,
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    expect(sortedIds(second)).toEqual(sortedIds(first));
  });

  it('C — generation bump → no stale HIT, authoritative recompute', () => {
    const rows = gyomuPair(['gen-a', 'gen-b']);
    buildProductDetailExcludedReceiptIds(rows, { ownerKey: OWNER });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    const genBefore = getAnalyticsReceiptSelectionDataGeneration();

    invalidateAnalyticsReceiptSelection('receipt_saved');
    expect(getAnalyticsReceiptSelectionDataGeneration()).toBe(genBefore + 1);

    const after = buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: OWNER,
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(2);
    expect(sortedIds(after)).toEqual(
      sortedIds(buildProductDetailExcludedReceiptIdsUncached(rows))
    );
  });

  it('D — owner change → no cross-owner reuse', () => {
    const rows = gyomuPair(['own-a', 'own-b']);
    buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: 'user:owner-a',
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: 'user:owner-b',
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(2);
  });

  it('E — receipt set change → distinct setSignature, no incorrect reuse', () => {
    const base = gyomuPair(['set-a', 'set-b']);
    const withExtra = [
      ...base,
      makeReceipt('set-extra', {
        createdAt: 9_000,
        transactionAt: TX + 86_400_000,
        merchant: 'Extra',
        merchantNormalized: 'Extra',
      }),
    ];
    buildProductDetailExcludedReceiptIds(base, { ownerKey: OWNER });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    buildProductDetailExcludedReceiptIds(withExtra, { ownerKey: OWNER });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(2);
  });

  it('F — empty/missing ownerKey → direct authoritative fallback, same result', () => {
    const rows = gyomuPair(['fb-a', 'fb-b']);
    const uncached = buildProductDetailExcludedReceiptIdsUncached(rows);
    const noOwner = buildProductDetailExcludedReceiptIds(rows);
    const emptyOwner = buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: '',
    });
    const blankOwner = buildProductDetailExcludedReceiptIds(rows, {
      ownerKey: '   ',
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(0);
    expect(sortedIds(noOwner)).toEqual(sortedIds(uncached));
    expect(sortedIds(emptyOwner)).toEqual(sortedIds(uncached));
    expect(sortedIds(blankOwner)).toEqual(sortedIds(uncached));
  });

  it('mutation invalidation: receipt_updated forces Product Detail path recompute', () => {
    const rows = gyomuPair(['mut-a', 'mut-b']);
    buildProductDetailExcludedReceiptIds(rows, { ownerKey: OWNER });
    invalidateAnalyticsReceiptSelection('receipt_updated');
    buildProductDetailExcludedReceiptIds(rows, { ownerKey: OWNER });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(2);

    invalidateAnalyticsReceiptSelection('receipt_deleted');
    buildProductDetailExcludedReceiptIds(rows, { ownerKey: OWNER });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(3);
  });

  it('Receipt078 conservative split: minute precision must not collapse', () => {
    const stored = gyomuPair(['078-a', '078-b']);
    for (const row of stored) {
      row.transaction_time_precision = 'minute';
      const parsed = JSON.parse(row.analysis_json);
      parsed.transactionDate = '2026-06-30 13:36';
      parsed.transaction_time_precision = 'minute';
      row.analysis_json = JSON.stringify(parsed);
    }
    const excluded = buildProductDetailExcludedReceiptIds(stored, {
      ownerKey: OWNER,
    });
    const selection = selectAnalyticsReceipts(stored);
    const universe = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    expect(universe.representativeReceipts.length).toBeGreaterThanOrEqual(2);
    // Neither receipt should be excluded solely as an occurrence non-rep.
    expect(excluded.has('078-a')).toBe(false);
    expect(excluded.has('078-b')).toBe(false);
  });

  it('screen load wires ready ownerKey into exclusion builder', async () => {
    const rows = gyomuPair(['wire-a', 'wire-b']);
    const buildSpy = jest.fn(
      (
        receipts: readonly ReceiptRow[],
        options?: { ownerKey?: string | null; analyticsGeneration?: number }
      ) => buildProductDetailExcludedReceiptIds(receipts, options)
    );

    await runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:wire' },
      'zh',
      {
        isActive: () => true,
        setSummary: jest.fn(),
        setPriceHistory: jest.fn(),
        setLoadFailed: jest.fn(),
        setPriceLoadFailed: jest.fn(),
        setLoading: jest.fn(),
        setPriceLoading: jest.fn(),
      },
      {
        listReceiptsForAnalysis: async () => rows,
        buildProductDetailExcludedReceiptIds: buildSpy,
        resolveOwnerScope: async () =>
          ({
            status: 'ready',
            ownerKey: OWNER,
            predicates: { ownerKey: OWNER },
          }) as never,
        loadProductHistory: async () =>
          ({
            target: { type: 'merchant_product', key: 'mp:wire' },
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
          }) as never,
        loadProductPriceHistory: async () =>
          ({
            status: 'not_enough_points',
            target: { type: 'merchant_product', key: 'mp:wire' },
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
          }) as never,
      }
    );

    expect(buildSpy).toHaveBeenCalledWith(rows, {
      ownerKey: OWNER,
      targetType: 'merchant_product',
      analyticsGeneration: expect.any(Number),
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
  });

  it('screen load: unavailable owner fails safe to direct selection (still builds)', async () => {
    const rows = gyomuPair(['safe-a', 'safe-b']);
    const buildSpy = jest.fn(
      (
        receipts: readonly ReceiptRow[],
        options?: { ownerKey?: string | null; analyticsGeneration?: number }
      ) => buildProductDetailExcludedReceiptIds(receipts, options)
    );

    await runProductDetailMainLoad(
      { type: 'merchant_product', key: 'mp:safe' },
      'zh',
      {
        isActive: () => true,
        setSummary: jest.fn(),
        setPriceHistory: jest.fn(),
        setLoadFailed: jest.fn(),
        setPriceLoadFailed: jest.fn(),
        setLoading: jest.fn(),
        setPriceLoading: jest.fn(),
      },
      {
        listReceiptsForAnalysis: async () => rows,
        buildProductDetailExcludedReceiptIds: buildSpy,
        resolveOwnerScope: async () => {
          throw new Error('owner boom');
        },
        loadProductHistory: async () =>
          ({
            target: { type: 'merchant_product', key: 'mp:safe' },
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
          }) as never,
        loadProductPriceHistory: async () =>
          ({
            status: 'not_enough_points',
            target: { type: 'merchant_product', key: 'mp:safe' },
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
          }) as never,
      }
    );

    expect(buildSpy).toHaveBeenCalledWith(rows, {
      ownerKey: undefined,
      targetType: 'merchant_product',
      analyticsGeneration: expect.any(Number),
    });
    // Direct path: no cache builds.
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(0);
  });
});
