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
  expandHistoryPurchaseEditIds,
  HISTORY_PURCHASE_TRUTH_LOAD_LIMIT,
  HistoryPurchaseDeleteResolutionError,
  projectHistorySearchToPurchaseTruth,
  resolveHistoryPurchaseDeleteIds,
  resolveHistoryPurchaseDetailReceiptId,
  resolveHistoryPurchaseEditMemberIds,
  resolvePurchaseRepresentativeReceiptId,
} from './historyPurchaseTruth';
import { getReceiptItems } from './receiptItems';
import {
  applyLogicalPurchaseEditOverlay,
  assertLogicalPurchaseEditPartition,
  deriveExactLogicalPurchaseMemberSet,
  LogicalPurchaseEditPartitionError,
} from './logicalPurchaseEditPartition';

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

const GYOMU_TX_AT = 1786351380000;
const GYOMU_NOW_MS = Date.parse('2026-09-01T12:00:00+09:00');
const GYOMU_LINE_AMOUNTS = [372, 378, 108, 313, 100, 103, 88, 1756] as const;
const GYOMU_SEVEN_RECEIPT_IDS = [
  'ACsMESsCvPCD9Vsgpmn4V',
  'erhG0uXoyTm6vRFNCrBFe',
  'KzeeGp7HDiUxMu0D0CyzE',
  'lmg2SfKrcRGFCM1JVpOMS',
  'rbVx_AFdAfnwFywe11mR_',
  'sLOTqc_9eqHnMhJLlzQpx',
  'auq8r7qU-EN_l38Y2xDea',
] as const;

function gyomuRealItems(
  order: readonly number[],
  variant: 'standard' | 'outlier'
) {
  return order.map((lineIndex) => {
    const lineTotal = GYOMU_LINE_AMOUNTS[lineIndex]!;
    if (lineIndex === 7) {
      return {
        name:
          variant === 'outlier'
            ? '正宗生煎包'
            : '正宗生煎包 (4個 x @439)',
        category: 'food_ingredients',
        lineTotal: 1756,
        quantity: variant === 'outlier' ? 1 : 4,
      };
    }
    return {
      name: `商品${String.fromCharCode(65 + lineIndex)}`,
      category: 'food_ingredients',
      lineTotal,
      quantity: 1,
    };
  });
}

function buildGyomuSevenScanFixture(): ReceiptRow[] {
  const itemOrders = [
    [0, 1, 2, 3, 4, 5, 6, 7],
    [7, 6, 5, 4, 3, 2, 1, 0],
    [2, 4, 6, 0, 1, 3, 5, 7],
    [1, 3, 5, 7, 0, 2, 4, 6],
    [4, 0, 6, 2, 7, 1, 5, 3],
    [3, 7, 1, 5, 2, 6, 0, 4],
    [5, 2, 0, 7, 4, 1, 6, 3],
  ];
  return GYOMU_SEVEN_RECEIPT_IDS.map((id, index) =>
    makeReceipt({
      id,
      at: GYOMU_TX_AT,
      createdAt: GYOMU_NOW_MS - index * 60_000,
      merchantType: 'supermarket',
      merchantNormalized:
        index % 2 === 0 ? '業務スーパー古川店' : '業務スーパー古川',
      transactionAt: GYOMU_TX_AT,
      total: 3393,
      tax: 251,
      taxIsKnown: 1,
      items: gyomuRealItems(
        itemOrders[index]!,
        id === 'auq8r7qU-EN_l38Y2xDea' ? 'outlier' : 'standard'
      ),
    })
  );
}

function gyomuRepresentative(receipts: ReceiptRow[]): ReceiptRow {
  const rep = selectAnalyticsReceipts(receipts).analyticsReceipts.find((receipt) =>
    receipt.merchant_normalized?.includes('業務スーパー')
  );
  if (!rep) throw new Error('Gyomu representative not found');
  return rep;
}

function buildEditedGyomuUserItemsJson(
  receipts: ReceiptRow[],
  edit: (items: Record<string, unknown>[]) => Record<string, unknown>[]
): string {
  const items = getReceiptItems(gyomuRepresentative(receipts)).map((item) => ({
    ...(item as Record<string, unknown>),
  }));
  return JSON.stringify(edit(items));
}

