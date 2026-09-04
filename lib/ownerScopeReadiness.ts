/**
 * Owner-scope readiness for authoritative local receipt reads.
 *
 * When anon auth is enabled and auth is still `initializing`, owner-scoped
 * readers await ensureAnonAuth single-flight, then await adoption settle.
 * Adoption failure / db-not-ready blocks authoritative user scope (fail closed).
 *
 * Does not block RootLayout / splash — only async owner-scoped data paths wait.
 */

import type { OwnershipAdoptionSettleResult } from './ownershipAdoptionOrchestrator';

export type OwnerScopeReadyResultKind =
  | 'user'
  | 'installation'
  | 'unavailable'
  | 'adoption_failed'
  | 'adoption_not_ready';

export type AuthStatusLike = 'initializing' | 'authenticated' | 'unavailable';

export type OwnerScopeReadinessResult = {
  waitedForAuth: boolean;
  authStatusBefore: AuthStatusLike;
  authStatusAfter: AuthStatusLike;
  waitStartedAtMs: number | null;
  /** Present when anon auth enabled; drives fail-closed user-scope decisions. */
  adoption: OwnershipAdoptionSettleResult;
  /**
   * User id whose adoption result this readiness cycle represents.
   * Must equal final auth/candidate before returning user:<id>.
   */
  adoptionUserId: string | null;
  /** True when authenticated anonymous adoption is failed/not_ready. */
  blockAuthoritativeUserScope: boolean;
};

function recordOwnerScopeWaitDiagnostic(
  name: 'owner_scope_wait_begin' | 'owner_scope_wait_end',
  meta: Record<string, unknown>,
  durationMs?: number
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordDiagnosticEvent } = require('./internalDiagnostics') as {
      recordDiagnosticEvent: (args: {
        category: 'lifecycle';
        name: string;
        screen: string;
        durationMs?: number;
        meta?: Record<string, unknown>;
      }) => void;
    };
    recordDiagnosticEvent({
      category: 'lifecycle',
      name,
      screen: 'owner_scope',
      ...(durationMs != null ? { durationMs } : {}),
      meta,
    });
  } catch {
    // never affect owner reads
  }
}

export function ownerScopeKindFromOwnerKey(
  ownerKey: string | null | undefined
): OwnerScopeReadyResultKind {
  if (!ownerKey) return 'unavailable';
  if (ownerKey.startsWith('user:')) return 'user';
  if (ownerKey.startsWith('installation:')) return 'installation';
  return 'unavailable';
}

export function adoptionBlocksAuthoritativeUserScope(
  adoption: OwnershipAdoptionSettleResult
): boolean {
  return adoption.status === 'failed' || adoption.status === 'not_ready';
}

function adoptionResultUserId(
  adoption: OwnershipAdoptionSettleResult
): string | null {
  if (adoption.status === 'not_applicable') return null;
  if ('userId' in adoption && typeof adoption.userId === 'string') {
    return adoption.userId;
  }
  return null;
}

function diagnosticResultFromAdoption(
  adoption: OwnershipAdoptionSettleResult
): OwnerScopeReadyResultKind | null {
  if (adoption.status === 'failed') return 'adoption_failed';
  if (adoption.status === 'not_ready') return 'adoption_not_ready';
  return null;
}

/**
 * Await authoritative auth (+ anonymous adoption) before resolving owner scope.
 * Never throws.
 */
export async function ensureAuthoritativeOwnerScopeReady(): Promise<OwnerScopeReadinessResult> {
  const result: OwnerScopeReadinessResult = {
    waitedForAuth: false,
    authStatusBefore: 'unavailable',
    authStatusAfter: 'unavailable',
    waitStartedAtMs: null,
    adoption: { status: 'not_applicable' },
    adoptionUserId: null,
    blockAuthoritativeUserScope: false,
  };

  try {
    const { getAuthState, ensureAnonAuth } = await import('./anonAuth');
    const { isAnonAuthEnabled } = await import('./env');

    const anonEnabled = isAnonAuthEnabled();
    // Auth disabled: do not wait for auth/adoption — installation scope immediately.
    if (!anonEnabled) {
      result.authStatusBefore = getAuthState().status as AuthStatusLike;
      result.authStatusAfter = result.authStatusBefore;
      result.adoption = { status: 'not_applicable' };
      return result;
    }

    const authStatusBefore = getAuthState().status as AuthStatusLike;
    result.authStatusBefore = authStatusBefore;
    result.authStatusAfter = authStatusBefore;

    if (authStatusBefore === 'initializing') {
      result.waitedForAuth = true;
      result.waitStartedAtMs = Date.now();
      recordOwnerScopeWaitDiagnostic('owner_scope_wait_begin', {
        authStatus: authStatusBefore,
      });
      await ensureAnonAuth();
      result.authStatusAfter = getAuthState().status as AuthStatusLike;
    }

    const {
      ensureOwnershipAdoptionSettledForOwnerRead,
    } = await import('./ownershipAdoptionOrchestrator');
    result.adoption = await ensureOwnershipAdoptionSettledForOwnerRead();
    result.adoptionUserId = adoptionResultUserId(result.adoption);
    // If settle didn't stamp userId, fall back to post-settle auth identity.
    if (
      result.adoptionUserId == null &&
      result.adoption.status !== 'not_applicable'
    ) {
      const after = getAuthState();
      if (
        after.status === 'authenticated' &&
        typeof after.userId === 'string' &&
        after.userId.trim() &&
        after.isAnonymous === true
      ) {
        result.adoptionUserId = after.userId.trim();
      }
    }
    result.blockAuthoritativeUserScope = adoptionBlocksAuthoritativeUserScope(
      result.adoption
    );
    result.authStatusAfter = getAuthState().status as AuthStatusLike;
  } catch {
    // Nonfatal: Jest suites without Expo natives, or transient import failures.
    result.adoption = { status: 'not_applicable' };
    result.adoptionUserId = null;
    result.blockAuthoritativeUserScope = false;
  }

  return result;
}

/** Record wait_end once the resulting owner scope kind is known. */
export function recordOwnerScopeWaitEnd(
  readiness: OwnerScopeReadinessResult,
  scopeKind: OwnerScopeReadyResultKind
): void {
  if (!readiness.waitedForAuth || readiness.waitStartedAtMs == null) return;
  const durationMs = Math.max(0, Date.now() - readiness.waitStartedAtMs);
  const adoptionDiag = diagnosticResultFromAdoption(readiness.adoption);
  recordOwnerScopeWaitDiagnostic(
    'owner_scope_wait_end',
    {
      authStatus: readiness.authStatusAfter,
      resultingScopeKind: adoptionDiag ?? scopeKind,
      ...(readiness.adoption.status !== 'not_applicable'
        ? { adoptionStatus: readiness.adoption.status }
        : {}),
    },
    durationMs
  );
}
