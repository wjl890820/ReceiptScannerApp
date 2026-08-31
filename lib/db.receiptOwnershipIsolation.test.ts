import type * as SQLite from 'expo-sqlite';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('nanoid/non-secure', () => {
  let nextId = 1;
  return {
    nanoid: jest.fn(() => `receipt-${nextId++}`),
  };
});

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
}));

jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({ status: 'unauthenticated', userId: null })),
  subscribeAuthState: jest.fn(() => () => undefined),
  ensureAnonAuth: jest.fn(async () => undefined),
}));

jest.mock('./installationId', () => ({
  getOrCreateInstallationId: jest.fn(async () => 'install-test'),
}));

jest.mock('./receiptOwnershipContext', () => ({
  resolveOwnershipStamp: jest.fn(),
  TRANSACTION_SOURCE_RECEIPT_OCR: 'receipt_ocr',
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

import {
  __setDbMutationTestHooksForTests,
  deleteReceipts,
  getReceipt,
  listReceipts,
  listReceiptsForAnalysis,
  updateReceipt,
  type ReceiptRow,
} from './db';
import { deleteReceiptItemIndex } from './receiptItemIndex';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  buildTransientScanReviewReceipt,
  evaluateScanReviewDuplicateGate,
  loadScanReviewDuplicateGateContext,
} from './scanReviewDuplicateGate';
import {
  makeYorkCollisionReceiptA,
  makeYorkCollisionReceiptC,
} from './receiptExactTransactionCollision.testFixtures';

type MutableReceiptRow = ReceiptRow & Record<string, unknown>;

const RECEIPT_COLUMNS = [
  'id',
  'created_at',
  'transaction_at',
  'scanned_at',
  'image_uri',
  'source',
  'merchant_raw',
  'merchant_normalized',
  'merchant_type',
  'store_raw',
  'store_normalized',
  'total',
  'tax',
  'tax_is_known',
  'currency',
  'analysis_json',
  'recognition_snapshot_json',
  'user_edited',
  'final_total',
  'final_category',
  'note',
  'user_items_json',
  'user_id',
  'installation_id',
  'transaction_source',
  'ocr_request_id',
  'client_updated_at',
  'merchant_hint',
  'confidence',
  'category_id',
  'updated_at',
  'source_type',
] as const;

function bindValues(params: SQLite.SQLiteBindParams | undefined): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

function rowMatchesOwnerPredicate(
  row: MutableReceiptRow,
  sql: string,
  params: SQLite.SQLiteBindValue[]
): boolean {
  if (/receipts\.user_id = \?/i.test(sql)) {
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

class OwnerAwareReceiptDb {
  readonly rows = new Map<string, MutableReceiptRow>();
  readonly syncOutbox: Array<{ receiptId: string; userId: string; operation: string }> =
    [];

  reset(): void {
    this.rows.clear();
    this.syncOutbox.length = 0;
  }

  seed(row: Partial<MutableReceiptRow> & { id: string }): void {
    this.rows.set(row.id, {
      created_at: 1_700_000_000_000,
      transaction_at: 1_700_000_000_000,
      image_uri: 'file://x',
      merchant_raw: 'Store',
      merchant_normalized: 'store',
      merchant_type: 'convenience',
      total: 100,
      tax: 0,
      tax_is_known: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({ items: [] }),
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
      user_id: null,
      installation_id: null,
      ...row,
      id: row.id,
    });
  }

  async execAsync(_source: string): Promise<void> {}

  async closeAsync(): Promise<void> {}

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    await task();
  }

  withExclusiveTransactionAsync = jest.fn(
    async (task: (txn: OwnerAwareReceiptDb) => Promise<void>) => {
      const rowsSnapshot = new Map(
        [...this.rows.entries()].map(([id, row]) => [id, { ...row }])
      );
      const outboxSnapshot = [...this.syncOutbox];
      try {
        await task(this);
      } catch (error) {
        this.rows.clear();
        for (const [id, row] of rowsSnapshot) {
          this.rows.set(id, { ...row });
        }
        this.syncOutbox.length = 0;
        this.syncOutbox.push(...outboxSnapshot);
        throw error;
      }
    }
  );

  async getAllAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    const values = bindValues(params);
    if (/PRAGMA table_info/i.test(source)) {
      return RECEIPT_COLUMNS.map((name) => ({ name, type: 'TEXT' })) as T[];
    }
    if (/FROM receipts/i.test(source) && /WHERE/i.test(source)) {
      const limit =
        /LIMIT \?/i.test(source) && values.length > 0
          ? Number(values[values.length - 1])
          : null;
      let rows = [...this.rows.values()].filter((row) => {
        if (/WHERE id IN/i.test(source)) {
          const idParams = values.slice(0, values.length - (source.includes('AND receipts.user_id') ? 1 : source.includes('AND receipts.installation_id') ? 1 : 0));
          // mixed: ids then owner param at end
          const ownerParamIndex = source.match(/AND receipts\.user_id = \?/i)
            ? values.length - 1
            : source.match(/AND receipts\.installation_id = \?/i)
              ? values.length - 1
              : -1;
          const ids =
            ownerParamIndex >= 0
              ? values.slice(0, ownerParamIndex).map(String)
              : values.map(String);
          const ownerValues =
            ownerParamIndex >= 0 ? [values[ownerParamIndex]] : [];
          return (
            ids.includes(String(row.id)) &&
            rowMatchesOwnerPredicate(row, source, ownerValues)
          );
        }
        if (/WHERE \(receipts\.user_id = \?\)/i.test(source) || /WHERE receipts\.user_id = \?/i.test(source)) {
          return rowMatchesOwnerPredicate(row, source, [values[0]]);
        }
        if (/installation_id = \?/i.test(source)) {
          return rowMatchesOwnerPredicate(row, source, [values[0]]);
        }
        return true;
      });
      rows = rows.sort(
        (left, right) =>
          (right.transaction_at ?? right.created_at) -
          (left.transaction_at ?? left.created_at)
      );
      if (limit != null && Number.isFinite(limit)) {
        rows = rows.slice(0, limit);
      }
      const selectsTransactionSource = /\btransaction_source\b/i.test(
        source.slice(0, source.search(/\bFROM\s+receipts\b/i))
      );
      return rows.map((row) => {
        const projected = { ...row };
        if (!selectsTransactionSource) {
          delete projected.transaction_source;
        }
        return projected;
      }) as T[];
    }
    if (/SELECT id, user_id FROM receipts WHERE id IN/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const ids = values.slice(0, values.length - 1).map(String);
      return [...this.rows.values()]
        .filter(
          (row) =>
            ids.includes(String(row.id)) &&
            rowMatchesOwnerPredicate(row, source, [ownerParam])
        )
        .map((row) => ({ id: row.id, user_id: row.user_id ?? null })) as T[];
    }
    return [];
  }

  async getFirstAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T | null> {
    const values = bindValues(params);
    if (/SELECT id FROM receipts WHERE id = \?/i.test(source)) {
      const [id, ownerParam] = values;
      const row = this.rows.get(String(id));
      if (!row) return null;
      return (
        rowMatchesOwnerPredicate(row, source, [ownerParam]) ? { id: row.id } : null
      ) as T | null;
    }
    if (/FROM receipts/i.test(source)) {
      const [id, ownerParam] = values;
      const row = this.rows.get(String(id));
      if (!row) return null;
      return (
        rowMatchesOwnerPredicate(row, source, [ownerParam]) ? { ...row } : null
      ) as T | null;
    }
    if (/SELECT user_id FROM receipts/i.test(source)) {
      const [id, ownerParam] = values;
      const row = this.rows.get(String(id));
      if (!row) return null;
      return (
        rowMatchesOwnerPredicate(row, source, [ownerParam])
          ? { user_id: row.user_id ?? null }
          : null
      ) as T | null;
    }
    if (/SELECT merchant_raw/i.test(source)) {
      const [id] = values;
      const row = this.rows.get(String(id));
      return (row
        ? {
            merchant_raw: row.merchant_raw,
            merchant_normalized: row.merchant_normalized,
            merchant_type: row.merchant_type,
          }
        : null) as T | null;
    }
    return null;
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
    if (/UPDATE receipts/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const id = String(values[values.length - 2]);
      const row = this.rows.get(id);
      if (!row || !rowMatchesOwnerPredicate(row, source, [ownerParam])) {
        return { changes: 0 };
      }
      const setClause =
        source.match(/SET\s+([\s\S]*?)\s+WHERE\s+id\s*=\s*\?/i)?.[1] ?? '';
      let valueIndex = 0;
      for (const assignment of setClause.split(',')) {
        const bindMatch = assignment.trim().match(/^(\w+)\s*=\s*\?$/);
        if (bindMatch) {
          row[bindMatch[1]] = values[valueIndex++];
        }
      }
      return { changes: 1 };
    }
    if (/INSERT OR REPLACE INTO sync_outbox/i.test(source)) {
      this.syncOutbox.push({
        receiptId: String(values[0]),
        userId: String(values[1]),
        operation: String(values[2]),
      });
      return { changes: 1 };
    }
    return { changes: 0 };
  }
}

const mockDatabase = new OwnerAwareReceiptDb() as OwnerAwareReceiptDb &
  SQLite.SQLiteDatabase;
const mockDeleteIndex = deleteReceiptItemIndex as jest.MockedFunction<
  typeof deleteReceiptItemIndex
>;

function setUserScope(userId: string) {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
    status: 'ready',
    ownerKey: `user:${userId}`,
    receiptWhereSql: 'receipts.user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: [userId],
  });
}

