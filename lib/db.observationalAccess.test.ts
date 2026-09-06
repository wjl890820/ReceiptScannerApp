/**
 * Observational DB accessor tests for Experiment Snapshot (A3).
 * Proves getInitializedReceiptsDatabaseOrThrow never calls initIfNeeded.
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('openDatabaseAsync must not be called by observational accessor');
  }),
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
}));

jest.mock('./receiptOwnershipScope', () => ({
  resolveCurrentLocalReceiptOwnerScope: jest.fn(async () => ({
    status: 'ready',
    ownerKey: 'owner-1',
    receiptWhereSql: '1=1',
    itemWhereSql: '1=1',
    params: [],
  })),
  composeReceiptListWhereClause: (scope: { receiptWhereSql: string }) =>
    scope.receiptWhereSql,
}));

jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(async () => ({ status: 'skipped' })),
}));

jest.mock('./syncOutbox', () => ({
  ensureSyncOutboxSchema: jest.fn(async () => undefined),
  generateSyncIntentId: jest.fn(() => 'intent'),
  replaceSyncOutboxIntent: jest.fn(async () => undefined),
}));

jest.mock('./receiptItemIndex', () => ({
  clearReceiptItemIndex: jest.fn(async () => undefined),
  deleteReceiptItemIndex: jest.fn(async () => undefined),
  ensureReceiptItemsSchema: jest.fn(async () => undefined),
  projectMinimalReceiptItemIndexFromSoT: jest.fn(() => []),
  rebuildReceiptItemIndex: jest.fn(async () => undefined),
}));

jest.mock('./receiptItemIndexBackfill', () => ({
  runReceiptItemIndexBackfillBatch: jest.fn(async () => ({
    succeeded: 0,
    failed: 0,
    remaining: 0,
  })),
}));

jest.mock('./shoppingIntentSchema', () => ({
  ensureShoppingIntentsSchema: jest.fn(async () => undefined),
}));

jest.mock('./productIdentityEntitySchema', () => ({
  ensureProductIdentityEntitySchema: jest.fn(async () => undefined),
}));

jest.mock('./personalProductIdentitySchema', () => ({
  ensurePersonalProductIdentitySchema: jest.fn(async () => undefined),
}));

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as SQLite from 'expo-sqlite';

import {
  ReceiptsDatabaseNotInitializedError,
  __resetReceiptsDatabaseLifecycleForTests,
  __setReceiptsDatabaseInitializedForTests,
  getInitializedReceiptsDatabaseOrThrow,
  isReceiptsDatabaseInitialized,
  listReceiptsForAnalysisWithDb,
} from './db';

describe('db observational accessors (Experiment Snapshot A3)', () => {
  beforeEach(() => {
    __resetReceiptsDatabaseLifecycleForTests();
    jest.clearAllMocks();
  });

  it('throws when not initialized and does not open DB', () => {
    expect(isReceiptsDatabaseInitialized()).toBe(false);
    expect(() => getInitializedReceiptsDatabaseOrThrow()).toThrow(
      ReceiptsDatabaseNotInitializedError
    );
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
  });

  it('returns the marked-initialized handle without open/init', () => {
    const fakeDb = {
      getAllAsync: jest.fn(async () => []),
    } as unknown as import('expo-sqlite').SQLiteDatabase;
    __setReceiptsDatabaseInitializedForTests(fakeDb);
    expect(isReceiptsDatabaseInitialized()).toBe(true);
    expect(getInitializedReceiptsDatabaseOrThrow()).toBe(fakeDb);
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
  });

  it('listReceiptsForAnalysisWithDb uses provided db getAllAsync only', async () => {
    const getAllAsync = jest.fn(async () => []);
    const runAsync = jest.fn();
    const execAsync = jest.fn();
    const fakeDb = {
      getAllAsync,
      runAsync,
      execAsync,
    } as unknown as import('expo-sqlite').SQLiteDatabase;

    const rows = await listReceiptsForAnalysisWithDb(fakeDb);
    expect(rows).toEqual([]);
    expect(getAllAsync).toHaveBeenCalled();
    expect(runAsync).not.toHaveBeenCalled();
    expect(execAsync).not.toHaveBeenCalled();
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
  });
});
