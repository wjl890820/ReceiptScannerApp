import type * as SQLite from 'expo-sqlite';

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

const outboxIntents: Array<{ receiptId: string; operation: string; userId: string }> =
  [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('nanoid/non-secure', () => ({
  nanoid: jest.fn(() => 'generated-id'),
}));

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
}));

jest.mock('./receiptOwnershipContext', () => ({
  TRANSACTION_SOURCE_RECEIPT_OCR: 'receipt_ocr',
  resolveOwnershipStamp: jest.fn(async () => ({
    userId: 'user-1',
    installationId: 'install-test',
    transactionSource: 'receipt_ocr',
  })),
  __setOwnershipStampProviderForTests: jest.fn(),
}));

jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(async () => ({
    ran: false,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  })),
}));

jest.mock('./syncOutbox', () => ({
  ensureSyncOutboxSchema: jest.fn(async () => undefined),
  generateSyncIntentId: jest.fn(() => 'intent-test'),
  replaceSyncOutboxIntent: jest.fn(
    async (
      _txn: unknown,
      intent: { receiptId: string; userId: string; operation: string }
    ) => {
      outboxIntents.push({
        receiptId: intent.receiptId,
        operation: intent.operation,
        userId: intent.userId,
      });
    }
  ),
}));

jest.mock('./receiptItemIndex', () => {
  const actual = jest.requireActual('./receiptItemIndex');
  return {
    ...actual,
    ensureReceiptItemsSchema: jest.fn(async () => undefined),
    rebuildReceiptItemIndex: jest.fn(),
    deleteReceiptItemIndex: jest.fn(),
    clearReceiptItemIndex: jest.fn(),
  };
});

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { updateLogicalPurchaseItemEdit, type ReceiptRow } from './db';
import { requestCloudBackupFlush } from './cloudBackupWorker';
import {
  buildHistoryPurchaseTruthView,
  resolveHistoryPurchaseEditMemberIds,
} from './historyPurchaseTruth';
import { LogicalPurchaseEditPartitionError } from './logicalPurchaseEditPartition';
import { getReceiptItems } from './receiptItems';
import { rebuildReceiptItemIndex } from './receiptItemIndex';
import { replaceSyncOutboxIntent } from './syncOutbox';

type MutableReceiptRow = ReceiptRow & Record<string, unknown>;

type FixtureItem = {
  name: string;
  category: string;
  lineTotal: number;
  quantity: number;
};

const costcoTx = Date.parse('2023-07-06T11:44:46+09:00');
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

function bindValues(params: SQLite.SQLiteBindParams | undefined): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

function rowMatchesOwnerPredicate(
  row: MutableReceiptRow,
  sql: string,
  params: SQLite.SQLiteBindValue[]
): boolean {
  if (/receipts\.user_id = \?/i.test(sql) && !/IS NULL/i.test(sql)) {
    return row.user_id === params[0];
  }
  if (/receipts\.user_id IS NULL AND receipts\.installation_id = \?/i.test(sql)) {
    return (
      (row.user_id == null || row.user_id === '') &&
      row.installation_id === params[0]
    );
  }
  return true;
}

class MemoryReceiptDb {
  readonly rows = new Map<string, MutableReceiptRow>();

  reset(): void {
    this.rows.clear();
  }

  async execAsync(_source: string): Promise<void> {}

  async closeAsync(): Promise<void> {}

  async withExclusiveTransactionAsync(
    task: (txn: MemoryReceiptDb) => Promise<void>
  ): Promise<void> {
    const rowsSnapshot = new Map(
      [...this.rows.entries()].map(([id, row]) => [id, { ...row }])
    );
    const outboxSnapshot = [...outboxIntents];
    try {
      await task(this);
    } catch (error) {
      this.rows.clear();
      for (const [id, row] of rowsSnapshot) {
        this.rows.set(id, { ...row });
      }
      outboxIntents.length = 0;
      outboxIntents.push(...outboxSnapshot);
      throw error;
    }
  }

