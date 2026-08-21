/**
 * P0 sync_outbox helpers — one latest pending intent per receipt.
 */
import type * as SQLite from 'expo-sqlite';

export type SyncOutboxOperation = 'upsert' | 'delete';

export type SyncOutboxRow = {
  receipt_id: string;
  user_id: string;
  operation: SyncOutboxOperation;
  intent_id: string;
  deleted_at: number | null;
  attempt_count: number;
  last_error: string | null;
  next_retry_at: number;
  created_at: number;
  updated_at: number;
};

export function generateSyncIntentId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Ensure sync_outbox exists (idempotent). */
export async function ensureSyncOutboxSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      intent_id TEXT NOT NULL,
      deleted_at INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sync_outbox_user_retry
      ON sync_outbox(user_id, next_retry_at ASC);
  `);
}

/**
 * Replace the latest pending intent for a receipt (INSERT OR REPLACE).
 * Must be called inside the caller's transaction when mutating receipts.
 */
export async function replaceSyncOutboxIntent(
  db: SQLite.SQLiteDatabase,
  params: {
    receiptId: string;
    userId: string;
    operation: SyncOutboxOperation;
    intentId: string;
    deletedAt?: number | null;
    nowMs?: number;
  }
): Promise<void> {
  const now = params.nowMs ?? Date.now();
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error('sync_outbox requires non-empty user_id');
  }

  await db.runAsync(
    `
    INSERT OR REPLACE INTO sync_outbox (
      receipt_id, user_id, operation, intent_id, deleted_at,
      attempt_count, last_error, next_retry_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
    `,
    [
      params.receiptId,
      userId,
      params.operation,
      params.intentId,
      params.operation === 'delete' ? (params.deletedAt ?? now) : null,
      now,
      now,
      now,
    ]
  );
}

/** Clear outbox row only when intent_id still matches (race-safe). */
export async function clearSyncOutboxIntentIfCurrent(
  db: SQLite.SQLiteDatabase,
  receiptId: string,
  intentId: string
): Promise<boolean> {
  const result = await db.runAsync(
    `DELETE FROM sync_outbox WHERE receipt_id = ? AND intent_id = ?`,
    [receiptId, intentId]
  );
  return (result?.changes ?? 0) > 0;
}

/** Update retry metadata only when intent_id still matches. */
export async function updateSyncOutboxRetryIfCurrent(
  db: SQLite.SQLiteDatabase,
  params: {
    receiptId: string;
    intentId: string;
    attemptCount: number;
    lastError: string | null;
    nextRetryAt: number;
    nowMs?: number;
  }
): Promise<boolean> {
  const now = params.nowMs ?? Date.now();
  const err =
    params.lastError == null
      ? null
      : String(params.lastError).slice(0, 500);
  const result = await db.runAsync(
    `
    UPDATE sync_outbox
    SET attempt_count = ?, last_error = ?, next_retry_at = ?, updated_at = ?
    WHERE receipt_id = ? AND intent_id = ?
    `,
    [
      params.attemptCount,
      err,
      params.nextRetryAt,
      now,
      params.receiptId,
      params.intentId,
    ]
  );
  return (result?.changes ?? 0) > 0;
}

export function computeBackoffMs(attemptCount: number): number {
  // attemptCount is the new count after failure (1-based for first failure).
  const base = 5_000;
  const exp = Math.max(attemptCount, 1) - 1;
  // Cap exponent to avoid overflow; wall-clock max is 1 hour.
  const ms = base * Math.pow(2, Math.min(exp, 20));
  return Math.min(ms, 60 * 60 * 1000);
}

export async function listDueSyncOutboxForUser(
  db: SQLite.SQLiteDatabase,
  userId: string,
  nowMs: number,
  limit = 20
): Promise<SyncOutboxRow[]> {
  const rows = await db.getAllAsync<SyncOutboxRow>(
    `
    SELECT receipt_id, user_id, operation, intent_id, deleted_at,
           attempt_count, last_error, next_retry_at, created_at, updated_at
    FROM sync_outbox
    WHERE user_id = ? AND next_retry_at <= ?
    ORDER BY updated_at ASC
    LIMIT ?
    `,
    [userId, nowMs, limit]
  );
  return rows ?? [];
}

/**
 * Earliest next_retry_at strictly in the future for this user, or null.
 * Used to schedule a single bounded wakeup (no polling).
 */
export async function getEarliestFutureSyncOutboxRetryAt(
  db: SQLite.SQLiteDatabase,
  userId: string,
  nowMs: number
): Promise<number | null> {
  const row = await db.getFirstAsync<{ next_retry_at: number }>(
    `
    SELECT next_retry_at
    FROM sync_outbox
    WHERE user_id = ? AND next_retry_at > ?
    ORDER BY next_retry_at ASC
    LIMIT 1
    `,
    [userId, nowMs]
  );
  if (!row || row.next_retry_at == null) return null;
  const n = Number(row.next_retry_at);
  return Number.isFinite(n) ? n : null;
}

export async function getSyncOutboxRow(
  db: SQLite.SQLiteDatabase,
  receiptId: string
): Promise<SyncOutboxRow | null> {
  const row = await db.getFirstAsync<SyncOutboxRow>(
    `
    SELECT receipt_id, user_id, operation, intent_id, deleted_at,
           attempt_count, last_error, next_retry_at, created_at, updated_at
    FROM sync_outbox WHERE receipt_id = ? LIMIT 1
    `,
    [receiptId]
  );
  return row ?? null;
}
