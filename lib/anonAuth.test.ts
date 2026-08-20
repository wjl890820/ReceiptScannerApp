/**
 * P0 Phase 3 — Anonymous auth + installation identity tests.
 */
/* eslint-disable import/first -- mocks must run before module imports. */
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', extra: {} } },
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const map = new Map<string, string>();
  return {
    getItem: jest.fn(async (key: string) => (map.has(key) ? map.get(key)! : null)),
    setItem: jest.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
    __map: map,
  };
});

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: {} })),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  __resetAnonAuthForTests,
  ensureAnonAuth,
  getAccessTokenIfReady,
  getAuthState,
  type AnonAuthDeps,
} from './anonAuth';
import {
  __resetInstallationIdMemoryForTests,
  getOrCreateInstallationId,
  INSTALLATION_ID_STORAGE_KEY,
} from './installationId';
import { registerInstallationForUser } from './installationRegistration';
import { resolveOcrAuthorizationBearer } from './ocrAuthHeaders';
import { parseProvenanceFeatureFlags } from '../supabase/functions/ocr-receipt/ocrProvenance';
import { resolveVerifiedUserId } from '../supabase/functions/ocr-receipt/verifyAuthUser';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';

function makeMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: async (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: async (key: string, value: string) => {
      map.set(key, value);
    },
    _map: map,
  };
}

function makeSession(userId: string, accessToken = 'eyJ.user.token') {
  return {
    access_token: accessToken,
    user: {
      id: userId,
      is_anonymous: true,
      app_metadata: { provider: 'anonymous' },
    },
  } as any;
}

describe('ENABLE_ANON_AUTH / provenance write defaults', () => {
  it('OCR_PROVENANCE_WRITE defaults to false (opt-in)', () => {
    expect(parseProvenanceFeatureFlags({})).toEqual({
      responseEnabled: true,
      writeEnabled: false,
    });
  });
});

