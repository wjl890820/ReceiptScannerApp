/**
 * Performance Slice 3D / 3D.1 — shared occurrence index cache + generation provenance.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./receiptOwnershipScope', () => ({
  resolveCurrentLocalReceiptOwnerScope: jest.fn(async () => ({
    status: 'ready' as const,
    ownerKey: 'user:slice3d-owner',
    receiptWhereSql: 'user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: ['slice3d-owner'],
  })),
}));

import type { ReceiptRow } from './db';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionDataGeneration,
  invalidateAnalyticsReceiptSelection,
  selectAnalyticsReceiptsCached,
} from './analyticsReceiptSelectionCache';
import * as canonicalPurchaseOccurrence from './canonicalPurchaseOccurrence';
import {
  applyOccurrenceRepresentativeUniverse,
  buildCanonicalPurchaseOccurrenceIndex,
  collectNonRepresentativeOccurrenceReceiptIds,
} from './canonicalPurchaseOccurrence';
import {
  __resetCanonicalPurchaseOccurrenceCacheForTests,
  applyOccurrenceRepresentativeUniverseCached,
  getCanonicalPurchaseOccurrenceBuildCount,
  getOrBuildCanonicalPurchaseOccurrenceIndexCached,
} from './canonicalPurchaseOccurrenceCache';
import {
  evaluateCurrentEngagementMilestoneWithDb,
  type EngagementMilestoneDatabase,
  type EngagementPreloadedAnalyticsContext,
  type EngagementReceipt,
} from './engagementMilestones';
import {
  beginProductDetailLoadTimingCapture,
  enableProductDetailLoadTimingsForTests,
  endProductDetailLoadTimingCapture,
} from './productDetailLoadTimings';
import {
  buildProductDetailExcludedReceiptIds,
  buildProductDetailExcludedReceiptIdsUncached,
} from './productDetailOccurrenceExclusions';

const TX = Date.parse('2026-06-30T13:36:46+09:00');
const OWNER = 'user:slice3d-owner';

function liveGen(): number {
  return getAnalyticsReceiptSelectionDataGeneration();
}

function sortedIds(set: ReadonlySet<string>): string[] {
  return [...set].sort((a, b) => a.localeCompare(b));
}

function indexFingerprint(index: ReturnType<typeof buildCanonicalPurchaseOccurrenceIndex>) {
  return {
    occurrenceIdByReceiptId: [...index.occurrenceIdByReceiptId.entries()].sort(
      (a, b) => a[0].localeCompare(b[0])
    ),
    representativeReceiptIdByOccurrenceId: [
      ...index.representativeReceiptIdByOccurrenceId.entries(),
    ].sort((a, b) => a[0].localeCompare(b[0])),
    representativeReceiptIdByReceiptId: [
      ...index.representativeReceiptIdByReceiptId.entries(),
    ].sort((a, b) => a[0].localeCompare(b[0])),
    groups: index.groups.map((g) => ({
      occurrenceId: g.occurrenceId,
      receiptIds: [...g.receiptIds],
      representativeReceiptId: g.representativeReceiptId,
    })),
  };
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

describe('Slice 3D.1 — occurrence cache generation provenance', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetCanonicalPurchaseOccurrenceCacheForTests();
  });

  describe('differential equivalence', () => {
    it('fresh ≡ cached MISS ≡ cached HIT (index + apply union)', () => {
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
      const g = liveGen();
      const hcExcluded = new Set<string>();
      const freshIndex = buildCanonicalPurchaseOccurrenceIndex(rows);
      const freshApply = applyOccurrenceRepresentativeUniverse(
        rows,
        hcExcluded
      );

      const miss = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: rows,
        ownerKey: OWNER,
        analyticsGeneration: g,
      });
      expect(miss.ok).toBe(true);
      if (!miss.ok) return;
      expect(miss.cacheState).toBe('miss');
      expect(indexFingerprint(miss.index)).toEqual(
        indexFingerprint(freshIndex)
      );

      const hit = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: rows,
        ownerKey: OWNER,
        analyticsGeneration: g,
      });
      expect(hit.ok).toBe(true);
      if (!hit.ok) return;
      expect(hit.cacheState).toBe('hit');
      expect(indexFingerprint(hit.index)).toEqual(
        indexFingerprint(freshIndex)
      );

      const cachedApply = applyOccurrenceRepresentativeUniverseCached(
        rows,
        hcExcluded,
        { ownerKey: OWNER, analyticsGeneration: g }
      );
      expect(cachedApply.ok).toBe(true);
      if (!cachedApply.ok) return;
      expect(sortedIds(cachedApply.excludedReceiptIds)).toEqual(
        sortedIds(freshApply.excludedReceiptIds)
      );
    });
  });

  describe('cache behavior', () => {
    it('A — input gen == live + cold → MISS', () => {
      const rows = gyomuPair(['a-a', 'a-b']);
      const result = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: rows,
        ownerKey: OWNER,
        analyticsGeneration: liveGen(),
      });
      expect(result).toEqual(
        expect.objectContaining({ ok: true, cacheState: 'miss' })
      );
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(1);
    });

    it('B — same valid input generation → HIT', () => {
      const rows = gyomuPair(['b-a', 'b-b']);
      const g = liveGen();
      getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: rows,
        ownerKey: OWNER,
        analyticsGeneration: g,
      });
      expect(
        getOrBuildCanonicalPurchaseOccurrenceIndexCached({
          analyticsReceipts: rows,
          ownerKey: OWNER,
          analyticsGeneration: g,
        })
      ).toEqual(expect.objectContaining({ ok: true, cacheState: 'hit' }));
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(1);
    });

    it('C — input generation < live → stale, no write', () => {
      const rows = gyomuPair(['c-a', 'c-b']);
      const staleGen = liveGen();
      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBeGreaterThan(staleGen);
      const result = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: rows,
        ownerKey: OWNER,
        analyticsGeneration: staleGen,
      });
      expect(result).toEqual({ ok: false, cacheState: 'stale' });
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);
    });

    it('D — generation changes after build before insertion → no insertion', () => {
      const rows = gyomuPair(['d-a', 'd-b']);
      const g = liveGen();
      const original =
        canonicalPurchaseOccurrence.prepareCanonicalPurchaseOccurrenceEvidence;
      const spy = jest
        .spyOn(
          canonicalPurchaseOccurrence,
          'prepareCanonicalPurchaseOccurrenceEvidence'
        )
        .mockImplementation((receipts) => {
          invalidateAnalyticsReceiptSelection('receipt_updated');
          return original(receipts);
        });
      const result = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: rows,
        ownerKey: OWNER,
        analyticsGeneration: g,
      });
      expect(result).toEqual({ ok: false, cacheState: 'stale' });
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);
      spy.mockRestore();
      // Fresh G+1 call should MISS and insert.
      const fresh = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: rows,
        ownerKey: OWNER,
        analyticsGeneration: liveGen(),
      });
      expect(fresh).toEqual(
        expect.objectContaining({ ok: true, cacheState: 'miss' })
      );
    });

    it('E — different owner → MISS', () => {
      const rows = gyomuPair(['e-a', 'e-b']);
      const g = liveGen();
      expect(
        getOrBuildCanonicalPurchaseOccurrenceIndexCached({
          analyticsReceipts: rows,
          ownerKey: 'user:owner-a',
          analyticsGeneration: g,
        })
      ).toEqual(expect.objectContaining({ ok: true, cacheState: 'miss' }));
      expect(
        getOrBuildCanonicalPurchaseOccurrenceIndexCached({
          analyticsReceipts: rows,
          ownerKey: 'user:owner-b',
          analyticsGeneration: g,
        })
      ).toEqual(expect.objectContaining({ ok: true, cacheState: 'miss' }));
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(2);
    });

    it('F — different retained set → MISS', () => {
      const base = gyomuPair(['f-a', 'f-b']);
      const withExtra = [
        ...base,
        makeReceipt('f-extra', {
          createdAt: 9_000,
          transactionAt: TX + 86_400_000,
          merchant: 'Extra',
          merchantNormalized: 'Extra',
        }),
      ];
      const g = liveGen();
      getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: base,
        ownerKey: OWNER,
        analyticsGeneration: g,
      });
      expect(
        getOrBuildCanonicalPurchaseOccurrenceIndexCached({
          analyticsReceipts: withExtra,
          ownerKey: OWNER,
          analyticsGeneration: g,
        })
      ).toEqual(expect.objectContaining({ ok: true, cacheState: 'miss' }));
    });

    it('G — same set different order → HIT', () => {
      const a = gyomuPair(['g-a', 'g-b']);
      const reversed = [a[1]!, a[0]!];
      const gen = liveGen();
      getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: a,
        ownerKey: OWNER,
        analyticsGeneration: gen,
      });
      expect(
        getOrBuildCanonicalPurchaseOccurrenceIndexCached({
          analyticsReceipts: reversed,
          ownerKey: OWNER,
          analyticsGeneration: gen,
        })
      ).toEqual(expect.objectContaining({ ok: true, cacheState: 'hit' }));
    });

    it('H — valid generation + missing owner → direct', () => {
      const rows = gyomuPair(['h-a', 'h-b']);
      expect(
        getOrBuildCanonicalPurchaseOccurrenceIndexCached({
          analyticsReceipts: rows,
          analyticsGeneration: liveGen(),
        })
      ).toEqual(expect.objectContaining({ ok: true, cacheState: 'direct' }));
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);
    });

    it('I — stale generation + missing owner → stale, NOT direct', () => {
      const rows = gyomuPair(['i-a', 'i-b']);
      const staleGen = liveGen();
      invalidateAnalyticsReceiptSelection('receipt_saved');
      expect(
        getOrBuildCanonicalPurchaseOccurrenceIndexCached({
          analyticsReceipts: rows,
          analyticsGeneration: staleGen,
        })
      ).toEqual({ ok: false, cacheState: 'stale' });
    });
  });

  describe('REQUIRED stale-poisoning regression', () => {
    it('stale G preloaded continuation must not poison G+1 occurrence cache', () => {
      // Treat as already HC-retained analytics rows (both kept).
      // Second-precision gyomu pair merges under occurrence at G.
      const analyticsG = gyomuPair(['poison-a', 'poison-b']);
      expect(analyticsG.length).toBe(2);
      const generationG = liveGen();
      const hcExcludedG = new Set<string>();

      const mergeAtG = buildCanonicalPurchaseOccurrenceIndex(analyticsG);
      expect(mergeAtG.groups.length).toBe(1);

      // Immutable G-era clones for the stale Home continuation.
      const staleAnalyticsRows = analyticsG.map((row) => ({
        ...row,
        analysis_json: row.analysis_json,
      }));

      // Mutate live truth without changing receipt IDs (minute + incompatible merchant).
      const liveRows = analyticsG.map((row) => ({ ...row }));
      const liveB = liveRows.find((r) => r.id === 'poison-b')!;
      liveB.merchant_raw = '別店X';
      liveB.merchant_normalized = '別店X';
      liveB.transaction_time_precision = 'minute';
      const parsed = JSON.parse(liveB.analysis_json);
      parsed.merchant = '別店X';
      parsed.transactionDate = '2026-06-30 13:36';
      parsed.transaction_time_precision = 'minute';
      liveB.analysis_json = JSON.stringify(parsed);

      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      const freshIndex = buildCanonicalPurchaseOccurrenceIndex(liveRows);
      expect(freshIndex.groups.length).toBeGreaterThanOrEqual(2);
      expect(
        collectNonRepresentativeOccurrenceReceiptIds(liveRows, freshIndex).size
      ).toBe(0);

      // Stale Home/preloaded G continuation.
      const staleApply = applyOccurrenceRepresentativeUniverseCached(
        staleAnalyticsRows,
        hcExcludedG,
        { ownerKey: OWNER, analyticsGeneration: generationG }
      );
      expect(staleApply).toEqual({ ok: false, cacheState: 'stale' });
      expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(0);

      const detailG1 = applyOccurrenceRepresentativeUniverseCached(
        liveRows,
        hcExcludedG,
        { ownerKey: OWNER, analyticsGeneration: liveGen() }
      );
      expect(detailG1.ok).toBe(true);
      if (!detailG1.ok) return;
      expect(detailG1.cacheState).toBe('miss');
      expect(detailG1.occurrenceIndex.groups.length).toBeGreaterThanOrEqual(2);
      expect(
        collectNonRepresentativeOccurrenceReceiptIds(
          liveRows,
          detailG1.occurrenceIndex
        ).size
      ).toBe(0);
      // No genuine current purchase excluded as non-representative.
      expect(detailG1.excludedReceiptIds.size).toBe(0);
    });

    it('production-path Home preloaded: mid-flight bump prevents cache poison', async () => {
      const analyticsRows = gyomuPair(['home-a', 'home-b']);
      expect(
        buildCanonicalPurchaseOccurrenceIndex(analyticsRows).groups.length
      ).toBe(1);
      const generationG = liveGen();
      const preloaded: EngagementPreloadedAnalyticsContext = {
        ownerKey: OWNER,
        receipts: analyticsRows as EngagementReceipt[],
        analyticsReceipts: analyticsRows as EngagementReceipt[],
        excludedDuplicateReceiptIds: new Set(),
        analyticsGeneration: generationG,
        precomputedSelection: true,
        sharedProductInsight: Promise.resolve({
          rows: [],
          queryFailed: false,
        }),
      };

      invalidateAnalyticsReceiptSelection('receipt_updated');
      expect(liveGen()).toBe(generationG + 1);

      const db = {
        getAllAsync: jest.fn(async () => analyticsRows),
      } as unknown as EngagementMilestoneDatabase;

      await evaluateCurrentEngagementMilestoneWithDb(db, { preloaded });

      const stale = applyOccurrenceRepresentativeUniverseCached(
        analyticsRows,
        new Set(),
        { ownerKey: OWNER, analyticsGeneration: generationG }
      );
      expect(stale).toEqual({ ok: false, cacheState: 'stale' });
    });
  });

  describe('Product Detail provenance', () => {
    it('stable generation: selection G → occurrence receives G → HIT on second open', () => {
      const rows = gyomuPair(['pd-a', 'pd-b']);
      enableProductDetailLoadTimingsForTests(true);
      beginProductDetailLoadTimingCapture();
      const first = buildProductDetailExcludedReceiptIds(rows, {
        ownerKey: OWNER,
      });
      const firstSamples = endProductDetailLoadTimingCapture();
      expect(
        firstSamples.find(
          (s) => s.stage === 'productDetail.exclusionOccurrence'
        )?.cacheState
      ).toBe('miss');

      beginProductDetailLoadTimingCapture();
      const second = buildProductDetailExcludedReceiptIds(rows, {
        ownerKey: OWNER,
      });
      const secondSamples = endProductDetailLoadTimingCapture();
      enableProductDetailLoadTimingsForTests(false);
      expect(
        secondSamples.find(
          (s) => s.stage === 'productDetail.exclusionOccurrence'
        )?.cacheState
      ).toBe('hit');
      expect(sortedIds(second)).toEqual(sortedIds(first));
      expect(sortedIds(first)).toEqual(
        sortedIds(buildProductDetailExcludedReceiptIdsUncached(rows))
      );
    });

    it('generation mismatch during occurrence throws (no stale exclusions)', () => {
      const rows = gyomuPair(['pd-stale-a', 'pd-stale-b']);
      const original =
        canonicalPurchaseOccurrence.prepareCanonicalPurchaseOccurrenceEvidence;
      const spy = jest
        .spyOn(
          canonicalPurchaseOccurrence,
          'prepareCanonicalPurchaseOccurrenceEvidence'
        )
        .mockImplementation((receipts) => {
          invalidateAnalyticsReceiptSelection('receipt_updated');
          return original(receipts);
        });
      expect(() =>
        buildProductDetailExcludedReceiptIds(rows, { ownerKey: OWNER })
      ).toThrow(/analytics generation drifted|stale|product_detail_occurrence_stale/);
      spy.mockRestore();
    });
  });

  describe('078 conservative split through cache', () => {
    it('minute precision remains split on MISS and HIT', () => {
      const stored = gyomuPair(['078-a', '078-b']);
      for (const row of stored) {
        row.transaction_time_precision = 'minute';
        const parsed = JSON.parse(row.analysis_json);
        parsed.transactionDate = '2026-06-30 13:36';
        parsed.transaction_time_precision = 'minute';
        row.analysis_json = JSON.stringify(parsed);
      }
      const g = liveGen();
      const miss = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: stored,
        ownerKey: OWNER,
        analyticsGeneration: g,
      });
      expect(miss.ok).toBe(true);
      if (!miss.ok) return;
      expect(miss.cacheState).toBe('miss');
      expect(miss.index.groups.length).toBeGreaterThanOrEqual(2);

      const hit = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
        analyticsReceipts: stored,
        ownerKey: OWNER,
        analyticsGeneration: g,
      });
      expect(hit.ok).toBe(true);
      if (!hit.ok) return;
      expect(hit.cacheState).toBe('hit');
      expect(indexFingerprint(hit.index)).toEqual(
        indexFingerprint(miss.index)
      );
    });
  });

  describe('Home→Detail prewarm still works', () => {
    it('Home occurrence MISS then Detail HIT at same generation', () => {
      const ownerScoped = gyomuPair(['warm-a', 'warm-b']);
      const g = liveGen();
      const selection = selectAnalyticsReceiptsCached({
        ownerKey: OWNER,
        receipts: ownerScoped,
      })!;
      const home = applyOccurrenceRepresentativeUniverseCached(
        selection.analyticsReceipts,
        selection.excludedDuplicateReceiptIds,
        { ownerKey: OWNER, analyticsGeneration: g }
      );
      expect(home.ok).toBe(true);
      if (!home.ok) return;
      expect(home.cacheState).toBe('miss');

      enableProductDetailLoadTimingsForTests(true);
      beginProductDetailLoadTimingCapture();
      const detailExcluded = buildProductDetailExcludedReceiptIds(ownerScoped, {
        ownerKey: OWNER,
        targetType: 'merchant_product',
      });
      const samples = endProductDetailLoadTimingCapture();
      enableProductDetailLoadTimingsForTests(false);

      expect(
        samples.find((s) => s.stage === 'productDetail.exclusionOccurrence')
          ?.cacheState
      ).toBe('hit');
      expect(sortedIds(detailExcluded)).toEqual(
        sortedIds(home.excludedReceiptIds)
      );
    });
  });
});
