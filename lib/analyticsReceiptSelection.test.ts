/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from './db';
import {
  filterProductRowsByExcludedReceiptIds,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';

const nowMs = Date.parse('2026-08-22T12:00:00+09:00');

function makeReceipt(args: {
  id: string;
  createdAt?: number;
  name?: string;
}): ReceiptRow {
  return {
    id: args.id,
    created_at: args.createdAt ?? nowMs,
    transaction_at: nowMs,
    image_uri: '',
    total: 198,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [
        {
          name: args.name ?? '明治おいしい牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
    }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

describe('analyticsReceiptSelection', () => {
  test('selects analytics receipts excluding high-confidence extras', () => {
    const a = makeReceipt({ id: 'keep', createdAt: nowMs });
    const b = makeReceipt({ id: 'drop', createdAt: nowMs + 1 });
    const result = selectAnalyticsReceipts([a, b]);
    expect(result.storedReceipts).toHaveLength(2);
    expect(result.analyticsReceipts.map((r) => r.id)).toEqual(['keep']);
    expect([...result.excludedDuplicateReceiptIds]).toEqual(['drop']);
    expect(result.contentExactDuplicateExtras).toBe(1);
    expect(result.analyticsPurchaseCandidateCount).toBe(1);
    expect(result.probableDuplicateExtras).toBe(0);
  });

  test('keepSeparateReceiptIds preserves structural extras', () => {
    const a = makeReceipt({ id: 'rep', createdAt: nowMs, name: '牛乳A' });
    const b = makeReceipt({
      id: 'keep-sep',
      createdAt: nowMs + 1,
      name: '牛乳B',
    });
    const result = selectAnalyticsReceipts([a, b], {
      keepSeparateReceiptIds: new Set(['keep-sep']),
    });
    expect(result.analyticsReceipts.map((r) => r.id).sort()).toEqual([
      'keep-sep',
      'rep',
    ]);
    expect(result.excludedDuplicateReceiptIds.size).toBe(0);
    expect(result.analyticsPurchaseCandidateCount).toBe(2);
    expect(result.keepSeparateReceiptIds.has('keep-sep')).toBe(true);
  });

  test('filterProductRowsByExcludedReceiptIds', () => {
    const rows = [
      { receiptId: 'a', n: 1 },
      { receiptId: 'b', n: 2 },
      { receiptId: 'c', n: 3 },
    ];
    expect(
      filterProductRowsByExcludedReceiptIds(rows, new Set(['b']))
    ).toEqual([
      { receiptId: 'a', n: 1 },
      { receiptId: 'c', n: 3 },
    ]);
    expect(filterProductRowsByExcludedReceiptIds(rows, new Set())).toEqual(
      rows
    );
  });
});