describe('Anonymous auth lifecycle', () => {
  beforeEach(() => {
    __resetAnonAuthForTests();
  });

  it('1 — no session → one anonymous sign-in attempt', async () => {
    let signInCalls = 0;
    const deps: AnonAuthDeps = {
      isEnabled: () => true,
      getClient: () =>
        ({
          auth: {
            getSession: async () => ({ data: { session: null }, error: null }),
            signInAnonymously: async () => {
              signInCalls += 1;
              return {
                data: { session: makeSession('user-new'), user: makeSession('user-new').user },
                error: null,
              };
            },
          },
          from: () => {
            throw new Error('registration mocked separately');
          },
        }) as any,
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1.0.0',
      nowMs: () => 1_000_000,
    };

    const state = await ensureAnonAuth(deps);
    expect(signInCalls).toBe(1);
    expect(state.status).toBe('authenticated');
    expect(state.userId).toBe('user-new');
  });

  it('2 — existing session → no new anonymous user', async () => {
    let signInCalls = 0;
    const deps: AnonAuthDeps = {
      isEnabled: () => true,
      getClient: () =>
        ({
          auth: {
            getSession: async () => ({
              data: { session: makeSession('user-existing', 'eyJ.existing.token') },
              error: null,
            }),
            signInAnonymously: async () => {
              signInCalls += 1;
              throw new Error('should not sign in');
            },
          },
          from: () => ({}),
        }) as any,
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1.0.0',
      nowMs: () => 1_000_000,
    };

    const state = await ensureAnonAuth(deps);
    expect(signInCalls).toBe(0);
    expect(state.userId).toBe('user-existing');
    expect(getAccessTokenIfReady()).toBe('eyJ.existing.token');
  });

  it('3 — concurrent initialization → single-flight, no duplicate users', async () => {
    let signInCalls = 0;
    let releaseSignIn: (value: any) => void = () => {};
    const signInGate = new Promise((resolve) => {
      releaseSignIn = resolve;
    });

    const deps: AnonAuthDeps = {
      isEnabled: () => true,
      getClient: () =>
        ({
          auth: {
            getSession: async () => ({ data: { session: null }, error: null }),
            signInAnonymously: async () => {
              signInCalls += 1;
              await signInGate;
              return {
                data: { session: makeSession('user-once'), user: makeSession('user-once').user },
                error: null,
              };
            },
          },
          from: () => ({}),
        }) as any,
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1.0.0',
      nowMs: () => 1_000_000,
    };

    const p1 = ensureAnonAuth(deps);
    const p2 = ensureAnonAuth(deps);
    releaseSignIn(undefined);
    const [a, b] = await Promise.all([p1, p2]);
    expect(signInCalls).toBe(1);
    expect(a.userId).toBe('user-once');
    expect(b.userId).toBe('user-once');
  });

  it('4 — auth network failure → app remains usable / state unavailable', async () => {
    const deps: AnonAuthDeps = {
      isEnabled: () => true,
      getClient: () =>
        ({
          auth: {
            getSession: async () => {
              throw new Error('network down');
            },
            signInAnonymously: async () => {
              throw new Error('network down');
            },
          },
          from: () => ({}),
        }) as any,
      getInstallationId: async () => 'install-1',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1.0.0',
      nowMs: () => 1_000_000,
    };

    const state = await ensureAnonAuth(deps);
    expect(state.status).toBe('unavailable');
    expect(state.userId).toBeNull();
    expect(getAccessTokenIfReady()).toBeNull();
    // OCR bearer falls back to anon key
    await expect(resolveOcrAuthorizationBearer('eyJ.anon.key')).resolves.toBe('eyJ.anon.key');
  });

  it('5 — persisted session reused after restart abstraction', async () => {
    const deps: AnonAuthDeps = {
      isEnabled: () => true,
      getClient: () =>
        ({
          auth: {
            getSession: async () => ({
              data: { session: makeSession('user-persisted', 'eyJ.persisted.token') },
              error: null,
            }),
            signInAnonymously: async () => {
              throw new Error('should not create new user');
            },
          },
          from: () => ({}),
        }) as any,
      getInstallationId: async () => 'install-stable',
      registerInstallation: async () => ({ attempted: true, ok: true }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1.0.0',
      nowMs: () => 1_000_000,
    };

    __resetAnonAuthForTests();
    const first = await ensureAnonAuth(deps);
    __resetAnonAuthForTests();
    // Simulate cold start: memory cleared, storage session still returned by getSession
    const second = await ensureAnonAuth(deps);
    expect(first.userId).toBe('user-persisted');
    expect(second.userId).toBe('user-persisted');
    expect(second.accessToken).toBe('eyJ.persisted.token');
  });

  it('flag OFF → unavailable without sign-in', async () => {
    const deps: AnonAuthDeps = {
      isEnabled: () => false,
      getClient: () => {
        throw new Error('client should not be created');
      },
      getInstallationId: async () => 'x',
      registerInstallation: async () => ({ attempted: false, ok: false }),
      getPlatform: () => 'ios',
      getAppVersion: () => '1.0.0',
      nowMs: () => 1,
    };
    const state = await ensureAnonAuth(deps);
    expect(state.status).toBe('unavailable');
    expect(getAuthState().status).toBe('unavailable');
  });
});

describe('installation_id', () => {
  beforeEach(() => {
    __resetInstallationIdMemoryForTests();
  });

  it('6 — installation_id stable during same installation', async () => {
    const storage = makeMemoryStorage();
    const a = await getOrCreateInstallationId(storage);
    const b = await getOrCreateInstallationId(storage);
    expect(a).toBe(b);
    expect(storage._map.get(INSTALLATION_ID_STORAGE_KEY)).toBe(a);
  });

  it('7 — installation_id distinct from legacy deviceId semantics', async () => {
    const storage = makeMemoryStorage();
    const installationId = await getOrCreateInstallationId(storage);
    // Legacy deviceId uses SecureStore key receipt_scanner_device_id — different key/space
    expect(INSTALLATION_ID_STORAGE_KEY).not.toBe('receipt_scanner_device_id');
    expect(installationId).not.toBe('receipt_scanner_device_id');
    expect(installationId.length).toBeGreaterThan(10);
  });
});

describe('cloud installation registration', () => {
  function createInstallationsMock() {
    const rows: Array<{
      row_id: string;
      user_id: string;
      installation_id: string;
      platform?: string | null;
      app_version?: string | null;
      first_seen_at?: string;
      last_seen_at?: string;
    }> = [];

    const supabase = {
      from: (table: string) => {
        expect(table).toBe('installations');
        return {
          select: (_cols: string) => ({
            eq: (col1: string, val1: string) => ({
              eq: (col2: string, val2: string) => ({
                maybeSingle: async () => {
                  const found = rows.find(
                    (r) =>
                      (col1 === 'user_id' ? r.user_id === val1 : r.installation_id === val1) &&
                      (col2 === 'installation_id' ? r.installation_id === val2 : r.user_id === val2)
                  );
                  return { data: found ? { row_id: found.row_id } : null, error: null };
                },
              }),
            }),
          }),
          insert: async (row: any) => {
            rows.push({
              row_id: `row-${rows.length + 1}`,
              ...row,
            });
            return { error: null };
          },
          update: (patch: any) => ({
            eq: async (col: string, val: string) => {
              const row = rows.find((r) => (col === 'row_id' ? r.row_id === val : false));
              if (row) Object.assign(row, patch);
              return { error: null };
            },
          }),
        };
      },
      _rows: rows,
    };
    return supabase;
  }

  it('8 — cloud installation registration uses authenticated user_id', async () => {
    const supabase = createInstallationsMock();
    const result = await registerInstallationForUser({
      supabase,
      userId: 'auth-user-A',
      installationId: 'install-X',
      platform: 'ios',
      appVersion: '1.0.5',
      nowIso: '2026-08-20T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    expect(supabase._rows).toHaveLength(1);
    expect(supabase._rows[0].user_id).toBe('auth-user-A');
    expect(supabase._rows[0].installation_id).toBe('install-X');
  });

  it('9 — installation registration failure is nonfatal', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: { message: 'network' } }),
            }),
          }),
        }),
      }),
    };
    const result = await registerInstallationForUser({
      supabase,
      userId: 'u1',
      installationId: 'i1',
    });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('10 — another auth user can register the same installation_id', async () => {
    const supabase = createInstallationsMock();
    await registerInstallationForUser({
      supabase,
      userId: 'user-A',
      installationId: 'same-install',
      nowIso: '2026-08-20T00:00:00.000Z',
    });
    await registerInstallationForUser({
      supabase,
      userId: 'user-B',
      installationId: 'same-install',
      nowIso: '2026-08-20T01:00:00.000Z',
    });
    expect(supabase._rows).toHaveLength(2);
    expect(supabase._rows.map((r) => r.user_id).sort()).toEqual(['user-A', 'user-B']);
    expect(supabase._rows.every((r) => r.installation_id === 'same-install')).toBe(true);
  });
});