function applyLogicalEditOverlay(
  receipts: readonly ReceiptRow[],
  memberIds: readonly string[],
  userItemsJson: string
): ReceiptRow[] {
  return applyLogicalPurchaseEditOverlay(receipts, memberIds, userItemsJson);
}

function gyomuPurchaseCount(receipts: readonly ReceiptRow[]): number {
  return buildHistoryPurchaseTruthView(receipts).visibleRows.filter((row) =>
    row.merchant_normalized?.includes('業務スーパー')
  ).length;
}

describe('history logical purchase edit', () => {
  const gyomuScans = buildGyomuSevenScanFixture();

  it('D. hidden member expands to the full logical group', () => {
    const view = buildHistoryPurchaseTruthView(gyomuScans);
    const hiddenId = [...view.selection.excludedDuplicateReceiptIds][0]!;
    const memberIds = resolveHistoryPurchaseEditMemberIds(hiddenId, gyomuScans);
    expect(memberIds.sort()).toEqual([...GYOMU_SEVEN_RECEIPT_IDS].sort());
  });

  it('E. singleton edit expands to itself', () => {
    const singleton = makeReceipt({
      id: 'solo-1',
      at: Date.parse('2026-08-01T12:00:00+09:00'),
      createdAt: GYOMU_NOW_MS,
      merchantType: 'supermarket',
      merchantNormalized: '単独店',
      transactionAt: Date.parse('2026-08-01T12:00:00+09:00'),
      total: 500,
      items: [{ name: '牛乳', category: 'food_ingredients', lineTotal: 500, quantity: 1 }],
    });
    expect(resolveHistoryPurchaseEditMemberIds(singleton.id, [singleton])).toEqual([
      'solo-1',
    ]);
    expect(expandHistoryPurchaseEditIds(singleton.id, [])).toEqual(['solo-1']);
  });

  it('A. Gyomu quantity edit stays one logical purchase', () => {
    expect(gyomuPurchaseCount(gyomuScans)).toBe(1);
    const rep = gyomuRepresentative(gyomuScans);
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) =>
      items.map((item) =>
        Number(item.lineTotal) === 1756
          ? { ...item, quantity: 3, quantityUserEdited: true }
          : item
      )
    );
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans);
    expect(memberIds).toHaveLength(7);
    const edited = applyLogicalEditOverlay(gyomuScans, memberIds, userItemsJson);
    expect(gyomuPurchaseCount(edited)).toBe(1);
    expect(selectAnalyticsReceipts(edited).analyticsPurchaseCandidateCount).toBe(1);
  });

  it('B. Gyomu line-amount edit stays one logical purchase', () => {
    const rep = gyomuRepresentative(gyomuScans);
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) =>
      items.map((item, index) =>
        index === 0 ? { ...item, lineTotal: 380, amountUserEdited: true } : item
      )
    );
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans);
    const edited = applyLogicalEditOverlay(gyomuScans, memberIds, userItemsJson);
    expect(gyomuPurchaseCount(edited)).toBe(1);
  });

  it('C. Gyomu category edit stays one logical purchase', () => {
    const rep = gyomuRepresentative(gyomuScans);
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) =>
      items.map((item, index) =>
        index === 0 ? { ...item, category: 'snacks_drinks' } : item
      )
    );
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans);
    const edited = applyLogicalEditOverlay(gyomuScans, memberIds, userItemsJson);
    expect(gyomuPurchaseCount(edited)).toBe(1);
  });

  it('H. raw analysis_json preserved after logical edit overlay', () => {
    const rep = gyomuRepresentative(gyomuScans);
    const originalAnalysis = new Map(
      gyomuScans.map((receipt) => [receipt.id, receipt.analysis_json])
    );
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) => items);
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans);
    const edited = applyLogicalEditOverlay(gyomuScans, memberIds, userItemsJson);
    for (const id of memberIds) {
      const row = edited.find((receipt) => receipt.id === id)!;
      expect(row.analysis_json).toBe(originalAnalysis.get(id));
      expect(row.user_items_json).toBe(userItemsJson);
    }
  });

  it('I. relaunch truth simulation stays one purchase', () => {
    const rep = gyomuRepresentative(gyomuScans);
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) =>
      items.map((item) =>
        Number(item.lineTotal) === 1756
          ? { ...item, lineTotal: 1800, amountUserEdited: true }
          : item
      )
    );
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans);
    const reloaded = applyLogicalEditOverlay(gyomuScans, memberIds, userItemsJson);
    const view = buildHistoryPurchaseTruthView(reloaded);
    expect(view.storedCount).toBe(7);
    expect(
      view.visibleRows.filter((row) =>
        row.merchant_normalized?.includes('業務スーパー')
      )
    ).toHaveLength(1);
  });
});

