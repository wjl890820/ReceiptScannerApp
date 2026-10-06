/**
 * On-demand OCR anonymous auth. Uses the real ensureAnonAuth helper.
 * ENABLE_ANON_AUTH=false must not sign in.
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', extra: {} } },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

import { createClient } from '@supabase/supabase-js';

import { __resetAnonAuthForTests, applyExternalSession, bootstrapAnonAuth, getAccessTokenIfReady } from './anonAuth';
import { __resetSupabaseConfigForTests } from './env';
import { ensureOcrUserAccessToken, SUPABASE_EDGE_AUTH_FAILURE_MESSAGE } from './ocrAuthHeaders';
import { __resetSupabaseClientForTests } from './supabaseClient';

const URL = 'https://example.supabase.co';
const PROJECT_KEY = `sb_publishable_${'C'.repeat(22)}_${'d'.repeat(8)}`;
const USER_JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbm9uIn0.signature';
const OLD_JWT = 'eyJ.old.cachedtoken';
const NEW_JWT = 'eyJ.new.refreshedtoken';

function session(accessToken: string) {
  return {
    access_token: accessToken,
    user: {
      id: 'anon-user',
      is_anonymous: true,
      app_metadata: { provider: 'anonymous' },
    },
  };
}

describe('ensureOcrUserAccessToken', () => {
  const prevFlag = process.env.ENABLE_ANON_AUTH;
  const prevUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    __resetAnonAuthForTests();
    __resetSupabaseClientForTests();
    __resetSupabaseConfigForTests();
    process.env.EXPO_PUBLIC_SUPABASE_URL = URL;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = PROJECT_KEY;
    delete process.env.ENABLE_ANON_AUTH;
    (createClient as jest.Mock).mockReset();
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env.ENABLE_ANON_AUTH;
    else process.env.ENABLE_ANON_AUTH = prevFlag;
    if (prevUrl === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    else process.env.EXPO_PUBLIC_SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = prevKey;
    __resetAnonAuthForTests();
    __resetSupabaseClientForTests();
    __resetSupabaseConfigForTests();
  });

  function installClient(auth: {
    getSession: () => Promise<{ data: { session: ReturnType<typeof session> | null }; error: null }>;
    signInAnonymously: jest.Mock;
  }): void {
    (createClient as jest.Mock).mockReturnValue({
      auth: {
        ...auth,
        startAutoRefresh: jest.fn(),
        stopAutoRefresh: jest.fn(),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: async () => ({ error: null }),
      }),
    });
  }

  it('uses the current Supabase session token', async () => {
    const signInAnonymously = jest.fn();
    installClient({
      signInAnonymously,
      getSession: async () => ({ data: { session: session(USER_JWT) }, error: null }),
    });
    delete process.env.ENABLE_ANON_AUTH;
    await expect(ensureOcrUserAccessToken(PROJECT_KEY)).resolves.toBe(USER_JWT);
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('prefers a refreshed session token over the copied anonAuth token', async () => {
    applyExternalSession(session(OLD_JWT) as any);
    expect(getAccessTokenIfReady()).toBe(OLD_JWT);
    const signInAnonymously = jest.fn();
    installClient({
      signInAnonymously,
      getSession: async () => ({ data: { session: session(NEW_JWT) }, error: null }),
    });
    await expect(ensureOcrUserAccessToken(PROJECT_KEY)).resolves.toBe(NEW_JWT);
    expect(getAccessTokenIfReady()).toBe(OLD_JWT);
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('does not trust a copied token when the Supabase session is absent', async () => {
    applyExternalSession(session(OLD_JWT) as any);
    const signInAnonymously = jest.fn();
    installClient({
      signInAnonymously,
      getSession: async () => ({ data: { session: null }, error: null }),
    });
    delete process.env.ENABLE_ANON_AUTH;
    await expect(ensureOcrUserAccessToken(PROJECT_KEY)).rejects.toThrow(SUPABASE_EDGE_AUTH_FAILURE_MESSAGE);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(getAccessTokenIfReady()).toBe(OLD_JWT);
  });

  it('re-reads the current session after on-demand anonymous sign-in', async () => {
    let signedIn = false;
    const signInAnonymously = jest.fn(async () => {
      signedIn = true;
      return { data: { session: session(OLD_JWT), user: session(OLD_JWT).user }, error: null };
    });
    installClient({
      signInAnonymously,
      getSession: async () => ({
        data: { session: signedIn ? session(NEW_JWT) : null },
        error: null,
      }),
    });
    process.env.ENABLE_ANON_AUTH = 'true';
    await expect(ensureOcrUserAccessToken(PROJECT_KEY)).resolves.toBe(NEW_JWT);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
    expect(getAccessTokenIfReady()).toBe(OLD_JWT);
  });

  it('does not sign in when anonymous auth is off and no session exists', async () => {
    const signInAnonymously = jest.fn();
    installClient({
      signInAnonymously,
      getSession: async () => ({ data: { session: null }, error: null }),
    });
    delete process.env.ENABLE_ANON_AUTH;
    await expect(ensureOcrUserAccessToken(PROJECT_KEY)).rejects.toThrow(SUPABASE_EDGE_AUTH_FAILURE_MESSAGE);
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('shares one anonymous sign-in between bootstrap and OCR', async () => {
    let token: string | null = null;
    let releaseSignIn: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSignIn = resolve;
    });
    const signInAnonymously = jest.fn(async () => {
      await gate;
      token = USER_JWT;
      return { data: { session: session(USER_JWT), user: session(USER_JWT).user }, error: null };
    });
    installClient({
      signInAnonymously,
      getSession: async () => ({
        data: { session: token ? session(token) : null },
        error: null,
      }),
    });
    process.env.ENABLE_ANON_AUTH = 'true';
    const ocr = ensureOcrUserAccessToken(PROJECT_KEY);
    bootstrapAnonAuth();
    await new Promise((resolve) => setImmediate(resolve));
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
    releaseSignIn();
    await expect(ocr).resolves.toBe(USER_JWT);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('does not create a second anonymous user for concurrent OCR auth', async () => {
    let token: string | null = null;
    let releaseSignIn: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSignIn = resolve;
    });
    const signInAnonymously = jest.fn(async () => {
      await gate;
      token = USER_JWT;
      return { data: { session: session(USER_JWT), user: session(USER_JWT).user }, error: null };
    });
    installClient({
      signInAnonymously,
      getSession: async () => ({
        data: { session: token ? session(token) : null },
        error: null,
      }),
    });
    process.env.ENABLE_ANON_AUTH = 'true';
    const first = ensureOcrUserAccessToken(PROJECT_KEY);
    const second = ensureOcrUserAccessToken(PROJECT_KEY);
    await new Promise((resolve) => setImmediate(resolve));
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
    releaseSignIn();
    await expect(Promise.all([first, second])).resolves.toEqual([USER_JWT, USER_JWT]);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('retries a failed anonymous sign-in after the cooldown', async () => {
    const now = { t: 1_700_000_000_000 };
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now.t);
    try {
      let token: string | null = null;
      let fail = true;
      const signInAnonymously = jest.fn(async () => {
        if (fail) {
          return { data: { session: null, user: null }, error: { message: 'temporary' } };
        }
        token = NEW_JWT;
        return { data: { session: session(NEW_JWT), user: session(NEW_JWT).user }, error: null };
      });
      installClient({
        signInAnonymously,
        getSession: async () => ({
          data: { session: token ? session(token) : null },
          error: null,
        }),
      });
      process.env.ENABLE_ANON_AUTH = 'true';
      await expect(ensureOcrUserAccessToken(PROJECT_KEY)).rejects.toThrow(
        SUPABASE_EDGE_AUTH_FAILURE_MESSAGE
      );
      await expect(ensureOcrUserAccessToken(PROJECT_KEY)).rejects.toThrow(
        SUPABASE_EDGE_AUTH_FAILURE_MESSAGE
      );
      expect(signInAnonymously).toHaveBeenCalledTimes(1);
      fail = false;
      now.t += 60_000;
      await expect(ensureOcrUserAccessToken(PROJECT_KEY)).resolves.toBe(NEW_JWT);
      expect(signInAnonymously).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