describe('Phase 2 auth verification boundary', () => {
  it('11 — forged/decode-only JWT cannot supply user_id without Auth verification', async () => {
    // Three-part JWT with forged sub — must not be trusted without getUser success
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'forged-user-id', role: 'authenticated' })
    ).toString('base64url');
    const forgedJwt = `eyJhbGciOiJub25lIn0.${forgedPayload}.fakesig`;

    const rejected = await resolveVerifiedUserId({
      bearerToken: forgedJwt,
      verifyWithSupabaseAuth: async () => ({
        data: { user: null },
        error: { message: 'invalid claim: missing sub' },
      }),
    });
    expect(rejected).toBeNull();

    const accepted = await resolveVerifiedUserId({
      bearerToken: forgedJwt,
      verifyWithSupabaseAuth: async (jwt) => {
        expect(jwt).toBe(forgedJwt);
        return {
          data: { user: { id: 'verified-real-user' } },
          error: null,
        };
      },
    });
    expect(accepted).toBe('verified-real-user');
  });

  it('Edge source uses resolveVerifiedUserId + getUser (not payload decode)', () => {
    const edgeSource = fs.readFileSync(
      path.resolve(__dirname, '../supabase/functions/ocr-receipt/index.ts'),
      'utf8'
    );
    expect(edgeSource).toContain("from './verifyAuthUser.ts'");
    expect(edgeSource).toContain('resolveVerifiedUserId');
    expect(edgeSource).toContain('auth.getUser');
    expect(edgeSource).not.toMatch(/JSON\.parse\s*\(\s*atob\s*\(/);
    expect(edgeSource).not.toMatch(/payload\.sub/);
  });
});

describe('Build 34 OCR semantic regression', () => {
  it('12 — Sample 007 totals unchanged by Phase 3 client auth wiring', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 8351,
      tax: 619,
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
      items: [
        { name: 'A', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'ROCHER ORIGINS CPN', quantity: 1, unitPrice: -600, lineTotal: -600 },
      ],
    } as any);
    expect(out.total).toBe(8351);
    expect(out.tax).toBe(619);
  });
});

describe('004 migration amendments (source)', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../supabase/migrations/004_p0_user_data.sql'),
    'utf8'
  );

  it('installations uses row_id + UNIQUE(user_id, installation_id); no device_id_hash; no receipt FK', () => {
    expect(sql).toContain('row_id UUID PRIMARY KEY');
    expect(sql).toContain('UNIQUE (user_id, installation_id)');
    expect(sql).not.toContain('device_id_hash');
    expect(sql).toMatch(/installation_id TEXT,/);
    expect(sql).not.toMatch(/installation_id TEXT REFERENCES public\.installations/);
  });
});
