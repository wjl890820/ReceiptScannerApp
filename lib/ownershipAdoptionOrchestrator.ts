/**
 * Best-effort local ownership adoption when auth becomes available.
 * Does not block app start; single-flight; no auth↔db recursion into auth bootstrap.
 *
 * Auto-adoption runs ONLY for anonymous users (is_anonymous), so a future
 * Apple restore onto a different account cannot silently merge unowned locals.
 */
import { getAuthState, subscribeAuthState, type AuthState } from './anonAuth';
import { enqueueUpsertIntentsForReceiptIds } from './cloudBackupBootstrap';
import { isAnonAuthEnabled } from './env';
import {
  adoptUnownedReceiptsForUserWithDefaults,
  shouldAutoAdoptUnownedReceipts,
} from './legacyReceiptAdoption';
import { requestCloudBackupFlush } from './cloudBackupWorker';

type GetDbFn = () => Promise<import('expo-sqlite').SQLiteDatabase>;

let _started = false;
let _unsubscribe: (() => void) | null = null;
let _inflight: Promise<void> | null = null;
let _getDb: GetDbFn | null = null;

async function runAdoptionBestEffort(state: AuthState): Promise<void> {
  if (!_getDb) return;
  if (!state.userId) return;
  if (!shouldAutoAdoptUnownedReceipts({ isAnonymous: state.isAnonymous })) {
    if (__DEV__) {
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

  const userId = state.userId;
  _inflight = (async () => {
    try {
      const result = await adoptUnownedReceiptsForUserWithDefaults(userId, _getDb!);
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[OwnershipAdoption]', result);
      }
      if (result.adopted_receipt_ids.length > 0) {
        try {
          const db = await _getDb!();
          await enqueueUpsertIntentsForReceiptIds(db, userId, result.adopted_receipt_ids);
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