  async getAllAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    const values = bindValues(params);
    if (/SELECT id, user_id FROM receipts WHERE id IN/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const ids = values.slice(0, values.length - 1).map(String);
      return [...this.rows.values()]
        .filter(
          (row) =>
            ids.includes(String(row.id)) &&
            rowMatchesOwnerPredicate(row, source, [ownerParam])
        )
        .map((row) => ({
          id: row.id,
          user_id: (row as { user_id?: string | null }).user_id ?? null,
        })) as T[];
    }
    if (
      /FROM receipts/i.test(source) &&
      /analysis_json/i.test(source) &&
      !/WHERE id IN/i.test(source)
    ) {
      return [...this.rows.values()]
        .filter((row) => rowMatchesOwnerPredicate(row, source, values))
        .map((row) => projectStoredReceiptRow(row)) as T[];
    }
    return [];
  }

  async getFirstAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T | null> {
    if (/SELECT user_id FROM receipts/i.test(source)) {
      const [id, ownerParam] = bindValues(params);
      const row = this.rows.get(String(id));
      if (!row) return null;
      return (
        rowMatchesOwnerPredicate(row, source, [ownerParam])
          ? { user_id: (row as { user_id?: string | null }).user_id ?? null }
          : null
      ) as T | null;
    }
    if (/SELECT id, analysis_json, user_items_json/i.test(source)) {
      const [id, ownerParam] = bindValues(params);
      const row = this.rows.get(String(id));
      if (!row) return null;
      return (
        rowMatchesOwnerPredicate(row, source, [ownerParam])
          ? {
              id: row.id,
              analysis_json: row.analysis_json,
              user_items_json: row.user_items_json,
            }
          : null
      ) as T | null;
    }
    return null;
  }

  async runAsync(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<{ changes: number }> {
    const values = bindValues(params);
    if (/UPDATE receipts/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const id = String(values[values.length - 2]);
      const row = this.rows.get(id);
      if (!row || !rowMatchesOwnerPredicate(row, source, [ownerParam])) {
        return { changes: 0 };
      }
      row.user_edited = 1;
      row.user_items_json = String(values[0]);
      row.client_updated_at = Number(values[1]);
      return { changes: 1 };
    }
    return { changes: 0 };
  }
}

const mockDatabase = new MemoryReceiptDb() as MemoryReceiptDb & SQLite.SQLiteDatabase;
const mockRebuild = rebuildReceiptItemIndex as jest.MockedFunction<
  typeof rebuildReceiptItemIndex
>;

function projectStoredReceiptRow(row: MutableReceiptRow): ReceiptRow {
  return {
    id: String(row.id),
    created_at: Number(row.created_at),
    transaction_at: row.transaction_at == null ? null : Number(row.transaction_at),
    image_uri: String(row.image_uri ?? ''),
    merchant_raw: row.merchant_raw == null ? null : String(row.merchant_raw),
    merchant_normalized:
      row.merchant_normalized == null ? null : String(row.merchant_normalized),
    merchant_type: row.merchant_type as ReceiptRow['merchant_type'],
    total: Number(row.total),
    tax: Number(row.tax),
    tax_is_known: Number(row.tax_is_known ?? 0),
    currency: String(row.currency ?? 'JPY'),
    analysis_json: String(row.analysis_json),
    user_edited: Number(row.user_edited ?? 0),
    final_total: row.final_total == null ? null : Number(row.final_total),
    final_category:
      row.final_category == null ? null : String(row.final_category),
    note: row.note == null ? null : String(row.note),
    user_items_json:
      row.user_items_json == null ? null : String(row.user_items_json),
  };
}

function reloadStoredReceiptRows(): ReceiptRow[] {
  return [...mockDatabase.rows.values()].map((row) => projectStoredReceiptRow(row));
}

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

