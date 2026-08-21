/**
 * P0 Phase 3 — Anonymous Auth lifecycle (no login wall).
 *
 * App remains usable when auth fails/offline.
 * Does NOT adopt receipts, backup, restore, or Apple login.
 */
import type { Session, User } from '@supabase/supabase-js';

import { isAnonAuthEnabled } from './env';
import { getOrCreateInstallationId } from './installationId';
import { registerInstallationForUser } from './installationRegistration';
import { getSupabaseClient } from './supabaseClient';

export type AuthStatus = 'initializing' | 'authenticated' | 'unavailable';

export type AuthState = {
  status: AuthStatus;
  userId: string | null;
  isAnonymous: boolean | null;
  /** True when Supabase user.identities includes provider === 'apple' */
  hasAppleIdentity: boolean | null;
  accessToken: string | null;
  error: string | null;
};

export type AnonAuthDeps = {
  isEnabled: () => boolean;
  getClient: () => {
    auth: {
      getSession: () => Promise<{ data: { session: Session | null }; error: { message?: string } | null }>;
      signInAnonymously: () => Promise<{
        data: { session: Session | null; user: User | null };
        error: { message?: string } | null;
      }>;
    };
    from: (table: string) => any;
  } | null;
  getInstallationId: () => Promise<string>;
  registerInstallation: typeof registerInstallationForUser;
  getPlatform: () => string;
  getAppVersion: () => string;
  nowMs: () => number;
};

const INITIAL_STATE: AuthState = {
  status: 'initializing',
  userId: null,
  isAnonymous: null,
  hasAppleIdentity: null,
  accessToken: null,
  error: null,
};

let _state: AuthState = { ...INITIAL_STATE };
let _inflight: Promise<AuthState> | null = null;
let _lastFailureAtMs = 0;
const RETRY_COOLDOWN_MS = 60_000;

type Listener = (state: AuthState) => void;
const _listeners = new Set<Listener>();

function emit(): void {
  for (const listener of _listeners) {
    try {
      listener(_state);
    } catch {
      // ignore listener errors
    }
  }
}

function setState(next: AuthState): AuthState {
  _state = next;
  emit();
  return _state;
}

export function userHasAppleIdentity(user: User | null | undefined): boolean {
  if (!user) return false;
  const identities = user.identities;
  if (!Array.isArray(identities)) return false;
  return identities.some((i) => i?.provider === 'apple');
}

function sessionToState(session: Session): AuthState {
  const user = session.user;
  const isAnonymous = Boolean(
    (user as { is_anonymous?: boolean }).is_anonymous ||
      user.app_metadata?.provider === 'anonymous'
  );
  return {
    status: 'authenticated',
    userId: user.id,
    isAnonymous,
    hasAppleIdentity: userHasAppleIdentity(user),
    accessToken: session.access_token || null,
    error: null,
  };
}

function defaultDeps(): AnonAuthDeps {
  // Lazy require RN modules so Jest unit tests can import this module without Expo natives.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Constants = require('expo-constants').default as typeof import('expo-constants').default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native') as typeof import('react-native');

  return {
    isEnabled: isAnonAuthEnabled,
    getClient: getSupabaseClient,
    getInstallationId: getOrCreateInstallationId,
    registerInstallation: registerInstallationForUser,
    getPlatform: () =>
      Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : Platform.OS,
    getAppVersion: () => Constants.expoConfig?.version || '1.0.0',
    nowMs: () => Date.now(),
  };
}

async function registerInstallationBestEffort(
  deps: AnonAuthDeps,
  client: NonNullable<ReturnType<AnonAuthDeps['getClient']>>,
  userId: string
): Promise<void> {
  try {
    const installationId = await deps.getInstallationId();
    await deps.registerInstallation({
      supabase: client,
      userId,
      installationId,
      platform: deps.getPlatform(),
      appVersion: deps.getAppVersion(),
    });
  } catch (e) {
    console.warn('[AnonAuth] installation registration failed (nonfatal):', e);
  }
}

