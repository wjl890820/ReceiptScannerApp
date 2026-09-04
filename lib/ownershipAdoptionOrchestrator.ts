/**
 * Best-effort local ownership adoption when auth becomes available.
 * Does not block app start; single-flight; no auth↔db recursion into auth bootstrap.
 *
 * Auto-adoption runs ONLY for anonymous users (is_anonymous).
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

let _started = false;
let _unsubscribe: (() => void) | null = null;
let _inflight: Promise<void> | null = null;
let _getDb: GetDbFn | null = null;

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

async function runAdoptionBestEffort(state: AuthState): Promise<void> {
  if (!_getDb) return;
  const snapshot = isAnonymousAdoptionSnapshot(state);
  if (!snapshot) {
    if (__DEV__ && state.status === 'authenticated' && state.userId) {
      // eslint-disable-next-line no-console
      console.log('[OwnershipAdoption] skip auto-adopt (not anonymous)', {
        userIdPrefix: state.userId.slice(0, 8),
        isAnonymous: state.isAnonymous,
      });
    }
    return;
  }

  if (_inflight) {
    await _inflight;
    return;
  }

  const adoptionSnapshot = snapshot;
  _inflight = (async () => {
    try {
      if (!authStillMatchesSnapshot(adoptionSnapshot)) {
        return;
      }
      const result = await adoptUnownedReceiptsForUserWithDefaults(
        adoptionSnapshot.userId,
        _getDb!,
        { authEligibility: buildAuthEligibility(adoptionSnapshot) }
      );
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[OwnershipAdoption]', result);
      }
      if (
        result.adopted_receipt_ids.length > 0 &&
        authStillMatchesSnapshot(adoptionSnapshot)
      ) {
        void import('./analysisPriceSessionCache')
          .then((m) => m.notifyAnalysisPriceTruthInvalidated())
          .catch(() => undefined);
        try {
          const db = await _getDb!();
          await enqueueUpsertIntentsForReceiptIds(
            db,
            adoptionSnapshot.userId,
            result.adopted_receipt_ids
          );
          void requestCloudBackupFlush();
        } catch (e) {
          console.warn('[OwnershipAdoption] backup handoff failed (nonfatal):', e);
        }
      }
    } catch (e) {
      console.warn('[OwnershipAdoption] failed (nonfatal):', e);
    } finally {
      _inflight = null;
    }
  })();

  await _inflight;
}

function onAuthState(state: AuthState): void {
  if (!isAnonAuthEnabled()) return;
  if (state.status !== 'authenticated' || !state.userId) return;
  void runAdoptionBestEffort(state);
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
}

/** Test-only: expose auth snapshot matcher for orchestrator tests. */
export function __authStillMatchesAdoptionSnapshotForTests(
  snapshot: AnonymousAuthSnapshot
): boolean {
  return authStillMatchesSnapshot(snapshot);
}
