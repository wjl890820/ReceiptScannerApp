/**
 * Startup restore for the current authenticated user, including anonymous users.
 *
 * Does not sign in and does not switch accounts. Cloud backup must be enabled.
 * While a clean-local restore is pending, receipt and personal-decision writes wait.
 * If the attempt fails, those writes fail closed until a later attempt settles.
 */

import { isCloudBackupEnabled, isJwtLike, getSupabaseAnonKey } from './env';
import {
  evaluateCleanLocalRestoreEligibility,
  restoreCloudReceiptsForCurrentUser,
  type CloudRestoreDeps,
  type CloudRestoreResult,
} from './cloudRestore';
import {
  armCurrentUserRestoreBarrier,
  currentUserRestorePhase,
  finishCurrentUserRestoreBarrier,
  isCurrentUserAccountSwitchInProgress,
  markCurrentUserRestoreBarrierSettledWithoutAttempt,
  __resetCurrentUserRestoreBarrierForTests,
} from './currentUserRestoreBarrier';

export {
  assertCurrentUserRestoreAllowsBusinessWrites,
  backupMayStartAfterCurrentUserRestore,
  CurrentUserRestoreBlockedError,
  waitForCurrentUserRestoreAttempt,
} from './currentUserRestoreBarrier';
export type { CurrentUserRestorePhase } from './currentUserRestoreBarrier';

type AuthoritativeSession = {
  userId: string;
  accessToken: string;
  isAnonymous: boolean;
};

export type CurrentUserCloudRestoreDeps = {
  isEnabled: () => boolean;
  getDb: CloudRestoreDeps['getDb'];
  readSession: () => Promise<AuthoritativeSession | null>;
  restore: typeof restoreCloudReceiptsForCurrentUser;
};

let attempt: Promise<void> | null = null;
let activeDeps: CurrentUserCloudRestoreDeps | null = null;

export function __resetCurrentUserCloudRestoreForTests(): void {
  __resetCurrentUserRestoreBarrierForTests();
  attempt = null;
  activeDeps = null;
}

class SessionLookupFailedError extends Error {
  constructor() {
    super('session_lookup_failed');
    this.name = 'SessionLookupFailedError';
  }
}

async function readAuthoritativeSession(): Promise<AuthoritativeSession | null> {
  // Loaded on use so restore orchestration does not import the client at module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSupabaseClient } = require('./supabaseClient') as typeof import('./supabaseClient');
  const client = getSupabaseClient();
  if (!client) return null;
  let result: Awaited<ReturnType<typeof client.auth.getSession>>;
  try {
    result = await client.auth.getSession();
  } catch {
    throw new SessionLookupFailedError();
  }
  if (result.error) throw new SessionLookupFailedError();
  const session = result.data.session;
  if (!session) return null;
  const userId = session.user?.id?.trim() ?? '';
  const accessToken = session.access_token ?? '';
  if (!userId || !isJwtLike(accessToken)) return null;
  if (accessToken === getSupabaseAnonKey()) return null;
  return {
    userId,
    accessToken,
    isAnonymous: session.user?.is_anonymous === true,
  };
}

function resolveDeps(
  partial?: Partial<CurrentUserCloudRestoreDeps>
): CurrentUserCloudRestoreDeps {
  return {
    isEnabled: partial?.isEnabled ?? isCloudBackupEnabled,
    getDb:
      partial?.getDb ??
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getReceiptsDatabase } = require('./db') as typeof import('./db');
        return getReceiptsDatabase();
      }),
    readSession: partial?.readSession ?? readAuthoritativeSession,
    restore: partial?.restore ?? restoreCloudReceiptsForCurrentUser,
  };
}

async function runAttempt(deps: CurrentUserCloudRestoreDeps): Promise<void> {
  try {
    const session = await deps.readSession();
    if (!session) {
      finishCurrentUserRestoreBarrier('settled');
      return;
    }
    const db = await deps.getDb();
    const eligibility = await evaluateCleanLocalRestoreEligibility(db, session.userId);
    if (!eligibility.ok) {
      finishCurrentUserRestoreBarrier('settled');
      return;
    }
    const result: CloudRestoreResult = await deps.restore({
      getDb: deps.getDb,
      getAuth: () => ({
        status: 'authenticated',
        userId: session.userId,
        isAnonymous: session.isAnonymous,
        hasAppleIdentity: false,
        accessToken: session.accessToken,
        error: null,
      }),
      confirmAuthenticatedUserId: async () => {
        const again = await deps.readSession();
        return again?.userId ?? null;
      },
    });
    if (
      result.status === 'ok' ||
      result.status === 'blocked_local_data_present' ||
      result.status === 'blocked_pending_local_changes'
    ) {
      finishCurrentUserRestoreBarrier('settled');
      return;
    }
    finishCurrentUserRestoreBarrier('failed');
  } catch {
    finishCurrentUserRestoreBarrier('failed');
  }
}

/**
 * Arm and start one current-user restore attempt.
 * Synchronous arming happens before the returned promise yields.
 */
export function startCurrentUserCloudRestore(
  partial?: Partial<CurrentUserCloudRestoreDeps>
): Promise<void> {
  const deps = resolveDeps(partial);
  activeDeps = deps;
  if (!deps.isEnabled()) {
    markCurrentUserRestoreBarrierSettledWithoutAttempt();
    attempt = Promise.resolve();
    return attempt;
  }
  if (isCurrentUserAccountSwitchInProgress()) {
    return attempt ?? Promise.resolve();
  }
  if (currentUserRestorePhase() === 'pending' && attempt) return attempt;
  if (currentUserRestorePhase() === 'settled') return attempt ?? Promise.resolve();
  armCurrentUserRestoreBarrier();
  attempt = runAttempt(deps);
  return attempt;
}

/**
 * Foreground recovery. A settled or unarmed barrier is left alone.
 * Suppressed while an Apple account switch owns the restore lifecycle.
 */
export function retryCurrentUserCloudRestoreIfFailed(): Promise<void> {
  if (isCurrentUserAccountSwitchInProgress()) return Promise.resolve();
  if (currentUserRestorePhase() !== 'failed') return Promise.resolve();
  const deps = activeDeps ?? resolveDeps();
  if (!deps.isEnabled()) {
    markCurrentUserRestoreBarrierSettledWithoutAttempt();
    return Promise.resolve();
  }
  armCurrentUserRestoreBarrier();
  attempt = runAttempt(deps);
  return attempt;
}