describe('logical purchase edit partition gate', () => {
  const gyomuScans = buildGyomuSevenScanFixture();

  it('Costco reconciled group rejects identical overlay that would split partition', () => {
    const stored = costcoTimedFour();
    expect(buildHistoryPurchaseTruthView(stored).visibleRows).toHaveLength(1);
    const rep = buildHistoryPurchaseTruthView(stored).visibleRows[0]!;
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, stored);
    const userItemsJson = JSON.stringify(getReceiptItems(rep));
    const edited = applyLogicalEditOverlay(stored, memberIds, userItemsJson);
    expect(selectAnalyticsReceipts(edited).analyticsPurchaseCandidateCount).toBeGreaterThan(
      1
    );
    expect(() =>
      assertLogicalPurchaseEditPartition({
        storedReceipts: stored,
        memberReceiptIds: memberIds,
        user_items_json: userItemsJson,
      })
    ).toThrow(LogicalPurchaseEditPartitionError);
  });

  it('Gyomu quantity edit keeps exact PRE/POST member set', () => {
    const rep = gyomuRepresentative(gyomuScans);
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) =>
      items.map((item) =>
        Number(item.lineTotal) === 1756
          ? { ...item, quantity: 3, quantityUserEdited: true }
          : item
      )
    );
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans);
    const result = assertLogicalPurchaseEditPartition({
      storedReceipts: gyomuScans,
      memberReceiptIds: memberIds,
      user_items_json: userItemsJson,
    });
    expect(result.preMemberSet.sort()).toEqual([...GYOMU_SEVEN_RECEIPT_IDS].sort());
    expect(result.postMemberSet).toEqual(result.preMemberSet);
  });

  it('Gyomu line-amount edit keeps exact PRE/POST member set', () => {
    const rep = gyomuRepresentative(gyomuScans);
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) =>
      items.map((item, index) =>
        index === 0 ? { ...item, lineTotal: 380, amountUserEdited: true } : item
      )
    );
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans);
    const result = assertLogicalPurchaseEditPartition({
      storedReceipts: gyomuScans,
      memberReceiptIds: memberIds,
      user_items_json: userItemsJson,
    });
    expect(result.preMemberSet.sort()).toEqual([...GYOMU_SEVEN_RECEIPT_IDS].sort());
    expect(result.postMemberSet).toEqual(result.preMemberSet);
  });

  it('Gyomu category edit keeps exact PRE/POST member set', () => {
    const rep = gyomuRepresentative(gyomuScans);
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) =>
      items.map((item, index) =>
        index === 0 ? { ...item, category: 'snacks_drinks' } : item
      )
    );
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans);
    const result = assertLogicalPurchaseEditPartition({
      storedReceipts: gyomuScans,
      memberReceiptIds: memberIds,
      user_items_json: userItemsJson,
    });
    expect(result.postMemberSet).toEqual(result.preMemberSet);
  });

  it('singleton POST remains exactly [receiptId] and cannot merge with another purchase', () => {
    const soloA = makeReceipt({
      id: 'solo-a',
      at: Date.parse('2026-08-01T10:00:00+09:00'),
      createdAt: GYOMU_NOW_MS,
      merchantType: 'supermarket',
      merchantNormalized: '単独店A',
      transactionAt: Date.parse('2026-08-01T10:00:00+09:00'),
      total: 500,
      items: [{ name: '牛乳', category: 'food_ingredients', lineTotal: 500, quantity: 1 }],
    });
    const soloB = makeReceipt({
      id: 'solo-b',
      at: Date.parse('2026-08-01T18:00:00+09:00'),
      createdAt: GYOMU_NOW_MS + 1,
      merchantType: 'supermarket',
      merchantNormalized: '単独店B',
      transactionAt: Date.parse('2026-08-01T18:00:00+09:00'),
      total: 700,
      items: [{ name: 'パン', category: 'food_ingredients', lineTotal: 700, quantity: 1 }],
    });
    const stored = [soloA, soloB];
    const userItemsJson = JSON.stringify(getReceiptItems(soloA));
    const result = assertLogicalPurchaseEditPartition({
      storedReceipts: stored,
      memberReceiptIds: ['solo-a'],
      user_items_json: userItemsJson,
    });
    expect(result.preMemberSet).toEqual(['solo-a']);
    expect(result.postMemberSet).toEqual(['solo-a']);
    expect(deriveExactLogicalPurchaseMemberSet('solo-b', stored)).toEqual(['solo-b']);
  });

  it('rejects stale caller membership when group no longer matches', () => {
    const rep = gyomuRepresentative(gyomuScans);
    const userItemsJson = buildEditedGyomuUserItemsJson(gyomuScans, (items) => items);
    const staleIds = resolveHistoryPurchaseEditMemberIds(rep.id, gyomuScans).slice(0, 6);
    expect(() =>
      assertLogicalPurchaseEditPartition({
        storedReceipts: gyomuScans,
        memberReceiptIds: staleIds,
        user_items_json: userItemsJson,
      })
    ).toThrow(LogicalPurchaseEditPartitionError);
  });
});

