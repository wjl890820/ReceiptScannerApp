/**
 * Final two semantic fixes — listReceipts transient failure + user-bound adoption.
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

type MutableRow = Record<string, unknown>;

function rowMatchesOwnerPredicate(
  row: MutableRow,
  sql: string,
  params: unknown[]
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

class MemoryDb {
  rows = new Map<string, MutableRow>();
  meta = new Map<string, string>();

  async execAsync(): Promise<void> {}
  async closeAsync(): Promise<void> {}
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    await task();
  }
  async withExclusiveTransactionAsync(
    task: (txn: MemoryDb) => Promise<void>
  ): Promise<void> {
    await task(this);
  }
  async getFirstAsync<T>(
    source: string,
    params?: unknown[]
  ): Promise<T | null> {
    const all = await this.getAllAsync<T>(source, params);
    return all[0] ?? null;
  }
  async getAllAsync<T>(source: string, params?: unknown[]): Promise<T[]> {
    const values = Array.isArray(params) ? params : [];
    if (/PRAGMA table_info/i.test(source)) {
      return [
        { name: 'id' },
        { name: 'user_id' },
        { name: 'installation_id' },
        { name: 'transaction_at' },
        { name: 'created_at' },
        { name: 'image_uri' },
        { name: 'merchant_raw' },
        { name: 'merchant_normalized' },
        { name: 'merchant_type' },
        { name: 'total' },
        { name: 'tax' },
        { name: 'tax_is_known' },
        { name: 'currency' },
        { name: 'analysis_json' },
        { name: 'user_edited' },
        { name: 'final_total' },
        { name: 'final_category' },
        { name: 'note' },
        { name: 'user_items_json' },
        { name: 'transaction_source' },
      ] as T[];
    }
    if (/FROM app_meta/i.test(source) && /SELECT/i.test(source)) {
      const key = String(values[0] ?? '');
      const v = this.meta.get(key);
      return (v == null ? [] : [{ value: v }]) as T[];
    }
    if (/FROM receipts/i.test(source) && /SELECT/i.test(source)) {
      const whereMatch = source.match(/WHERE\s+([\s\S]*?)(?:ORDER BY|LIMIT|$)/i);
      const whereSql = whereMatch?.[1] ?? '';
      let rows = [...this.rows.values()].filter((row) =>
        rowMatchesOwnerPredicate(row, whereSql, values)
      );
      rows.sort((a, b) => {
        const ta = Number(a.transaction_at ?? a.created_at ?? 0);
        const tb = Number(b.transaction_at ?? b.created_at ?? 0);
        return tb - ta;
      });
      if (/LIMIT \?/i.test(source)) {
        const limit = Number(values[values.length - 1]);
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => ({ ...row })) as T[];
    }
    return [];
  }
  async runAsync(source: string, params?: unknown[]): Promise<{ changes: number }> {
    const values = Array.isArray(params) ? params : [];
    if (/INSERT OR REPLACE INTO app_meta/i.test(source)) {
      this.meta.set(String(values[0]), String(values[1]));
      return { changes: 1 };
    }
    return { changes: 0 };
  }
}

const mockDatabase = new MemoryDb();

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('nanoid/non-secure', () => ({
  nanoid: jest.fn(() => 'id-gen'),
}));

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
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

jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(async () => ({
    ran: false,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  })),
}));

jest.mock('./legacyReceiptInstallationBackfill', () => ({
  ensureLegacyReceiptInstallationBackfill: jest.fn(async () => undefined),
}));

const authState = {
  status: 'initializing' as 'initializing' | 'authenticated' | 'unavailable',
  userId: null as string | null,
  isAnonymous: null as boolean | null,
};

jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({
    status: authState.status,
    userId: authState.userId,
    isAnonymous: authState.isAnonymous,
    hasAppleIdentity: false,
    accessToken: authState.status === 'authenticated' ? 'tok' : null,
    error: null,
  })),
  ensureAnonAuth: jest.fn(async () => {
    authState.status = 'authenticated';
    authState.userId = 'user-U';
    authState.isAnonymous = true;
    return {
      status: 'authenticated',
      userId: 'user-U',
      isAnonymous: true,
      hasAppleIdentity: false,
      accessToken: 'tok',
      error: null,
    };
  }),
  subscribeAuthState: jest.fn(() => () => undefined),
  bootstrapAnonAuth: jest.fn(),
}));

jest.mock('./env', () => ({
  isAnonAuthEnabled: jest.fn(() => true),
}));

jest.mock('./installationId', () => ({
  getOrCreateInstallationId: jest.fn(async () => 'install-1'),
}));

jest.mock('./ownershipAdoptionOrchestrator', () => ({
  ensureOwnershipAdoptionSettledForOwnerRead: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: authState.userId ?? 'user-U',
  })),
  settleOwnershipAdoptionForCurrentAuth: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: authState.userId ?? 'user-U',
  })),
  startOwnershipAdoptionOrchestrator: jest.fn(),
  __resetOwnershipAdoptionOrchestratorForTests: jest.fn(),
}));

import {
  listReceipts,
  OwnerScopedReceiptReadUnavailableError,
  isOwnerScopedReceiptReadUnavailableError,
} from './db';
import { ensureOwnershipAdoptionSettledForOwnerRead } from './ownershipAdoptionOrchestrator';
import {
  failHomeRefresh,
  INITIAL_HOME_REFRESH_STATE,
} from './homeRefreshState';

describe('listReceipts owner_unavailable vs stable empty', () => {
  beforeEach(() => {
    mockDatabase.rows.clear();
    mockDatabase.meta.clear();
    authState.status = 'initializing';
    authState.userId = null;
    authState.isAnonymous = null;
    (ensureOwnershipAdoptionSettledForOwnerRead as jest.Mock).mockImplementation(
      async () => ({
        status: 'settled',
        reason: 'noop',
        userId: authState.userId ?? 'user-U',
      })
    );
  });

  it('1/3 — adoption failure → listReceipts rejects typed error (not [])', async () => {
    authState.status = 'authenticated';
    authState.userId = 'user-U';
    authState.isAnonymous = true;
    (ensureOwnershipAdoptionSettledForOwnerRead as jest.Mock).mockResolvedValue({
      status: 'failed',
      reason: 'boom',
      userId: 'user-U',
    });
    mockDatabase.rows.set('legacy', {
      id: 'legacy',
      created_at: 1,
      transaction_at: 1,
      image_uri: '',
      merchant_raw: 'L',
      merchant_normalized: 'L',
      merchant_type: 'supermarket',
      total: 1,
      tax: 0,
      tax_is_known: 0,
      currency: 'JPY',
      analysis_json: '{}',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
      user_id: null,
      installation_id: 'install-1',
      transaction_source: 'receipt_ocr',
    });

    await expect(listReceipts(200)).rejects.toBeInstanceOf(
      OwnerScopedReceiptReadUnavailableError
    );
    await expect(listReceipts(200)).rejects.toMatchObject({
      code: 'OWNER_SCOPE_UNAVAILABLE',
      reason: 'adoption_failed',
    });
  });

  it('4 — failed adoption can retry and later return rows', async () => {
    authState.status = 'authenticated';
    authState.userId = 'user-U';
    authState.isAnonymous = true;
    (ensureOwnershipAdoptionSettledForOwnerRead as jest.Mock)
      .mockResolvedValueOnce({
        status: 'failed',
        reason: 'boom',
        userId: 'user-U',
      })
      .mockResolvedValue({
        status: 'settled',
        reason: 'adopted',
        userId: 'user-U',
      });

    await expect(listReceipts(200)).rejects.toBeInstanceOf(
      OwnerScopedReceiptReadUnavailableError
    );

    mockDatabase.rows.set('legacy', {
      id: 'legacy',
      created_at: 1,
      transaction_at: 1,
      image_uri: '',
      merchant_raw: 'L',
      merchant_normalized: 'L',
      merchant_type: 'supermarket',
      total: 1,
      tax: 0,
      tax_is_known: 0,
      currency: 'JPY',
      analysis_json: '{}',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
      user_id: 'user-U',
      installation_id: 'install-1',
      transaction_source: 'receipt_ocr',
    });

    const rows = await listReceipts(200);
    expect(rows.map((r) => r.id)).toEqual(['legacy']);
  });

  it('5 — DB not ready → listReceipts typed failure', async () => {
    authState.status = 'authenticated';
    authState.userId = 'user-U';
    authState.isAnonymous = true;
    (ensureOwnershipAdoptionSettledForOwnerRead as jest.Mock).mockResolvedValue({
      status: 'not_ready',
      reason: 'db_unavailable',
      userId: 'user-U',
    });
    await expect(listReceipts(200)).rejects.toMatchObject({
      code: 'OWNER_SCOPE_UNAVAILABLE',
      reason: 'adoption_not_ready',
    });
  });

  it('2/16 — stable empty authenticated user → []', async () => {
    authState.status = 'authenticated';
    authState.userId = 'user-U';
    authState.isAnonymous = true;
    await expect(listReceipts(200)).resolves.toEqual([]);
  });

  it('A cold — initializing → authenticated U → first listReceipts returns U rows', async () => {
    mockDatabase.rows.set('r-u', {
      id: 'r-u',
      created_at: 100,
      transaction_at: 100,
      image_uri: '',
      merchant_raw: 'Store',
      merchant_normalized: 'Store',
      merchant_type: 'supermarket',
      total: 10,
      tax: 0,
      tax_is_known: 0,
      currency: 'JPY',
      analysis_json: '{}',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
      user_id: 'user-U',
      installation_id: 'install-1',
      transaction_source: 'receipt_ocr',
    });
    const rows = await listReceipts(200);
    expect(rows.map((r) => r.id)).toEqual(['r-u']);
  });

  it('21 — Home fail path does not mark complete snapshot for typed error', () => {
    const err = new OwnerScopedReceiptReadUnavailableError('adoption_failed');
    expect(isOwnerScopedReceiptReadUnavailableError(err)).toBe(true);
    const next = failHomeRefresh(INITIAL_HOME_REFRESH_STATE);
    expect(next.hasCompleteSnapshot).toBe(false);
    expect(next.initialLoading).toBe(false);
  });
});
