/**
 * Single-flight cloud backup flush worker.
 * Race-safe: only clears/updates outbox when intent_id still matches.
 *
 * Reliability:
 * - One flush request drains due intents in batches (bounded).
 * - Restored authenticated session triggers flush on worker start + auth emit.
 * - AppState active resumes flush.
 * - The earliest pending next_retry_at schedules one wakeup.
 *   Overdue rows wake immediately; future rows wait for that deadline.
 */
import type * as SQLite from 'expo-sqlite';

import { getAuthState, subscribeAuthState, type AuthState } from './anonAuth';
import { bootstrapOwnedReceiptBackupIntents } from './cloudBackupBootstrap';
import {
  assertNoImageUriInPayload,
  BACKUP_SELECT_COLUMNS,
  buildCloudUserReceiptUpsertPayload,
  type LocalReceiptBackupSource,
} from './cloudBackupPayload';
import { isCloudBackupEnabled } from './env';
import { logger } from './logger';
import { OutboxWakeupScheduler } from './outboxWakeupScheduler';
import { retryCurrentUserCloudRestoreIfFailed } from './currentUserCloudRestore';
import { backupMayStartAfterCurrentUserRestore } from './currentUserRestoreBarrier';
import { getSupabaseClient } from './supabaseClient';
import { syncPersonalDecisionBackup } from './personalDecisionCloudSync';
import {
  clearSyncOutboxIntentIfCurrent,
  computeBackoffMs,
  getEarliestPendingSyncOutboxRetryAt,
  listDueSyncOutboxForUser,
  pendingOutboxRetryToken,
  type SyncOutboxRow,
  updateSyncOutboxRetryIfCurrent,
} from './syncOutbox';

export { BACKUP_SELECT_COLUMNS } from './cloudBackupPayload';

export type CloudBackupFlushResult = {
  ran: boolean;
  reason?: string;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  batches?: number;
};

type GetDbFn = () => Promise<SQLite.SQLiteDatabase>;

/** Per-batch due-intent page size (matches historical LIMIT 20). */
export const CLOUD_BACKUP_BATCH_SIZE = 20;
/** Safety: max batches per flush request (20 * 100 = 2000 intents). */
export const CLOUD_BACKUP_MAX_BATCHES_PER_FLUSH = 100;
/** Safety: wall-clock budget per flush request. */
export const CLOUD_BACKUP_MAX_FLUSH_MS = 90_000;

let _getDb: GetDbFn | null = null;
let _inflight: Promise<CloudBackupFlushResult> | null = null;
let _flushRequestGeneration = 0;
let _cloudBackupPassCount = 0;
let _activeFlushLoops = 0;
let _afterFinalScheduleObservationForTests: (() => Promise<void>) | null = null;
let _beforeCloudBackupPassWorkForTests: (() => Promise<void>) | null = null;
let _throwNextCloudBackupPass: Error | null = null;
let _started = false;
let _unsubscribeAuth: (() => void) | null = null;
let _appStateSub: { remove: () => void } | null = null;
let _lastAppState: string | null = null;
let _scheduledUserId: string | null = null;
let _armedToken: string | null = null;
let _lastFiredToken: string | null = null;
let _wakeupScheduler: OutboxWakeupScheduler | null = null;

function isForeground(): boolean {
  return _lastAppState == null || _lastAppState === 'active';
}

function wakeupScheduler(): OutboxWakeupScheduler {
  if (!_wakeupScheduler) {
    _wakeupScheduler = new OutboxWakeupScheduler(
      {
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle),
      },
      onWakeupFire
    );
  }
  return _wakeupScheduler;
}

