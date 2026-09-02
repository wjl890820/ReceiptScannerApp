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

const mockResolveCurrentLocalReceiptOwnerScope = jest.fn();

jest.mock('./receiptOwnershipScope', () => ({
  resolveCurrentLocalReceiptOwnerScope: (...args: unknown[]) =>
    mockResolveCurrentLocalReceiptOwnerScope(...args),
  composeReceiptListWhereClause: (scope: { receiptWhereSql: string }, search?: string) =>
    search ? `(${scope.receiptWhereSql}) AND (${search})` : scope.receiptWhereSql,
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
import {
  deleteReceipts,
  DeleteReceiptsOwnerScopeError,
  DeleteReceiptsOwnershipError,
  listAllReceiptsForCurrentOwnerPurchaseTruth,
  listReceipts,
  type ReceiptRow,
} from './db';
import { requestCloudBackupFlush } from './cloudBackupWorker';
import {
  buildHistoryPurchaseTruthView,
  HISTORY_PURCHASE_TRUTH_LOAD_LIMIT,
  HistoryPurchaseDeleteResolutionError,
  resolveHistoryPurchaseDeleteIds,
  resolveHistoryPurchaseDetailReceiptId,
} from './historyPurchaseTruth';
import { deleteReceiptItemIndex } from './receiptItemIndex';
import { replaceSyncOutboxIntent } from './syncOutbox';

type MutableReceiptRow = ReceiptRow & Record<string, unknown>;

const GYOMU_TX_AT = 1786351380000;
const GYOMU_NOW_MS = Date.parse('2026-09-01T12:00:00+09:00');
const DISPLAY_LIMIT = HISTORY_PURCHASE_TRUTH_LOAD_LIMIT;
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
    if (/FROM receipts/i.test(source) && /WHERE/i.test(source)) {
      const limit =
        /LIMIT \?/i.test(source) && values.length > 0
          ? Number(values[values.length - 1])
          : null;
      const ownerParam = values[0];
      let rows = [...this.rows.values()].filter((row) =>
        rowMatchesOwnerPredicate(row, source, [ownerParam])
      );
      rows = rows.sort(
        (left, right) =>
          (right.transaction_at ?? right.created_at) -
          (left.transaction_at ?? left.created_at)
      );
      if (limit != null && Number.isFinite(limit)) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => ({ ...row })) as T[];
    }
    return [];
  }

  async runAsync(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<{ changes: number }> {
    const values = bindValues(params);
    if (/DELETE FROM receipts WHERE id IN/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const ids = values.slice(0, values.length - 1).map(String);
      let changes = 0;
      for (const id of ids) {
        const row = this.rows.get(id);
        if (row && rowMatchesOwnerPredicate(row, source, [ownerParam])) {
          this.rows.delete(id);
          changes += 1;
        }
      }
      return { changes };
    }
    return { changes: 0 };
  }
}

const mockDatabase = new MemoryReceiptDb() as MemoryReceiptDb & SQLite.SQLiteDatabase;
const mockDeleteIndex = deleteReceiptItemIndex as jest.MockedFunction<
  typeof deleteReceiptItemIndex
>;

function setUserScope(userId: string): void {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
    status: 'ready',
    ownerKey: `user:${userId}`,
    receiptWhereSql: 'receipts.user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: [userId],
  });
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

