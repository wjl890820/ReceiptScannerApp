/**
 * Single-flight cloud backup flush worker.
 * Race-safe: only clears/updates outbox when intent_id still matches.
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
};

type GetDbFn = () => Promise<SQLite.SQLiteDatabase>;

let _getDb: GetDbFn | null = null;
let _inflight: Promise<CloudBackupFlushResult> | null = null;
let _started = false;
let _unsubscribe: (() => void) | null = null;

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

async function runFlushOnce(): Promise<CloudBackupFlushResult> {
  if (!isCloudBackupEnabled()) {
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
  const now = Date.now();

  try {
    await bootstrapOwnedReceiptBackupIntents(db, currentUserId, now);
  } catch (e) {
    console.warn('[CloudBackup] bootstrap failed (nonfatal):', e);
  }

  const due = await listDueSyncOutboxForUser(db, currentUserId, now);
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const intent of due) {
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

      if (outcome === 'ok') succeeded += 1;
      else if (outcome === 'skip') skipped += 1;
      else failed += 1;
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

  return {
    ran: true,
    processed: due.length,
    succeeded,
    failed,
    skipped,
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
  if (!isCloudBackupEnabled()) return;
  if (state.status !== 'authenticated' || !state.userId) return;
  void requestCloudBackupFlush();
}

export function startCloudBackupWorker(getDb: GetDbFn): void {
  _getDb = getDb;
  if (_started) {
    onAuthState(getAuthState());
    return;
  }
  _started = true;
  _unsubscribe = subscribeAuthState(onAuthState);
  onAuthState(getAuthState());
}

/** Test helpers */
export function __resetCloudBackupWorkerForTests(): void {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  _started = false;
  _inflight = null;
  _getDb = null;
}

export function __runCloudBackupFlushForTests(
  getDb: GetDbFn
): Promise<CloudBackupFlushResult> {
  _getDb = getDb;
  return requestCloudBackupFlush();
}
