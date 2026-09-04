/**
 * Best-effort local ownership adoption when auth becomes available.
 * Does not block app start; single-flight; no auth↔db recursion into auth bootstrap.
 *
 * Auto-adoption runs ONLY for anonymous users (is_anonymous).
 *
 * Shared settle primitive is user-bound: U's in-flight/result never authorizes V.
 */
import { getAuthState, subscribeAuthState, type AuthState } from './anonAuth';
import { enqueueUpsertIntentsForReceiptIds } from './cloudBackupBootstrap';
import { isAnonAuthEnabled } from './env';
import {
  adoptUnownedReceiptsForUserWithDefaults,
  shouldAutoAdoptUnownedReceipts,
  type AdoptionAuthEligibility,
} from './legacyReceiptAdoption';
import { requestCloudBackupFlush } from './cloudBackupWorker';

type GetDbFn = () => Promise<import('expo-sqlite').SQLiteDatabase>;

type AnonymousAuthSnapshot = {
  userId: string;
  isAnonymous: true;
};

export type OwnershipAdoptionSettleResult =
  | { status: 'settled'; reason: 'adopted' | 'noop'; userId: string }
  | { status: 'failed'; reason: string; userId?: string }
  | { status: 'not_ready'; reason: 'db_unavailable'; userId?: string }
  | { status: 'not_applicable' };

type InFlightAdoption = {
  userId: string;
  promise: Promise<OwnershipAdoptionSettleResult>;
};

let _started = false;
let _unsubscribe: (() => void) | null = null;
/** User-bound in-flight adoption shared by orchestrator + owner-read readiness. */
let _inflight: InFlightAdoption | null = null;
let _getDb: GetDbFn | null = null;
/** Only successful terminal adopted/no-op results are cached per user. */
let _settledAdoptionUserId: string | null = null;

function isAnonymousAdoptionSnapshot(
  state: AuthState
): AnonymousAuthSnapshot | null {
  if (state.status !== 'authenticated' || !state.userId) return null;
  if (!shouldAutoAdoptUnownedReceipts({ isAnonymous: state.isAnonymous })) {
    return null;
  }
  if (state.isAnonymous !== true) return null;
  return { userId: state.userId, isAnonymous: true };
}

function authStillMatchesSnapshot(snapshot: AnonymousAuthSnapshot): boolean {
  const current = getAuthState();
  return (
    current.status === 'authenticated' &&
    current.userId === snapshot.userId &&
    current.isAnonymous === true &&
    shouldAutoAdoptUnownedReceipts({ isAnonymous: current.isAnonymous })
  );
}

function buildAuthEligibility(
  snapshot: AnonymousAuthSnapshot
): AdoptionAuthEligibility {
  return {
    isValid: () => authStillMatchesSnapshot(snapshot),
  };
}

async function runAdoptionForSnapshot(
  adoptionSnapshot: AnonymousAuthSnapshot,
  getDb: GetDbFn
): Promise<OwnershipAdoptionSettleResult> {
  try {
    if (!authStillMatchesSnapshot(adoptionSnapshot)) {
      return {
        status: 'failed',
        reason: 'auth_mismatch',
        userId: adoptionSnapshot.userId,
      };
    }
    const result = await adoptUnownedReceiptsForUserWithDefaults(
      adoptionSnapshot.userId,
      getDb,
      { authEligibility: buildAuthEligibility(adoptionSnapshot) }
    );
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[OwnershipAdoption]', result);
    }
    if (!authStillMatchesSnapshot(adoptionSnapshot)) {
      return {
        status: 'failed',
        reason: 'auth_mismatch',
        userId: adoptionSnapshot.userId,
      };
    }
    if (result.adopted_receipt_ids.length > 0) {
      void import('./analysisPriceSessionCache')
        .then((m) => m.notifyAnalysisPriceTruthInvalidated())
        .catch(() => undefined);
      try {
        const db = await getDb();
        await enqueueUpsertIntentsForReceiptIds(
          db,
          adoptionSnapshot.userId,
          result.adopted_receipt_ids
        );
        void requestCloudBackupFlush();
      } catch (e) {
        console.warn('[OwnershipAdoption] backup handoff failed (nonfatal):', e);
      }
      _settledAdoptionUserId = adoptionSnapshot.userId;
      return {
        status: 'settled',
        reason: 'adopted',
        userId: adoptionSnapshot.userId,
      };
    }
    _settledAdoptionUserId = adoptionSnapshot.userId;
    return {
      status: 'settled',
      reason: 'noop',
      userId: adoptionSnapshot.userId,
    };
  } catch (e) {
    console.warn('[OwnershipAdoption] failed (nonfatal):', e);
    return {
      status: 'failed',
      reason: String((e as { message?: string })?.message || e || 'adoption_failed'),
      userId: adoptionSnapshot.userId,
    };
  }
}