function makeReceipt(args: {
  id: string;
  at: number;
  merchantType: string;
  items: Array<{
    name: string;
    category: string;
    lineTotal: number;
    quantity: number;
  }>;
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

function seedReceiptRow(row: ReceiptRow): void {
  mockDatabase.rows.set(row.id, {
    ...row,
    user_id: 'user-1',
    installation_id: 'install-test',
  });
}

function seedFillerReceipts(count: number, baseAt: number): ReceiptRow[] {
  return Array.from({ length: count }, (_, index) =>
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
}

function fourIdenticalAeonScansOld(): ReceiptRow[] {
  const oldTx = Date.parse('2020-01-01T12:00:00+09:00');
  const items = [
    { name: '卵', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
    { name: '牛乳', category: 'food_ingredients', lineTotal: 3918, quantity: 1 },
  ];
  return [0, 1, 2, 3].map((i) =>
    makeReceipt({
      id: `aeon-scan-${i}`,
      at: oldTx,
      createdAt: oldTx + i * 1000,
      merchantType: 'supermarket',
      merchantNormalized: 'イオン古川店',
      transactionAt: oldTx,
      total: 4118,
      items,
    })
  );
}

describe('history purchase delete integration', () => {
  beforeEach(() => {
    mockDatabase.reset();
    outboxIntents.length = 0;
    jest.clearAllMocks();
    setUserScope('user-1');
  });

  it('D/E. Gyomu logical purchase delete removes all siblings and does not resurrect after reload', async () => {
    const fixture = buildGyomuSevenScanFixture();
    for (const row of fixture) seedReceiptRow(row);

    const beforeView = buildHistoryPurchaseTruthView(fixture);
    expect(beforeView.visibleRows).toHaveLength(1);
    const visibleId = beforeView.visibleRows[0]!.id;

    const storedBeforeDelete = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    const deleteIds = resolveHistoryPurchaseDeleteIds([visibleId], storedBeforeDelete);
    expect(deleteIds.sort()).toEqual([...GYOMU_SEVEN_RECEIPT_IDS].sort());

    await deleteReceipts(deleteIds);

    const reloaded = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    expect(reloaded).toHaveLength(0);
    const reloadedView = buildHistoryPurchaseTruthView(reloaded);
    expect(reloadedView.visibleRows).toHaveLength(0);
    expect(selectAnalyticsReceipts(reloaded).analyticsPurchaseCandidateCount).toBe(0);
    for (const id of GYOMU_SEVEN_RECEIPT_IDS) {
      expect(mockDatabase.rows.has(id)).toBe(false);
    }
  });

  it('F. authenticated logical purchase delete enqueues one tombstone per member', async () => {
    const fixture = buildGyomuSevenScanFixture();
    for (const row of fixture) seedReceiptRow(row);
    const visibleId = buildHistoryPurchaseTruthView(fixture).visibleRows[0]!.id;
    const stored = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    const deleteIds = resolveHistoryPurchaseDeleteIds([visibleId], stored);

    await deleteReceipts(deleteIds);

    expect(outboxIntents).toHaveLength(7);
    expect(outboxIntents.map((intent) => intent.receiptId).sort()).toEqual(
      [...GYOMU_SEVEN_RECEIPT_IDS].sort()
    );
    expect(outboxIntents.every((intent) => intent.operation === 'delete')).toBe(true);
    expect(replaceSyncOutboxIntent).toHaveBeenCalledTimes(7);
    expect(mockDeleteIndex).toHaveBeenCalledTimes(7);
    expect(requestCloudBackupFlush).toHaveBeenCalledTimes(1);
  });

  it('B. batch delete resolution fails before any DB mutation when one target is missing', async () => {
    const fixture = buildGyomuSevenScanFixture();
    for (const row of fixture) seedReceiptRow(row);
    const visibleId = buildHistoryPurchaseTruthView(fixture).visibleRows[0]!.id;
    const stored = await listAllReceiptsForCurrentOwnerPurchaseTruth();

    expect(() =>
      resolveHistoryPurchaseDeleteIds([visibleId, 'missing-receipt'], stored)
    ).toThrow(HistoryPurchaseDeleteResolutionError);

    expect(mockDatabase.rows.size).toBe(7);
    expect(outboxIntents).toHaveLength(0);
    expect(mockDeleteIndex).not.toHaveBeenCalled();
    expect(requestCloudBackupFlush).not.toHaveBeenCalled();
  });

  it('G. owner scope unavailable fails explicitly with zero mutation', async () => {
    seedReceiptRow(
      makeReceipt({
        id: 'solo-delete',
        at: GYOMU_NOW_MS,
        createdAt: GYOMU_NOW_MS,
        merchantType: 'supermarket',
        merchantNormalized: '単独店',
        transactionAt: GYOMU_NOW_MS,
        total: 500,
        items: [{ name: '牛乳', category: 'food_ingredients', lineTotal: 500, quantity: 1 }],
      })
    );
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
      status: 'owner_unavailable',
    });

    await expect(deleteReceipts(['solo-delete'])).rejects.toBeInstanceOf(
      DeleteReceiptsOwnerScopeError
    );
    expect(mockDatabase.rows.has('solo-delete')).toBe(true);
    expect(outboxIntents).toHaveLength(0);
    expect(mockDeleteIndex).not.toHaveBeenCalled();
    expect(requestCloudBackupFlush).not.toHaveBeenCalled();
  });

  it('H. singleton purchase deletes normally', async () => {
    seedReceiptRow(
      makeReceipt({
        id: 'solo-delete',
        at: GYOMU_NOW_MS,
        createdAt: GYOMU_NOW_MS,
        merchantType: 'supermarket',
        merchantNormalized: '単独店',
        transactionAt: GYOMU_NOW_MS,
        total: 500,
        items: [{ name: '牛乳', category: 'food_ingredients', lineTotal: 500, quantity: 1 }],
      })
    );
    const stored = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    const deleteIds = resolveHistoryPurchaseDeleteIds(['solo-delete'], stored);
    expect(deleteIds).toEqual(['solo-delete']);

    await deleteReceipts(deleteIds);

    expect(mockDatabase.rows.has('solo-delete')).toBe(false);
    expect(await listReceipts(2000)).toHaveLength(0);
    expect(outboxIntents).toHaveLength(1);
    expect(mockDeleteIndex).toHaveBeenCalledTimes(1);
  });

  it('A. >2000 boundary uses exhaustive reader for full HC delete expansion', async () => {
    const baseAt = Date.parse('2026-08-01T12:00:00+09:00');
    const fillers = seedFillerReceipts(DISPLAY_LIMIT, baseAt);
    const aeonGroup = fourIdenticalAeonScansOld();
    for (const row of [...fillers, ...aeonGroup]) seedReceiptRow(row);

    const displayLimited = await listReceipts(DISPLAY_LIMIT);
    expect(displayLimited).toHaveLength(DISPLAY_LIMIT);
    expect(displayLimited.some((row) => row.id.startsWith('aeon-scan-'))).toBe(
      false
    );

    const exhaustive = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    expect(exhaustive.length).toBe(DISPLAY_LIMIT + aeonGroup.length);

    const visibleId = buildHistoryPurchaseTruthView(exhaustive).visibleRows.find(
      (row) => row.id.startsWith('aeon-scan-')
    )!.id;

    expect(() =>
      resolveHistoryPurchaseDeleteIds([visibleId], displayLimited)
    ).toThrow(HistoryPurchaseDeleteResolutionError);

    const deleteIds = resolveHistoryPurchaseDeleteIds([visibleId], exhaustive);
    expect(deleteIds.sort()).toEqual(aeonGroup.map((row) => row.id).sort());
  });

  it('B-detail. >2000 boundary resolves hidden member to representative exhaustively', async () => {
    const baseAt = Date.parse('2027-01-01T12:00:00+09:00');
    const fillers = seedFillerReceipts(DISPLAY_LIMIT, baseAt);
    const gyomu = buildGyomuSevenScanFixture();
    for (const row of [...fillers, ...gyomu]) seedReceiptRow(row);

    const displayLimited = await listReceipts(DISPLAY_LIMIT);
    const exhaustive = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    const view = buildHistoryPurchaseTruthView(exhaustive);
    const rep = view.visibleRows.find((row) =>
      row.merchant_normalized?.includes('業務スーパー')
    )!.id;
    const hiddenId = [...view.selection.excludedDuplicateReceiptIds][0]!;

    expect(displayLimited.some((row) => row.id === hiddenId)).toBe(false);
    expect(resolveHistoryPurchaseDetailReceiptId(hiddenId, displayLimited)).toBeNull();
    expect(resolveHistoryPurchaseDetailReceiptId(hiddenId, exhaustive)).toBe(rep);
  });

  it('C. mixed requested ownership fails with zero mutation', async () => {
    seedReceiptRow(
      makeReceipt({
        id: 'owned-a',
        at: GYOMU_NOW_MS,
        createdAt: GYOMU_NOW_MS,
        merchantType: 'supermarket',
        merchantNormalized: 'Owned',
        transactionAt: GYOMU_NOW_MS,
        total: 500,
        items: [{ name: '牛乳', category: 'food_ingredients', lineTotal: 500, quantity: 1 }],
      })
    );
    mockDatabase.rows.set('foreign-b', {
      ...makeReceipt({
        id: 'foreign-b',
        at: GYOMU_NOW_MS,
        createdAt: GYOMU_NOW_MS,
        merchantType: 'supermarket',
        merchantNormalized: 'Foreign',
        transactionAt: GYOMU_NOW_MS,
        total: 500,
        items: [{ name: 'パン', category: 'food_ingredients', lineTotal: 500, quantity: 1 }],
      }),
      user_id: 'user-foreign',
      installation_id: 'install-test',
    });

    await expect(deleteReceipts(['owned-a', 'foreign-b'])).rejects.toBeInstanceOf(
      DeleteReceiptsOwnershipError
    );
    expect(mockDatabase.rows.has('owned-a')).toBe(true);
    expect(mockDatabase.rows.has('foreign-b')).toBe(true);
    expect(outboxIntents).toHaveLength(0);
    expect(mockDeleteIndex).not.toHaveBeenCalled();
    expect(requestCloudBackupFlush).not.toHaveBeenCalled();
  });

  it('D. missing requested row at transaction time rolls back with zero effects', async () => {
    const fixture = buildGyomuSevenScanFixture();
    for (const row of fixture) seedReceiptRow(row);
    const exhaustive = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    const visibleId = buildHistoryPurchaseTruthView(exhaustive).visibleRows[0]!.id;
    const deleteIds = resolveHistoryPurchaseDeleteIds([visibleId], exhaustive);
    const missingId = deleteIds[0]!;
    mockDatabase.rows.delete(missingId);

    await expect(deleteReceipts(deleteIds)).rejects.toBeInstanceOf(
      DeleteReceiptsOwnershipError
    );
    expect(mockDatabase.rows.size).toBe(deleteIds.length - 1);
    expect(outboxIntents).toHaveLength(0);
    expect(mockDeleteIndex).not.toHaveBeenCalled();
    expect(requestCloudBackupFlush).not.toHaveBeenCalled();
  });

  it('E. TOCTOU: member disappearance between UI resolution and DB delete fails atomically', async () => {
    const fixture = buildGyomuSevenScanFixture();
    for (const row of fixture) seedReceiptRow(row);
    const exhaustive = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    const visibleId = buildHistoryPurchaseTruthView(exhaustive).visibleRows[0]!.id;
    const deleteIds = resolveHistoryPurchaseDeleteIds([visibleId], exhaustive);
    const vanishedId = deleteIds[1]!;
    mockDatabase.rows.delete(vanishedId);

    await expect(deleteReceipts(deleteIds)).rejects.toBeInstanceOf(
      DeleteReceiptsOwnershipError
    );
    for (const id of deleteIds) {
      if (id !== vanishedId) {
        expect(mockDatabase.rows.has(id)).toBe(true);
      }
    }
    expect(outboxIntents).toHaveLength(0);
    expect(mockDeleteIndex).not.toHaveBeenCalled();
  });

  it('empty deleteReceipts input remains a safe no-op', async () => {
    await expect(deleteReceipts([])).resolves.toBeUndefined();
    expect(outboxIntents).toHaveLength(0);
    expect(mockDeleteIndex).not.toHaveBeenCalled();
    expect(requestCloudBackupFlush).not.toHaveBeenCalled();
  });
});
