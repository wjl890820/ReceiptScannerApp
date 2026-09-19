/**
 * Canonical purchase-occurrence SSOT — conservative matcher + representative tests.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import {
  buildCanonicalPurchaseOccurrenceIndex,
  evaluateCanonicalPurchaseOccurrencePair,
  retainOccurrenceRepresentativeReceipts,
  strongNameCompatibleBasketEvidence,
} from './canonicalPurchaseOccurrence';
import { summarizeReceiptForDuplicateAudit } from './analysisDDuplicateAudit';
import { buildProductPriceHistory } from './productPriceHistory';
import {
  buildPurchaseEventDatesFromRows,
  buildRepeatProductProfiles,
} from './repeatProductProfile';
import type { ProductPriceHistoryRow } from './productPriceHistory';
import { calculateStats } from './statsCalculator';

const TX_2023 = Date.parse('2023-07-06T11:44:46+09:00');
const TX_2026 = Date.parse('2026-07-06T11:44:46+09:00');

function costcoBasketItems() {
  return [
    { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
    { name: 'ROTISSERIE CHICKEN', quantity: 1, lineTotal: 698 },
    { name: 'BANANA', quantity: 1, lineTotal: 428 },
  ];
}

function makeReceipt(
  id: string,
  opts: {
    transactionAt?: number | null;
    transactionTimePrecision?: 'second' | 'minute' | 'date' | 'unknown';
    transactionDateText?: string | null;
    createdAt?: number;
    merchant?: string;
    merchantNormalized?: string;
    total?: number;
    tax?: number;
    taxKnown?: boolean;
    items?: unknown[];
    currency?: string;
  } = {}
): ReceiptRow {
  const items = opts.items ?? costcoBasketItems();
  const total =
    opts.total ??
    (items as Array<{ lineTotal: number }>).reduce((s, i) => s + i.lineTotal, 0);
  const taxKnown = opts.taxKnown !== false;
  const txAt =
    opts.transactionAt === undefined ? TX_2026 : opts.transactionAt;
  const precision =
    opts.transactionTimePrecision ??
    (txAt == null ? 'unknown' : 'second');
  const analysis: Record<string, unknown> = {
    merchant: opts.merchant ?? 'コストコ',
    total,
    tax: opts.tax ?? 100,
    tax_is_known: taxKnown,
    currency: opts.currency ?? 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items,
    transaction_time_precision: precision,
  };
  if (opts.transactionDateText) {
    analysis.transactionDate = opts.transactionDateText;
  } else if (precision === 'second' && txAt != null) {
    // Durable second provenance for fixtures that intend exact-time evidence.
    analysis.transactionDate = '2026-07-06 11:44:46';
  } else if (precision === 'minute' && txAt != null) {
    analysis.transactionDate = '2026-07-06 11:44';
  }
  return {
    id,
    created_at: opts.createdAt ?? 2_000,
    transaction_at: txAt,
    transaction_time_precision: precision,
    image_uri: '',
    merchant_raw: opts.merchant ?? 'コストコ',
    merchant_normalized: opts.merchantNormalized ?? 'コストコ',
    merchant_type: 'supermarket',
    total,
    tax: opts.tax ?? 100,
    tax_is_known: taxKnown ? 1 : 0,
    currency: opts.currency ?? 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

function pphRowsFromReceipts(receipts: ReceiptRow[]): ProductPriceHistoryRow[] {
  const out: ProductPriceHistoryRow[] = [];
  for (const receipt of receipts) {
    const items = JSON.parse(receipt.analysis_json).items as Array<{
      name: string;
      quantity: number;
      lineTotal: number;
    }>;
    const occurredAt =
      receipt.transaction_at != null
        ? receipt.transaction_at
        : receipt.created_at;
    items.forEach((item, sourceIndex) => {
      out.push({
        receiptId: receipt.id,
        itemId: `${receipt.id}:${sourceIndex}`,
        sourceIndex,
        occurredAt,
        merchantRaw: receipt.merchant_raw,
        merchantNormalized: receipt.merchant_normalized,
        displayName: item.name,
        currency: 'JPY',
        lineTotal: item.lineTotal,
        purchaseQuantity: item.quantity,
        skuKey: null,
        productFamilyKey: null,
        volumeBaseMl: null,
        weightBaseG: null,
        countBase: null,
        grossLineAmount: item.lineTotal,
        effectiveLineAmount: item.lineTotal,
        discountAllocated: 0,
        receiptAnalysisJson: receipt.analysis_json,
        receiptTotal: receipt.total,
        receiptTax: receipt.tax,
        receiptTaxIsKnown: 1,
        receiptCurrency: 'JPY',
        receiptTransactionAt: receipt.transaction_at,
        receiptCreatedAt: receipt.created_at,
      });
    });
  }
  return out;
}

function repeatRows(receipts: ReceiptRow[]) {
  return pphRowsFromReceipts(receipts).map((row) => ({
    receiptId: row.receiptId,
    sourceIndex: row.sourceIndex,
    occurredAt: row.occurredAt,
    displayName: row.displayName,
    merchantNormalized: row.merchantNormalized,
    merchantRaw: row.merchantRaw,
    lineTotal: row.lineTotal,
    purchaseQuantity: row.purchaseQuantity,
  }));
}

describe('canonicalPurchaseOccurrence — false-merge guards', () => {
  it('A: same merchant/basket/total hours apart → 2', () => {
    const a = makeReceipt('hours-a', {
      transactionAt: Date.parse('2026-07-06T10:00:00+09:00'),
    });
    const b = makeReceipt('hours-b', {
      transactionAt: Date.parse('2026-07-06T14:00:00+09:00'),
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('B: several minutes apart → 2', () => {
    const a = makeReceipt('min-a', {
      transactionAt: Date.parse('2026-07-06T11:44:00+09:00'),
    });
    const b = makeReceipt('min-b', {
      transactionAt: Date.parse('2026-07-06T11:49:00+09:00'),
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('C: same minute but different seconds → 2', () => {
    const a = makeReceipt('sec-a', {
      transactionAt: Date.parse('2026-07-06T11:44:10+09:00'),
    });
    const b = makeReceipt('sec-b', {
      transactionAt: Date.parse('2026-07-06T11:44:40+09:00'),
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('D: different day → 2', () => {
    const a = makeReceipt('day-a', {
      transactionAt: Date.parse('2026-07-01T11:44:46+09:00'),
    });
    const b = makeReceipt('day-b', {
      transactionAt: Date.parse('2026-07-08T11:44:46+09:00'),
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('E: valid tx + genuine later null-tx same small basket → 2 (fail closed)', () => {
    const dated = makeReceipt('dated', {
      transactionAt: TX_2026,
      createdAt: 1,
    });
    const undated = makeReceipt('undated', {
      transactionAt: null,
      createdAt: 9_999,
    });
    expect(
      buildCanonicalPurchaseOccurrenceIndex([dated, undated]).groups
    ).toHaveLength(2);
  });

  it('E2: null-tx + dated with large identical basket → 2 (no durable provenance)', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({
      name: `ITEM_${n}`,
      quantity: 1,
      lineTotal: 100 * n,
    }));
    const total = items.reduce((s, i) => s + i.lineTotal, 0);
    const dated = makeReceipt('hc-dated', {
      transactionAt: TX_2026,
      createdAt: 1,
      items,
      total,
    });
    const undated = makeReceipt('hc-null', {
      transactionAt: null,
      createdAt: 9_999,
      items,
      total,
    });
    expect(
      buildCanonicalPurchaseOccurrenceIndex([dated, undated]).groups
    ).toHaveLength(2);
  });

  it('E3: both-null large identical basket → 2', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      name: `ITEM_${n}`,
      quantity: 1,
      lineTotal: 100 * n,
    }));
    const total = items.reduce((s, i) => s + i.lineTotal, 0);
    const a = makeReceipt('null-large-a', {
      transactionAt: null,
      createdAt: 1,
      items,
      total,
    });
    const b = makeReceipt('null-large-b', {
      transactionAt: null,
      createdAt: 2,
      items,
      total,
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('F: two genuine null-tx purchases → 2', () => {
    const a = makeReceipt('null-a', {
      transactionAt: null,
      createdAt: 1_000,
    });
    const b = makeReceipt('null-b', {
      transactionAt: null,
      createdAt: 2_000,
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('G: cross-year same clock + same amounts but different names → 2', () => {
    const a = makeReceipt('name-2023', {
      transactionAt: TX_2023,
      items: [
        { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
        { name: 'BANANA', quantity: 1, lineTotal: 428 },
      ],
      total: 846,
    });
    const b = makeReceipt('name-2026', {
      transactionAt: TX_2026,
      items: [
        { name: 'KS ALMOND MILK', quantity: 1, lineTotal: 418 },
        { name: 'BANANA', quantity: 1, lineTotal: 428 },
      ],
      total: 846,
    });
    const left = summarizeReceiptForDuplicateAudit(a);
    const right = summarizeReceiptForDuplicateAudit(b);
    expect(strongNameCompatibleBasketEvidence(left, right)).toBe(false);
    expect(evaluateCanonicalPurchaseOccurrencePair(left, right)).toBe(false);
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('G2: cross-year same clock + identical large named basket → 2', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({
      name: `KS ITEM ${n}`,
      quantity: 1,
      lineTotal: 200 + n,
    }));
    const total = items.reduce((s, i) => s + i.lineTotal, 0);
    const a = makeReceipt('xy-2023', {
      transactionAt: TX_2023,
      items,
      total,
      tax: 700,
    });
    const b = makeReceipt('xy-2026', {
      transactionAt: TX_2026,
      items,
      total,
      tax: 700,
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('H: recurring identical basket on different genuine dates → 2', () => {
    const a = makeReceipt('recur-a', {
      transactionAt: Date.parse('2026-01-15T12:00:00+09:00'),
    });
    const b = makeReceipt('recur-b', {
      transactionAt: Date.parse('2026-02-15T12:00:00+09:00'),
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('I: generic merchant must not bridge conflicting specific branches', () => {
    const items = [
      { name: 'グリーンカレーペースト', quantity: 1, lineTotal: 88 },
      { name: '炭化竹箸天削(袋無)', quantity: 1, lineTotal: 386 },
    ];
    const tx = Date.parse('2026-06-30T13:36:00+09:00');
    const branchA = makeReceipt('branch-a', {
      transactionAt: tx,
      merchant: '業務スーパー 一吉店',
      merchantNormalized: '業務スーパー 一吉店',
      total: 474,
      tax: 61,
      items,
    });
    const generic = makeReceipt('generic', {
      transactionAt: tx,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      total: 474,
      tax: 61,
      items,
    });
    const branchB = makeReceipt('branch-b', {
      transactionAt: tx,
      merchant: '業務スーパー 古川店',
      merchantNormalized: '業務スーパー 古川店',
      total: 474,
      tax: 61,
      items,
    });
    const index = buildCanonicalPurchaseOccurrenceIndex([
      branchA,
      generic,
      branchB,
    ]);
    // Generic may pair with each branch, but branches conflict → not one group.
    expect(index.groups.length).toBeGreaterThanOrEqual(2);
    const aOcc = index.occurrenceIdByReceiptId.get('branch-a');
    const bOcc = index.occurrenceIdByReceiptId.get('branch-b');
    expect(aOcc).not.toBe(bOcc);
  });
});

describe('canonicalPurchaseOccurrence — false-split / durable evidence', () => {
  it('exact same transaction_at + strong basket → 1', () => {
    const a = makeReceipt('exact-a', { transactionAt: TX_2026, createdAt: 1 });
    const b = makeReceipt('exact-b', { transactionAt: TX_2026, createdAt: 2 });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(1);
  });

  it('A: minute+minute generic↔branch same basket → 2', () => {
    const epoch = Date.parse('2026-06-30T13:36:00+09:00');
    const items = [
      { name: 'グリーンカレーペースト', quantity: 1, lineTotal: 88 },
      { name: '炭化竹箸天削(袋無)', quantity: 1, lineTotal: 386 },
    ];
    const generic = makeReceipt('g', {
      transactionAt: epoch,
      transactionTimePrecision: 'minute',
      transactionDateText: '2026-06-30 13:36',
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      total: 474,
      tax: 61,
      items,
    });
    const branch = makeReceipt('b', {
      transactionAt: epoch,
      transactionTimePrecision: 'minute',
      transactionDateText: '2026-06-30 13:36',
      merchant: '業務スーパー 一吉店',
      merchantNormalized: '業務スーパー 一吉店',
      total: 474,
      tax: 61,
      items,
    });
    expect(
      buildCanonicalPurchaseOccurrenceIndex([generic, branch]).groups
    ).toHaveLength(2);
  });

  it('B: minute+minute generic↔branch OCR-varied names → 2', () => {
    const epoch = Date.parse('2026-06-30T13:36:00+09:00');
    const generic = makeReceipt('g-ocr', {
      transactionAt: epoch,
      transactionTimePrecision: 'minute',
      transactionDateText: '2026-06-30 13:36',
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      total: 474,
      tax: 61,
      items: [
        { name: 'グリーンカレーペースト', quantity: 1, lineTotal: 88 },
        { name: '炭化竹箸天削(袋無)', quantity: 1, lineTotal: 386 },
      ],
    });
    const branch = makeReceipt('b-ocr', {
      transactionAt: epoch,
      transactionTimePrecision: 'minute',
      transactionDateText: '2026-06-30 13:36',
      merchant: '業務スーパー古川店',
      merchantNormalized: '業務スーパー古川店',
      total: 474,
      tax: 61,
      items: [
        { name: 'ｸﾞﾘｰﾝｶﾚｰﾍﾟｰｽﾄ', quantity: 1, lineTotal: 88 },
        { name: '炭化竹箸 天削', quantity: 1, lineTotal: 386 },
      ],
    });
    expect(
      buildCanonicalPurchaseOccurrenceIndex([generic, branch]).groups
    ).toHaveLength(2);
  });

  it('C: minute+minute same generic merchant → 2', () => {
    const epoch = Date.parse('2026-07-10T12:03:00+09:00');
    const a = makeReceipt('081-a', {
      transactionAt: epoch,
      transactionTimePrecision: 'minute',
      transactionDateText: '2026-07-10 12:03',
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      createdAt: 1,
    });
    const b = makeReceipt('081-b', {
      transactionAt: epoch,
      transactionTimePrecision: 'minute',
      transactionDateText: '2026-07-10 12:03',
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      createdAt: 2,
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('D: minute vs explicit second same epoch → 2', () => {
    const epoch = Date.parse('2026-07-06T11:44:00+09:00');
    const minuteOnly = makeReceipt('min-a', {
      transactionAt: epoch,
      transactionTimePrecision: 'minute',
      transactionDateText: '2026-07-06 11:44',
      createdAt: 1,
    });
    const explicitSecond = makeReceipt('sec-b', {
      transactionAt: epoch,
      transactionTimePrecision: 'second',
      transactionDateText: '2026-07-06 11:44:00',
      createdAt: 2,
    });
    expect(
      buildCanonicalPurchaseOccurrenceIndex([minuteOnly, explicitSecond]).groups
    ).toHaveLength(2);
  });

  it('E: unknown + second → 2', () => {
    const epoch = Date.parse('2026-07-06T11:44:46+09:00');
    const unk = makeReceipt('unk-a', {
      transactionAt: epoch,
      transactionTimePrecision: 'unknown',
      transactionDateText: null,
      createdAt: 1,
    });
    unk.analysis_json = JSON.stringify({
      ...JSON.parse(unk.analysis_json),
      transactionDate: undefined,
      transaction_time_precision: 'unknown',
    });
    const sec = makeReceipt('sec-b', {
      transactionAt: epoch,
      transactionTimePrecision: 'second',
      transactionDateText: '2026-07-06 11:44:46',
      createdAt: 2,
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([unk, sec]).groups).toHaveLength(
      2
    );
  });

  it('F: second+second strong structural duplicate → 1', () => {
    const epoch = Date.parse('2026-07-06T11:44:46+09:00');
    const a = makeReceipt('dup-a', {
      transactionAt: epoch,
      transactionTimePrecision: 'second',
      transactionDateText: '2026-07-06 11:44:46',
      createdAt: 1,
    });
    const b = makeReceipt('dup-b', {
      transactionAt: epoch,
      transactionTimePrecision: 'second',
      transactionDateText: '2026-07-06 11:44:46',
      createdAt: 2,
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(1);
  });

  it('G: second+second CONTENT_EXACT shape → 1', () => {
    const epoch = Date.parse('2026-07-06T11:44:46+09:00');
    const items = costcoBasketItems();
    const a = makeReceipt('ce-a', {
      transactionAt: epoch,
      transactionTimePrecision: 'second',
      transactionDateText: '2026-07-06 11:44:46',
      createdAt: 1,
      items,
    });
    const b = makeReceipt('ce-b', {
      transactionAt: epoch,
      transactionTimePrecision: 'second',
      transactionDateText: '2026-07-06 11:44:46',
      createdAt: 2,
      items,
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(1);
  });

  it('legacy precision unknown fail-closed → 2', () => {
    const epoch = Date.parse('2026-07-06T11:44:46+09:00');
    const a = makeReceipt('unk-a', {
      transactionAt: epoch,
      transactionTimePrecision: 'unknown',
      transactionDateText: null,
      createdAt: 1,
    });
    const b = makeReceipt('unk-b', {
      transactionAt: epoch,
      transactionTimePrecision: 'unknown',
      transactionDateText: null,
      createdAt: 2,
    });
    // Strip date text that makeReceipt would otherwise inject for second precision.
    a.analysis_json = JSON.stringify({
      ...JSON.parse(a.analysis_json),
      transactionDate: undefined,
      transaction_time_precision: 'unknown',
    });
    b.analysis_json = JSON.stringify({
      ...JSON.parse(b.analysis_json),
      transactionDate: undefined,
      transaction_time_precision: 'unknown',
    });
    expect(buildCanonicalPurchaseOccurrenceIndex([a, b]).groups).toHaveLength(2);
  });

  it('cross-year identical basket fails closed → 2 (no durable provenance)', () => {
    const a = makeReceipt('year-2023', { transactionAt: TX_2023, createdAt: 1 });
    const b = makeReceipt('year-2026', { transactionAt: TX_2026, createdAt: 2 });
    const index = buildCanonicalPurchaseOccurrenceIndex([a, b]);
    expect(index.groups).toHaveLength(2);

    const milkRows = pphRowsFromReceipts([a, b])
      .filter((r) => r.displayName.includes('MILK'))
      .map((r) => ({ ...r, skuKey: 'milk-test' }));
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'milk-test' },
      milkRows,
      {
        canonicalDuplicateSelectionApplied: true,
        purchaseOccurrenceIndex: index,
      }
    );
    // Two genuine production occurrences may contribute up to 2 points.
    expect(history.totalOccurrenceCount).toBe(2);
  });

  it('generic↔specific same clock+basket share one occurrence', () => {
    const items = [
      { name: 'グリーンカレーペースト', quantity: 1, lineTotal: 88 },
      { name: '炭化竹箸天削(袋無)', quantity: 1, lineTotal: 386 },
    ];
    const tx = Date.parse('2026-06-30T13:36:00+09:00');
    const generic = makeReceipt('generic', {
      transactionAt: tx,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      total: 474,
      tax: 61,
      items,
    });
    const branch = makeReceipt('branch-a', {
      transactionAt: tx,
      merchant: '業務スーパー 一吉店',
      merchantNormalized: '業務スーパー 一吉店',
      total: 474,
      tax: 61,
      items,
    });
    expect(
      buildCanonicalPurchaseOccurrenceIndex([generic, branch]).groups
    ).toHaveLength(1);
  });
});

describe('canonicalPurchaseOccurrence — representative + Repeat/PPH values', () => {
  it('three rescans qty1 → occurrence 1 and quantity 1', () => {
    const items = [{ name: '正宗生煎包', quantity: 1, lineTotal: 439 }];
    const tx = Date.parse('2026-07-06T11:44:46+09:00');
    const rows = [
      makeReceipt('r1', {
        transactionAt: tx,
        createdAt: 1,
        items,
        total: 439,
        merchant: '業務スーパー',
        merchantNormalized: '業務スーパー',
      }),
      makeReceipt('r2', {
        transactionAt: tx,
        createdAt: 2,
        items,
        total: 439,
        merchant: '業務スーパー',
        merchantNormalized: '業務スーパー',
      }),
      makeReceipt('r3', {
        transactionAt: tx,
        createdAt: 3,
        items,
        total: 439,
        merchant: '業務スーパー',
        merchantNormalized: '業務スーパー',
      }),
    ];
    const index = buildCanonicalPurchaseOccurrenceIndex(rows);
    expect(index.groups).toHaveLength(1);

    const productRows = repeatRows(rows);
    const timeline = buildPurchaseEventDatesFromRows(productRows, {
      purchaseOccurrenceIdByReceiptId: index.occurrenceIdByReceiptId,
      representativeReceiptIdByReceiptId: index.representativeReceiptIdByReceiptId,
    });
    expect(timeline.purchaseOccurrenceCount).toBe(1);

    // Force a second genuine purchase so a Repeat profile exists.
    const other = makeReceipt('other-day', {
      transactionAt: Date.parse('2026-07-20T11:44:46+09:00'),
      items,
      total: 439,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
    });
    const all = [...rows, other];
    const index2 = buildCanonicalPurchaseOccurrenceIndex(all);
    const profiles = buildRepeatProductProfiles(all, repeatRows(all), {
      purchaseOccurrenceIndex: index2,
    });
    const hit = profiles.find((p) => p.displayName.includes('生煎'));
    expect(hit?.purchaseOccurrenceCount).toBe(2);
    expect(hit?.totalPurchaseQuantity).toBe(2);
  });

  it('one receipt qty3 → occurrence 1 quantity 3', () => {
    const receipt = makeReceipt('qty3', {
      items: [
        { name: '正宗生煎包', quantity: 3, unitPrice: 439, lineTotal: 1317 },
      ],
      merchant: '業務スーパー古川店',
      merchantNormalized: '業務スーパー',
      total: 1317,
      tax: 100,
    });
    const other = makeReceipt('qty3-other', {
      transactionAt: Date.parse('2026-08-01T10:00:00+09:00'),
      items: [
        { name: '正宗生煎包', quantity: 1, unitPrice: 439, lineTotal: 439 },
      ],
      merchant: '業務スーパー古川店',
      merchantNormalized: '業務スーパー',
      total: 439,
      tax: 40,
    });
    const index = buildCanonicalPurchaseOccurrenceIndex([receipt, other]);
    const profiles = buildRepeatProductProfiles(
      [receipt, other],
      [
        {
          receiptId: 'qty3',
          sourceIndex: 0,
          occurredAt: TX_2026,
          displayName: '正宗生煎包',
          merchantNormalized: '業務スーパー',
          merchantRaw: '業務スーパー古川店',
          lineTotal: 1317,
          purchaseQuantity: 3,
        },
        {
          receiptId: 'qty3-other',
          sourceIndex: 0,
          occurredAt: Date.parse('2026-08-01T10:00:00+09:00'),
          displayName: '正宗生煎包',
          merchantNormalized: '業務スーパー',
          merchantRaw: '業務スーパー古川店',
          lineTotal: 439,
          purchaseQuantity: 1,
        },
      ],
      { purchaseOccurrenceIndex: index }
    );
    const hit = profiles.find((p) => p.displayName.includes('生煎'));
    expect(hit?.purchaseOccurrenceCount).toBe(2);
    expect(hit?.totalPurchaseQuantity).toBe(4);
  });

  it('PPH: three rescans ¥899×1 → one point gross 899 qty 1', () => {
    const items = [{ name: 'KS ITEM', quantity: 1, lineTotal: 899 }];
    const tx = Date.parse('2026-07-06T11:44:46+09:00');
    const receipts = [1, 2, 3].map((n) =>
      makeReceipt(`pph-${n}`, {
        transactionAt: tx,
        createdAt: n,
        items,
        total: 899,
      })
    );
    const index = buildCanonicalPurchaseOccurrenceIndex(receipts);
    const rows = pphRowsFromReceipts(receipts).map((r) => ({
      ...r,
      skuKey: 'ks-item' as const,
      priceObservationVersion: 1,
      itemAmountEvidenceState: 'coherent' as const,
      amountProvenance: 'ocr_observed' as const,
      evidenceCaptureVersion: 1,
      receiptAnalysisJson: JSON.stringify({
        items,
        evidenceCaptureVersion: 1,
        reconciliation: { ok: true },
        amount_mismatch: false,
      }),
    }));
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'ks-item' },
      rows,
      {
        purchaseOccurrenceIndex: index,
        canonicalDuplicateSelectionApplied: true,
      }
    );
    // May be NEP without Level-2 trust cache; still at most one occurrence.
    expect(history.totalOccurrenceCount).toBe(1);
    if (history.points.length > 0) {
      expect(history.points).toHaveLength(1);
      expect(history.points[0]!.grossLineAmount).toBe(899);
      expect(history.points[0]!.purchaseQuantity).toBe(1);
    }
  });

  it('PPH conflicting representations prefer representative / fail closed', () => {
    const tx = Date.parse('2026-07-06T11:44:46+09:00');
    const a = makeReceipt('rep-a', {
      transactionAt: tx,
      createdAt: 1,
      items: [{ name: 'ITEM', quantity: 1, lineTotal: 100 }],
      total: 100,
    });
    (a as { user_edited: number }).user_edited = 1;
    const b = makeReceipt('rep-b', {
      transactionAt: tx,
      createdAt: 2,
      items: [{ name: 'ITEM', quantity: 1, lineTotal: 100 }],
      total: 100,
    });
    const index = buildCanonicalPurchaseOccurrenceIndex([a, b]);
    expect(index.groups).toHaveLength(1);
    expect(index.groups[0]!.representativeReceiptId).toBe('rep-a');
  });
});

describe('visit/spend occurrence representatives', () => {
  it('three rescans of ¥9534 → visit 1 spend 9534', () => {
    const tx = Date.parse('2026-07-06T11:44:46+09:00');
    const items = [{ name: 'BULK', quantity: 1, lineTotal: 9534 }];
    const receipts = [1, 2, 3].map((n) =>
      makeReceipt(`spend-${n}`, {
        transactionAt: tx,
        createdAt: n,
        items,
        total: 9534,
        tax: 800,
      })
    );
    const reps = retainOccurrenceRepresentativeReceipts(receipts);
    expect(reps).toHaveLength(1);
    const stats = calculateStats(reps, 'all', Date.parse('2026-08-01T00:00:00+09:00'));
    expect(stats.supportedReceiptCount).toBe(1);
    expect(stats.supportedSpend).toBe(9534);
  });

  it('two genuine receipts both ¥9534 → visit 2 spend 19068', () => {
    const items = [{ name: 'BULK', quantity: 1, lineTotal: 9534 }];
    const a = makeReceipt('gen-a', {
      transactionAt: Date.parse('2026-07-01T11:44:46+09:00'),
      items,
      total: 9534,
      tax: 800,
    });
    const b = makeReceipt('gen-b', {
      transactionAt: Date.parse('2026-07-15T11:44:46+09:00'),
      items,
      total: 9534,
      tax: 800,
    });
    const reps = retainOccurrenceRepresentativeReceipts([a, b]);
    expect(reps).toHaveLength(2);
    const stats = calculateStats(reps, 'all', Date.parse('2026-08-01T00:00:00+09:00'));
    expect(stats.supportedReceiptCount).toBe(2);
    expect(stats.supportedSpend).toBe(19068);
  });

  it('A: two genuine identical 11-line purchases different dates → visits 2', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({
      name: `LINE_${n}`,
      quantity: 1,
      lineTotal: 800 + n,
    }));
    const total = 9534;
    const a = makeReceipt('11-a', {
      transactionAt: Date.parse('2026-07-01T11:44:46+09:00'),
      items,
      total,
      tax: 800,
    });
    const b = makeReceipt('11-b', {
      transactionAt: Date.parse('2026-07-15T11:44:46+09:00'),
      items,
      total,
      tax: 800,
    });
    const reps = retainOccurrenceRepresentativeReceipts([a, b]);
    expect(reps).toHaveLength(2);
    const stats = calculateStats(
      reps,
      'all',
      Date.parse('2026-08-01T00:00:00+09:00')
    );
    expect(stats.supportedReceiptCount).toBe(2);
    expect(stats.supportedSpend).toBe(19068);
  });

  it('B: valid tx + genuine null tx identical 11-line basket → visits 2', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({
      name: `LINE_${n}`,
      quantity: 1,
      lineTotal: 800 + n,
    }));
    const total = 9534;
    const dated = makeReceipt('11-dated', {
      transactionAt: TX_2026,
      createdAt: 1,
      items,
      total,
      tax: 800,
    });
    const undated = makeReceipt('11-null', {
      transactionAt: null,
      createdAt: 9_999,
      items,
      total,
      tax: 800,
    });
    const reps = retainOccurrenceRepresentativeReceipts([dated, undated]);
    expect(reps).toHaveLength(2);
    const stats = calculateStats(
      reps,
      'all',
      Date.parse('2026-08-01T00:00:00+09:00')
    );
    expect(stats.supportedReceiptCount).toBe(2);
    expect(stats.supportedSpend).toBe(19068);
  });

  it('C: two null-tx genuine identical baskets → visits 2', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({
      name: `LINE_${n}`,
      quantity: 1,
      lineTotal: 800 + n,
    }));
    const total = 9534;
    const a = makeReceipt('11-null-a', {
      transactionAt: null,
      createdAt: 1,
      items,
      total,
      tax: 800,
    });
    const b = makeReceipt('11-null-b', {
      transactionAt: null,
      createdAt: 2,
      items,
      total,
      tax: 800,
    });
    const reps = retainOccurrenceRepresentativeReceipts([a, b]);
    expect(reps).toHaveLength(2);
    const stats = calculateStats(
      reps,
      'all',
      Date.parse('2026-08-01T00:00:00+09:00')
    );
    expect(stats.supportedReceiptCount).toBe(2);
    expect(stats.supportedSpend).toBe(19068);
  });

  it('D: proven exact duplicate cohort → visits 1 spend once', () => {
    const tx = Date.parse('2026-07-06T11:44:46+09:00');
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({
      name: `LINE_${n}`,
      quantity: 1,
      lineTotal: 800 + n,
    }));
    const total = 9534;
    const a = makeReceipt('dup-a', {
      transactionAt: tx,
      createdAt: 1,
      items,
      total,
      tax: 800,
    });
    const b = makeReceipt('dup-b', {
      transactionAt: tx,
      createdAt: 2,
      items,
      total,
      tax: 800,
    });
    const reps = retainOccurrenceRepresentativeReceipts([a, b]);
    expect(reps).toHaveLength(1);
    const stats = calculateStats(
      reps,
      'all',
      Date.parse('2026-08-01T00:00:00+09:00')
    );
    expect(stats.supportedReceiptCount).toBe(1);
    expect(stats.supportedSpend).toBe(9534);
  });
});

describe('Repeat/PPH genuine purchase preservation', () => {
  it('valid + null identical product → Repeat occurrence 2', () => {
    const items = [{ name: '正宗生煎包', quantity: 1, lineTotal: 439 }];
    const dated = makeReceipt('rep-dated', {
      transactionAt: TX_2026,
      items,
      total: 439,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
    });
    const undated = makeReceipt('rep-null', {
      transactionAt: null,
      createdAt: 9_999,
      items,
      total: 439,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
    });
    const index = buildCanonicalPurchaseOccurrenceIndex([dated, undated]);
    expect(index.groups).toHaveLength(2);
    const profiles = buildRepeatProductProfiles(
      [dated, undated],
      repeatRows([dated, undated]),
      { purchaseOccurrenceIndex: index }
    );
    const hit = profiles.find((p) => p.displayName.includes('生煎'));
    expect(hit?.purchaseOccurrenceCount).toBe(2);
  });

  it('cross-year identical product → Repeat occurrence 2', () => {
    const items = [{ name: '正宗生煎包', quantity: 1, lineTotal: 439 }];
    const a = makeReceipt('xy-rep-a', {
      transactionAt: TX_2023,
      items,
      total: 439,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
    });
    const b = makeReceipt('xy-rep-b', {
      transactionAt: TX_2026,
      items,
      total: 439,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
    });
    const index = buildCanonicalPurchaseOccurrenceIndex([a, b]);
    expect(index.groups).toHaveLength(2);
    const profiles = buildRepeatProductProfiles([a, b], repeatRows([a, b]), {
      purchaseOccurrenceIndex: index,
    });
    const hit = profiles.find((p) => p.displayName.includes('生煎'));
    expect(hit?.purchaseOccurrenceCount).toBe(2);
  });

  it('PPH: two genuine purchases → totalOccurrenceCount 2', () => {
    const items = [{ name: 'KS ITEM', quantity: 1, lineTotal: 899 }];
    const a = makeReceipt('pph-g1', {
      transactionAt: Date.parse('2026-07-01T11:44:46+09:00'),
      items,
      total: 899,
    });
    const b = makeReceipt('pph-g2', {
      transactionAt: Date.parse('2026-07-15T11:44:46+09:00'),
      items,
      total: 899,
    });
    const index = buildCanonicalPurchaseOccurrenceIndex([a, b]);
    const rows = pphRowsFromReceipts([a, b]).map((r) => ({
      ...r,
      skuKey: 'ks-item' as const,
    }));
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'ks-item' },
      rows,
      {
        purchaseOccurrenceIndex: index,
        canonicalDuplicateSelectionApplied: true,
      }
    );
    expect(history.totalOccurrenceCount).toBe(2);
  });
});