describe('history purchase delete truth', () => {
  const gyomuScans = buildGyomuSevenScanFixture();

  it('A. fresh batch delete uses current production groups, not stale cached authority', () => {
    const stored = fourIdenticalAeonScans();
    const view = buildHistoryPurchaseTruthView(stored);
    const visibleId = view.visibleRows[0]!.id;
    const staleGroups = view.selection.highConfidenceDuplicateGroups.map((group) => ({
      ...group,
      receiptIds: group.receiptIds.slice(0, 2),
    }));
    const staleDeleteIds = expandHistoryPurchaseDeleteIds([visibleId], staleGroups);
    expect(staleDeleteIds).toHaveLength(2);

    const freshDeleteIds = resolveHistoryPurchaseDeleteIds([visibleId], stored);
    expect(freshDeleteIds.sort()).toEqual(stored.map((row) => row.id).sort());
  });

  it('B. batch delete fails closed when one selected purchase is missing', () => {
    const stored = fourIdenticalAeonScans();
    const visibleId = buildHistoryPurchaseTruthView(stored).visibleRows[0]!.id;
    expect(() =>
      resolveHistoryPurchaseDeleteIds([visibleId, 'missing-receipt'], stored)
    ).toThrow(HistoryPurchaseDeleteResolutionError);
  });

  it('C. hidden-member detail resolves to representative; singleton and missing behave correctly', () => {
    const view = buildHistoryPurchaseTruthView(gyomuScans);
    const rep = view.visibleRows[0]!.id;
    const hiddenId = [...view.selection.excludedDuplicateReceiptIds][0]!;

    expect(resolveHistoryPurchaseDetailReceiptId(rep, gyomuScans)).toBe(rep);
    expect(resolveHistoryPurchaseDetailReceiptId(hiddenId, gyomuScans)).toBe(rep);

    const singleton = makeReceipt({
      id: 'solo-detail',
      at: Date.parse('2026-08-01T12:00:00+09:00'),
      createdAt: GYOMU_NOW_MS,
      merchantType: 'supermarket',
      merchantNormalized: '単独店',
      transactionAt: Date.parse('2026-08-01T12:00:00+09:00'),
      total: 500,
      items: [{ name: '牛乳', category: 'food_ingredients', lineTotal: 500, quantity: 1 }],
    });
    expect(resolveHistoryPurchaseDetailReceiptId('solo-detail', [singleton])).toBe(
      'solo-detail'
    );
    expect(resolveHistoryPurchaseDetailReceiptId('missing-id', gyomuScans)).toBeNull();
  });

  it('D. >2000 display slice cannot authoritatively resolve beyond HISTORY_PURCHASE_TRUTH_LOAD_LIMIT', () => {
    const baseAt = Date.parse('2027-01-01T12:00:00+09:00');
    const fillers = Array.from({ length: HISTORY_PURCHASE_TRUTH_LOAD_LIMIT }, (_, index) =>
      makeReceipt({
        id: `filler-${index}`,
        at: baseAt + index * 60_000,
        createdAt: baseAt + index * 60_000,
        merchantType: 'supermarket',
        merchantNormalized: `Filler ${index}`,
        transactionAt: baseAt + index * 60_000,
        total: 100,
        items: [{ name: 'Item', category: 'other', lineTotal: 100, quantity: 1 }],
      })
    );
    const aeonGroup = fourIdenticalAeonScans().map((row) => ({
      ...row,
      transaction_at: Date.parse('2020-01-01T12:00:00+09:00'),
      created_at: Date.parse('2020-01-01T12:00:00+09:00') + Number(row.id.slice(-1)),
    }));
    const exhaustive = [...fillers, ...aeonGroup];
    const displaySlice = exhaustive
      .slice()
      .sort(
        (left, right) =>
          (right.transaction_at ?? right.created_at) -
          (left.transaction_at ?? left.created_at)
      )
      .slice(0, HISTORY_PURCHASE_TRUTH_LOAD_LIMIT);
    const visibleId = buildHistoryPurchaseTruthView(exhaustive).visibleRows.find((row) =>
      row.id.startsWith('aeon-scan-')
    )!.id;

    expect(displaySlice).toHaveLength(HISTORY_PURCHASE_TRUTH_LOAD_LIMIT);
    expect(() => resolveHistoryPurchaseDeleteIds([visibleId], displaySlice)).toThrow(
      HistoryPurchaseDeleteResolutionError
    );
    expect(resolveHistoryPurchaseDeleteIds([visibleId], exhaustive).sort()).toEqual(
      aeonGroup.map((row) => row.id).sort()
    );
  });

  it('E. >2000 hidden member detail needs exhaustive stored truth', () => {
    const baseAt = Date.parse('2027-01-01T12:00:00+09:00');
    const fillers = Array.from({ length: HISTORY_PURCHASE_TRUTH_LOAD_LIMIT }, (_, index) =>
      makeReceipt({
        id: `gyomu-filler-${index}`,
        at: baseAt + index * 60_000,
        createdAt: baseAt + index * 60_000,
        merchantType: 'supermarket',
        merchantNormalized: `Filler ${index}`,
        transactionAt: baseAt + index * 60_000,
        total: 100,
        items: [{ name: 'Item', category: 'other', lineTotal: 100, quantity: 1 }],
      })
    );
    const exhaustive = [...fillers, ...gyomuScans];
    const displaySlice = exhaustive
      .slice()
      .sort(
        (left, right) =>
          (right.transaction_at ?? right.created_at) -
          (left.transaction_at ?? left.created_at)
      )
      .slice(0, HISTORY_PURCHASE_TRUTH_LOAD_LIMIT);
    const view = buildHistoryPurchaseTruthView(exhaustive);
    const rep = view.visibleRows.find((row) =>
      row.merchant_normalized?.includes('業務スーパー')
    )!.id;
    const hiddenId = [...view.selection.excludedDuplicateReceiptIds][0]!;

    expect(resolveHistoryPurchaseDetailReceiptId(hiddenId, displaySlice)).toBeNull();
    expect(resolveHistoryPurchaseDetailReceiptId(hiddenId, exhaustive)).toBe(rep);
  });
});