function onWakeupFire(_deadline: number | null): void {
  logger.info('OutboxWakeup', 'timer fired');
  const scheduledFor = _scheduledUserId;
  const armedToken = _armedToken;
  _scheduledUserId = null;
  _armedToken = null;

  if (!isCloudBackupEnabled()) {
    logger.info('OutboxWakeup', 'blocked auth_or_flag');
    return;
  }
  const auth = getAuthState();
  if (auth.status !== 'authenticated' || !auth.userId) {
    logger.info('OutboxWakeup', 'blocked auth_or_flag');
    return;
  }
  if (scheduledFor && auth.userId !== scheduledFor) {
    logger.info('OutboxWakeup', 'blocked user_mismatch');
    _lastFiredToken = null;
    wakeupScheduler().clearSuppression();
    void requestCloudBackupFlush();
    return;
  }
  if (_inflight) {
    logger.info('OutboxWakeup', 'worker already running');
    if (armedToken) _lastFiredToken = armedToken;
    // Join the active pass and latch a fresh one. Do not start a second worker.
    void requestCloudBackupFlush();
    return;
  }
  _lastFiredToken = armedToken;
  void requestCloudBackupFlush();
}

async function loadLocalReceiptForBackup(
  db: SQLite.SQLiteDatabase,
  receiptId: string
): Promise<LocalReceiptBackupSource | null> {
  const row = await db.getFirstAsync<LocalReceiptBackupSource>(
    `SELECT ${BACKUP_SELECT_COLUMNS} FROM receipts WHERE id = ? LIMIT 1`,
    [receiptId]
  );
  return row ?? null;
}

async function processUpsert(
  db: SQLite.SQLiteDatabase,
  intent: SyncOutboxRow,
  currentUserId: string
): Promise<'ok' | 'fail' | 'skip'> {
  if (intent.user_id !== currentUserId) {
    return 'skip';
  }
  const row = await loadLocalReceiptForBackup(db, intent.receipt_id);
  if (!row || row.user_id !== currentUserId) {
    // Local gone or ownership mismatch — leave intent for correct owner / future handling
    return 'skip';
  }

  const payload = buildCloudUserReceiptUpsertPayload(row);
  assertNoImageUriInPayload(payload as unknown as Record<string, unknown>);

  const client = getSupabaseClient();
  if (!client) return 'fail';

  const { error } = await client.from('user_receipts').upsert(payload, {
    onConflict: 'user_id,id',
  });

  if (error) {
    throw new Error(error.message || 'upsert failed');
  }

  await clearSyncOutboxIntentIfCurrent(db, intent.receipt_id, intent.intent_id);
  return 'ok';
}

async function processDelete(
  db: SQLite.SQLiteDatabase,
  intent: SyncOutboxRow,
  currentUserId: string
): Promise<'ok' | 'fail' | 'skip'> {
  if (intent.user_id !== currentUserId) {
    return 'skip';
  }
  if (!intent.user_id) {
    return 'skip';
  }

  const client = getSupabaseClient();
  if (!client) return 'fail';

  const deletedAtIso = new Date(intent.deleted_at ?? Date.now()).toISOString();
  const { error } = await client
    .from('user_receipts')
    .update({ deleted_at: deletedAtIso })
    .eq('user_id', currentUserId)
    .eq('id', intent.receipt_id);

  // 0 rows affected is idempotent success (no cloud row to tombstone).
  if (error) {
    throw new Error(error.message || 'tombstone failed');
  }

  await clearSyncOutboxIntentIfCurrent(db, intent.receipt_id, intent.intent_id);
  return 'ok';
}

function cancelOutboxWakeup(reason: 'auth_or_flag' | 'background' | 'reset'): void {
  const hadTimer = wakeupScheduler().hasTimer();
  wakeupScheduler().cancel();
  _scheduledUserId = null;
  _armedToken = null;
  if (hadTimer && reason !== 'reset') {
    logger.info('OutboxWakeup', 'timer cancelled', { reason });
  }
}

/**
 * One wakeup for the earliest pending retry.
 * Overdue (next_retry_at <= now) uses a single immediate timer, never a negative delay.
 * Unchanged overdue intents are suppressed after one wakeup so a failed clear cannot spin.
 */
