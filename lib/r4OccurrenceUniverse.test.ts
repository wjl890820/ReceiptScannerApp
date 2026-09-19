/**
 * R4 A2/A3 — Home/post-save milestones + Product Detail use occurrence reps.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import {
  applyOccurrenceRepresentativeUniverse,
  buildCanonicalPurchaseOccurrenceIndex,
} from './canonicalPurchaseOccurrence';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { hasExactTransactionTime } from './receiptExactTransactionTime';
import { calculateStats } from './statsCalculator';

const TX = Date.parse('2026-06-30T13:36:00+09:00');

function gyomuPair(ids: [string, string]): ReceiptRow[] {
  const items = [
    { name: 'グリーンカレーペースト', quantity: 1, lineTotal: 88 },
    { name: '炭化竹箸天削(袋無)', quantity: 1, lineTotal: 386 },
    { name: '他商品', quantity: 1, lineTotal: 267 },
  ];
  return ids.map((id, index) => {
    const total = 741;
    return {
      id,
      created_at: 1_000 + index,
      transaction_at: TX,
      transaction_time_precision: 'second',
      image_uri: '',
      merchant_raw: index === 0 ? '業務スーパー' : '業務スーパー 一吉店',
      merchant_normalized:
        index === 0 ? '業務スーパー' : '業務スーパー 一吉店',
      merchant_type: 'supermarket',
      total,
      tax: 61,
      tax_is_known: 1,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        merchant: index === 0 ? '業務スーパー' : '業務スーパー 一吉店',
        total,
        tax: 61,
        tax_is_known: true,
        currency: 'JPY',
        is_grocery: true,
        merchant_type: 'supermarket',
        transactionDate: '2026-06-30 13:36:00',
        transaction_time_precision: 'second',
        items,
      }),
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    } as ReceiptRow;
  });
}

describe('R4 A2 — milestone occurrence universe', () => {
  it('Receipt078-shaped analytics pair collapses only when second-precision proven', () => {
    const stored = gyomuPair(['078-a', '078-b']);
    // Force minute precision (production OCR shape) — must NOT collapse.
    for (const row of stored) {
      row.transaction_time_precision = 'minute';
      const parsed = JSON.parse(row.analysis_json);
      parsed.transactionDate = '2026-06-30 13:36';
      parsed.transaction_time_precision = 'minute';
      row.analysis_json = JSON.stringify(parsed);
    }
    const selection = selectAnalyticsReceipts(stored);
    const universe = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    expect(universe.representativeReceipts.length).toBeGreaterThanOrEqual(2);
  });

  it('Home and post-save share the same representative count', () => {
    const stored = gyomuPair(['home-a', 'home-b']);
    const selection = selectAnalyticsReceipts(stored);
    const home = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    const postSave = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    expect(home.representativeReceipts.map((r) => r.id)).toEqual(
      postSave.representativeReceipts.map((r) => r.id)
    );
  });
});

describe('R4 A3 — Product Detail exclusion of non-representatives', () => {
  it('second-precision proven rescans: non-representative joins exclusion set', () => {
    const stored = gyomuPair(['pd-a', 'pd-b']);
    // Keep second precision (proven exact) — one occurrence.
    const selection = selectAnalyticsReceipts(stored);
    const universe = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    expect(universe.representativeReceipts).toHaveLength(1);
    const repId = universe.representativeReceipts[0]!.id;
    for (const row of selection.analyticsReceipts) {
      if (row.id !== repId) {
        expect(universe.excludedReceiptIds.has(row.id)).toBe(true);
      }
    }
    expect(universe.excludedReceiptIds.has(repId)).toBe(false);
  });

  it('second-precision curry paste spend counted once after exclusion', () => {
    const stored = gyomuPair(['curry-a', 'curry-b']);
    const selection = selectAnalyticsReceipts(stored);
    const universe = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    const retainedIds = new Set(
      selection.analyticsReceipts
        .map((r) => r.id)
        .filter((id) => !universe.excludedReceiptIds.has(id))
    );
    expect(retainedIds.size).toBe(1);
    let spend = 0;
    let qty = 0;
    let purchases = 0;
    for (const receipt of stored) {
      if (!retainedIds.has(receipt.id)) continue;
      purchases += 1;
      const items = JSON.parse(receipt.analysis_json).items as Array<{
        name: string;
        quantity: number;
        lineTotal: number;
      }>;
      for (const item of items) {
        if (item.name.includes('カレー')) {
          spend += item.lineTotal;
          qty += item.quantity;
        }
      }
    }
    expect(purchases).toBe(1);
    expect(spend).toBe(88);
    expect(qty).toBe(1);
  });
});

describe('R4 A1 — precision gate', () => {
  it('minute precision is not exact transaction time', () => {
    const epoch = Date.parse('2026-07-06T11:44:00+09:00');
    const minute: ReceiptRow = {
      id: 'm',
      created_at: 1,
      transaction_at: epoch,
      transaction_time_precision: 'minute',
      image_uri: '',
      merchant_raw: 'X',
      merchant_normalized: 'X',
      total: 100,
      tax: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        transactionDate: '2026-07-06 11:44',
        transaction_time_precision: 'minute',
        items: [{ name: 'A', lineTotal: 100, quantity: 1 }],
      }),
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    };
    const second: ReceiptRow = {
      ...minute,
      id: 's',
      transaction_time_precision: 'second',
      analysis_json: JSON.stringify({
        transactionDate: '2026-07-06 11:44:00',
        transaction_time_precision: 'second',
        items: [{ name: 'A', lineTotal: 100, quantity: 1 }],
      }),
    };
    expect(hasExactTransactionTime(minute)).toBe(false);
    expect(hasExactTransactionTime(second)).toBe(true);
    expect(
      buildCanonicalPurchaseOccurrenceIndex([minute, second]).groups
    ).toHaveLength(2);
  });
});
