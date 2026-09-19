/**
 * R5 A3 — Product Detail exclusions must use uncapped owner history.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import type { ReceiptRow } from './db';
import { buildProductDetailExcludedReceiptIds } from './productDetailOccurrenceExclusions';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { applyOccurrenceRepresentativeUniverse } from './canonicalPurchaseOccurrence';

const TX = Date.parse('2026-06-30T13:36:46+09:00');
const DAY = 86_400_000;

function makeReceipt(
  id: string,
  opts: {
    createdAt: number;
    transactionAt?: number;
    merchant?: string;
    merchantNormalized?: string;
    items?: Array<{ name: string; quantity: number; lineTotal: number }>;
    total?: number;
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
    tax: 8,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      merchant: opts.merchant ?? 'テスト店',
      total,
      tax: 8,
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

describe('Product Detail full-history occurrence exclusions', () => {
  it('production path uses listReceiptsForAnalysis (uncapped), not listReceipts(200)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/product/[targetType].tsx'),
      'utf8'
    );
    expect(source).toContain('listReceiptsForAnalysis');
    expect(source).toContain('buildProductDetailExcludedReceiptIds');
    expect(source).not.toMatch(
      /excludedReceiptIds[\s\S]{0,200}listReceipts\(\)/
    );
  });

  it('>200 receipts: old proven duplicate beyond newest-200 still excludes once', () => {
    const newest: ReceiptRow[] = [];
    for (let i = 0; i < 200; i += 1) {
      newest.push(
        makeReceipt(`new-${i}`, {
          createdAt: 10_000_000 + i * DAY,
          transactionAt: 10_000_000 + i * DAY,
          merchant: `店${i}`,
          merchantNormalized: `店${i}`,
          total: 100 + i,
        })
      );
    }

    const curryItems = [
      { name: 'グリーンカレーペースト', quantity: 1, lineTotal: 88 },
    ];
    const oldA = makeReceipt('old-curry-a', {
      createdAt: 1_000,
      transactionAt: TX,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      items: curryItems,
      total: 88,
    });
    const oldB = makeReceipt('old-curry-b', {
      createdAt: 1_001,
      transactionAt: TX,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      items: curryItems,
      total: 88,
    });

    const fullHistory = [...newest, oldA, oldB];
    expect(fullHistory.length).toBe(202);

    // Cap mismatch: newest-200 omits the old duplicate pair entirely.
    const cappedNewest200 = [...newest].sort(
      (a, b) => b.created_at - a.created_at
    );
    expect(cappedNewest200).toHaveLength(200);
    expect(cappedNewest200.some((r) => r.id.startsWith('old-curry'))).toBe(
      false
    );

    const cappedExclusions = buildProductDetailExcludedReceiptIds(
      cappedNewest200
    );
    expect(cappedExclusions.has('old-curry-a')).toBe(false);
    expect(cappedExclusions.has('old-curry-b')).toBe(false);

    // Full-history path (production): both old rescans resolve to one occurrence.
    const fullExclusions = buildProductDetailExcludedReceiptIds(fullHistory);
    const selection = selectAnalyticsReceipts(fullHistory);
    const universe = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    expect(universe.representativeReceipts.some((r) => r.id.startsWith('old-curry'))).toBe(
      true
    );
    const oldReps = universe.representativeReceipts.filter((r) =>
      r.id.startsWith('old-curry')
    );
    expect(oldReps).toHaveLength(1);
    const nonRep = oldReps[0]!.id === 'old-curry-a' ? 'old-curry-b' : 'old-curry-a';
    expect(fullExclusions.has(nonRep)).toBe(true);
    expect(fullExclusions.has(oldReps[0]!.id)).toBe(false);

    // Simulated Product History aggregation after full-history exclusion.
    let spend = 0;
    let qty = 0;
    let purchases = 0;
    for (const receipt of [oldA, oldB]) {
      if (fullExclusions.has(receipt.id)) continue;
      purchases += 1;
      spend += 88;
      qty += 1;
    }
    expect(purchases).toBe(1);
    expect(spend).toBe(88);
    expect(qty).toBe(1);
  });
});