/**
 * Shared adoption settle primitive (user-bound single-flight).
 * Returns the true terminal result — never throws.
 */
export async function settleOwnershipAdoptionForCurrentAuth(
  state: AuthState = getAuthState()
): Promise<OwnershipAdoptionSettleResult> {
  try {
    if (!isAnonAuthEnabled()) {
      return { status: 'not_applicable' };
    }

    const snapshot = isAnonymousAdoptionSnapshot(state);
    if (!snapshot) {
      if (__DEV__ && state.status === 'authenticated' && state.userId) {
        // eslint-disable-next-line no-console
        console.log('[OwnershipAdoption] skip auto-adopt (not anonymous)', {
          userIdPrefix: state.userId.slice(0, 8),
          isAnonymous: state.isAnonymous,
        });
      }
      return { status: 'not_applicable' };
    }

    if (_settledAdoptionUserId === snapshot.userId) {
      return {
        status: 'settled',
        reason: 'noop',
        userId: snapshot.userId,
      };
    }

    if (!_getDb) {
      if (_inflight && _inflight.userId === snapshot.userId) {
        return await _inflight.promise;
      }
      return {
        status: 'not_ready',
        reason: 'db_unavailable',
        userId: snapshot.userId,
      };
    }

    if (_inflight) {
      if (_inflight.userId === snapshot.userId) {
        return await _inflight.promise;
      }
      // Different user: serialize — wait for U, discard result, settle for V.
      await _inflight.promise;
      const current = getAuthState();
      const currentSnap = isAnonymousAdoptionSnapshot(current);
      if (!currentSnap) {
        return { status: 'not_applicable' };
      }
      if (currentSnap.userId !== snapshot.userId) {
        // Auth moved again — settle for whoever is current now.
        return settleOwnershipAdoptionForCurrentAuth(current);
      }
      if (_settledAdoptionUserId === currentSnap.userId) {
        return {
          status: 'settled',
          reason: 'noop',
          userId: currentSnap.userId,
        };
      }
      // Fall through to start V's own adoption below (re-read snapshot).
      return settleOwnershipAdoptionForCurrentAuth(current);
    }

    const adoptionSnapshot = snapshot;
    const getDb = _getDb;
    const entry: InFlightAdoption = {
      userId: adoptionSnapshot.userId,
      promise: Promise.resolve({ status: 'not_applicable' }),
    };
    entry.promise = (async (): Promise<OwnershipAdoptionSettleResult> => {
      try {
        return await runAdoptionForSnapshot(adoptionSnapshot, getDb);
      } finally {
        if (_inflight === entry) {
          _inflight = null;
        }
      }
    })();
    _inflight = entry;
    return await entry.promise;
  } catch (e) {
    console.warn('[OwnershipAdoption] settle failed (nonfatal):', e);
    return {
      status: 'failed',
      reason: String((e as { message?: string })?.message || e || 'settle_failed'),
    };
  }
}

/**
 * Owner-read readiness entry: await shared settle and return its result.
 */
export async function ensureOwnershipAdoptionSettledForOwnerRead(): Promise<OwnershipAdoptionSettleResult> {
  return settleOwnershipAdoptionForCurrentAuth(getAuthState());
}

/** Background orchestrator: best-effort; ignores detailed result. */
function onAuthState(state: AuthState): void {
  if (!isAnonAuthEnabled()) return;
  if (state.status !== 'authenticated' || !state.userId) return;
  void settleOwnershipAdoptionForCurrentAuth(state);
}

/**
 * Start listening for authenticated sessions and adopt unowned receipts.
 * Safe to call multiple times (no-op after first start).
 */
export function startOwnershipAdoptionOrchestrator(getDb: GetDbFn): void {
  _getDb = getDb;
  if (_started) {
    onAuthState(getAuthState());
    return;
  }
  _started = true;
  _unsubscribe = subscribeAuthState(onAuthState);
  onAuthState(getAuthState());
}

/** Test-only reset. */
export function __resetOwnershipAdoptionOrchestratorForTests(): void {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  _started = false;
  _inflight = null;
  _getDb = null;
  _settledAdoptionUserId = null;
}

/** Test-only: expose auth snapshot matcher for orchestrator tests. */
export function __authStillMatchesAdoptionSnapshotForTests(
  snapshot: AnonymousAuthSnapshot
): boolean {
  return authStillMatchesSnapshot(snapshot);
}

/** Test-only: whether a user id is in the successful settled cache. */
export function __isAdoptionSettledForUserForTests(userId: string): boolean {
  return _settledAdoptionUserId === userId;
}

/** Test-only: current in-flight user id, if any. */
export function __getAdoptionInFlightUserIdForTests(): string | null {
  return _inflight?.userId ?? null;
}