async function scheduleRetryWakeup(
  db: SQLite.SQLiteDatabase,
  userId: string,
  nowMs: number = Date.now()
): Promise<void> {
  if (!isCloudBackupEnabled()) {
    _lastFiredToken = null;
    cancelOutboxWakeup('auth_or_flag');
    wakeupScheduler().clearSuppression();
    return;
  }
  const auth = getAuthState();
  if (auth.status !== 'authenticated' || auth.userId !== userId) {
    _lastFiredToken = null;
    cancelOutboxWakeup('auth_or_flag');
    wakeupScheduler().clearSuppression();
    return;
  }
  if (!isForeground()) {
    _lastFiredToken = null;
    cancelOutboxWakeup('background');
    return;
  }

  const earliest = await getEarliestPendingSyncOutboxRetryAt(db, userId);
  const authNow = getAuthState();
  if (
    authNow.status !== 'authenticated' ||
    authNow.userId !== userId ||
    !isCloudBackupEnabled()
  ) {
    _lastFiredToken = null;
    cancelOutboxWakeup('auth_or_flag');
    wakeupScheduler().clearSuppression();
    return;
  }
  if (!isForeground()) {
    _lastFiredToken = null;
    cancelOutboxWakeup('background');
    return;
  }

  const token = earliest ? pendingOutboxRetryToken(earliest) : null;
  const firedToken = _lastFiredToken;
  _lastFiredToken = null;
  if (firedToken) wakeupScheduler().queueSuppressIfUnchanged(firedToken);
  const plan = wakeupScheduler().reevaluate({
    nowMs,
    earliestRetryAt: earliest?.nextRetryAt ?? null,
    earliestToken: token,
    foreground: true,
    eligible: true,
    workerRunning: false,
  });

  if (plan.action === 'arm') {
    _scheduledUserId = userId;
    _armedToken = token;
    logger.info('OutboxWakeup', 'timer scheduled', { delayMs: plan.delayMs });
  } else if (plan.action === 'cancel' || plan.action === 'suppress') {
    _scheduledUserId = null;
    _armedToken = null;
    if (plan.action === 'suppress') {
      logger.info('OutboxWakeup', 'suppressed unchanged overdue');
    }
  }
  const afterObservation = _afterFinalScheduleObservationForTests;
  if (afterObservation) {
    await afterObservation();
  }
}

