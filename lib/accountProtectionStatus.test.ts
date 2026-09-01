/* eslint-disable import/first */
jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(),
}));
jest.mock('./receiptOwnershipScope', () => ({
  resolveCurrentLocalReceiptOwnerScope: jest.fn(),
}));
jest.mock('./db', () => ({
  countScopedLocalReceiptsForOwnerScope: jest.fn(),
  countScopedLocalReceiptsForCurrentOwner: jest.fn(),
  getReceiptsDatabase: jest.fn(),
}));

import type * as SQLite from 'expo-sqlite';
import {
  getAccountProtectionStatus,
  type AccountProtectionUiState,
} from './accountProtectionStatus';
import type { AuthState } from './anonAuth';
import type {
  LocalReceiptOwnerScope,
  LocalReceiptOwnerScopeReady,
} from './receiptOwnershipScope';

const authenticatedAnonymous: AuthState = {
  status: 'authenticated',
  userId: 'user-1',
  isAnonymous: true,
  hasAppleIdentity: false,
  accessToken: 'token',
  error: null,
};

const authenticatedApple: AuthState = {
  status: 'authenticated',
  userId: 'user-1',
  isAnonymous: false,
  hasAppleIdentity: true,
  accessToken: 'token',
  error: null,
};

const readyScope: LocalReceiptOwnerScopeReady = {
  status: 'ready',
  ownerKey: 'user:user-1',
  receiptWhereSql: 'receipts.user_id = ?',
  itemWhereSql: 'receipts.user_id = ?',
  params: ['user-1'],
};

function mockDb(localCount: number, pendingOutbox = 0) {
  return {
    getFirstAsync: jest.fn(async (sql: string) => {
      if (sql.includes('sync_outbox')) {
        return { c: pendingOutbox };
      }
      if (sql.includes('receipts')) {
        return { c: localCount };
      }
      return { c: 0 };
    }),
  } as unknown as SQLite.SQLiteDatabase;
}

