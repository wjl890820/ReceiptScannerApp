/**
 * Round 6 — cooperative blur / stale-run suppression with deferred stages.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import {
  beginAsyncRequestGeneration,
  invalidateAsyncRequestGeneration,
  shouldApplyAsyncRequestGeneration,
} from './asyncRequestGeneration';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionBuildCount,
  selectAnalyticsReceiptsCached,
} from './analyticsReceiptSelectionCache';
import { buildHistoryPurchaseTruthView } from './historyPurchaseTruth';
import type { ReceiptRow } from './db';

function receipt(id: string): ReceiptRow {
  return {
    id,
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_000_000,
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

describe('Round 6 hidden-work / stale-run suppression', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
  });

  it('Home-equivalent: after early stage, blur skips selection build', async () => {
    const visible = { current: true };
    const listGate = deferred<ReceiptRow[]>();
    let selectionStarted = false;

    const run = (async () => {
      const rows = await listGate.promise;
      if (!visible.current) return { applied: false, selection: null as null };
      selectionStarted = true;
      const selection = selectAnalyticsReceiptsCached({
        ownerKey: 'user:owner-a',
        receipts: rows,
        shouldSkipExpensiveBuild: () => !visible.current,
      });
      if (!visible.current) return { applied: false, selection };
      return { applied: true, selection };
    })();

    visible.current = false;
    listGate.resolve([receipt('r1'), receipt('r2')]);
    const result = await run;
    expect(result.applied).toBe(false);
    expect(selectionStarted).toBe(false);
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(0);
  });

  it('Analysis-equivalent: blur after list skips MISS build via shouldSkip', async () => {
    const cycle = { id: 1 };
    const listGate = deferred<ReceiptRow[]>();
    const beforeSelect = deferred<void>();
    let reachedSelectionBoundary = false;

    const run = (async () => {
      const rows = await listGate.promise;
      if (cycle.id !== 1) return null;
      await beforeSelect.promise;
      reachedSelectionBoundary = true;
      return selectAnalyticsReceiptsCached({
        ownerKey: 'user:owner-a',
        receipts: rows,
        shouldSkipExpensiveBuild: () => cycle.id !== 1,
      });
    })();

    listGate.resolve([receipt('r1')]);
    await Promise.resolve();
    cycle.id = 2;
    beforeSelect.resolve();
    const selection = await run;
    expect(reachedSelectionBoundary).toBe(true);
    expect(selection).toBeNull();
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(0);
  });

  it('History stale run A cannot overwrite newer run B', async () => {
    const genRef = { current: 0 };
    const aGate = deferred<ReceiptRow[]>();
    const bGate = deferred<ReceiptRow[]>();
    let applied: 'A' | 'B' | null = null;

    const loadA = beginAsyncRequestGeneration(genRef);
    const runA = (async () => {
      const rows = await aGate.promise;
      if (!shouldApplyAsyncRequestGeneration(loadA, genRef.current)) return;
      const view = buildHistoryPurchaseTruthView(rows, {
        ownerKey: 'user:owner-a',
        shouldSkipExpensiveBuild: () =>
          !shouldApplyAsyncRequestGeneration(loadA, genRef.current),
      });
      if (!view) return;
      if (!shouldApplyAsyncRequestGeneration(loadA, genRef.current)) return;
      applied = 'A';
    })();

    invalidateAsyncRequestGeneration(genRef); // blur
    const loadB = beginAsyncRequestGeneration(genRef);
    const runB = (async () => {
      const rows = await bGate.promise;
      if (!shouldApplyAsyncRequestGeneration(loadB, genRef.current)) return;
      const view = buildHistoryPurchaseTruthView(rows, {
        ownerKey: 'user:owner-a',
        shouldSkipExpensiveBuild: () =>
          !shouldApplyAsyncRequestGeneration(loadB, genRef.current),
      });
      if (!view) return;
      if (!shouldApplyAsyncRequestGeneration(loadB, genRef.current)) return;
      applied = 'B';
    })();

    bGate.resolve([receipt('b1')]);
    await runB;
    expect(applied).toBe('B');

    aGate.resolve([receipt('a1'), receipt('a2')]);
    await runA;
    expect(applied).toBe('B');
  });
});
