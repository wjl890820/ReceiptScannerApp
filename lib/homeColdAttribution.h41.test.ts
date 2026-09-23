/**
 * Home Performance Slice H4.1a/H4.1b — baseline stale reconciliation +
 * immediate ProductContext rejection observation.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionDataGeneration,
  invalidateAnalyticsReceiptSelection,
} from './analyticsReceiptSelectionCache';
import * as canonicalPurchaseOccurrence from './canonicalPurchaseOccurrence';
import {
  __resetCanonicalPurchaseOccurrenceCacheForTests,
  getCanonicalPurchaseOccurrenceBuildCount,
} from './canonicalPurchaseOccurrenceCache';
import * as currentItemMonetaryTruth from './currentItemMonetaryTruth';
import {
  __setProductInsightPreOccurrenceHooksForTests,
  loadEngagementProductInsightContextWithDb,
  type EngagementMilestoneDatabase,
  type EngagementPreloadedAnalyticsContext,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';
import {
  __resetHomeFocusHeavySnapshotForTests,
  commitHomeFocusHeavySnapshot,
  tryReuseHomeFocusHeavySnapshot,
} from './homeFocusHeavySnapshot';
import { buildHomeProgressiveExperienceBundle } from './homeProgressiveExperience';
import {
  beginHomeRefreshTimingCapture,
  enableHomeRefreshTimingsForTests,
  endHomeRefreshTimingCapture,
  type HomeRefreshTimingSample,
} from './homeRefreshTimings';
import { readTabFocusDataGenerations } from './tabFocusDataGenerations';
import type { ReceiptRow } from './db';

const OWNER = 'user:h41-owner';
const USER_ID = 'h41-user';

const mockResolveCurrentLocalReceiptOwnerScope = jest.fn();
jest.mock('./receiptOwnershipScope', () => {
  const actual = jest.requireActual('./receiptOwnershipScope');
  return {
    ...actual,
    resolveCurrentLocalReceiptOwnerScope: (...args: unknown[]) =>
      mockResolveCurrentLocalReceiptOwnerScope(...args),
  };
});

function privacyKeysOf(sample: HomeRefreshTimingSample): string[] {
  return Object.keys(sample).filter(
    (k) =>
      ![
        'stage',
        'durationMs',
        'receiptCount',
        'analyticsReceiptCount',
        'productRowCount',
        'success',
        'rowCount',
        'itemRowCount',
        'decisionCount',
        'inputRowCount',
        'outputRowCount',
        'resolvedRowCount',
        'cacheState',
      ].includes(k)
  );
}

function baseReceipt(id: string, at: number): ReceiptRow {
  return {
    id,
    created_at: at,
    transaction_at: at,
    transaction_time_precision: 'second',
    image_uri: '',
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    total: 100,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      merchant: 'イオン',
      total: 100,
      tax: 0,
      tax_is_known: true,
      currency: 'JPY',
      is_grocery: true,
      merchant_type: 'supermarket',
      items: [{ name: 'Milk', quantity: 1, lineTotal: 100 }],
      transaction_time_precision: 'second',
      transactionDate: '2026-07-06 11:44:46',
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: USER_ID,
    installation_id: null,
  };
}

function productRow(
  receiptId: string,
  itemId: string,
  at: number
): EngagementProductRow {
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    occurredAt: at,
    merchantRaw: 'イオン',
    merchantNormalized: 'イオン',
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    receiptAnalysisJson: '{}',
    displayName: 'Milk',
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    canonicalProductName: null,
    productFamilyKey: null,
    skuKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    grossLineAmount: 100,
    effectiveLineAmount: 100,
    discountAllocated: null,
    amountProvenance: null,
    itemAmountEvidenceState: null,
    promoMarkersJson: null,
    evidenceCaptureVersion: null,
    priceObservationVersion: null,
    itemSource: null,
    identitySource: null,
    identityConfidence: null,
    receiptUserItemsJson: null,
    receiptUserEdited: 0,
    receiptTotal: 100,
    receiptFinalTotal: null,
    receiptTax: 0,
    receiptTaxIsKnown: 0,
    receiptCurrency: 'JPY',
  } as EngagementProductRow;
}

function ownerScopeReady() {
  return {
    status: 'ready' as const,
    ownerKey: OWNER,
    receiptWhereSql: 'user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: [USER_ID],
  };
}

function makePreloaded(
  receipts: ReceiptRow[],
  excluded: ReadonlySet<string> = new Set()
): EngagementPreloadedAnalyticsContext {
  return {
    ownerKey: OWNER,
    receipts: receipts as EngagementReceipt[],
    analyticsReceipts: receipts as EngagementReceipt[],
    excludedDuplicateReceiptIds: excluded,
    analyticsGeneration: getAnalyticsReceiptSelectionDataGeneration(),
    precomputedSelection: true,
  };
}

function makeStalePreloaded(
  receipts: ReceiptRow[],
  excluded: ReadonlySet<string> = new Set()
): EngagementPreloadedAnalyticsContext {
  const preloaded = makePreloaded(receipts, excluded);
  // Distinct from live generation → apply returns { ok:false, cacheState:'stale' }.
  preloaded.analyticsGeneration =
    getAnalyticsReceiptSelectionDataGeneration() + 1_000_001;
  return preloaded;
}

function productItemsCallCount(
  getAllAsync: jest.Mock
): number {
  return getAllAsync.mock.calls.filter((c) =>
    String(c[0]).includes('FROM receipt_items')
  ).length;
}

beforeEach(() => {
  enableHomeRefreshTimingsForTests(true);
  beginHomeRefreshTimingCapture();
  __resetCanonicalPurchaseOccurrenceCacheForTests();
  __resetAnalyticsReceiptSelectionCacheForTests();
  __resetHomeFocusHeavySnapshotForTests();
  __setProductInsightPreOccurrenceHooksForTests(null);
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue(ownerScopeReady());
  jest
    .spyOn(currentItemMonetaryTruth, 'enrichProductRowsWithCurrentItemMonetaryTruth')
    .mockImplementation((rows) => [...rows]);
});

afterEach(() => {
  enableHomeRefreshTimingsForTests(false);
  endHomeRefreshTimingCapture();
  __setProductInsightPreOccurrenceHooksForTests(null);
  jest.restoreAllMocks();
  __resetCanonicalPurchaseOccurrenceCacheForTests();
  __resetAnalyticsReceiptSelectionCacheForTests();
  __resetHomeFocusHeavySnapshotForTests();
});

describe('H4.1a — overlap + baseline stale reconciliation', () => {
  it('ordering: getAllAsync before occurrence prepare; then enrich→filter', async () => {
    const events: string[] = [];
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const row = productRow('r1', 'i1', 1_700_000_000_000);

    const originalPrepare =
      canonicalPurchaseOccurrence.prepareCanonicalPurchaseOccurrenceEvidence;
    jest
      .spyOn(
        canonicalPurchaseOccurrence,
        'prepareCanonicalPurchaseOccurrenceEvidence'
      )
      .mockImplementation((receipts) => {
        events.push('occurrence-prepare');
        return originalPrepare(receipts);
      });

    jest
      .spyOn(
        currentItemMonetaryTruth,
        'enrichProductRowsWithCurrentItemMonetaryTruth'
      )
      .mockImplementation((rows) => {
        events.push('enrich');
        return [...rows];
      });

    const db = {
      getAllAsync: jest.fn(async (sql: string) => {
        if (String(sql).includes('FROM receipt_items')) {
          events.push('product-db');
          return [row];
        }
        return [];
      }),
    } as unknown as EngagementMilestoneDatabase;

    const ctx = await loadEngagementProductInsightContextWithDb(db, {
      preloaded: makePreloaded([receipt]),
    });
    expect(ctx.queryFailed).toBe(false);
    expect(ctx.rows).toHaveLength(1);

    expect(events.indexOf('product-db')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('occurrence-prepare')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('enrich')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('product-db')).toBeLessThan(
      events.indexOf('occurrence-prepare')
    );
    expect(events.indexOf('occurrence-prepare')).toBeLessThan(
      events.indexOf('enrich')
    );
  });

  it('MISS: prepare once, prepared captured, rows filtered, timings once', async () => {
    const keep = baseReceipt('keep', 1_700_000_000_000);
    const drop = baseReceipt('drop', 1_700_000_000_100);
    drop.transaction_at = keep.transaction_at;
    drop.created_at = keep.created_at + 10;
    drop.analysis_json = keep.analysis_json;
    drop.merchant_raw = keep.merchant_raw;
    drop.merchant_normalized = keep.merchant_normalized;
    drop.total = keep.total;
    drop.tax = keep.tax;

    const rows = [
      productRow('keep', 'ik', keep.created_at),
      productRow('drop', 'id', drop.created_at),
    ];
    const db = {
      getAllAsync: jest.fn(async (sql: string) => {
        if (String(sql).includes('FROM receipt_items')) return rows;
        return [];
      }),
    } as unknown as EngagementMilestoneDatabase;

    const preloaded = makePreloaded([keep, drop]);
    const prepareSpy = jest.spyOn(
      canonicalPurchaseOccurrence,
      'prepareCanonicalPurchaseOccurrenceEvidence'
    );

    const ctx = await loadEngagementProductInsightContextWithDb(db, {
      preloaded,
    });

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(1);
    expect(preloaded.occurrencePreparedEvidence).toBeDefined();
    expect(ctx.queryFailed).toBe(false);
    expect(ctx.rows.every((r) => r.receiptId !== 'drop')).toBe(true);
    expect(ctx.rows.some((r) => r.receiptId === 'keep')).toBe(true);

    const samples = endHomeRefreshTimingCapture();
    expect(
      samples.filter((s) => s.stage === 'home.occurrence.apply')
    ).toHaveLength(1);
    expect(
      samples.filter((s) => s.stage === 'home.productContext.db')
    ).toHaveLength(1);
    expect(
      samples.filter((s) => s.stage === 'home.productContext.enrich')
    ).toHaveLength(1);
    const occ = samples.find((s) => s.stage === 'home.occurrence.apply')!;
    expect(occ.success).toBe(true);
    expect(occ.cacheState).toBe('miss');
    expect(privacyKeysOf(occ)).toEqual([]);
  });

  it('HIT: no prepare, no prepared evidence, output filtered from cache', async () => {
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const row = productRow('r1', 'i1', 1_700_000_000_000);
    const db = {
      getAllAsync: jest.fn(async (sql: string) => {
        if (String(sql).includes('FROM receipt_items')) return [row];
        return [];
      }),
    } as unknown as EngagementMilestoneDatabase;

    await loadEngagementProductInsightContextWithDb(db, {
      preloaded: makePreloaded([receipt]),
    });
    endHomeRefreshTimingCapture();
    beginHomeRefreshTimingCapture();

    const prepareSpy = jest.spyOn(
      canonicalPurchaseOccurrence,
      'prepareCanonicalPurchaseOccurrenceEvidence'
    );
    const preloaded2 = makePreloaded([receipt]);
    const ctx = await loadEngagementProductInsightContextWithDb(db, {
      preloaded: preloaded2,
    });

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(preloaded2.occurrencePreparedEvidence).toBeUndefined();
    expect(ctx.rows).toHaveLength(1);

    const samples = endHomeRefreshTimingCapture();
    const occ = samples.find((s) => s.stage === 'home.occurrence.apply');
    expect(occ?.cacheState).toBe('hit');
    expect(occ?.success).toBe(true);
  });

  it('stale: drain DB#1, fresh fallback DB#2, no prepared promote', async () => {
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const db1Row = productRow('from-db1', 'i-db1', 1_700_000_000_000);
    const db2Row = productRow('from-db2', 'i-db2', 1_700_000_000_000);
    let productItemsCalls = 0;
    let releaseDb1!: () => void;
    const db1Gate = new Promise<void>((resolve) => {
      releaseDb1 = resolve;
    });

    const getAllAsync = jest.fn(async (sql: string) => {
      if (String(sql).includes('FROM receipt_items')) {
        productItemsCalls += 1;
        if (productItemsCalls === 1) {
          await db1Gate;
          return [db1Row];
        }
        return [db2Row];
      }
      if (String(sql).includes('FROM receipts')) {
        return [receipt];
      }
      return [];
    });
    const db = { getAllAsync } as unknown as EngagementMilestoneDatabase;

    const preloaded = makeStalePreloaded([receipt]);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const ctxPromise = loadEngagementProductInsightContextWithDb(db, {
        preloaded,
      });
      await Promise.resolve();
      await Promise.resolve();
      releaseDb1();
      const ctx = await ctxPromise;

      expect(ctx.queryFailed).toBe(false);
      expect(ctx.rows.some((r) => r.receiptId === 'from-db2')).toBe(true);
      expect(ctx.rows.every((r) => r.receiptId !== 'from-db1')).toBe(true);
      expect(productItemsCallCount(getAllAsync)).toBe(2);
      expect(preloaded.occurrencePreparedEvidence).toBeUndefined();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      releaseDb1();
    }
  });

  it('stale fallback selection failure → empty baseline, no DB#1 authority', async () => {
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const db1Row = productRow('from-db1', 'i-db1', 1);
    let productItemsCalls = 0;

    const getAllAsync = jest.fn(async (sql: string) => {
      if (String(sql).includes('FROM receipt_items')) {
        productItemsCalls += 1;
        return [db1Row];
      }
      if (String(sql).includes('FROM receipts')) {
        // Drift during fallthrough read → provenance ok:false → empty.
        invalidateAnalyticsReceiptSelection('receipt_updated');
        return [receipt];
      }
      return [];
    });
    const db = { getAllAsync } as unknown as EngagementMilestoneDatabase;

    const preloaded = makeStalePreloaded([receipt]);
    const ctx = await loadEngagementProductInsightContextWithDb(db, {
      preloaded,
    });

    expect(ctx).toEqual({ rows: [], queryFailed: false });
    expect(ctx.rows.every((r) => r.receiptId !== 'from-db1')).toBe(true);
    expect(preloaded.occurrencePreparedEvidence).toBeUndefined();
    // DB #1 started; fallthrough never reached a successful ProductContext DB #2.
    expect(productItemsCalls).toBe(1);
  });

  it('stale + DB#1 rejects later: no unhandled, fallback result preserved', async () => {
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const db2Row = productRow('from-db2', 'i-db2', 1_700_000_000_000);
    let rejectDb1!: (err: Error) => void;
    const db1Promise = new Promise<EngagementProductRow[]>((_, reject) => {
      rejectDb1 = reject;
    });
    let productItemsCalls = 0;

    const getAllAsync = jest.fn((sql: string) => {
      if (String(sql).includes('FROM receipt_items')) {
        productItemsCalls += 1;
        if (productItemsCalls === 1) {
          return db1Promise;
        }
        return Promise.resolve([db2Row]);
      }
      if (String(sql).includes('FROM receipts')) {
        return Promise.resolve([receipt]);
      }
      return Promise.resolve([]);
    });
    const db = { getAllAsync } as unknown as EngagementMilestoneDatabase;

    const preloaded = makeStalePreloaded([receipt]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const ctx = await loadEngagementProductInsightContextWithDb(db, {
        preloaded,
      });
      expect(ctx.queryFailed).toBe(false);
      expect(ctx.rows.some((r) => r.receiptId === 'from-db2')).toBe(true);
      rejectDb1(new Error('db1-boom'));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      expect(productItemsCallCount(getAllAsync)).toBe(2);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('occurrence throw + DB reject: occurrence wins, DB drained, no unhandled', async () => {
    const receipt = baseReceipt('r1', 1);
    let rejectDb!: (err: Error) => void;
    const dbPromise = new Promise<EngagementProductRow[]>((_, reject) => {
      rejectDb = reject;
    });

    const db = {
      getAllAsync: jest.fn((sql: string) => {
        if (String(sql).includes('FROM receipt_items')) {
          return dbPromise;
        }
        return Promise.resolve([]);
      }),
    } as unknown as EngagementMilestoneDatabase;

    jest
      .spyOn(
        canonicalPurchaseOccurrence,
        'prepareCanonicalPurchaseOccurrenceEvidence'
      )
      .mockImplementation(() => {
        throw new Error('occurrence-boom');
      });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const p = loadEngagementProductInsightContextWithDb(db, {
        preloaded: makePreloaded([receipt]),
      });
      await expect(p).rejects.toThrow('occurrence-boom');
      rejectDb(new Error('db-boom'));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('occurrence ok + DB fail → queryFailed true', async () => {
    const receipt = baseReceipt('r1', 1);
    const db = {
      getAllAsync: jest.fn(async (sql: string) => {
        if (String(sql).includes('FROM receipt_items')) {
          throw new Error('db-boom');
        }
        return [];
      }),
    } as unknown as EngagementMilestoneDatabase;

    const ctx = await loadEngagementProductInsightContextWithDb(db, {
      preloaded: makePreloaded([receipt]),
    });
    expect(ctx.queryFailed).toBe(true);
    expect(ctx.rows).toEqual([]);
  });

  it('single-flight: shared promise → one product DB query', async () => {
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const row = productRow('r1', 'i1', 1_700_000_000_000);
    const getAllAsync = jest.fn(async (sql: string) => {
      if (String(sql).includes('FROM receipt_items')) return [row];
      return [];
    });
    const db = { getAllAsync } as unknown as EngagementMilestoneDatabase;
    const preloaded = makePreloaded([receipt]);
    const shared = loadEngagementProductInsightContextWithDb(db, {
      preloaded: { ...preloaded, sharedProductInsight: undefined },
    });
    preloaded.sharedProductInsight = shared;

    const [a, b] = await Promise.all([
      loadEngagementProductInsightContextWithDb(db, { preloaded }),
      loadEngagementProductInsightContextWithDb(db, { preloaded }),
    ]);
    expect(a).toBe(b);
    expect(productItemsCallCount(getAllAsync)).toBe(1);
  });

  it('enrich-before-filter: enrich receives retained + excluded raw rows', async () => {
    const keep = baseReceipt('keep', 1_000);
    const drop = baseReceipt('drop', 2_000);
    const rows = [
      productRow('keep', 'ik', 1_000),
      productRow('drop', 'id', 2_000),
    ];
    const db = {
      getAllAsync: jest.fn(async (sql: string) => {
        if (String(sql).includes('FROM receipt_items')) return rows;
        return [];
      }),
    } as unknown as EngagementMilestoneDatabase;

    const enrichSpy = jest
      .spyOn(
        currentItemMonetaryTruth,
        'enrichProductRowsWithCurrentItemMonetaryTruth'
      )
      .mockImplementation((input) => [...input]);

    const ctx = await loadEngagementProductInsightContextWithDb(db, {
      preloaded: makePreloaded([keep, drop], new Set(['drop'])),
    });

    expect(enrichSpy).toHaveBeenCalledTimes(1);
    const enrichedInput = enrichSpy.mock.calls[0]![0] as EngagementProductRow[];
    expect(enrichedInput.map((r) => r.receiptId).sort()).toEqual([
      'drop',
      'keep',
    ]);
    expect(ctx.rows.every((r) => r.receiptId !== 'drop')).toBe(true);
    expect(ctx.rows.some((r) => r.receiptId === 'keep')).toBe(true);

    const samples = endHomeRefreshTimingCapture();
    const enrichSample = samples.find(
      (s) => s.stage === 'home.productContext.enrich'
    );
    expect(enrichSample?.inputRowCount).toBe(2);
  });

  it('occurrence timer starts only after awaited dynamic import', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, './engagementMilestones.ts'),
      'utf8'
    );
    const fnStart = source.indexOf(
      'export async function loadEngagementProductInsightContextWithDb'
    );
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const preloadedBlock = source.slice(
      fnStart,
      source.indexOf(
        'export async function loadEngagementProductInsightContext(',
        fnStart
      )
    );
    const importIdx = preloadedBlock.indexOf(
      "await import(\n        './canonicalPurchaseOccurrenceCache'"
    );
    const altImportIdx = preloadedBlock.indexOf(
      "await import('./canonicalPurchaseOccurrenceCache')"
    );
    const resolvedImport = Math.max(importIdx, altImportIdx);
    // Multi-line import form used in source.
    const multiImport = preloadedBlock.indexOf(
      './canonicalPurchaseOccurrenceCache'
    );
    const importAnchor =
      resolvedImport >= 0 ? resolvedImport : multiImport;
    expect(importAnchor).toBeGreaterThanOrEqual(0);

    const startedIdx = preloadedBlock.indexOf(
      'const occurrenceStarted = Date.now()'
    );
    expect(startedIdx).toBeGreaterThan(importAnchor);

    // Timer must not start before the occurrence-cache import in this block.
    const earlyStarted = preloadedBlock
      .slice(0, importAnchor)
      .includes('const occurrenceStarted = Date.now()');
    expect(earlyStarted).toBe(false);
  });

  it('warm heavySnapshot emits no H4.1 cold stages', () => {
    const experience = buildHomeProgressiveExperienceBundle([], null).experience;
    endHomeRefreshTimingCapture();
    beginHomeRefreshTimingCapture();
    const gens = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER,
      startGenerations: gens,
      displayReceipts: [],
      experience,
      repeatProfiles: [],
    });
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).not.toBeNull();
    const samples = endHomeRefreshTimingCapture();
    for (const stage of [
      'home.occurrence.apply',
      'home.productContext.db',
      'home.productContext.enrich',
    ] as const) {
      expect(samples.some((s) => s.stage === stage)).toBe(false);
    }

    const homeSource = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    const reuseBlock = homeSource.slice(
      homeSource.indexOf('tryReuseHomeFocusHeavySnapshot'),
      homeSource.indexOf("measureHomeRefreshStage('listReceipts'")
    );
    expect(reuseBlock).not.toContain('home.occurrence.apply');
  });
});

describe('H4.1b — immediate ProductContext rejection observation', () => {
  it('source: observer attached before first await after DB dispatch', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, './engagementMilestones.ts'),
      'utf8'
    );
    const fnStart = source.indexOf(
      'export async function loadEngagementProductInsightContextWithDb'
    );
    const block = source.slice(
      fnStart,
      source.indexOf(
        'export async function loadEngagementProductInsightContext(',
        fnStart
      )
    );
    const dispatchIdx = block.indexOf('fetchProductInsightRowsFromDb(');
    const observeIdx = block.indexOf(
      'observeProductRowsPromise(productRowsPromise)'
    );
    const afterDispatch = block.slice(dispatchIdx);
    const gateAwait = afterDispatch.indexOf(
      'await occurrenceCacheImportGateForTests'
    );
    const importAwait = afterDispatch.indexOf('await import(');
    const firstAwaitRel = Math.min(
      ...[gateAwait, importAwait].filter((i) => i >= 0)
    );
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(observeIdx).toBeGreaterThan(dispatchIdx);
    expect(firstAwaitRel).toBeGreaterThan(0);
    expect(observeIdx - dispatchIdx).toBeLessThan(firstAwaitRel);
  });

  it('early DB reject while import gated: no unhandled; observer before reject', async () => {
    const events: string[] = [];
    const receipt = baseReceipt('r1', 1);
    let rejectDb!: (err: Error) => void;
    const db1Promise = new Promise<EngagementProductRow[]>((_, reject) => {
      rejectDb = reject;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateEntered!: () => void;
    const gateEnteredPromise = new Promise<void>((resolve) => {
      gateEntered = resolve;
    });

    __setProductInsightPreOccurrenceHooksForTests({
      occurrenceCacheImportGate: async () => {
        events.push('first-await/import-pending');
        gateEntered();
        await gate;
      },
      onProductRowsObserverAttached: () => {
        events.push('observer-attached');
      },
    });

    const getAllAsync = jest.fn((sql: string) => {
      if (String(sql).includes('FROM receipt_items')) {
        events.push('db-start');
        return db1Promise;
      }
      return Promise.resolve([]);
    });
    const db = { getAllAsync } as unknown as EngagementMilestoneDatabase;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const loadPromise = loadEngagementProductInsightContextWithDb(db, {
        preloaded: makePreloaded([receipt]),
      });

      // Deterministic: wait until first await after observer attach.
      await gateEnteredPromise;
      expect(events).toEqual([
        'db-start',
        'observer-attached',
        'first-await/import-pending',
      ]);

      rejectDb(new Error('db1-early-boom'));
      events.push('db-reject');
      // Give the event loop a chance to surface an unhandled rejection.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      expect(events.indexOf('observer-attached')).toBeLessThan(
        events.indexOf('db-reject')
      );

      // Occurrence succeeds; authoritative await still sees original rejection.
      releaseGate();
      const ctx = await loadPromise;
      expect(ctx.queryFailed).toBe(true);
      expect(ctx.rows).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      releaseGate();
    }
  });

  it('early DB reject + stale → fresh DB#2, no unhandled, no DB#1 rows', async () => {
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const db2Row = productRow('from-db2', 'i-db2', 1_700_000_000_000);
    let rejectDb1!: (err: Error) => void;
    const db1Promise = new Promise<EngagementProductRow[]>((_, reject) => {
      rejectDb1 = reject;
    });
    let productItemsCalls = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateEntered!: () => void;
    const gateEnteredPromise = new Promise<void>((resolve) => {
      gateEntered = resolve;
    });

    __setProductInsightPreOccurrenceHooksForTests({
      occurrenceCacheImportGate: async () => {
        gateEntered();
        await gate;
      },
    });

    const getAllAsync = jest.fn((sql: string) => {
      if (String(sql).includes('FROM receipt_items')) {
        productItemsCalls += 1;
        if (productItemsCalls === 1) return db1Promise;
        return Promise.resolve([db2Row]);
      }
      if (String(sql).includes('FROM receipts')) {
        return Promise.resolve([receipt]);
      }
      return Promise.resolve([]);
    });
    const db = { getAllAsync } as unknown as EngagementMilestoneDatabase;
    const preloaded = makeStalePreloaded([receipt]);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const ctxPromise = loadEngagementProductInsightContextWithDb(db, {
        preloaded,
      });
      await gateEnteredPromise;
      rejectDb1(new Error('db1-early-boom'));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);

      releaseGate();
      const ctx = await ctxPromise;
      expect(ctx.queryFailed).toBe(false);
      expect(ctx.rows.some((r) => r.receiptId === 'from-db2')).toBe(true);
      expect(ctx.rows.every((r) => r.receiptId !== 'from-db1')).toBe(true);
      expect(productItemsCallCount(getAllAsync)).toBe(2);
      expect(preloaded.occurrencePreparedEvidence).toBeUndefined();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      releaseGate();
    }
  });

  it('early DB reject + occurrence throw: occurrence wins, no unhandled', async () => {
    const receipt = baseReceipt('r1', 1);
    let rejectDb1!: (err: Error) => void;
    const db1Promise = new Promise<EngagementProductRow[]>((_, reject) => {
      rejectDb1 = reject;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateEntered!: () => void;
    const gateEnteredPromise = new Promise<void>((resolve) => {
      gateEntered = resolve;
    });

    __setProductInsightPreOccurrenceHooksForTests({
      occurrenceCacheImportGate: async () => {
        gateEntered();
        await gate;
      },
    });

    const db = {
      getAllAsync: jest.fn((sql: string) => {
        if (String(sql).includes('FROM receipt_items')) return db1Promise;
        return Promise.resolve([]);
      }),
    } as unknown as EngagementMilestoneDatabase;

    jest
      .spyOn(
        canonicalPurchaseOccurrence,
        'prepareCanonicalPurchaseOccurrenceEvidence'
      )
      .mockImplementation(() => {
        throw new Error('occurrence-boom');
      });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const p = loadEngagementProductInsightContextWithDb(db, {
        preloaded: makePreloaded([receipt]),
      });
      await gateEnteredPromise;
      rejectDb1(new Error('db1-early-boom'));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);

      releaseGate();
      await expect(p).rejects.toThrow('occurrence-boom');
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      releaseGate();
    }
  });

  it('early DB reject + occurrence success → queryFailed (observer does not swallow)', async () => {
    const receipt = baseReceipt('r1', 1);
    let rejectDb1!: (err: Error) => void;
    const db1Promise = new Promise<EngagementProductRow[]>((_, reject) => {
      rejectDb1 = reject;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateEntered!: () => void;
    const gateEnteredPromise = new Promise<void>((resolve) => {
      gateEntered = resolve;
    });

    __setProductInsightPreOccurrenceHooksForTests({
      occurrenceCacheImportGate: async () => {
        gateEntered();
        await gate;
      },
    });

    const db = {
      getAllAsync: jest.fn((sql: string) => {
        if (String(sql).includes('FROM receipt_items')) return db1Promise;
        return Promise.resolve([]);
      }),
    } as unknown as EngagementMilestoneDatabase;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const p = loadEngagementProductInsightContextWithDb(db, {
        preloaded: makePreloaded([receipt]),
      });
      await gateEnteredPromise;
      rejectDb1(new Error('db1-early-boom'));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);

      releaseGate();
      const ctx = await p;
      expect(ctx.queryFailed).toBe(true);
      expect(ctx.rows).toEqual([]);
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      releaseGate();
    }
  });
});
