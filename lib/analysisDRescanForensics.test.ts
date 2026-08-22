/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import { ANALYSIS_D_KNOWN_COSTCO_9534_FORENSIC_TARGET_RECEIPT_IDS } from './analysisDDuplicateAudit';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildAnalysisDReport } from './analysisDReport';
import {
  buildAnalysisDRescanForensicsExport,
  serializeAnalysisDRescanForensicsExport,
} from './analysisDRescanForensics';
import type { ReceiptRow } from './db';

const TX = Date.parse('2023-07-06T11:44:00+09:00');

type FixtureItem = {
  name: string;
  category: string;
  lineTotal: number;
  quantity: number;
};

function makeReceipt(args: {
  id: string;
  items: FixtureItem[];
  total?: number;
  tax?: number;
  taxIsKnown?: number;
  createdAt?: number;
  transactionAt?: number | null;
  merchantNormalized?: string;
}): ReceiptRow {
  const itemSum = args.items.reduce((sum, item) => sum + item.lineTotal, 0);
  return {
    id: args.id,
    created_at: args.createdAt ?? TX,
    transaction_at:
      args.transactionAt === undefined ? TX : args.transactionAt,
    image_uri: 'file:///tmp/receipt.jpg',
    total: args.total ?? itemSum,
    tax: args.tax ?? 706,
    tax_is_known: args.taxIsKnown ?? 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: args.items }),
    merchant_raw: args.merchantNormalized ?? 'コストコ',
    merchant_normalized: args.merchantNormalized ?? 'コストコ',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: 'user-secret',
    installation_id: 'install-secret',
    ocr_request_id: 'ocr-secret',
  } as ReceiptRow;
}

const elevenItems: FixtureItem[] = [
  { name: 'ミルク', category: 'food_ingredients', lineTotal: 418, quantity: 1 },
  { name: 'じゃがいも', category: 'food_ingredients', lineTotal: 698, quantity: 1 },
  { name: 'パクチー', category: 'food_ingredients', lineTotal: 428, quantity: 1 },
  { name: 'チキン', category: 'ready_to_eat', lineTotal: 899, quantity: 1 },
  { name: 'きゅうり', category: 'food_ingredients', lineTotal: 488, quantity: 1 },
  { name: 'えのき', category: 'food_ingredients', lineTotal: 298, quantity: 1 },
  { name: 'ロール', category: 'food_ingredients', lineTotal: 998, quantity: 1 },
  { name: 'さつまいも', category: 'food_ingredients', lineTotal: 698, quantity: 1 },
  { name: 'クッキー', category: 'food_ingredients', lineTotal: 777, quantity: 1 },
  { name: 'モモカクキリ', category: 'food_ingredients', lineTotal: 3484, quantity: 1 },
  { name: 'water', category: 'food_ingredients', lineTotal: 348, quantity: 1 },
];

const thirteenItems: FixtureItem[] = [
  ...elevenItems.slice(0, 5),
  { name: '値引A', category: 'uncategorized', lineTotal: 100, quantity: 1 },
  { name: '値引B', category: 'uncategorized', lineTotal: 50, quantity: 1 },
  ...elevenItems.slice(5),
];

function allWindowConservation(report: ReturnType<typeof buildAnalysisDReport>) {
  return report.categoryValue.find((w) => w.window === 'all')?.conservation;
}