function setInstallationScope(installationId: string) {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
    status: 'ready',
    ownerKey: `installation:${installationId}`,
    receiptWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
    itemWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
    params: [installationId],
  });
}

describe('db receipt ownership isolation (Privacy-H2)', () => {
  beforeEach(() => {
    mockDatabase.reset();
    jest.clearAllMocks();
    __setDbMutationTestHooksForTests(null);
    setUserScope('user-a');
  });

  afterEach(() => {
    __setDbMutationTestHooksForTests(null);
  });

  it('listReceipts returns only current user rows', async () => {
    mockDatabase.seed({ id: 'a', user_id: 'user-a', merchant_raw: 'A Store' });
    mockDatabase.seed({ id: 'b', user_id: 'user-b', merchant_raw: 'B Store' });
    mockDatabase.seed({ id: 'null', user_id: null, installation_id: null });

    const rows = await listReceipts();
    expect(rows.map((row) => row.id)).toEqual(['a']);
  });

  it('listReceiptsForAnalysis returns only current user rows', async () => {
    mockDatabase.seed({ id: 'a', user_id: 'user-a' });
    mockDatabase.seed({ id: 'b', user_id: 'user-b' });

    const rows = await listReceiptsForAnalysis();
    expect(rows.map((row) => row.id)).toEqual(['a']);
  });

  it('preserves persisted transaction_source through the production Analysis accessor', async () => {
    mockDatabase.seed({
      id: 'source-receipt',
      user_id: 'user-a',
      transaction_source: 'receipt_ocr',
    });

    const rows = await listReceiptsForAnalysis();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transaction_source).toBe('receipt_ocr');
  });

  it('lets the Scan Review gate collide with a production-loaded York receipt', async () => {
    mockDatabase.seed({
      ...makeYorkCollisionReceiptA(),
      user_id: 'user-a',
      installation_id: null,
      transaction_source: 'receipt_ocr',
    });

    const loadedRows = await listReceiptsForAnalysis();
    expect(loadedRows).toHaveLength(1);
    expect(loadedRows[0]?.transaction_source).toBe('receipt_ocr');

    const context = await loadScanReviewDuplicateGateContext();
    expect(context?.storedReceipts).toHaveLength(1);
    expect(context?.storedReceipts[0]).toEqual(loadedRows[0]);
    expect(context?.storedReceipts[0]?.transaction_source).toBe('receipt_ocr');

    const yorkC = makeYorkCollisionReceiptC();
    const transient = buildTransientScanReviewReceipt({
      transientReceiptId: 'scan-review:device-regression',
      imageUri: 'file://review.jpg',
      analysis: {
        ...JSON.parse(yorkC.analysis_json),
        merchant: yorkC.merchant_raw,
        transactionDate: '2026-06-30 12:55',
        total: 4102,
        tax: 303,
        tax_is_known: true,
        currency: 'JPY',
      },
    });
    expect(transient).not.toBeNull();

    const match = evaluateScanReviewDuplicateGate(transient!, context!);
    expect(match?.existingReceiptId).toBe(makeYorkCollisionReceiptA().id);
  });

  it('getReceipt returns owned row and null for foreign row', async () => {
    mockDatabase.seed({ id: 'a', user_id: 'user-a' });
    mockDatabase.seed({ id: 'b', user_id: 'user-b' });

    await expect(getReceipt('a')).resolves.toMatchObject({ id: 'a' });
    await expect(getReceipt('b')).resolves.toBeNull();
  });

  it('owner unavailable fails closed for list/get', async () => {
    mockDatabase.seed({ id: 'a', user_id: 'user-a' });
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
      status: 'owner_unavailable',
    });

    await expect(listReceipts()).resolves.toEqual([]);
    await expect(listReceiptsForAnalysis()).resolves.toEqual([]);
    await expect(getReceipt('a')).resolves.toBeNull();
  });

  it('installation owner sees only NULL user_id + matching installation_id', async () => {
    setInstallationScope('install-i1');
    mockDatabase.seed({
      id: 'owned',
      user_id: null,
      installation_id: 'install-i1',
    });
    mockDatabase.seed({
      id: 'other-install',
      user_id: null,
      installation_id: 'install-i2',
    });
    mockDatabase.seed({
      id: 'user-row',
      user_id: 'user-u1',
      installation_id: 'install-i1',
    });
    mockDatabase.seed({
      id: 'double-null',
      user_id: null,
      installation_id: null,
    });

    const rows = await listReceipts();
    expect(rows.map((row) => row.id)).toEqual(['owned']);
  });

  it('mixed delete removes owned only and skips foreign tombstone/index cleanup', async () => {
    mockDatabase.seed({ id: 'a', user_id: 'user-a' });
    mockDatabase.seed({ id: 'b', user_id: 'user-b' });

    await deleteReceipts(['a', 'b']);

    expect(mockDatabase.rows.has('a')).toBe(false);
    expect(mockDatabase.rows.has('b')).toBe(true);
    expect(mockDeleteIndex).toHaveBeenCalledTimes(1);
    expect(mockDeleteIndex).toHaveBeenCalledWith(expect.anything(), 'a');
    expect(mockDatabase.syncOutbox.map((row) => row.receiptId)).toEqual(['a']);
  });

  it('foreign update is a no-op', async () => {
    mockDatabase.seed({
      id: 'b',
      user_id: 'user-b',
      merchant_raw: 'Foreign',
      analysis_json: JSON.stringify({ items: [] }),
    });

    await updateReceipt({
      id: 'b',
      analysis: {
        merchant: 'Hacked',
        total: 999,
        tax: 0,
        currency: 'JPY',
        items: [],
      },
    });

    expect(mockDatabase.rows.get('b')?.merchant_raw).toBe('Foreign');
    expect(mockDeleteIndex).not.toHaveBeenCalled();
    expect(mockDatabase.syncOutbox).toEqual([]);
  });

  it('duplicate selection cannot group across owners when list is owner-scoped first', async () => {
    mockDatabase.seed({
      id: 'a-dup-1',
      user_id: 'user-a',
      merchant_raw: 'Same Store',
      total: 1000,
      analysis_json: JSON.stringify({
        items: [{ name: 'Milk', category: 'food', lineTotal: 100, quantity: 1 }],
      }),
    });
    mockDatabase.seed({
      id: 'b-dup-1',
      user_id: 'user-b',
      merchant_raw: 'Same Store',
      total: 1000,
      analysis_json: JSON.stringify({
        items: [{ name: 'Milk', category: 'food', lineTotal: 100, quantity: 1 }],
      }),
    });

    const scoped = await listReceiptsForAnalysis();
    const selection = selectAnalyticsReceipts(scoped);
    expect(selection.analyticsReceipts.map((row) => row.id)).toEqual(['a-dup-1']);
    expect(selection.excludedDuplicateReceiptIds.size).toBe(0);
  });

  it('update and delete use exclusive transactions', async () => {
    mockDatabase.seed({ id: 'a', user_id: 'user-a' });
    await updateReceipt({ id: 'a', note: 'scoped' });
    await deleteReceipts(['a']);
    expect(mockDatabase.withExclusiveTransactionAsync).toHaveBeenCalled();
  });

  it('update ownership transition after authorization is a no-op without side effects', async () => {
    mockDatabase.seed({
      id: 'race-update',
      user_id: 'user-a',
      merchant_raw: 'Original',
      analysis_json: JSON.stringify({ items: [{ name: 'Milk', lineTotal: 100 }] }),
    });
    __setDbMutationTestHooksForTests({
      afterUpdateAuthorizedBeforeMutation: () => {
        const row = mockDatabase.rows.get('race-update');
        if (row) row.user_id = 'user-b';
      },
    });

    await updateReceipt({
      id: 'race-update',
      analysis: {
        merchant: 'Hacked',
        total: 999,
        tax: 0,
        currency: 'JPY',
        items: [{ name: 'Milk', lineTotal: 200 }],
      },
    });

    expect(mockDatabase.rows.get('race-update')?.merchant_raw).toBe('Original');
    expect(mockDatabase.syncOutbox).toEqual([]);
    expect(mockDeleteIndex).not.toHaveBeenCalled();
  });

  it('delete ownership transition rolls back tombstones and skips index cleanup', async () => {
    mockDatabase.seed({ id: 'race-delete', user_id: 'user-a' });
    __setDbMutationTestHooksForTests({
      afterDeleteSelectedBeforeMutation: () => {
        const row = mockDatabase.rows.get('race-delete');
        if (row) row.user_id = 'user-b';
      },
    });

    await expect(deleteReceipts(['race-delete'])).rejects.toThrow(
      /ownership delete mismatch/
    );
    expect(mockDatabase.rows.has('race-delete')).toBe(true);
    expect(mockDatabase.syncOutbox).toEqual([]);
    expect(mockDeleteIndex).not.toHaveBeenCalled();
  });
});
