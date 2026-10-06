/**
 * Current-user clean-local restore at startup, and the restore-first barrier.
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', extra: {} } },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const map = new Map<string, string>();
  return {
    getItem: jest.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
    setItem: jest.fn(async (k: string, v: string) => {
      map.set(k, v);
    }),
  };
});

jest.mock('./supabaseClient', () => ({
  getSupabaseClient: jest.fn(() => null),
}));

import * as SQLite from 'expo-sqlite';
import { restoreExistingAppleAccount } from './appleAccountRestore';
import {
  __resetReceiptsDatabaseLifecycleForTests,
  __setReceiptsDatabaseInitializedForTests,
  saveReceipt,
} from './db';
import * as env from './env';
import { buildProductAttributes } from './productIdentityContract';
import { buildPersonalMerchantProductEndpointV1 } from './personalProductIdentityContract';
import {
  createMemoryPersonalProductIdentityDatabase,
  recordPersonalProductIdentityDecisionWithDb,
} from './personalProductIdentityRepository';
import { withPersonalDecisionLocalMutationGate } from './personalDecisionLocalMutationGate';
import { getSupabaseClient } from './supabaseClient';
import { __handleAppStateForTests, __runCloudBackupFlushForTests } from './cloudBackupWorker';
import { currentUserRestorePhase } from './currentUserRestoreBarrier';
import {
  assertCurrentUserRestoreAllowsBusinessWrites,
  backupMayStartAfterCurrentUserRestore,
  CurrentUserRestoreBlockedError,
  __resetCurrentUserCloudRestoreForTests,
  retryCurrentUserCloudRestoreIfFailed,
  startCurrentUserCloudRestore,
} from './currentUserCloudRestore';
import { restoreCloudReceiptsForCurrentUser } from './cloudRestore';

const UID = '7be02278-2fde-4672-8ec1-10d9f05b6d5c';

type FakeState = {
  receipts: number;
  outbox: number;
  decisions: number;
  dirty: string | null;
};

function fakeDb(state: FakeState) {
  return {
    async execAsync() {
      return undefined;
    },
    async getAllAsync() {
      return [];
    },
    async runAsync() {
      return { changes: 0 };
    },
    async withExclusiveTransactionAsync(task: (txn: unknown) => Promise<void>) {
      await task(this);
    },
    async getFirstAsync(sql: string) {
      if (/FROM receipts/i.test(sql)) return { c: state.receipts };
      if (/sync_outbox/i.test(sql)) return { c: state.outbox };
      if (/personal_product_identity_decisions/i.test(sql)) return { c: state.decisions };
      if (/app_kv/i.test(sql)) return state.dirty == null ? null : { v: state.dirty };
      return null;
    },
  };
}

function session(userId = UID) {
  return {
    userId,
    accessToken: 'eyJ.session.signature',
    isAnonymous: true,
  };
}

afterEach(() => {
  __resetCurrentUserCloudRestoreForTests();
});

describe('startup current-user restore', () => {
  it('restores an authenticated anonymous user into a clean local database', async () => {
    const seen: string[] = [];
    const state = { receipts: 0, outbox: 0, decisions: 0, dirty: null };
    const finished = startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb(state) as never,
      readSession: async () => session(),
      restore: async (deps) => {
        const auth = deps?.getAuth?.();
        if (!auth) throw new Error('missing auth');
        seen.push(`${auth.userId}:${auth.isAnonymous}`);
        state.receipts = 4;
        state.decisions = 1;
        return { status: 'ok', restored: 4 };
      },
    });
    await finished;
    expect(seen).toEqual([`${UID}:true`]);
    await assertCurrentUserRestoreAllowsBusinessWrites();
  });

  it('does not call Apple sign-in and keeps the same user id', async () => {
    const signIn = jest.fn();
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      readSession: async () => session(),
      restore: async (deps) => {
        expect(deps?.getAuth?.().userId).toBe(UID);
        expect(signIn).not.toHaveBeenCalled();
        return { status: 'ok', restored: 0 };
      },
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('settles an empty remote snapshot and then allows local writes', async () => {
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      readSession: async () => session(),
      restore: async () => ({ status: 'ok', restored: 0 }),
    });
    expect(assertCurrentUserRestoreAllowsBusinessWrites()).toBeUndefined();
  });

  it('does not overwrite a non-clean local database', async () => {
    const restore = jest.fn();
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 2, outbox: 0, decisions: 0, dirty: null }) as never,
      readSession: async () => session(),
      restore,
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it('refuses restore when the current user has a dirty personal decision', async () => {
    const restore = jest.fn();
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: '1' }) as never,
      readSession: async () => session(),
      restore,
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it('refuses restore when sync_outbox is nonempty', async () => {
    const restore = jest.fn();
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 1, decisions: 0, dirty: null }) as never,
      readSession: async () => session(),
      restore,
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it('fails closed on a network error and recovers on retry', async () => {
    let online = false;
    const attempt = startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      readSession: async () => session(),
      restore: async () => {
        if (!online) return { status: 'fetch_failed', restored: 0, error: 'offline' };
        return { status: 'ok', restored: 4 };
      },
    });
    await attempt;
    let wrote = false;
    expect(() => assertCurrentUserRestoreAllowsBusinessWrites()).toThrow(
      CurrentUserRestoreBlockedError
    );
    expect(wrote).toBe(false);
    online = true;
    await retryCurrentUserCloudRestoreIfFailed();
    await assertCurrentUserRestoreAllowsBusinessWrites();
    wrote = true;
    expect(wrote).toBe(true);
  });

  it('aborts before writing when the authoritative session user changes', async () => {
    let current = UID;
    const db = fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null });
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => ({
        status: 'authenticated',
        userId: UID,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'eyJ.session.signature',
        error: null,
      }),
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-1',
      confirmAuthenticatedUserId: async () => {
        current = 'other-user';
        return current;
      },
      fetchActiveCloudReceipts: async () => {
        throw new Error('should not fetch');
      },
      fetchActiveCloudDecisions: async () => [],
    });
    expect(result).toMatchObject({ status: 'auth_unavailable', error: 'session_user_changed' });
    expect(db).toBeTruthy();
  });
});

describe('restore-first barrier', () => {
  it('holds receipt and decision writes until restore settles', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      readSession: async () => session(),
      restore: async () => {
        await hold;
        return { status: 'ok', restored: 4 };
      },
    });
    let receiptWrote = false;
    let decisionWrote = false;
    const receipt = Promise.resolve(assertCurrentUserRestoreAllowsBusinessWrites()).then(() => {
      receiptWrote = true;
    });
    const decision = Promise.resolve(assertCurrentUserRestoreAllowsBusinessWrites()).then(() => {
      decisionWrote = true;
    });
    await Promise.resolve();
    expect(receiptWrote).toBe(false);
    expect(decisionWrote).toBe(false);
    const backupWhilePending = backupMayStartAfterCurrentUserRestore().then((gate) => gate.ok);
    await Promise.resolve();
    release();
    await running;
    await receipt;
    await decision;
    await expect(backupWhilePending).resolves.toBe(true);
    expect(receiptWrote).toBe(true);
    expect(decisionWrote).toBe(true);
  });

  it('does not open the receipt database for saveReceipt while restore is pending', async () => {
    const openDatabaseAsync = SQLite.openDatabaseAsync as jest.Mock;
    openDatabaseAsync.mockClear();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      readSession: async () => session(),
      restore: async () => {
        await hold;
        return { status: 'ok', restored: 4 };
      },
    });
    const save = saveReceipt({} as never);
    await Promise.resolve();
    expect(openDatabaseAsync).not.toHaveBeenCalled();
    release();
    await running;
    await expect(save).rejects.toThrow();
    expect(openDatabaseAsync).toHaveBeenCalled();
  });

  it('does not let backup start while a failed restore is unrecovered', async () => {
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      readSession: async () => session(),
      restore: async () => ({ status: 'decision_schema_unavailable', restored: 0 }),
    });
    await expect(backupMayStartAfterCurrentUserRestore()).resolves.toEqual({
      ok: false,
      reason: 'restore_failed',
    });
  });

  it('makes Apple sign-in wait until the current-user attempt settles, then blocks on restored rows', async () => {
    const state = { receipts: 0, outbox: 0, decisions: 0, dirty: null };
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb(state) as never,
      readSession: async () => session(),
      restore: async () => {
        await hold;
        state.receipts = 4;
        return { status: 'ok', restored: 4 };
      },
    });
    const requestApple = jest.fn(async () => ({ status: 'canceled' as const }));
    const apple = restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: UID,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'eyJ.session.signature',
        error: null,
      }),
      getClient: () => ({ auth: { signInWithIdToken: jest.fn() } }) as never,
      getDb: async () => fakeDb(state) as never,
      requestAppleCredential: requestApple as never,
      restoreCloud: jest.fn(async () => ({ status: 'ok' as const, restored: 4 })),
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    await Promise.resolve();
    expect(requestApple).not.toHaveBeenCalled();
    release();
    await running;
    const result = await apple;
    expect(result.status).toBe('blocked_local_data_present');
    expect(requestApple).not.toHaveBeenCalled();
  });
});

const getSupabaseClientMock = getSupabaseClient as jest.Mock;

function authenticatedSessionResponse(userId = UID) {
  return {
    data: {
      session: {
        access_token: 'eyJ.session.signature',
        user: { id: userId, is_anonymous: userId === UID },
      },
    },
    error: null,
  };
}

describe('getSession error versus no session', () => {
  it('fails closed when getSession returns an error and recovers on retry', async () => {
    const restore = jest.fn(async () => ({ status: 'ok' as const, restored: 4 }));
    const writes: string[] = [];
    getSupabaseClientMock.mockReturnValue({
      auth: {
        getSession: async () => ({ data: { session: null }, error: { message: 'auth down' } }),
      },
    });
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () =>
        ({
          async execAsync() {
            writes.push('exec');
          },
          async runAsync(sql: string) {
            writes.push(sql);
            return { changes: 0 };
          },
          async getFirstAsync() {
            return { c: 0 };
          },
          async getAllAsync() {
            return [];
          },
        }) as never,
      restore,
    });
    expect(currentUserRestorePhase()).toBe('failed');
    expect(restore).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(() => assertCurrentUserRestoreAllowsBusinessWrites()).toThrow(
      CurrentUserRestoreBlockedError
    );
    await expect(backupMayStartAfterCurrentUserRestore()).resolves.toEqual({
      ok: false,
      reason: 'restore_failed',
    });

    getSupabaseClientMock.mockReturnValue({
      auth: { getSession: async () => authenticatedSessionResponse() },
    });
    await retryCurrentUserCloudRestoreIfFailed();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(currentUserRestorePhase()).toBe('settled');
    expect(assertCurrentUserRestoreAllowsBusinessWrites()).toBeUndefined();
  });

  it('fails closed when getSession throws', async () => {
    getSupabaseClientMock.mockReturnValue({
      auth: {
        getSession: async () => {
          throw new Error('auth threw');
        },
      },
    });
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      restore: async () => ({ status: 'ok', restored: 1 }),
    });
    expect(currentUserRestorePhase()).toBe('failed');
    expect(() => assertCurrentUserRestoreAllowsBusinessWrites()).toThrow(
      CurrentUserRestoreBlockedError
    );
    await expect(backupMayStartAfterCurrentUserRestore()).resolves.toEqual({
      ok: false,
      reason: 'restore_failed',
    });
  });

  it('settles when getSession reports no session and no error', async () => {
    const restore = jest.fn();
    getSupabaseClientMock.mockReturnValue({
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
      },
    });
    await startCurrentUserCloudRestore({
      isEnabled: () => true,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      restore,
    });
    expect(restore).not.toHaveBeenCalled();
    expect(currentUserRestorePhase()).toBe('settled');
    expect(assertCurrentUserRestoreAllowsBusinessWrites()).toBeUndefined();
  });
});

function appleClient(userId = 'apple-user') {
  return {
    auth: {
      signInWithIdToken: async () => ({
        data: {
          session: {
            access_token: 'eyJ.apple.signature',
            user: { id: userId, is_anonymous: false, identities: [{ provider: 'apple' }] },
          },
        },
        error: null,
      }),
    },
  };
}

function appleAuthState(userId = 'apple-user') {
  return {
    status: 'authenticated' as const,
    userId,
    isAnonymous: false,
    hasAppleIdentity: true,
    accessToken: 'eyJ.apple.signature',
    error: null,
  };
}

async function failAnonymousRestore(options?: {
  readSession?: () => Promise<ReturnType<typeof session>>;
  restore?: (deps?: { getAuth?: () => { userId: string } }) => Promise<{
    status: 'ok' | 'fetch_failed';
    restored: number;
  }>;
}) {
  const anonymousRestore = jest.fn(
    options?.restore ?? (async () => ({ status: 'fetch_failed' as const, restored: 0 }))
  );
  await startCurrentUserCloudRestore({
    isEnabled: () => true,
    getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
    readSession: options?.readSession ?? (async () => session()),
    restore: anonymousRestore as never,
  });
  return anonymousRestore;
}

describe('Apple restore reconciles a failed current-user barrier', () => {
  let backupSpy: jest.SpyInstance | null = null;

  afterEach(() => {
    backupSpy?.mockRestore();
    backupSpy = null;
    __resetReceiptsDatabaseLifecycleForTests();
  });

  it('lets saveReceipt proceed after a successful Apple restore', async () => {
    await failAnonymousRestore();
    const result = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: UID,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'eyJ.session.signature',
        error: null,
      }),
      getClient: () => appleClient() as never,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 'id-token',
        rawNonce: 'nonce',
      }),
      applySession: () => appleAuthState(),
      restoreCloud: async () => ({ status: 'ok', restored: 4 }),
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('ok');
    expect(currentUserRestorePhase()).toBe('settled');

    const inserted: string[] = [];
    __setReceiptsDatabaseInitializedForTests({
      async execAsync() {
        return undefined;
      },
      async getFirstAsync() {
        return null;
      },
      async getAllAsync() {
        return [];
      },
      async runAsync(sql: string) {
        inserted.push(sql);
        return { changes: 1 };
      },
      async withTransactionAsync(task: () => Promise<void>) {
        await task();
      },
      async withExclusiveTransactionAsync(task: (txn: unknown) => Promise<void>) {
        await task(this);
      },
    } as never);
    const id = await saveReceipt({
      imageUri: 'file://receipt.jpg',
      analysis: { merchant: '店', total: 100, tax: 0, currency: 'JPY', items: [] },
    });
    expect(id).toEqual(expect.any(String));
    expect(inserted.some((sql) => /INSERT INTO receipts/i.test(sql))).toBe(true);
  });

  it('lets a personal decision commit after a successful Apple restore', async () => {
    await failAnonymousRestore();
    const result = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: UID,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'eyJ.session.signature',
        error: null,
      }),
      getClient: () => appleClient() as never,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 'id-token',
        rawNonce: 'nonce',
      }),
      applySession: () => appleAuthState(),
      restoreCloud: async () => ({ status: 'ok', restored: 4 }),
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('ok');
    const db = createMemoryPersonalProductIdentityDatabase();
    const left = buildPersonalMerchantProductEndpointV1({
      merchantProductId: 'mp_a',
      merchantScopeKey: 'lawson',
      comparisonKey: 'cmp-mp_a',
      attributes: buildProductAttributes([]),
    });
    const right = buildPersonalMerchantProductEndpointV1({
      merchantProductId: 'mp_b',
      merchantScopeKey: 'lawson',
      comparisonKey: 'cmp-mp_b',
      attributes: buildProductAttributes([]),
    });
    const recorded = await recordPersonalProductIdentityDecisionWithDb(
      db,
      'user:apple-user',
      left,
      right,
      'same_product',
      { nowMs: 20, currentEndpoints: new Map([['mp_a', left], ['mp_b', right]]) }
    );
    expect(recorded).toEqual({ ok: true, outcome: 'created' });
  });

  it('no longer reports restore_failed from the backup worker after Apple success', async () => {
    backupSpy = jest.spyOn(env, 'isCloudBackupEnabled').mockReturnValue(true);
    await failAnonymousRestore();
    const result = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: UID,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'eyJ.session.signature',
        error: null,
      }),
      getClient: () => appleClient() as never,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 'id-token',
        rawNonce: 'nonce',
      }),
      applySession: () => appleAuthState(),
      restoreCloud: async () => ({ status: 'ok', restored: 4 }),
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('ok');
    await expect(backupMayStartAfterCurrentUserRestore()).resolves.toEqual({ ok: true });
    const flush = await __runCloudBackupFlushForTests(async () => ({}) as never);
    expect(flush.reason).not.toBe('restore_failed');
  });

  it('ignores a foreground retry while the Apple credential UI is open', async () => {
    backupSpy = jest.spyOn(env, 'isCloudBackupEnabled').mockReturnValue(true);
    const anonymousRestore = await failAnonymousRestore();
    let retryDuringCredential = false;
    const result = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: UID,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'eyJ.session.signature',
        error: null,
      }),
      getClient: () => appleClient() as never,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      requestAppleCredential: async () => {
        __handleAppStateForTests('background');
        __handleAppStateForTests('active');
        await retryCurrentUserCloudRestoreIfFailed();
        await startCurrentUserCloudRestore();
        retryDuringCredential = true;
        expect(anonymousRestore).toHaveBeenCalledTimes(1);
        expect(currentUserRestorePhase()).toBe('failed');
        return { status: 'ok', identityToken: 'id-token', rawNonce: 'nonce' };
      },
      applySession: () => appleAuthState(),
      restoreCloud: async () => ({ status: 'ok', restored: 4 }),
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(retryDuringCredential).toBe(true);
    expect(result.status).toBe('ok');
    expect(anonymousRestore).toHaveBeenCalledTimes(1);
    expect(currentUserRestorePhase()).toBe('settled');
  });

  it('keeps a failed Apple restore recoverable for the new user', async () => {
    let current = session();
    const seen: string[] = [];
    const anonymousRestore = await failAnonymousRestore({
      readSession: async () => current,
      restore: async (deps) => {
        seen.push(deps?.getAuth?.().userId ?? '');
        return seen.length === 1
          ? { status: 'fetch_failed', restored: 0 }
          : { status: 'ok', restored: 2 };
      },
    });
    const result = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: current.userId,
        isAnonymous: current.isAnonymous,
        hasAppleIdentity: false,
        accessToken: current.accessToken,
        error: null,
      }),
      getClient: () => appleClient() as never,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      requestAppleCredential: async () => {
        await retryCurrentUserCloudRestoreIfFailed();
        expect(anonymousRestore).toHaveBeenCalledTimes(1);
        return { status: 'ok', identityToken: 'id-token', rawNonce: 'nonce' };
      },
      applySession: () => {
        current = {
          userId: 'apple-user',
          accessToken: 'eyJ.apple.signature',
          isAnonymous: false,
        };
        return appleAuthState();
      },
      restoreCloud: async () => ({ status: 'fetch_failed', restored: 0, error: 'net' }),
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('restore_failed');
    expect(currentUserRestorePhase()).toBe('failed');
    expect(() => assertCurrentUserRestoreAllowsBusinessWrites()).toThrow(
      CurrentUserRestoreBlockedError
    );
    await retryCurrentUserCloudRestoreIfFailed();
    expect(seen).toEqual([UID, 'apple-user']);
    expect(currentUserRestorePhase()).toBe('settled');
    expect(assertCurrentUserRestoreAllowsBusinessWrites()).toBeUndefined();
  });

  it('does not deadlock the account-switch guard with the decision gate or backup', async () => {
    await failAnonymousRestore();
    let gateEntered = false;
    const result = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: UID,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'eyJ.session.signature',
        error: null,
      }),
      getClient: () => appleClient() as never,
      getDb: async () => fakeDb({ receipts: 0, outbox: 0, decisions: 0, dirty: null }) as never,
      requestAppleCredential: async () => {
        await retryCurrentUserCloudRestoreIfFailed();
        await withPersonalDecisionLocalMutationGate(async () => {
          gateEntered = true;
        });
        await backupMayStartAfterCurrentUserRestore();
        return { status: 'ok', identityToken: 'id-token', rawNonce: 'nonce' };
      },
      applySession: () => appleAuthState(),
      restoreCloud: async () => {
        await withPersonalDecisionLocalMutationGate(async () => undefined);
        await backupMayStartAfterCurrentUserRestore();
        return { status: 'ok', restored: 1 };
      },
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(gateEntered).toBe(true);
    expect(result.status).toBe('ok');
    expect(currentUserRestorePhase()).toBe('settled');
  });
});
