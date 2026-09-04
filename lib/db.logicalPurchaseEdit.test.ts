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

jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({
    status: 'authenticated',
    userId: 'user-1',
    isAnonymous: true,
    hasAppleIdentity: false,
    accessToken: 't',
    error: null,
  })),
  ensureAnonAuth: jest.fn(async () => ({
    status: 'authenticated',
    userId: 'user-1',
    isAnonymous: true,
    hasAppleIdentity: false,
    accessToken: 't',
    error: null,
  })),
  subscribeAuthState: jest.fn(() => () => undefined),
}));

jest.mock('./env', () => ({
  isAnonAuthEnabled: () => true,
}));

jest.mock('./ownershipAdoptionOrchestrator', () => ({
  ensureOwnershipAdoptionSettledForOwnerRead: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: 'user-1',
  })),
  settleOwnershipAdoptionForCurrentAuth: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: 'user-1',
  })),
  startOwnershipAdoptionOrchestrator: jest.fn(),
}));

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
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

import {
  updateLogicalPurchaseItemEdit,
  type ReceiptRow,
} from './db';
import { LogicalPurchaseEditPartitionError } from './logicalPurchaseEditPartition';
import { requestCloudBackupFlush } from './cloudBackupWorker';
import { replaceSyncOutboxIntent } from './syncOutbox';
import { rebuildReceiptItemIndex } from './receiptItemIndex';

type MutableReceiptRow = ReceiptRow & Record<string, unknown>;

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
        .map((row) => ({
          id: row.id,
          created_at: row.created_at,
          transaction_at: row.transaction_at,
          image_uri: row.image_uri,
          merchant_raw: row.merchant_raw,
          merchant_normalized: row.merchant_normalized,
          merchant_type: row.merchant_type,
          total: row.total,
          tax: row.tax,
          tax_is_known: row.tax_is_known ?? 0,
          currency: row.currency,
          analysis_json: row.analysis_json,
          user_edited: row.user_edited ?? 0,
          final_total: row.final_total,
          final_category: row.final_category,
          note: row.note,
          user_items_json: row.user_items_json,
        })) as T[];
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

function seedReceipt(id: string, analysisJson: string): void {
  mockDatabase.rows.set(id, {
    id,
    created_at: 1,
    transaction_at: 1,
    image_uri: 'file://x',
    total: 100,
    tax: 8,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: analysisJson,
    merchant_raw: '店',
    merchant_normalized: '店',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: 'user-1',
    installation_id: 'install-test',
  });
}

describe('updateLogicalPurchaseItemEdit', () => {
  beforeEach(() => {
    mockDatabase.reset();
    outboxIntents.length = 0;
    jest.clearAllMocks();
    seedReceipt('member-a', JSON.stringify({ items: [{ name: 'A', lineTotal: 100, quantity: 1 }] }));
    seedReceipt('member-b', JSON.stringify({ items: [{ name: 'B', lineTotal: 200, quantity: 1 }] }));
    seedReceipt('member-c', JSON.stringify({ items: [{ name: 'C', lineTotal: 300, quantity: 1 }] }));
  });

  it('F. rolls back when one member is missing or unowned', async () => {
    const beforeA = mockDatabase.rows.get('member-a')!.user_items_json;
    const beforeB = mockDatabase.rows.get('member-b')!.user_items_json;
    await expect(
      updateLogicalPurchaseItemEdit({
        memberReceiptIds: ['member-a', 'missing-member'],
        user_items_json: JSON.stringify([{ name: 'edited', lineTotal: 1, quantity: 1 }]),
      })
    ).rejects.toThrow(
      /stale logical purchase membership|ownership mismatch|missing or unowned/
    );
    expect(mockDatabase.rows.get('member-a')!.user_items_json).toBe(beforeA);
    expect(mockDatabase.rows.get('member-b')!.user_items_json).toBe(beforeB);
    expect(outboxIntents).toHaveLength(0);
    expect(mockRebuild).not.toHaveBeenCalled();
    expect(requestCloudBackupFlush).not.toHaveBeenCalled();
  });

  it('G. enqueues upsert intent for a singleton logical purchase edit', async () => {
    const userItemsJson = JSON.stringify([{ name: 'edited', lineTotal: 99, quantity: 2 }]);
    const result = await updateLogicalPurchaseItemEdit({
      memberReceiptIds: ['member-a'],
      user_items_json: userItemsJson,
    });
    expect(result.updatedReceiptIds).toEqual(['member-a']);
    expect(outboxIntents).toHaveLength(1);
    expect(outboxIntents[0]!.receiptId).toBe('member-a');
    expect(outboxIntents[0]!.operation).toBe('upsert');
    expect(replaceSyncOutboxIntent).toHaveBeenCalledTimes(1);
    expect(requestCloudBackupFlush).toHaveBeenCalledTimes(1);
  });

  it('H. preserves analysis_json while updating user overlay on singleton member', async () => {
    const original = mockDatabase.rows.get('member-a')!.analysis_json;
    const userItemsJson = JSON.stringify([{ name: 'overlay', lineTotal: 50, quantity: 1 }]);
    await updateLogicalPurchaseItemEdit({
      memberReceiptIds: ['member-a'],
      user_items_json: userItemsJson,
    });
    const row = mockDatabase.rows.get('member-a')!;
    expect(row.analysis_json).toBe(original);
    expect(row.user_items_json).toBe(userItemsJson);
    expect(row.user_edited).toBe(1);
  });

  it('rebuilds item index for updated singleton member after commit', async () => {
    await updateLogicalPurchaseItemEdit({
      memberReceiptIds: ['member-a'],
      user_items_json: JSON.stringify([{ name: 'indexed', lineTotal: 10, quantity: 1 }]),
    });
    expect(mockRebuild).toHaveBeenCalledTimes(1);
  });

  it('rejects stale multi-member caller ids before any mutation', async () => {
    const beforeA = mockDatabase.rows.get('member-a')!.user_items_json;
    const beforeB = mockDatabase.rows.get('member-b')!.user_items_json;
    await expect(
      updateLogicalPurchaseItemEdit({
        memberReceiptIds: ['member-a', 'member-b'],
        user_items_json: JSON.stringify([{ name: 'edited', lineTotal: 1, quantity: 1 }]),
      })
    ).rejects.toBeInstanceOf(LogicalPurchaseEditPartitionError);
    expect(mockDatabase.rows.get('member-a')!.user_items_json).toBe(beforeA);
    expect(mockDatabase.rows.get('member-b')!.user_items_json).toBe(beforeB);
    expect(outboxIntents).toHaveLength(0);
    expect(mockRebuild).not.toHaveBeenCalled();
    expect(requestCloudBackupFlush).not.toHaveBeenCalled();
  });
});