async function runEnsureAuth(deps: AnonAuthDeps): Promise<AuthState> {
  if (!deps.isEnabled()) {
    return setState({
      status: 'unavailable',
      userId: null,
      isAnonymous: null,
      hasAppleIdentity: null,
      accessToken: null,
      error: null,
    });
  }

  const now = deps.nowMs();
  if (
    _state.status === 'unavailable' &&
    _lastFailureAtMs > 0 &&
    now - _lastFailureAtMs < RETRY_COOLDOWN_MS
  ) {
    return _state;
  }

  setState({
    status: 'initializing',
    userId: _state.userId,
    isAnonymous: _state.isAnonymous,
    hasAppleIdentity: _state.hasAppleIdentity,
    accessToken: _state.accessToken,
    error: null,
  });

  const client = deps.getClient();
  if (!client) {
    _lastFailureAtMs = now;
    return setState({
      status: 'unavailable',
      userId: null,
      isAnonymous: null,
      hasAppleIdentity: null,
      accessToken: null,
      error: 'supabase_client_unavailable',
    });
  }

  try {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) {
      console.warn('[AnonAuth] getSession error:', sessionError.message || sessionError);
    }

    const existing = sessionData?.session;
    if (existing?.user?.id && existing.access_token) {
      const next = setState(sessionToState(existing));
      void registerInstallationBestEffort(deps, client, existing.user.id);
      _lastFailureAtMs = 0;
      return next;
    }

    const { data: signInData, error: signInError } = await client.auth.signInAnonymously();
    if (signInError || !signInData?.session?.user?.id) {
      _lastFailureAtMs = now;
      return setState({
        status: 'unavailable',
        userId: null,
        isAnonymous: null,
        hasAppleIdentity: null,
        accessToken: null,
        error: signInError?.message || 'anonymous_sign_in_failed',
      });
    }

    const next = setState(sessionToState(signInData.session));
    void registerInstallationBestEffort(deps, client, signInData.session.user.id);
    _lastFailureAtMs = 0;
    return next;
  } catch (e: any) {
    _lastFailureAtMs = now;
    return setState({
      status: 'unavailable',
      userId: null,
      isAnonymous: null,
      hasAppleIdentity: null,
      accessToken: null,
      error: String(e?.message || e || 'auth_network_error'),
    });
  }
}

/**
 * Ensure an anonymous/authenticated session exists when ENABLE_ANON_AUTH is on.
 * Single-flight: concurrent callers share one attempt (no duplicate sign-ins).
 */
export async function ensureAnonAuth(deps: AnonAuthDeps = defaultDeps()): Promise<AuthState> {
  if (_inflight) return _inflight;
  _inflight = runEnsureAuth(deps).finally(() => {
    _inflight = null;
  });
  return _inflight;
}

/** Non-blocking bootstrap for app start (never throws). */
export function bootstrapAnonAuth(): void {
  void ensureAnonAuth().catch((e) => {
    console.warn('[AnonAuth] bootstrap failed (nonfatal):', e);
  });
}

/**
 * Apply an already-established Supabase session into in-memory auth state
 * (e.g. after Apple linkIdentity / signInWithIdToken). Does not sign out.
 */
export function applyExternalSession(session: Session): AuthState {
  return setState(sessionToState(session));
}

export function getAuthState(): AuthState {
  return _state;
}

/**
 * Access token if already authenticated — does not trigger sign-in.
 * OCR may use this; falls back to anon key when null.
 */
export function getAccessTokenIfReady(): string | null {
  if (_state.status !== 'authenticated') return null;
  return _state.accessToken;
}

/**
 * Subscribe to auth state changes.
 * Immediately notifies with the current state (so restored-session cold start
 * is not missed if authentication completed before the subscriber attached).
 */
export function subscribeAuthState(listener: Listener): () => void {
  _listeners.add(listener);
  try {
    listener(_state);
  } catch {
    // ignore listener errors on sync notify
  }
  return () => {
    _listeners.delete(listener);
  };
}

/** Test-only reset. */
export function __resetAnonAuthForTests(): void {
  _state = { ...INITIAL_STATE };
  _inflight = null;
  _lastFailureAtMs = 0;
  _listeners.clear();
}