async function runOneCloudBackupPass(): Promise<CloudBackupFlushResult> {
  _cloudBackupPassCount += 1;
  const beforeWork = _beforeCloudBackupPassWorkForTests;
  if (beforeWork) {
    _beforeCloudBackupPassWorkForTests = null;
    await beforeWork();
  }
  if (_throwNextCloudBackupPass) {
    const error = _throwNextCloudBackupPass;
    _throwNextCloudBackupPass = null;
    throw error;
  }
  if (!isCloudBackupEnabled()) {
    _lastFiredToken = null;
    cancelOutboxWakeup('auth_or_flag');
    return { ran: false, reason: 'flag_off', processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }
  const restoreGate = await backupMayStartAfterCurrentUserRestore();
  if (!restoreGate.ok) {
    _lastFiredToken = null;
    logger.info('OutboxWakeup', 'blocked restore');
    return {
      ran: false,
      reason: restoreGate.reason,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };
  }
  if (!_getDb) {
    _lastFiredToken = null;
    return { ran: false, reason: 'no_db', processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  const auth = getAuthState();
  if (auth.status !== 'authenticated' || !auth.userId || !auth.accessToken) {
    _lastFiredToken = null;
    return {
      ran: false,
      reason: 'auth_unavailable',
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };
  }

  const currentUserId = auth.userId;
  const db = await _getDb();
  const flushStartedAt = Date.now();

  try {
    await bootstrapOwnedReceiptBackupIntents(db, currentUserId, flushStartedAt);
  } catch (e) {
    console.warn('[CloudBackup] bootstrap failed (nonfatal):', e);
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;
  let batches = 0;

  while (
    batches < CLOUD_BACKUP_MAX_BATCHES_PER_FLUSH &&
    Date.now() - flushStartedAt < CLOUD_BACKUP_MAX_FLUSH_MS
  ) {
    const now = Date.now();
    const due = await listDueSyncOutboxForUser(
      db,
      currentUserId,
      now,
      CLOUD_BACKUP_BATCH_SIZE
    );
    if (due.length === 0) break;

    batches += 1;
    let batchSucceeded = 0;

    for (const intent of due) {
      processed += 1;
      // Ownership gate (client-side; RLS is second boundary)
      if (!intent.user_id || intent.user_id !== currentUserId) {
        skipped += 1;
        continue;
      }

      try {
        const outcome =
          intent.operation === 'delete'
            ? await processDelete(db, intent, currentUserId)
            : await processUpsert(db, intent, currentUserId);

        if (outcome === 'ok') {
          succeeded += 1;
          batchSucceeded += 1;
        } else if (outcome === 'skip') {
          skipped += 1;
        } else {
          failed += 1;
        }
      } catch (e: any) {
        failed += 1;
        const nextAttempt = (intent.attempt_count || 0) + 1;
        const delay = computeBackoffMs(nextAttempt);
        await updateSyncOutboxRetryIfCurrent(db, {
          receiptId: intent.receipt_id,
          intentId: intent.intent_id,
          attemptCount: nextAttempt,
          lastError: String(e?.message || e || 'backup_failed'),
          nextRetryAt: Date.now() + delay,
        });
      }
    }

    // No successful clears this batch → stop drain to avoid skip hot-loops.
    if (batchSucceeded === 0) break;
    // Partial page means no more due rows right now.
    if (due.length < CLOUD_BACKUP_BATCH_SIZE) break;
  }

  try {
    await syncPersonalDecisionBackup(db, currentUserId);
  } catch (e) {
    // Decision durability is independent of receipt outbox success.
    console.warn('[CloudBackup] personal decision sync failed (nonfatal):', e);
  }

  try {
    await scheduleRetryWakeup(db, currentUserId, Date.now());
  } catch (e) {
    console.warn('[CloudBackup] retry schedule failed (nonfatal):', e);
  }

  return {
    ran: true,
    processed,
    succeeded,
    failed,
    skipped,
    batches,
  };
}

const EMPTY_FLUSH_RESULT: CloudBackupFlushResult = {
  ran: false,
  processed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
};

/**
 * One active worker. Requests that arrive during a pass bump the generation
 * and coalesce into a single later pass. The generation check and the
 * _inflight release happen in the same turn, with no await between them.
 */
async function runCoalescedCloudBackupLoop(
  shared: Promise<CloudBackupFlushResult>,
  resolveOut: (result: CloudBackupFlushResult) => void,
  rejectOut: (error: unknown) => void
): Promise<void> {
  let last = EMPTY_FLUSH_RESULT;
  try {
    for (;;) {
      const seen = _flushRequestGeneration;
      try {
        last = await runOneCloudBackupPass();
      } catch (error) {
        if (_flushRequestGeneration !== seen) continue;
        if (_inflight === shared) {
          _inflight = null;
          _activeFlushLoops = Math.max(0, _activeFlushLoops - 1);
        }
        rejectOut(error);
        return;
      }
      if (_flushRequestGeneration !== seen) continue;
      if (_inflight === shared) {
        _inflight = null;
        _activeFlushLoops = Math.max(0, _activeFlushLoops - 1);
      }
      resolveOut(last);
      return;
    }
  } catch (error) {
    if (_inflight === shared) {
      _inflight = null;
      _activeFlushLoops = Math.max(0, _activeFlushLoops - 1);
    }
    rejectOut(error);
  }
}

/**
 * Request a backup flush. Serialized in-process (single-flight).
 * Not async: must return the exact shared Promise reference.
 * A request during an active pass never disappears: it latches one fresh pass.
 */
export function requestCloudBackupFlush(): Promise<CloudBackupFlushResult> {
  _flushRequestGeneration += 1;
  if (_inflight) return _inflight;

  let resolveOut!: (result: CloudBackupFlushResult) => void;
  let rejectOut!: (error: unknown) => void;
  const shared = new Promise<CloudBackupFlushResult>((resolve, reject) => {
    resolveOut = resolve;
    rejectOut = reject;
  });
  _inflight = shared;
  _activeFlushLoops += 1;
  void runCoalescedCloudBackupLoop(shared, resolveOut, rejectOut);
  return shared;
}

function onAuthState(state: AuthState): void {
  cancelOutboxWakeup('auth_or_flag');
  wakeupScheduler().clearSuppression();
  if (!isCloudBackupEnabled()) return;
  if (state.status !== 'authenticated' || !state.userId) return;
  void requestCloudBackupFlush();
}

function onAppStateChange(next: string): void {
  const prev = _lastAppState;
  _lastAppState = next;
  if (!isCloudBackupEnabled()) return;
  if (next !== 'active') {
    cancelOutboxWakeup('background');
    return;
  }
  // background/inactive → active
  if (prev != null && prev !== 'active') {
    wakeupScheduler().clearSuppression();
    void retryCurrentUserCloudRestoreIfFailed().then(() => {
      void requestCloudBackupFlush();
    });
  }
}

function ensureAppStateListener(): void {
  if (_appStateSub) return;
  try {
    // Lazy require so Jest can mock react-native.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppState } = require('react-native') as typeof import('react-native');
    _lastAppState = AppState.currentState ?? null;
    _appStateSub = AppState.addEventListener('change', (state) => {
      onAppStateChange(String(state));
    });
  } catch {
    // Non-RN environments (unit tests without AppState) — ignore.
  }
}

export function startCloudBackupWorker(getDb: GetDbFn): void {
  _getDb = getDb;
  ensureAppStateListener();

  if (_started) {
    // Re-entry: still flush if already authenticated (restored session / remount).
    onAuthState(getAuthState());
    return;
  }
  _started = true;
  _unsubscribeAuth = subscribeAuthState(onAuthState);
  // subscribeAuthState immediately notifies current state; also call once for clarity.
  onAuthState(getAuthState());
}

/** Test helpers */
export function __resetCloudBackupWorkerForTests(): void {
  cancelOutboxWakeup('reset');
  wakeupScheduler().clearSuppression();
  _lastFiredToken = null;
  if (_unsubscribeAuth) {
    _unsubscribeAuth();
    _unsubscribeAuth = null;
  }
  if (_appStateSub) {
    try {
      _appStateSub.remove();
    } catch {
      // ignore
    }
    _appStateSub = null;
  }
  _started = false;
  _inflight = null;
  _flushRequestGeneration = 0;
  _cloudBackupPassCount = 0;
  _activeFlushLoops = 0;
  _afterFinalScheduleObservationForTests = null;
  _beforeCloudBackupPassWorkForTests = null;
  _throwNextCloudBackupPass = null;
  _getDb = null;
  _lastAppState = null;
}

export function __runCloudBackupFlushForTests(
  getDb: GetDbFn
): Promise<CloudBackupFlushResult> {
  _getDb = getDb;
  return requestCloudBackupFlush();
}

/** Test-only: simulate AppState transitions without RN. */
export function __handleAppStateForTests(next: string): void {
  onAppStateChange(next);
}

export function __getRetryTimerPendingForTests(): boolean {
  return wakeupScheduler().hasTimer();
}

export function __isCloudBackupFlushInFlightForTests(): boolean {
  return _inflight != null;
}

export function __getCloudBackupPassCountForTests(): number {
  return _cloudBackupPassCount;
}

export function __getActiveCloudBackupFlushCountForTests(): number {
  return _activeFlushLoops;
}

export function __setAfterFinalScheduleObservationForTests(
  hook: (() => Promise<void>) | null
): void {
  _afterFinalScheduleObservationForTests = hook;
}

export function __setBeforeCloudBackupPassWorkForTests(
  hook: (() => Promise<void>) | null
): void {
  _beforeCloudBackupPassWorkForTests = hook;
}

export function __throwNextCloudBackupPassForTests(
  message = 'unexpected_pass_failure'
): void {
  _throwNextCloudBackupPass = new Error(message);
}

/** Test-only: invoke the scheduler wakeup callback without a second worker. */
export function __fireScheduledOutboxWakeupForTests(): void {
  onWakeupFire(wakeupScheduler().pendingDeadline());
}
