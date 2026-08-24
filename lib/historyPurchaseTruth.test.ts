/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import * as fs from 'fs';
import * as path from 'path';

import type { ReceiptListRow, ReceiptRow } from './db';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  buildHistoryPurchaseTruthView,
  expandHistoryPurchaseDeleteIds,
  projectHistorySearchToPurchaseTruth,
  resolvePurchaseRepresentativeReceiptId,
} from './historyPurchaseTruth';

const nowMs = Date.parse('2026-02-21T12:28:00+09:00');
const costcoTx = Date.parse('2023-07-06T11:44:46+09:00');

type FixtureItem = {
  name: string;
  category: string;
  lineTotal: number;
  quantity: number;
};

function makeReceipt(args: {
  id: string;
  at: number;
  merchantType: string;
  items: FixtureItem[];
  total?: number;
  merchantNormalized?: string;
  transactionAt?: number | null;
  createdAt?: number;
  tax?: number;
  taxIsKnown?: number;
}): ReceiptRow {
  const itemSum = args.items.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
  return {
    id: args.id,
    created_at: args.createdAt ?? args.at,
    transaction_at:
      args.transactionAt === undefined ? args.at : args.transactionAt,
    image_uri: '',
    total: args.total ?? itemSum,
    tax: args.tax ?? 0,
    tax_is_known: args.taxIsKnown ?? 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: args.items }),
    merchant_raw: args.merchantNormalized ?? 'イオン',
    merchant_normalized: args.merchantNormalized ?? 'イオン',
    merchant_type: args.merchantType as ReceiptRow['merchant_type'],
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

function toListRow(row: ReceiptRow): ReceiptListRow {
  const { image_uri: _imageUri, ...rest } = row;
  return rest;
}

