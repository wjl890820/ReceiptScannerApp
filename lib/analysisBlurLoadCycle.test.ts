/**
 * Round 7 A3 — Analysis blur must invalidate loadCycleRef (base-load cycle).
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionBuildCount,
  selectAnalyticsReceiptsCached,
} from './analyticsReceiptSelectionCache';
import type { ReceiptRow } from './db';

function receipt(id: string): ReceiptRow {
  return {
    id,
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_100_000,
    image_uri: 'file://x',
    merchant_raw: 'Lawson',
    merchant_normalized: 'lawson',
    merchant_type: 'convenience',
    total: 500,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      total: 500,
      items: [{ name: `item-${id}`, quantity: 1, unitPrice: 500, lineTotal: 500 }],
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: 'owner-a',
    installation_id: null,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Mirrors Analysis base-load cycle gating after Round 7:
 * blur increments loadCycleRef so after_list / selection / truth apply stop.
 */
function createAnalysisBaseLoadHarness() {
  const loadCycleRef = { current: 0 };
  let truthApplyCount = 0;
  let selectionStartedCount = 0;

  async function runLoad(listPromise: Promise<ReceiptRow[]>) {
    const cycleId = loadCycleRef.current + 1;
    loadCycleRef.current = cycleId;
    const rows = await listPromise;
    if (loadCycleRef.current !== cycleId) {
      return { applied: false, reason: 'after_list' as const };
    }
    selectionStartedCount += 1;
    const selection = selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: rows,
      shouldSkipExpensiveBuild: () => loadCycleRef.current !== cycleId,
    });
    if (!selection || loadCycleRef.current !== cycleId) {
      return { applied: false, reason: 'after_select' as const };
    }
    truthApplyCount += 1;
    return { applied: true, reason: 'ok' as const, selection };
  }

  function blur() {
    loadCycleRef.current += 1;
  }

  return {
    runLoad,
    blur,
    get truthApplyCount() {
      return truthApplyCount;
    },
    get selectionStartedCount() {
      return selectionStartedCount;
    },
  };
}

describe('Round 7 A3 Analysis blur ↔ loadCycleRef', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
  });

  it('source contract: blur increments loadCycleRef', () => {
    const analysisSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(analysisSource).toMatch(
      /name:\s*'blur'[\s\S]*loadCycleRef\.current\s*\+=\s*1/
    );
  });

  it('T9 blur before list completion skips selection and truth apply', async () => {
    const harness = createAnalysisBaseLoadHarness();
    const listGate = deferred<ReceiptRow[]>();
    const run = harness.runLoad(listGate.promise);
    harness.blur();
    listGate.resolve([receipt('r1'), receipt('r2')]);
    const result = await run;
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('after_list');
    expect(harness.selectionStartedCount).toBe(0);
    expect(harness.truthApplyCount).toBe(0);
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(0);
  });

  it('T10 blur after selection started: selection may finish, no truth apply', async () => {
    const loadCycleRef = { current: 0 };
    const listGate = deferred<ReceiptRow[]>();
    const beforeTruth = deferred<void>();
    let selectionFinished = false;
    let truthApplied = false;

    const run = (async () => {
      const cycleId = loadCycleRef.current + 1;
      loadCycleRef.current = cycleId;
      const rows = await listGate.promise;
      if (loadCycleRef.current !== cycleId) return;
      const selection = selectAnalyticsReceiptsCached({
        ownerKey: 'user:owner-a',
        receipts: rows,
      });
      selectionFinished = true;
      await beforeTruth.promise;
      if (!selection || loadCycleRef.current !== cycleId) return;
      truthApplied = true;
    })();

    listGate.resolve([receipt('r1'), receipt('r2')]);
    await Promise.resolve();
    expect(selectionFinished).toBe(true);
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    loadCycleRef.current += 1; // blur
    beforeTruth.resolve();
    await run;
    expect(truthApplied).toBe(false);
  });

  it('T11 refocus after blur starts a fresh cycle normally', async () => {
    const harness = createAnalysisBaseLoadHarness();
    const listA = deferred<ReceiptRow[]>();
    const runA = harness.runLoad(listA.promise);
    harness.blur();
    listA.resolve([receipt('a1')]);
    await runA;
    expect(harness.truthApplyCount).toBe(0);

    const listB = deferred<ReceiptRow[]>();
    const runB = harness.runLoad(listB.promise);
    listB.resolve([receipt('b1'), receipt('b2')]);
    const resultB = await runB;
    expect(resultB.applied).toBe(true);
    expect(harness.truthApplyCount).toBe(1);
    expect(getAnalyticsReceiptSelectionBuildCount()).toBeGreaterThanOrEqual(1);
  });
});