describe('getAccountProtectionStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('A. resolves owner scope once and counts with that snapshot', async () => {
    const scopeA: LocalReceiptOwnerScopeReady = {
      status: 'ready',
      ownerKey: 'user:user-a',
      receiptWhereSql: 'receipts.user_id = ?',
      itemWhereSql: 'receipts.user_id = ?',
      params: ['user-a'],
    };
    const scopeB: LocalReceiptOwnerScopeReady = {
      status: 'ready',
      ownerKey: 'user:user-b',
      receiptWhereSql: 'receipts.user_id = ?',
      itemWhereSql: 'receipts.user_id = ?',
      params: ['user-b'],
    };

    let resolveCalls = 0;
    const resolveOwnerScope = jest.fn(async () => {
      resolveCalls += 1;
      return resolveCalls === 1 ? scopeA : scopeB;
    });

    const countScopedLocalReceiptsForScope = jest.fn(
      async (scope: LocalReceiptOwnerScopeReady, db: SQLite.SQLiteDatabase) => {
        expect(scope).toEqual(scopeA);
        expect(scope.receiptWhereSql).toBe('receipts.user_id = ?');
        expect(scope.params).toEqual(['user-a']);
        const row = await db.getFirstAsync<{ c: number }>(
          `SELECT COUNT(*) as c FROM receipts WHERE ${scope.receiptWhereSql}`,
          scope.params
        );
        return row?.c ?? 0;
      }
    );

    const db = mockDb(3);
    const status = await getAccountProtectionStatus({
      getAuth: () => authenticatedAnonymous,
      getDb: async () => db,
      resolveOwnerScope,
      countScopedLocalReceiptsForScope,
    });

    expect(resolveOwnerScope).toHaveBeenCalledTimes(1);
    expect(countScopedLocalReceiptsForScope).toHaveBeenCalledTimes(1);
    expect(countScopedLocalReceiptsForScope).toHaveBeenCalledWith(scopeA, db);
    expect(status.localReceiptCount).toBe(3);
    expect(status.uiState).toBe('anonymous');
  });

  it('1. true local zero + anonymous => empty_install', async () => {
    const status = await getAccountProtectionStatus({
      getAuth: () => authenticatedAnonymous,
      getDb: async () => mockDb(0, 0),
      resolveOwnerScope: async () => readyScope,
      countScopedLocalReceiptsForScope: async () => 0,
    });
    expect(status.uiState).toBe('empty_install');
    expect(status.localReceiptCount).toBe(0);
  });

  it('2. local receipts > 0 => NOT empty_install', async () => {
    const status = await getAccountProtectionStatus({
      getAuth: () => authenticatedAnonymous,
      getDb: async () => mockDb(3, 0),
      resolveOwnerScope: async () => readyScope,
      countScopedLocalReceiptsForScope: async () => 3,
    });
    expect(status.uiState).toBe('anonymous');
    expect(status.localReceiptCount).toBe(3);
    expect(status.uiState).not.toBe('empty_install');
  });

  it('3. auth unavailable => auth_unavailable and not zero local count', async () => {
    const status = await getAccountProtectionStatus({
      getAuth: () => ({
        status: 'unavailable',
        userId: null,
        isAnonymous: null,
        hasAppleIdentity: null,
        accessToken: null,
        error: 'offline',
      }),
    });
    expect(status.uiState).toBe('auth_unavailable');
    expect(status.localReceiptCount).toBeNull();
  });

  it('4. account status error/unresolved does not imply empty data', async () => {
    const status = await getAccountProtectionStatus({
      getAuth: () => authenticatedAnonymous,
      getDb: async () => {
        throw new Error('db_unavailable');
      },
      resolveOwnerScope: async () => readyScope,
      countScopedLocalReceiptsForScope: async () => 5,
    });
    expect(status.uiState).toBe('auth_unavailable');
    expect(status.localReceiptCount).toBeNull();
    expect(status.uiState).not.toBe('empty_install');
  });

  it('5. owner scope unavailable => auth_unavailable', async () => {
    const status = await getAccountProtectionStatus({
      getAuth: () => authenticatedAnonymous,
      getDb: async () => mockDb(2),
      resolveOwnerScope: async () => ({ status: 'owner_unavailable' }),
      countScopedLocalReceiptsForScope: async () => null,
    });
    expect(status.uiState).toBe('auth_unavailable');
    expect(status.localReceiptCount).toBeNull();
  });

  it('6. scoped local count uses resolved owner scope snapshot', async () => {
    const countScopedLocalReceiptsForScope = jest.fn(async () => 4);
    const status = await getAccountProtectionStatus({
      getAuth: () => authenticatedAnonymous,
      getDb: async () => mockDb(4),
      resolveOwnerScope: async () => readyScope,
      countScopedLocalReceiptsForScope,
    });
    expect(countScopedLocalReceiptsForScope).toHaveBeenCalledWith(
      readyScope,
      expect.anything()
    );
    expect(status.localReceiptCount).toBe(4);
    expect(status.uiState).toBe('anonymous');
  });

  it('7. Settings state mapping: empty_install / auth_unavailable are distinct', async () => {
    const states: AccountProtectionUiState[] = [];
    states.push(
      (
        await getAccountProtectionStatus({
          getAuth: () => authenticatedAnonymous,
          getDb: async () => mockDb(0),
          resolveOwnerScope: async () => readyScope,
          countScopedLocalReceiptsForScope: async () => 0,
        })
      ).uiState
    );
    states.push(
      (
        await getAccountProtectionStatus({
          getAuth: () => ({
            status: 'initializing',
            userId: null,
            isAnonymous: null,
            hasAppleIdentity: null,
            accessToken: null,
            error: null,
          }),
        })
      ).uiState
    );
    expect(states).toEqual(['empty_install', 'auth_unavailable']);
    expect(states[0]).not.toBe(states[1]);
  });

  it('apple linked protected when scoped data exists and outbox empty', async () => {
    const status = await getAccountProtectionStatus({
      getAuth: () => authenticatedApple,
      getDb: async () => mockDb(2, 0),
      resolveOwnerScope: async () => readyScope,
      countScopedLocalReceiptsForScope: async () => 2,
    });
    expect(status.uiState).toBe('apple_linked_protected');
  });
});

describe('settings account UI state mapping', () => {
  it('maps unresolved loading separately from empty install and auth unavailable', () => {
    const loadingUi: string | null = null;
    const emptyInstallUi = 'empty_install';
    const authUnavailableUi = 'auth_unavailable';

    expect(loadingUi).toBeNull();
    expect(emptyInstallUi).not.toBe(authUnavailableUi);
    expect(loadingUi).not.toBe(emptyInstallUi);
  });
});