function fourIdenticalAeonScans(): ReceiptRow[] {
  const items: FixtureItem[] = [
    { name: '卵', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
    { name: '牛乳', category: 'food_ingredients', lineTotal: 3918, quantity: 1 },
  ];
  return [0, 1, 2, 3].map((i) =>
    makeReceipt({
      id: `aeon-scan-${i}`,
      at: nowMs,
      createdAt: nowMs + i * 1000,
      merchantType: 'supermarket',
      merchantNormalized: 'イオン古川店',
      transactionAt: nowMs,
      total: 4118,
      items,
    })
  );
}

const costcoCoreItems: FixtureItem[] = [
  { name: 'A', category: 'other', lineTotal: 418, quantity: 1 },
  { name: 'B', category: 'other', lineTotal: 698, quantity: 1 },
  { name: 'C', category: 'other', lineTotal: 428, quantity: 1 },
  { name: 'D', category: 'other', lineTotal: 899, quantity: 1 },
  { name: 'E', category: 'other', lineTotal: 488, quantity: 1 },
  { name: 'F', category: 'other', lineTotal: 298, quantity: 1 },
  { name: 'G', category: 'other', lineTotal: 998, quantity: 1 },
  { name: 'H', category: 'other', lineTotal: 698, quantity: 1 },
  { name: 'I', category: 'other', lineTotal: 777, quantity: 1 },
  { name: 'J', category: 'other', lineTotal: 3484, quantity: 1 },
  { name: 'K', category: 'other', lineTotal: 348, quantity: 1 },
];

const trailingArtifacts: FixtureItem[] = [
  { name: 'コストコ コネクション', category: 'other', lineTotal: 1, quantity: 1 },
  { name: 'コストコ コネクション ムリョウ', category: 'other', lineTotal: 1, quantity: 1 },
];

function cleanCostco(id: string, createdAt: number, nameSuffix = '') {
  return makeReceipt({
    id,
    at: costcoTx,
    createdAt,
    merchantType: 'supermarket',
    merchantNormalized: 'コストコ',
    transactionAt: costcoTx,
    total: 9534,
    tax: 706,
    taxIsKnown: 1,
    items: costcoCoreItems.map((it, idx) => ({
      ...it,
      name: `${it.name}${nameSuffix}${idx}`,
    })),
  });
}

function noisyCostco(id: string, createdAt: number, tax = 708) {
  return makeReceipt({
    id,
    at: costcoTx,
    createdAt,
    merchantType: 'supermarket',
    merchantNormalized: 'コストコ',
    transactionAt: costcoTx,
    total: 9534,
    tax,
    taxIsKnown: 1,
    items: [
      ...costcoCoreItems.map((it, idx) => ({
        ...it,
        name: `${it.name}_n${idx}`,
      })),
      ...trailingArtifacts,
    ],
  });
}

function costcoTimedFour(): ReceiptRow[] {
  return [
    cleanCostco('2bDvMWs3dkCKagyrYWyxA', 2000),
    noisyCostco('C_aMA69ijcqNLhGI76Y5Q', 1000),
    cleanCostco('n6_vGM5c8X255Psyiup4k', 3000, '_b'),
    cleanCostco('NEHGZCkqd8MiBCyKO-fWd', 4000, '_c'),
  ];
}

describe('historyPurchaseTruth', () => {
  it('A — four identical high-confidence duplicate scans → 4 stored, 1 visible', () => {
    const stored = fourIdenticalAeonScans();
    const view = buildHistoryPurchaseTruthView(stored);
    expect(view.storedCount).toBe(4);
    expect(view.visibleRows).toHaveLength(1);
    expect(view.selection.analyticsPurchaseCandidateCount).toBe(1);
    expect(view.selection.storedReceipts).toHaveLength(4);
  });

  it('B — Costco known timed duplicate fixture → 1 visible History purchase', () => {
    const view = buildHistoryPurchaseTruthView(costcoTimedFour());
    expect(view.storedCount).toBe(4);
    expect(view.visibleRows).toHaveLength(1);
    expect(view.selection.analyticsPurchaseCandidateCount).toBe(1);
    expect(
      view.selection.excludedDuplicateReceiptIds.has('C_aMA69ijcqNLhGI76Y5Q')
    ).toBe(true);
  });

  it('C — two legitimate same-day purchases remain two visible rows', () => {
    const items: FixtureItem[] = [
      { name: '牛乳', category: 'food_ingredients', lineTotal: 1000, quantity: 1 },
    ];
    const a = makeReceipt({
      id: 'legit-morning',
      at: nowMs,
      createdAt: nowMs,
      merchantType: 'supermarket',
      merchantNormalized: 'イオン',
      transactionAt: nowMs,
      total: 1000,
      items,
    });
    const b = makeReceipt({
      id: 'legit-evening',
      at: nowMs + 6 * 3600_000,
      createdAt: nowMs + 6 * 3600_000,
      merchantType: 'supermarket',
      merchantNormalized: 'イオン',
      transactionAt: nowMs + 6 * 3600_000,
      total: 1000,
      items,
    });
    const view = buildHistoryPurchaseTruthView([a, b]);
    expect(view.storedCount).toBe(2);
    expect(view.visibleRows).toHaveLength(2);
  });

  it('D — date-only legitimate same-day purchases remain two visible rows', () => {
    const dateOnly = Date.parse('2023-07-06T00:00:00+09:00');
    const coreItems: FixtureItem[] = [
      { name: '牛乳', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
      { name: 'パン', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
    ];
    const a = makeReceipt({
      id: 'date-a',
      at: dateOnly,
      createdAt: 1000,
      merchantType: 'supermarket',
      merchantNormalized: 'イオン',
      transactionAt: dateOnly,
      total: 500,
      items: coreItems,
    });
    const b = makeReceipt({
      id: 'date-b',
      at: dateOnly,
      createdAt: 2000,
      merchantType: 'supermarket',
      merchantNormalized: 'イオン',
      transactionAt: dateOnly,
      total: 500,
      items: [
        ...coreItems,
        { name: 'ポイント残高', category: 'other', lineTotal: 0, quantity: 1 },
      ],
    });
    const view = buildHistoryPurchaseTruthView([a, b]);
    expect(view.visibleRows).toHaveLength(2);
    expect(view.selection.analyticsPurchaseCandidateCount).toBe(2);
  });

  it('E — search projection shows a duplicate purchase once', () => {
    const stored = fourIdenticalAeonScans();
    const view = buildHistoryPurchaseTruthView(stored);
    const projected = projectHistorySearchToPurchaseTruth(
      {
        itemResults: stored.map((r, i) => ({
          receiptId: r.id,
          itemId: `item-${i}`,
          displayName: '牛乳',
          sourceIndex: 0,
        })),
        receiptResults: stored.map(toListRow),
      },
      view.selection
    );
    expect(projected.receiptResults).toHaveLength(1);
    expect(projected.itemResults).toHaveLength(1);
    expect(projected.receiptResults[0]!.id).toBe(view.visibleRows[0]!.id);
  });

  it('F — delete expands to full confirmed group so purchase cannot resurrect', () => {
    const stored = fourIdenticalAeonScans();
    const view = buildHistoryPurchaseTruthView(stored);
    const visibleId = view.visibleRows[0]!.id;
    const deleteIds = expandHistoryPurchaseDeleteIds(
      [visibleId],
      view.selection.highConfidenceDuplicateGroups
    );
    expect(deleteIds.sort()).toEqual(stored.map((r) => r.id).sort());

    const remaining = stored.filter((r) => !deleteIds.includes(r.id));
    expect(remaining).toHaveLength(0);
    expect(buildHistoryPurchaseTruthView(remaining).visibleRows).toHaveLength(0);
  });

  it('F2 — deleting only the representative without expand would resurrect (guard)', () => {
    const stored = fourIdenticalAeonScans();
    const view = buildHistoryPurchaseTruthView(stored);
    const visibleId = view.visibleRows[0]!.id;
    const naiveRemaining = stored.filter((r) => r.id !== visibleId);
    expect(naiveRemaining).toHaveLength(3);
    expect(buildHistoryPurchaseTruthView(naiveRemaining).visibleRows).toHaveLength(
      1
    );
  });

  it('does not alter selectAnalyticsReceipts purchase counts vs direct call', () => {
    const stored = costcoTimedFour();
    const direct = selectAnalyticsReceipts(stored);
    const view = buildHistoryPurchaseTruthView(stored);
    expect(view.selection.analyticsPurchaseCandidateCount).toBe(
      direct.analyticsPurchaseCandidateCount
    );
    expect(view.selection.excludedDuplicateReceiptIds.size).toBe(
      direct.excludedDuplicateReceiptIds.size
    );
  });

  it('resolvePurchaseRepresentativeReceiptId maps extras to representative', () => {
    const view = buildHistoryPurchaseTruthView(costcoTimedFour());
    const rep = view.visibleRows[0]!.id;
    expect(
      resolvePurchaseRepresentativeReceiptId(
        'C_aMA69ijcqNLhGI76Y5Q',
        view.selection.highConfidenceDuplicateGroups
      )
    ).toBe(rep);
  });
});

describe('History screen wiring (purchase truth)', () => {
  it('History list uses purchase-truth consumer + group-aware delete', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/index.tsx'),
      'utf8'
    );
    expect(src).toContain('buildHistoryPurchaseTruthView');
    expect(src).toContain('expandHistoryPurchaseDeleteIds');
    expect(src).toContain('projectHistorySearchToPurchaseTruth');
    expect(src).toContain('listReceipts');
    expect(src).not.toMatch(/listReceiptsForList\(/);
  });

  it('Receipt Detail delete expands confirmed duplicate group', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/[id].tsx'),
      'utf8'
    );
    expect(src).toContain('expandHistoryPurchaseDeleteIds');
    expect(src).toContain('selectAnalyticsReceipts');
    expect(src).toContain('deleteReceipts');
  });
});