describe('Analysis D2-E1 known rescan forensic export', () => {
  const targetIds = [...ANALYSIS_D_KNOWN_COSTCO_9534_FORENSIC_TARGET_RECEIPT_IDS];

  test('exports four target receipts when available', () => {
    const receipts = targetIds.map((id, i) =>
      makeReceipt({ id, items: elevenItems, createdAt: TX + i, total: 9534 })
    );
    const payload = buildAnalysisDRescanForensicsExport({
      receipts,
      nowMs: TX,
    });
    expect(payload.targetReceiptIds).toEqual(targetIds);
    expect(payload.missingTargetReceiptIds).toEqual([]);
    expect(payload.receipts).toHaveLength(4);
    expect(payload.receipts.every((r) => r.present)).toBe(true);
  });

  test('missing target receipt is explicitly reported', () => {
    const receipts = [
      makeReceipt({ id: targetIds[0]!, items: elevenItems, total: 9534 }),
      makeReceipt({ id: targetIds[1]!, items: thirteenItems, total: 9534 }),
    ];
    const payload = buildAnalysisDRescanForensicsExport({
      receipts,
      nowMs: TX,
    });
    expect(payload.missingTargetReceiptIds).toEqual([
      targetIds[2],
      targetIds[3],
    ]);
    const missing = payload.receipts.filter((r) => !r.present);
    expect(missing).toHaveLength(2);
    expect(
      missing.every(
        (r) => !r.present && r.reason === 'not_found_in_local_receipts'
      )
    ).toBe(true);
  });

  test('raw + derived fields are both present', () => {
    const receipt = makeReceipt({
      id: targetIds[0]!,
      items: elevenItems,
      total: 9534,
    });
    const payload = buildAnalysisDRescanForensicsExport({
      receipts: [receipt],
      nowMs: TX,
    });
    const row = payload.receipts[0];
    expect(row?.present).toBe(true);
    if (!row || !row.present) return;
    expect(row.storedReceiptJson).toBeTruthy();
    expect(row.rawMerchantValue).toBe('コストコ');
    expect(row.resolvedMerchantAnalyticsKey).toBeTruthy();
    expect(row.contentFingerprint).toBeTruthy();
    expect(row.structuralFingerprint).toBeTruthy();
    expect(row.derivedComparison.orderedAmountVector).toHaveLength(11);
  });

  test('all source item rows are preserved in source order', () => {
    const receipt = makeReceipt({
      id: targetIds[1]!,
      items: thirteenItems,
      total: 9534,
    });
    const payload = buildAnalysisDRescanForensicsExport({
      receipts: [receipt],
      nowMs: TX,
    });
    const row = payload.receipts.find((r) => r.receiptId === targetIds[1]);
    expect(row?.present).toBe(true);
    if (!row || !row.present) return;
    expect(row.storedItemCount).toBe(13);
    expect(row.items).toHaveLength(13);
    expect(row.items.map((i) => i.sourceIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(row.items.map((i) => i.rawOcrOrProductName)).toEqual(
      thirteenItems.map((i) => i.name)
    );
  });

  test('comparison detects item-count mismatch and ordered amount differences', () => {
    const a = makeReceipt({
      id: 'C_aMA69ijcqNLhGI76Y5Q',
      items: thirteenItems,
      total: 9534,
      createdAt: TX + 1,
    });
    const b = makeReceipt({
      id: 'NEHGZCkqd8MiBCyKO-fWd',
      items: elevenItems,
      total: 9534,
      createdAt: TX,
    });
    const payload = buildAnalysisDRescanForensicsExport({
      receipts: [a, b],
      nowMs: TX,
    });
    const pair = payload.pairwiseComparisons.find(
      (p) =>
        p.leftReceiptId === 'C_aMA69ijcqNLhGI76Y5Q' &&
        p.rightReceiptId === 'NEHGZCkqd8MiBCyKO-fWd'
    );
    expect(pair).toBeTruthy();
    expect(pair!.itemCountEqual).toBe(false);
    expect(pair!.orderedAmountVectorEqual).toBe(false);
    expect(payload.caMaVsNehgLineByLine.lineDiffs.length).toBeGreaterThan(0);
  });

  test('export itself performs no receipt mutation', () => {
    const receipt = makeReceipt({
      id: targetIds[0]!,
      items: elevenItems,
      total: 9534,
    });
    const before = JSON.stringify(receipt);
    buildAnalysisDRescanForensicsExport({ receipts: [receipt], nowMs: TX });
    expect(JSON.stringify(receipt)).toBe(before);
  });

  test('production analytics output unchanged by forensic export', () => {
    const receipts = targetIds.map((id, i) =>
      makeReceipt({
        id,
        items: i === 1 ? thirteenItems : elevenItems,
        total: 9534,
        createdAt: TX + i,
      })
    );
    const beforeSelection = selectAnalyticsReceipts(receipts);
    const beforeReport = buildAnalysisDReport({
      receipts: beforeSelection.analyticsReceipts,
      nowMs: TX,
    });
    buildAnalysisDRescanForensicsExport({ receipts, nowMs: TX });
    const afterSelection = selectAnalyticsReceipts(receipts);
    const afterReport = buildAnalysisDReport({
      receipts: afterSelection.analyticsReceipts,
      nowMs: TX,
    });
    expect(afterSelection.analyticsPurchaseCandidateCount).toBe(
      beforeSelection.analyticsPurchaseCandidateCount
    );
    expect([...afterSelection.excludedDuplicateReceiptIds].sort()).toEqual(
      [...beforeSelection.excludedDuplicateReceiptIds].sort()
    );
    expect(allWindowConservation(afterReport)).toEqual(
      allWindowConservation(beforeReport)
    );
  });

  test('duplicate selection output unchanged', () => {
    const receipts = [
      makeReceipt({ id: targetIds[0]!, items: elevenItems, createdAt: TX }),
      makeReceipt({
        id: targetIds[2]!,
        items: elevenItems,
        createdAt: TX + 10,
      }),
      makeReceipt({
        id: targetIds[3]!,
        items: elevenItems,
        createdAt: TX + 20,
      }),
    ];
    const before = selectAnalyticsReceipts(receipts);
    buildAnalysisDRescanForensicsExport({ receipts, nowMs: TX });
    const after = selectAnalyticsReceipts(receipts);
    expect(after.analyticsReceipts.map((r) => r.id)).toEqual(
      before.analyticsReceipts.map((r) => r.id)
    );
    expect(after.highConfidenceDuplicateGroups).toEqual(
      before.highConfidenceDuplicateGroups
    );
  });

  test('category conservation remains stable on selected universe', () => {
    const receipts = [
      makeReceipt({ id: targetIds[0]!, items: elevenItems, total: 9534 }),
    ];
    const before = buildAnalysisDReport({
      receipts: selectAnalyticsReceipts(receipts).analyticsReceipts,
      nowMs: TX,
    });
    buildAnalysisDRescanForensicsExport({ receipts, nowMs: TX });
    const after = buildAnalysisDReport({
      receipts: selectAnalyticsReceipts(receipts).analyticsReceipts,
      nowMs: TX,
    });
    expect(allWindowConservation(after)).toEqual(allWindowConservation(before));
    expect(allWindowConservation(after)?.gap).toBe(0);
  });

  test('sensitive fields are redacted in storedReceiptJson', () => {
    const receipt = makeReceipt({
      id: targetIds[0]!,
      items: elevenItems,
      total: 9534,
    });
    const payload = buildAnalysisDRescanForensicsExport({
      receipts: [receipt],
      nowMs: TX,
    });
    const row = payload.receipts[0];
    expect(row?.present).toBe(true);
    if (!row || !row.present) return;
    expect(row.storedReceiptJson.user_id).toBe('[redacted]');
    expect(row.storedReceiptJson.installation_id).toBe('[redacted]');
    expect(row.storedReceiptJson.ocr_request_id).toBe('[redacted]');
    expect(row.storedReceiptJson.image_uri).toBe('[redacted]');
    expect(JSON.stringify(row.storedReceiptJson)).not.toContain('user-secret');
  });

  test('serialize produces stable JSON envelope', () => {
    const payload = buildAnalysisDRescanForensicsExport({
      receipts: [],
      nowMs: TX,
    });
    const json = serializeAnalysisDRescanForensicsExport(payload);
    expect(json).toContain('known_costco_9534_rescan_ground_truth');
    expect(json.endsWith('\n')).toBe(true);
    expect(payload.missingTargetReceiptIds).toEqual(targetIds);
  });
});