function seedReceiptRow(row: ReceiptRow): void {
  mockDatabase.rows.set(row.id, {
    ...row,
    user_id: 'user-1',
    installation_id: 'install-test',
  });
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

describe('updateLogicalPurchaseItemEdit partition integration', () => {
  beforeEach(() => {
    mockDatabase.reset();
    outboxIntents.length = 0;
    jest.clearAllMocks();
  });

  it('persists Gyomu quantity edit across all members with unchanged partition', async () => {
    const fixture = buildGyomuSevenScanFixture();
    const beforeSnapshot = new Map(
      fixture.map((row) => [
        row.id,
        {
          analysis_json: row.analysis_json,
          user_items_json: row.user_items_json,
          user_edited: row.user_edited,
        },
      ])
    );
    for (const row of fixture) seedReceiptRow(row);

    const rep = gyomuRepresentative(fixture);
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, fixture);
    const editedItems = getReceiptItems(rep).map((item) => {
      const row = item as Record<string, unknown>;
      return Number(row.lineTotal) === 1756
        ? { ...row, quantity: 3, quantityUserEdited: true }
        : row;
    });
    const userItemsJson = JSON.stringify(editedItems);

    const result = await updateLogicalPurchaseItemEdit({
      memberReceiptIds: memberIds,
      user_items_json: userItemsJson,
    });
    expect(result.updatedReceiptIds.sort()).toEqual(
      [...GYOMU_SEVEN_RECEIPT_IDS].sort()
    );

    const reloaded = reloadStoredReceiptRows();
    const view = buildHistoryPurchaseTruthView(reloaded);
    expect(view.selection.analyticsPurchaseCandidateCount).toBe(1);
    expect(
      view.visibleRows.filter((row) =>
        row.merchant_normalized?.includes('業務スーパー')
      )
    ).toHaveLength(1);
    expect(resolveHistoryPurchaseEditMemberIds(rep.id, reloaded).sort()).toEqual(
      [...GYOMU_SEVEN_RECEIPT_IDS].sort()
    );

    for (const id of GYOMU_SEVEN_RECEIPT_IDS) {
      const row = mockDatabase.rows.get(id)!;
      expect(row.analysis_json).toBe(beforeSnapshot.get(id)!.analysis_json);
      expect(row.user_items_json).toBe(userItemsJson);
      expect(row.user_edited).toBe(1);
    }

    expect(outboxIntents).toHaveLength(7);
    expect(replaceSyncOutboxIntent).toHaveBeenCalledTimes(7);
    expect(mockRebuild).toHaveBeenCalledTimes(7);
    expect(requestCloudBackupFlush).toHaveBeenCalledTimes(1);
  });

  it('rejects Costco reconciled edit with zero DB/outbox/index/flush effects', async () => {
    const fixture = costcoTimedFour();
    const beforeSnapshot = new Map(
      fixture.map((row) => [
        row.id,
        {
          analysis_json: row.analysis_json,
          user_items_json: row.user_items_json,
          user_edited: row.user_edited,
        },
      ])
    );
    for (const row of fixture) seedReceiptRow(row);

    const rep = buildHistoryPurchaseTruthView(fixture).visibleRows[0]!;
    const memberIds = resolveHistoryPurchaseEditMemberIds(rep.id, fixture);
    const userItemsJson = JSON.stringify(getReceiptItems(rep));

    await expect(
      updateLogicalPurchaseItemEdit({
        memberReceiptIds: memberIds,
        user_items_json: userItemsJson,
      })
    ).rejects.toBeInstanceOf(LogicalPurchaseEditPartitionError);

    for (const row of fixture) {
      const stored = mockDatabase.rows.get(row.id)!;
      expect(stored.analysis_json).toBe(beforeSnapshot.get(row.id)!.analysis_json);
      expect(stored.user_items_json).toBe(beforeSnapshot.get(row.id)!.user_items_json);
      expect(stored.user_edited).toBe(beforeSnapshot.get(row.id)!.user_edited);
    }

    const reloaded = reloadStoredReceiptRows();
    expect(buildHistoryPurchaseTruthView(reloaded).visibleRows).toHaveLength(1);
    expect(selectAnalyticsReceipts(reloaded).analyticsPurchaseCandidateCount).toBe(1);
    expect(outboxIntents).toHaveLength(0);
    expect(replaceSyncOutboxIntent).not.toHaveBeenCalled();
    expect(mockRebuild).not.toHaveBeenCalled();
    expect(requestCloudBackupFlush).not.toHaveBeenCalled();
  });
});
