/**
 * P0 Phase 7 — Apple protect / restore + account protection status.
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', extra: { ENABLE_APPLE_LINK: 'true' } } },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

import {
  applyExternalSession,
  getAuthState,
  userHasAppleIdentity,
  __resetAnonAuthForTests,
} from './anonAuth';
import { getAccountProtectionStatus } from './accountProtectionStatus';
import { protectCurrentAccountWithApple } from './appleAccountProtect';
import { restoreExistingAppleAccount } from './appleAccountRestore';
import { requestAppleIdentityToken } from './appleAuthCredential';
import { generateAppleRawNonce } from './appleNonce';
import { classifyAppleAuthFailure } from './appleAuthDiagnostics';
import { shouldAutoAdoptUnownedReceipts as shouldAdopt } from './legacyReceiptAdoption';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';

describe('API capability (installed SDK source)', () => {
  it('1/2 — auth-js exposes linkIdentity(IdToken) and signInWithIdToken', () => {
    const goTrue = fs.readFileSync(
      path.resolve(
        __dirname,
        '../node_modules/@supabase/auth-js/dist/module/GoTrueClient.d.ts'
      ),
      'utf8'
    );
    expect(goTrue).toContain(
      'linkIdentity(credentials: SignInWithIdTokenCredentials)'
    );
    expect(goTrue).toContain(
      'signInWithIdToken(credentials: SignInWithIdTokenCredentials)'
    );
    const impl = fs.readFileSync(
      path.resolve(
        __dirname,
        '../node_modules/@supabase/auth-js/dist/module/GoTrueClient.js'
      ),
      'utf8'
    );
    expect(impl).toContain('link_identity: true');
    expect(generateAppleRawNonce()).toBeTruthy();
  });

  it('diagnostics classify nonce mismatch without exposing secrets', () => {
    const d = classifyAppleAuthFailure({
      flow: 'protect',
      status: 'link_failed',
      errorMessage: 'Nonces mismatch',
    });
    expect(d.code).toBe('supabase_nonce_mismatch');
    expect(JSON.stringify(d)).not.toMatch(/eyJ/);
  });

  it('3 — nonce pair: Apple gets hashedNonce; Supabase gets rawNonce', async () => {
    const raw = 'raw-nonce-abc';
    const hashed = await (async () => {
      const { createHash } = require('crypto') as typeof import('crypto');
      return createHash('sha256').update(raw, 'utf8').digest('hex');
    })();
    expect(hashed).not.toBe(raw);

    let seenAppleNonce: string | undefined;
    const result = await requestAppleIdentityToken({
      isIos: () => true,
      isAvailableAsync: async () => true,
      createNoncePair: async () => ({ rawNonce: raw, hashedNonce: hashed }),
      signInAsync: async (opts) => {
        seenAppleNonce = opts.nonce;
        return { identityToken: 'id-token-xyz' };
      },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(seenAppleNonce).toBe(hashed);
      expect(seenAppleNonce).not.toBe(raw);
      expect(result.rawNonce).toBe(raw);
      expect(result.identityToken).toBe('id-token-xyz');
    }

    const protectSrc = fs.readFileSync(
      path.resolve(__dirname, './appleAccountProtect.ts'),
      'utf8'
    );
    const restoreSrc = fs.readFileSync(
      path.resolve(__dirname, './appleAccountRestore.ts'),
      'utf8'
    );
    const credSrc = fs.readFileSync(
      path.resolve(__dirname, './appleAuthCredential.ts'),
      'utf8'
    );
    expect(protectSrc).toContain('linkIdentity');
    expect(protectSrc).toContain('nonce: apple.rawNonce');
    expect(protectSrc).not.toMatch(/signInWithIdToken\(/);
    expect(restoreSrc).toContain('signInWithIdToken');
    expect(restoreSrc).toContain('nonce: apple.rawNonce');
    expect(restoreSrc).not.toMatch(/linkIdentity\(/);
    expect(credSrc).toContain('nonce: hashedNonce');
    expect(credSrc).not.toMatch(/nonce: rawNonce/);
  });

  it('nonce hashing: hashedNonce = SHA256(raw) hex; pairs are unique', async () => {
    const { createAppleNoncePair, sha256Hex } = require('./appleNonce') as typeof import('./appleNonce');
    const { createHash } = require('crypto') as typeof import('crypto');
    const expected = (raw: string) =>
      createHash('sha256').update(raw, 'utf8').digest('hex');

    const a = await createAppleNoncePair({ generateRaw: () => 'fixed-raw-1' });
    const b = await createAppleNoncePair({ generateRaw: () => 'fixed-raw-2' });
    expect(a.hashedNonce).toBe(await sha256Hex('fixed-raw-1'));
    expect(a.hashedNonce).toBe(expected('fixed-raw-1'));
    expect(b.hashedNonce).toBe(await sha256Hex('fixed-raw-2'));
    expect(b.hashedNonce).toBe(expected('fixed-raw-2'));
    expect(a.hashedNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(b.hashedNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hashedNonce).not.toBe(a.rawNonce);
    expect(a.hashedNonce).not.toBe(b.hashedNonce);
    expect(a.rawNonce).not.toBe(b.rawNonce);

    const c = await createAppleNoncePair();
    const d = await createAppleNoncePair();
    expect(c.rawNonce).not.toBe(d.rawNonce);
    expect(c.hashedNonce).not.toBe(d.hashedNonce);
    expect(c.hashedNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(d.hashedNonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it('production appleNonce source never requires Node crypto', () => {
    const src = fs.readFileSync(path.resolve(__dirname, './appleNonce.ts'), 'utf8');
    expect(src).toContain("from 'expo-crypto'");
    expect(src).not.toMatch(/require\(['"]crypto['"]\)/);
    expect(src).not.toMatch(/from ['"]crypto['"]/);
    expect(src).not.toMatch(/from ['"]node:crypto['"]/);
  });

  it('cancel/error does not return or persist nonce material', async () => {
    const canceled = await requestAppleIdentityToken({
      isIos: () => true,
      isAvailableAsync: async () => true,
      createNoncePair: async () => ({ rawNonce: 'r', hashedNonce: 'h' }),
      signInAsync: async () => {
        const err: any = new Error('canceled');
        err.code = 'ERR_REQUEST_CANCELED';
        throw err;
      },
    });
    expect(canceled.status).toBe('canceled');
    expect(canceled).not.toHaveProperty('rawNonce');
    expect(canceled).not.toHaveProperty('identityToken');

    const failed = await requestAppleIdentityToken({
      isIos: () => true,
      isAvailableAsync: async () => true,
      createNoncePair: async () => ({ rawNonce: 'r2', hashedNonce: 'h2' }),
      signInAsync: async () => {
        throw new Error('provider boom');
      },
    });
    expect(failed.status).toBe('error');
    expect(failed).not.toHaveProperty('rawNonce');
  });

  it('28 — app code does not persist identityToken / nonce / authorizationCode', () => {
    const files = [
      'appleAccountProtect.ts',
      'appleAccountRestore.ts',
      'appleAuthCredential.ts',
      'appleNonce.ts',
      'appleAuthDiagnostics.ts',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(__dirname, `./${f}`), 'utf8');
      expect(src).not.toMatch(/AsyncStorage\.setItem/);
      expect(src).not.toMatch(/SecureStore/);
      expect(src).not.toMatch(/console\.(log|info|debug).*identityToken/);
      expect(src).not.toMatch(/console\.(log|info|debug).*rawNonce/);
    }
    const diag = fs.readFileSync(
      path.resolve(__dirname, './appleAuthDiagnostics.ts'),
      'utf8'
    );
    expect(diag).toContain('APPLE_NONCE_VALIDATION_NOTE');
    expect(diag).toContain('Only investigate temporary nonce-verification bypass');
    expect(diag).not.toMatch(/GOTRUE_.*SKIP_NONCE/);
  });
});

describe('Protect flow', () => {
  afterEach(() => {
    __resetAnonAuthForTests();
  });

  function makeDb() {
    return {
      async getFirstAsync() {
        return { c: 0 };
      },
      async withTransactionAsync(task: () => Promise<void>) {
        await task();
      },
      async runAsync() {
        return { changes: 0 };
      },
      async execAsync() {},
      async getAllAsync() {
        return [];
      },
    };
  }

  it('4/5/6 — anonymous A → link → uid remains A; flush requested', async () => {
    const before = 'user-a';
    const linkIdentity = jest.fn(async () => ({
      data: {
        session: {
          access_token: 'tok',
          user: {
            id: before,
            is_anonymous: false,
            identities: [{ provider: 'apple', identity_id: '1', id: '1', user_id: before, identity_data: {}, created_at: '', last_sign_in_at: '', updated_at: '' }],
          },
        },
        user: {
          id: before,
          is_anonymous: false,
          identities: [{ provider: 'apple', identity_id: '1', id: '1', user_id: before, identity_data: {}, created_at: '', last_sign_in_at: '', updated_at: '' }],
        },
      },
      error: null,
    }));
    const requestFlush = jest.fn(async () => ({
      ran: false,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    }));
    const bootstrapBackup = jest.fn(async () => ({
      attempted: true,
      queued: 0,
      alreadyMarked: true,
    }));

    const result = await protectCurrentAccountWithApple({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: before,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tok',
        error: null,
      }),
      getClient: () =>
        ({
          auth: { linkIdentity },
          from: () => ({}),
        }) as any,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 'apple-token',
        rawNonce: 'nonce-1',
      }),
      applySession: applyExternalSession,
      getDb: async () => makeDb() as any,
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      bootstrapBackup: bootstrapBackup as any,
      requestFlush: requestFlush as any,
      getPlatform: () => 'ios',
      getAppVersion: () => '1.0.0',
    });

    expect(result.status).toBe('ok');
    expect(result.beforeUserId).toBe(before);
    expect(result.afterUserId).toBe(before);
    expect(linkIdentity).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'apple-token',
      nonce: 'nonce-1',
    });
    expect(bootstrapBackup).toHaveBeenCalled();
    expect(requestFlush).toHaveBeenCalled();
    expect(getAuthState().userId).toBe(before);
    expect(getAuthState().hasAppleIdentity).toBe(true);
  });

  it('9 — Apple cancel → session/data unchanged', async () => {
    const linkIdentity = jest.fn();
    const result = await protectCurrentAccountWithApple({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'user-a',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tok',
        error: null,
      }),
      getClient: () => ({ auth: { linkIdentity }, from: () => ({}) }) as any,
      requestAppleCredential: async () => ({ status: 'canceled' }),
      applySession: applyExternalSession,
      getDb: async () => makeDb() as any,
      getInstallationId: async () => 'i',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      bootstrapBackup: async () => ({ attempted: false, queued: 0, alreadyMarked: true }),
      requestFlush: async () => ({ ran: false, processed: 0, succeeded: 0, failed: 0, skipped: 0 }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('canceled');
    expect(linkIdentity).not.toHaveBeenCalled();
  });

  it('10 — link error → no ownership rewrite', async () => {
    const result = await protectCurrentAccountWithApple({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'user-a',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tok',
        error: null,
      }),
      getClient: () =>
        ({
          auth: {
            linkIdentity: async () => ({
              data: { user: null, session: null },
              error: { message: 'network' },
            }),
          },
          from: () => ({}),
        }) as any,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 't',
        rawNonce: 'n',
      }),
      applySession: applyExternalSession,
      getDb: async () => makeDb() as any,
      getInstallationId: async () => 'i',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      bootstrapBackup: async () => ({ attempted: false, queued: 0, alreadyMarked: true }),
      requestFlush: async () => ({ ran: false, processed: 0, succeeded: 0, failed: 0, skipped: 0 }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('link_failed');
  });

  it('11-15 — Apple identity already on B → conflict; no switch/merge', async () => {
    const result = await protectCurrentAccountWithApple({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'user-a',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tok',
        error: null,
      }),
      getClient: () =>
        ({
          auth: {
            linkIdentity: async () => ({
              data: { user: null, session: null },
              error: { message: 'Identity is already linked to another user' },
            }),
          },
          from: () => ({}),
        }) as any,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 't',
        rawNonce: 'n',
      }),
      applySession: applyExternalSession,
      getDb: async () => makeDb() as any,
      getInstallationId: async () => 'i',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      bootstrapBackup: async () => ({ attempted: false, queued: 0, alreadyMarked: true }),
      requestFlush: async () => ({ ran: false, processed: 0, succeeded: 0, failed: 0, skipped: 0 }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('apple_identity_in_use');
  });

  it('uid_changed is critical failure', async () => {
    const result = await protectCurrentAccountWithApple({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'user-a',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tok',
        error: null,
      }),
      getClient: () =>
        ({
          auth: {
            linkIdentity: async () => ({
              data: {
                session: {
                  access_token: 't',
                  user: { id: 'user-b', is_anonymous: false, identities: [] },
                },
                user: { id: 'user-b', is_anonymous: false, identities: [] },
              },
              error: null,
            }),
          },
          from: () => ({}),
        }) as any,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 't',
        rawNonce: 'n',
      }),
      applySession: applyExternalSession,
      getDb: async () => makeDb() as any,
      getInstallationId: async () => 'i',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      bootstrapBackup: async () => ({ attempted: false, queued: 0, alreadyMarked: true }),
      requestFlush: async () => ({ ran: false, processed: 0, succeeded: 0, failed: 0, skipped: 0 }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('uid_changed');
  });
});

describe('Protection status 7/8', () => {
  const readyScope = {
    status: 'ready' as const,
    ownerKey: 'user:u',
    receiptWhereSql: 'receipts.user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: ['u'],
  };

  it('pending outbox → linked-but-pending; empty → protected', async () => {
    const pending = await getAccountProtectionStatus({
      getAuth: () => ({
        status: 'authenticated',
        userId: 'u',
        isAnonymous: false,
        hasAppleIdentity: true,
        accessToken: 't',
        error: null,
      }),
      getDb: async () =>
        ({
          getFirstAsync: async (sql: string) => {
            if (/sync_outbox/i.test(sql)) return { c: 2 };
            return { c: 5 };
          },
        }) as any,
      resolveOwnerScope: async () => readyScope,
      countScopedLocalReceiptsForScope: async () => 5,
    });
    expect(pending.uiState).toBe('apple_linked_backup_pending');

    const protectedState = await getAccountProtectionStatus({
      getAuth: () => ({
        status: 'authenticated',
        userId: 'u',
        isAnonymous: false,
        hasAppleIdentity: true,
        accessToken: 't',
        error: null,
      }),
      getDb: async () =>
        ({
          getFirstAsync: async () => ({ c: 0 }),
        }) as any,
      resolveOwnerScope: async () => readyScope,
      countScopedLocalReceiptsForScope: async () => 3,
    });
    expect(protectedState.uiState).toBe('apple_linked_protected');
  });
});

describe('Restore flow', () => {
  it('16/17 — local receipts / pending outbox blocked BEFORE Apple', async () => {
    const requestApple = jest.fn();
    const signIn = jest.fn();

    const blockedLocal = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'temp-x',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 't',
        error: null,
      }),
      getClient: () => ({ auth: { signInWithIdToken: signIn }, from: () => ({}) }) as any,
      getDb: async () =>
        ({
          getFirstAsync: async (sql: string) => {
            if (/FROM receipts/i.test(sql)) return { c: 3 };
            return { c: 0 };
          },
        }) as any,
      requestAppleCredential: requestApple as any,
      applySession: applyExternalSession,
      restoreCloud: async () => ({ status: 'ok', restored: 0 }),
      getInstallationId: async () => 'install-x',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(blockedLocal.status).toBe('blocked_local_data_present');
    expect(requestApple).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();

    const blockedOutbox = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'temp-x',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 't',
        error: null,
      }),
      getClient: () => ({ auth: { signInWithIdToken: signIn }, from: () => ({}) }) as any,
      getDb: async () =>
        ({
          getFirstAsync: async (sql: string) => {
            if (/FROM receipts/i.test(sql)) return { c: 0 };
            return { c: 1 };
          },
        }) as any,
      requestAppleCredential: requestApple as any,
      applySession: applyExternalSession,
      restoreCloud: async () => ({ status: 'ok', restored: 0 }),
      getInstallationId: async () => 'install-x',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(blockedOutbox.status).toBe('blocked_pending_local_changes');
  });

  it('18-22 — empty local → Apple sign-in A → install register → Phase 6 restore', async () => {
    __resetAnonAuthForTests();
    const registerInstallation = jest.fn(async () => ({ attempted: true, ok: true }));
    const restoreCloud = jest.fn(async () => ({ status: 'ok' as const, restored: 4 }));
    const signInWithIdToken = jest.fn(async () => ({
      data: {
        session: {
          access_token: 'tok-a',
          user: {
            id: 'user-a',
            is_anonymous: false,
            identities: [{ provider: 'apple', identity_id: '1', id: '1', user_id: 'user-a', identity_data: {}, created_at: '', last_sign_in_at: '', updated_at: '' }],
          },
        },
        user: {
          id: 'user-a',
          is_anonymous: false,
          identities: [{ provider: 'apple', identity_id: '1', id: '1', user_id: 'user-a', identity_data: {}, created_at: '', last_sign_in_at: '', updated_at: '' }],
        },
      },
      error: null,
    }));

    const result = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => {
        const s = getAuthState();
        if (s.status === 'authenticated' && s.userId) return s;
        return {
          status: 'authenticated',
          userId: 'temp-x',
          isAnonymous: true,
          hasAppleIdentity: false,
          accessToken: 'tx',
          error: null,
        };
      },
      getClient: () =>
        ({ auth: { signInWithIdToken }, from: () => ({}) }) as any,
      getDb: async () =>
        ({
          getFirstAsync: async () => ({ c: 0 }),
        }) as any,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 'idtok',
        rawNonce: 'raw',
      }),
      applySession: applyExternalSession,
      restoreCloud: restoreCloud as any,
      getInstallationId: async () => 'install-same',
      registerInstallation: registerInstallation as any,
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });

    expect(result.status).toBe('ok');
    expect(result.temporaryUserId).toBe('temp-x');
    expect(result.restoredUserId).toBe('user-a');
    expect(result.restoredCount).toBe(4);
    expect(signInWithIdToken).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'idtok',
      nonce: 'raw',
    });
    expect(registerInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        installationId: 'install-same',
      })
    );
    expect(restoreCloud).toHaveBeenCalled();
  });

  it('23 — restore failure keeps session A', async () => {
    __resetAnonAuthForTests();
    const result = await restoreExistingAppleAccount({
      isEnabled: () => true,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'temp-x',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tx',
        error: null,
      }),
      getClient: () =>
        ({
          auth: {
            signInWithIdToken: async () => ({
              data: {
                session: {
                  access_token: 'tok-a',
                  user: { id: 'user-a', is_anonymous: false, identities: [{ provider: 'apple' }] },
                },
                user: { id: 'user-a', is_anonymous: false, identities: [{ provider: 'apple' }] },
              },
              error: null,
            }),
          },
          from: () => ({}),
        }) as any,
      getDb: async () => ({ getFirstAsync: async () => ({ c: 0 }) }) as any,
      requestAppleCredential: async () => ({
        status: 'ok',
        identityToken: 't',
        rawNonce: 'n',
      }),
      applySession: applyExternalSession,
      restoreCloud: async () => ({ status: 'fetch_failed', restored: 0, error: 'net' }),
      getInstallationId: async () => 'i',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1',
    });
    expect(result.status).toBe('restore_failed');
    expect(result.restoredUserId).toBe('user-a');
    expect(getAuthState().userId).toBe('user-a');
  });
});

describe('Orchestrator boundaries 26/27', () => {
  it('non-anonymous after link must not auto-adopt', () => {
    expect(shouldAdopt({ is_anonymous: true })).toBe(true);
    expect(shouldAdopt({ is_anonymous: false })).toBe(false);
    expect(shouldAdopt({ isAnonymous: false })).toBe(false);
  });

  it('userHasAppleIdentity derives from identities', () => {
    expect(
      userHasAppleIdentity({
        id: 'u',
        identities: [{ provider: 'apple' } as any],
      } as any)
    ).toBe(true);
    expect(
      userHasAppleIdentity({
        id: 'u',
        identities: [{ provider: 'email' } as any],
      } as any)
    ).toBe(false);
  });
});

describe('Regression', () => {
  it('31 — Build 34 samples unchanged', () => {
    expect(
      normalizeOcrAnalysis({
        merchant: 'コストコ',
        currency: 'JPY',
        total: 8351,
        tax: 619,
        discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
        items: [
          { name: 'A', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
          { name: 'ROCHER ORIGINS CPN', quantity: 1, unitPrice: -600, lineTotal: -600 },
        ],
      } as any).total
    ).toBe(8351);
  });

  it('flag + usesAppleSignIn + plugin present', () => {
    const env = fs.readFileSync(path.resolve(__dirname, './env.ts'), 'utf8');
    const cfg = fs.readFileSync(path.resolve(__dirname, '../app.config.js'), 'utf8');
    expect(env).toContain('isAppleLinkEnabled');
    expect(cfg).toContain('ENABLE_APPLE_LINK');
    expect(cfg).toContain('expo-apple-authentication');
    expect(cfg).toContain('usesAppleSignIn: true');
  });
});
