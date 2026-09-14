/**
 * Round 7 — analytics decision-only cache semantics (A1).
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import {
  selectAnalyticsReceipts,
  type AnalyticsReceiptSelection,
} from './analyticsReceiptSelection';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionBuildCount,
  invalidateAnalyticsReceiptSelection,
  selectAnalyticsReceiptsCached,
  selectAnalyticsReceiptsCachedAsync,
  buildAnalyticsReceiptSetSignature,
} from './analyticsReceiptSelectionCache';
import type { ReceiptRow } from './db';

function receipt(id: string, overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id,
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0),
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
      tax: 0,
      currency: 'JPY',
      items: [{ name: `item-${id}`, quantity: 1, unitPrice: 500, lineTotal: 500 }],
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: 'owner-a',
    installation_id: null,
    ...overrides,
  };
}

function decisionFingerprint(selection: AnalyticsReceiptSelection) {
  return {
    excluded: [...selection.excludedDuplicateReceiptIds].sort(),
    groups: selection.highConfidenceDuplicateGroups.map((g) => ({
      representativeReceiptId: g.representativeReceiptId,
      receiptIds: [...g.receiptIds].sort(),
      confidence: g.confidence,
    })),
    counts: {
      content: selection.contentExactDuplicateExtras,
      structural: selection.structuralExactDuplicateExtras,
      reconciled: selection.reconciledStructuralExactDuplicateExtras,
      highConfidence: selection.highConfidenceDuplicateExtras,
      purchase: selection.analyticsPurchaseCandidateCount,
    },
  };
}

describe('Round 7 A1 decision-only analytics cache', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
  });

  it('T1 reversed order preserves caller order and shares one decision build', () => {
    const aInput = [receipt('r3'), receipt('r2'), receipt('r1')];
    const bInput = [receipt('r1'), receipt('r2'), receipt('r3')];
    const a = selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: aInput,
    })!;
    const b = selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: bInput,
    })!;
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    expect(a.storedReceipts.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    expect(b.storedReceipts.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(a.storedReceipts[0]).toBe(aInput[0]);
    expect(b.storedReceipts[0]).toBe(bInput[0]);
    expect(decisionFingerprint(a).excluded).toEqual(
      decisionFingerprint(b).excluded
    );
  });

  it('T2 different projection rematerializes caller objects, not cached rows', () => {
    const lean = [
      receipt('r1', { image_uri: '', note: null, final_category: null }),
      receipt('r2', { image_uri: '', note: null, final_category: null }),
    ];
    const rich = [
      receipt('r1', {
        image_uri: 'file://rich-1',
        note: 'caller-b-note',
        final_category: 'food_ingredients',
      }),
      receipt('r2', {
        image_uri: 'file://rich-2',
        note: 'caller-b-note-2',
        final_category: 'snacks_drinks',
      }),
    ];
    selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: lean,
    });
    const b = selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: rich,
    })!;
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    expect(b.storedReceipts[0]).toBe(rich[0]);
    expect(b.storedReceipts[0]!.image_uri).toBe('file://rich-1');
    expect(b.storedReceipts[0]!.note).toBe('caller-b-note');
    expect(b.storedReceipts[0]!.final_category).toBe('food_ingredients');
    expect(b.analyticsReceipts.every((row) => rich.includes(row))).toBe(true);
  });

  it('T3 excluded IDs / groups / counts match direct uncached selection', () => {
    const rows = [
      receipt('dup-a', {
        transaction_at: 1_700_000_100_000,
        created_at: 1_700_000_100_000,
        analysis_json: JSON.stringify({
          total: 500,
          items: [
            { name: '牛乳', quantity: 1, unitPrice: 500, lineTotal: 500 },
          ],
        }),
      }),
      receipt('dup-b', {
        transaction_at: 1_700_000_100_000,
        created_at: 1_700_000_100_001,
        analysis_json: JSON.stringify({
          total: 500,
          items: [
            { name: '牛乳', quantity: 1, unitPrice: 500, lineTotal: 500 },
          ],
        }),
      }),
      receipt('solo'),
    ];
    const cached = selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: rows,
    })!;
    const direct = selectAnalyticsReceipts(rows);
    expect(decisionFingerprint(cached)).toEqual(decisionFingerprint(direct));
    expect(cached.analyticsReceipts.map((r) => r.id)).toEqual(
      direct.analyticsReceipts.map((r) => r.id)
    );
  });

  it('T4 subset safety: 200-row set and full-history set remain distinct', () => {
    const slice = Array.from({ length: 3 }, (_, i) => receipt(`s${i}`));
    const full = [
      ...slice,
      ...Array.from({ length: 2 }, (_, i) => receipt(`f${i}`)),
    ];
    selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: slice,
    });
    selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: full,
    });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(2);
    expect(buildAnalyticsReceiptSetSignature(slice)).not.toBe(
      buildAnalyticsReceiptSetSignature(full)
    );
  });

  it('lifecycle: HIT / mutation MISS / owner isolation / JOIN / fail-safe', async () => {
    const rows = [receipt('r1'), receipt('r2')];
    const first = selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: rows,
    })!;
    const second = selectAnalyticsReceiptsCached({
      ownerKey: 'user:owner-a',
      receipts: rows,
    })!;
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    expect(first.analyticsReceipts).not.toBe(second.analyticsReceipts);
    expect(first.analyticsReceipts.map((r) => r.id)).toEqual(
      second.analyticsReceipts.map((r) => r.id)
    );

    invalidateAnalyticsReceiptSelection('receipt_saved');
    selectAnalyticsReceiptsCached({ ownerKey: 'user:owner-a', receipts: rows });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(2);

    selectAnalyticsReceiptsCached({ ownerKey: 'user:owner-b', receipts: rows });
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(3);

    __resetAnalyticsReceiptSelectionCacheForTests();
    const [x, y] = await Promise.all([
      selectAnalyticsReceiptsCachedAsync({
        ownerKey: 'user:owner-a',
        receipts: rows,
      }),
      selectAnalyticsReceiptsCachedAsync({
        ownerKey: 'user:owner-a',
        receipts: [...rows].reverse(),
      }),
    ]);
    expect(getAnalyticsReceiptSelectionBuildCount()).toBe(1);
    expect(x!.storedReceipts.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(y!.storedReceipts.map((r) => r.id)).toEqual(['r2', 'r1']);

    await expect(
      selectAnalyticsReceiptsCachedAsync({
        ownerKey: 'user:owner-a',
        receipts: [receipt('boom')],
        shouldSkipExpensiveBuild: () => {
          throw new Error('synthetic_before_build');
        },
      })
    ).rejects.toThrow('synthetic_before_build');
  });
});
