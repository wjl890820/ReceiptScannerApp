/**
 * Single-flight cloud backup flush worker.
 * Race-safe: only clears/updates outbox when intent_id still matches.
 *
 * Reliability:
 * - One flush request drains due intents in batches (bounded).
 * - Restored authenticated session triggers flush on worker start + auth emit.
 * - AppState active resumes flush.
 * - Future next_retry_at schedules a single wakeup timer.
 */
import type * as SQLite from 'expo-sqlite';

import { getAuthState, subscribeAuthState, type AuthState } from './anonAuth';
import { bootstrapOwnedReceiptBackupIntents } from './cloudBackupBootstrap';
import {
  assertNoImageUriInPayload,
  buildCloudUserReceiptUpsertPayload,
  type LocalReceiptBackupSource,
} from './cloudBackupPayload';
import { isCloudBackupEnabled } from './env';
import { getSupabaseClient } from './supabaseClient';
import {
  clearSyncOutboxIntentIfCurrent,
  computeBackoffMs,
  getEarliestFutureSyncOutboxRetryAt,
  listDueSyncOutboxForUser,
  type SyncOutboxRow,
  updateSyncOutboxRetryIfCurrent,
} from './syncOutbox';

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
let _started = false;
let _unsubscribeAuth: (() => void) | null = null;
let _appStateSub: { remove: () => void } | null = null;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
let _lastAppState: string | null = null;

const BACKUP_SELECT_COLUMNS = `
  id, user_id, installation_id, transaction_source, source,
  created_at, transaction_at, scanned_at,
  merchant_raw, merchant_normalized, merchant_type,
  store_raw, store_normalized,
  total, tax, COALESCE(tax_is_known, 0) as tax_is_known, currency,
  analysis_json, recognition_snapshot_json, user_items_json,
  COALESCE(user_edited, 0) as user_edited,
  final_total, final_category, note, ocr_request_id, client_updated_at
`;

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

function clearRetryTimer(): void {
  if (_retryTimer != null) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

/**
 * Schedule at most one wakeup for the earliest future next_retry_at.
 * No polling loop; cancelled when disabled / unauthenticated / reset.
 */
async function scheduleRetryWakeup(
  db: SQLite.SQLiteDatabase,
  userId: string,
  nowMs: number = Date.now()
): Promise<void> {
  clearRetryTimer();
  if (!isCloudBackupEnabled()) return;
  const auth = getAuthState();
  if (auth.status !== 'authenticated' || auth.userId !== userId) return;

  const earliest = await getEarliestFutureSyncOutboxRetryAt(db, userId, nowMs);
  if (earliest == null) return;

  const delay = Math.max(250, Math.min(earliest - nowMs, 60 * 60 * 1000));
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    if (!isCloudBackupEnabled()) return;
    const s = getAuthState();
    if (s.status !== 'authenticated' || !s.userId) return;
    void requestCloudBackupFlush();
  }, delay);
}

async function runFlushOnce(): Promise<CloudBackupFlushResult> {
  if (!isCloudBackupEnabled()) {
    clearRetryTimer();
    return { ran: false, reason: 'flag_off', processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }
  if (!_getDb) {
    return { ran: false, reason: 'no_db', processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  const auth = getAuthState();
  if (auth.status !== 'authenticated' || !auth.userId || !auth.accessToken) {
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

/**
 * Request a backup flush. Serialized in-process (single-flight).
 * Not async: must return the exact shared Promise reference.
 */
export function requestCloudBackupFlush(): Promise<CloudBackupFlushResult> {
  if (_inflight) return _inflight;
  _inflight = runFlushOnce().finally(() => {
    _inflight = null;
  });
  return _inflight;
}

function onAuthState(state: AuthState): void {
  if (!isCloudBackupEnabled()) {
    clearRetryTimer();
    return;
  }
  if (state.status !== 'authenticated' || !state.userId) {
    clearRetryTimer();
    return;
  }
  void requestCloudBackupFlush();
}

function onAppStateChange(next: string): void {
  const prev = _lastAppState;
  _lastAppState = next;
  if (!isCloudBackupEnabled()) return;
  // background/inactive → active
  if (next === 'active' && prev != null && prev !== 'active') {
    void requestCloudBackupFlush();
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
  clearRetryTimer();
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
  return _retryTimer != null;
}