describe('History screen wiring (purchase truth)', () => {
  it('History list uses purchase-truth consumer + fresh delete resolution', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/index.tsx'),
      'utf8'
    );
    expect(src).toContain('buildHistoryPurchaseTruthView');
    expect(src).toContain('resolveHistoryPurchaseDeleteIds');
    expect(src).toContain('listAllReceiptsForCurrentOwnerPurchaseTruth');
    expect(src).not.toContain('duplicateGroups');
    expect(src).toContain('projectHistorySearchToPurchaseTruth');
    expect(src).toContain('listReceipts');
    expect(src).toContain('HISTORY_PURCHASE_TRUTH_LOAD_LIMIT');
    expect(src).not.toMatch(/listReceiptsForList\(/);
  });

  it('Receipt Detail delete expands confirmed duplicate group', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/[id].tsx'),
      'utf8'
    );
    expect(src).toContain('resolveHistoryPurchaseDeleteIds');
    expect(src).toContain('resolveHistoryPurchaseDetailReceiptId');
    expect(src).toContain('listAllReceiptsForCurrentOwnerPurchaseTruth');
    expect(src).toContain('resolveHistoryPurchaseEditMemberIds');
    expect(src).toContain('updateLogicalPurchaseItemEdit');
    expect(src).toContain('LogicalPurchaseEditPartitionError');
    expect(src).toContain('savePartitionUnsafe');
    expect(src).toContain('deleteReceipts');
  });
});
