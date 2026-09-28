/**
 * A2.2a — production purchase-truth integration.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { ANALYTICS_RECEIPT_SELECTION_CACHE_VERSION } from './analyticsReceiptSelectionCache';
import * as analyticsCache from './analyticsReceiptSelectionCache';
import { buildCanonicalPurchaseOccurrenceIndex } from './canonicalPurchaseOccurrence';
import {
  buildHistoryPurchaseTruthView,
  projectHistorySearchToPurchaseTruth,
  resolveHistoryPurchaseDeleteIds,
  resolveHistoryPurchaseDetailReceiptId,
} from './historyPurchaseTruth';
import { buildHomeProgressiveExperience } from './homeProgressiveExperience';
import { deriveExactLogicalPurchaseMemberSet } from './logicalPurchaseEditPartition';
import { assignVerifiedPurchaseOccurrenceWithDb } from './verifiedPurchaseOccurrence';

const TX = Date.parse('2024-05-02T09:00:00+09:00');
const VERIFIED_AT = 1_710_000_000_000;

function makeReceipt(
  id: string,
  opts: {
    precision?: 'second' | 'minute';
    transactionAt?: number;
    createdAt?: number;
    total?: number;
    verifiedId?: string | null;
    verifiedSource?: string | null;
    verifiedAt?: number | null;
  } = {}
): ReceiptRow {
  const precision = opts.precision ?? 'minute';
  const total = opts.total ?? 1200;
  const txAt = opts.transactionAt ?? TX;
  const analysis = {
    merchant: 'MARKET',
    total,
    tax: 80,
    tax_is_known: true,
    currency: 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items: [{ name: 'MILK', quantity: 1, lineTotal: total }],
    transaction_time_precision: precision,
    transactionDate:
      precision === 'second' ? '2024-05-02 09:00:00' : '2024-05-02 09:00',
  };
  return {
    id,
    created_at: opts.createdAt ?? 2_000,
    transaction_at: txAt,
    transaction_time_precision: precision,
    image_uri: '',
    merchant_raw: 'MARKET',
    merchant_normalized: 'MARKET',
    merchant_type: 'supermarket',
    total,
    tax: 80,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    verified_purchase_occurrence_id: opts.verifiedId ?? null,
    verified_purchase_occurrence_source:
      opts.verifiedId != null ? (opts.verifiedSource ?? 'research_verified') : null,
    verified_purchase_occurrence_verified_at:
      opts.verifiedId != null ? (opts.verifiedAt ?? VERIFIED_AT) : null,
  };
}

describe('A2.2a production purchase truth', () => {
  it('1–3 — verified boundaries survive analytics selection', () => {
    const g1 = makeReceipt('g1', {
      precision: 'second',
      verifiedId: 'vpo_g1',
      createdAt: 1,
    });
    const g2 = makeReceipt('g2', {
      precision: 'second',
      verifiedId: 'vpo_g2',
      createdAt: 2,
    });
    const split = selectAnalyticsReceipts([g1, g2]);
    expect(split.analyticsReceipts.map((row) => row.id).sort()).toEqual([
      'g1',
      'g2',
    ]);
    expect(
      buildCanonicalPurchaseOccurrenceIndex(split.analyticsReceipts).groups
    ).toHaveLength(2);

    const same = [
      makeReceipt('s1', { precision: 'second', verifiedId: 'vpo_same', createdAt: 1 }),
      makeReceipt('s2', { precision: 'second', verifiedId: 'vpo_same', createdAt: 2 }),
    ];
    expect(
      buildCanonicalPurchaseOccurrenceIndex(same).groups
    ).toHaveLength(1);

    const plain = [
      makeReceipt('p1', { precision: 'second', createdAt: 1 }),
      makeReceipt('p2', { precision: 'second', createdAt: 2 }),
    ];
    const legacy = selectAnalyticsReceipts(plain);
    expect(legacy.analyticsPurchaseCandidateCount).toBe(1);
    expect(legacy.excludedDuplicateReceiptIds.size).toBe(1);
  });

  it('4–7 — History projects one row per canonical occurrence', () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      makeReceipt(`m${i}`, {
        precision: 'minute',
        verifiedId: 'vpo_hist',
        createdAt: 10 + i,
      })
    );
    const view = buildHistoryPurchaseTruthView(seven);
    expect(view.visibleRows).toHaveLength(1);
    expect(view.visibleRows[0]!.transaction_time_precision).toBe('minute');

    const separated = [
      makeReceipt('a', { precision: 'second', verifiedId: 'vpo_a', createdAt: 1 }),
      makeReceipt('b', { precision: 'second', verifiedId: 'vpo_b', createdAt: 2 }),
    ];
    expect(buildHistoryPurchaseTruthView(separated).visibleRows).toHaveLength(2);

    const selection = selectAnalyticsReceipts(seven);
    const search = projectHistorySearchToPurchaseTruth(
      {
        itemResults: seven.map((row) => ({
          receiptId: row.id,
          displayName: 'MILK',
          sourceIndex: 0,
        })),
        receiptResults: seven,
      },
      selection
    );
    expect(search.receiptResults).toHaveLength(1);
    expect(search.itemResults).toHaveLength(1);

    const detail = resolveHistoryPurchaseDetailReceiptId('m3', seven);
    expect(detail).toBe(view.visibleRows[0]!.id);
  });

  it('8–11 — edit/delete membership follows canonical occurrence', () => {
    const verified = makeReceipt('g', {
      precision: 'second',
      verifiedId: 'vpo_join',
      createdAt: 1,
    });
    const unassigned = makeReceipt('u', { precision: 'second', createdAt: 2 });
    const rows = [verified, unassigned];
    const fromG = deriveExactLogicalPurchaseMemberSet('g', rows);
    const fromU = deriveExactLogicalPurchaseMemberSet('u', rows);
    expect(fromG).toEqual(fromU);
    expect(fromG).toEqual(['g', 'u']);

    const other = makeReceipt('h', {
      precision: 'second',
      verifiedId: 'vpo_other',
      transactionAt: TX + 86_400_000,
      createdAt: 3,
    });
    expect(
      resolveHistoryPurchaseDeleteIds(['g', 'h'], [verified, unassigned, other]).sort()
    ).toEqual(['g', 'h', 'u']);
    expect(deriveExactLogicalPurchaseMemberSet('g', [verified, other])).toEqual([
      'g',
    ]);
    expect(deriveExactLogicalPurchaseMemberSet('h', [verified, other])).toEqual([
      'h',
    ]);

    const soloA = makeReceipt('solo-a', {
      precision: 'minute',
      transactionAt: TX,
    });
    const soloB = makeReceipt('solo-b', {
      precision: 'minute',
      transactionAt: TX + 86_400_000,
    });
    expect(deriveExactLogicalPurchaseMemberSet('solo-a', [soloA, soloB])).toEqual([
      'solo-a',
    ]);
    expect(buildHistoryPurchaseTruthView([soloA, soloB]).visibleRows).toHaveLength(
      2
    );
  });

  it('12–14 — Home recent/latest uses occurrence representatives', () => {
    const rescans = Array.from({ length: 7 }, (_, i) =>
      makeReceipt(`g${i}`, {
        precision: 'minute',
        verifiedId: 'vpo_home',
        createdAt: i + 1,
        total: 100,
        transactionAt: TX,
      })
    );
    const h = makeReceipt('h', {
      precision: 'minute',
      transactionAt: TX + 86_400_000,
      total: 200,
      createdAt: 20,
    });
    const i = makeReceipt('i', {
      precision: 'minute',
      transactionAt: TX + 2 * 86_400_000,
      total: 300,
      createdAt: 30,
    });
    const experience = buildHomeProgressiveExperience(
      [...rescans, h, i],
      null
    );
    expect(experience.recentInsight?.receiptIds).toHaveLength(3);
    expect(new Set(experience.recentInsight?.receiptIds).size).toBe(3);
    expect(experience.recentInsight?.totalSpend).toBe(600);
    expect(experience.latestPurchase?.receiptId).toBe(
      experience.recentInsight?.receiptIds[2]
    );

    const split = [
      makeReceipt('left', {
        precision: 'second',
        verifiedId: 'vpo_left',
        transactionAt: TX + 3 * 86_400_000,
        createdAt: 1,
      }),
      makeReceipt('right', {
        precision: 'second',
        verifiedId: 'vpo_right',
        transactionAt: TX + 4 * 86_400_000,
        createdAt: 2,
      }),
      makeReceipt('older', {
        precision: 'minute',
        transactionAt: TX,
        createdAt: 3,
      }),
    ];
    const splitExperience = buildHomeProgressiveExperience(split, null);
    expect(splitExperience.recentInsight?.receiptIds).toEqual(
      expect.arrayContaining(['left', 'right', 'older'])
    );
  });

  it('15–16 — verified and derived keys do not collide', () => {
    const verified = makeReceipt('member', {
      precision: 'minute',
      verifiedId: 'receipt-x',
      transactionAt: TX,
      createdAt: 1,
    });
    const unrelated = makeReceipt('receipt-x', {
      precision: 'minute',
      transactionAt: TX + 5 * 86_400_000,
      createdAt: 2,
    });
    const orders = [
      [verified, unrelated],
      [unrelated, verified],
    ];
    const signatures = orders.map((rows) => {
      const index = buildCanonicalPurchaseOccurrenceIndex(rows);
      return JSON.stringify({
        keys: index.groups.map((group) => group.occurrenceKey).sort(),
        reps: index.groups.map((group) => group.representativeReceiptId).sort(),
        size: index.representativeReceiptIdByOccurrenceId.size,
      });
    });
    expect(new Set(signatures).size).toBe(1);
    const index = buildCanonicalPurchaseOccurrenceIndex([verified, unrelated]);
    expect(index.groups).toHaveLength(2);
    expect(index.groups.map((group) => group.occurrenceKey).sort()).toEqual([
      'derived:receipt-x',
      'verified:receipt-x',
    ]);
    expect(index.representativeReceiptIdByOccurrenceId.size).toBe(2);
  });

  it('17–20 — selection cache version and assignment invalidation', async () => {
    expect(ANALYTICS_RECEIPT_SELECTION_CACHE_VERSION).toContain('v3');
    const spy = jest.spyOn(
      analyticsCache,
      'invalidateAnalyticsReceiptSelection'
    );
    spy.mockClear();

    const receipts = new Map([
      ['r1', { id: 'r1', user_id: 'user' }],
      ['r2', { id: 'r2', user_id: 'user' }],
    ]);
    let fail = false;
    let assigned = false;
    const db: {
      getAllAsync: () => Promise<unknown[]>;
      withExclusiveTransactionAsync: (
        task: (txn: {
          getAllAsync: () => Promise<unknown[]>;
          runAsync: (sql: string) => Promise<{ changes: number }>;
        }) => Promise<void>
      ) => Promise<void>;
      runAsync: (sql: string) => Promise<{ changes: number }>;
    } = {
      async getAllAsync() {
        return [...receipts.values()].map((row) => ({
          ...row,
          verified_purchase_occurrence_id: assigned ? 'vpo_cached' : null,
          verified_purchase_occurrence_source: assigned
            ? 'research_verified'
            : null,
          verified_purchase_occurrence_verified_at: assigned ? VERIFIED_AT : null,
        }));
      },
      async withExclusiveTransactionAsync(task) {
        await task(db);
      },
      async runAsync(sql: string) {
        if (/UPDATE receipts/i.test(sql)) {
          if (fail) throw new Error('rollback');
          return { changes: 1 };
        }
        if (/sync_outbox/i.test(sql)) return { changes: 1 };
        return { changes: 0 };
      },
    };

    fail = true;
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: 'user',
        receiptIds: ['r1', 'r2'],
        source: 'research_verified',
        verifiedAt: VERIFIED_AT,
        nowMs: VERIFIED_AT,
      })
    ).rejects.toThrow(/rollback/);
    expect(spy).not.toHaveBeenCalled();

    fail = false;
    await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: 'user',
      receiptIds: ['r1', 'r2'],
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
      nowMs: VERIFIED_AT,
    });
    expect(spy).toHaveBeenCalledWith('verified_purchase_occurrence_assigned');
    spy.mockClear();
    assigned = true;
    await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: 'user',
      receiptIds: ['r1', 'r2'],
      occurrenceId: 'vpo_cached',
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
      nowMs: VERIFIED_AT,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
