/**
 * Idempotent initial cloud-backup bootstrap: queue upsert intents for owned
 * receipts that predate sync_outbox (no existing outbox row).
 *
 * Marker: app_kv key includes schema version + user_id.
 * Marker is set only after all current owned rows were queued successfully.
 */
import type * as SQLite from 'expo-sqlite';

import {
  generateSyncIntentId,
  replaceSyncOutboxIntent,
} from './syncOutbox';

export const CLOUD_BACKUP_BOOTSTRAP_SCHEMA_VERSION = 1;

export function cloudBackupBootstrapKvKey(userId: string): string {
  return `cloud_backup_bootstrap_v${CLOUD_BACKUP_BOOTSTRAP_SCHEMA_VERSION}:${userId}`;
}

export type BootstrapResult = {
  attempted: boolean;
  queued: number;
  alreadyMarked: boolean;
};

async function ensureAppKv(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
  );
}

/**
 * Queue upsert intents for owned receipts missing from sync_outbox.
 * Crash-safe: marker written only after successful queue pass.
 */
export async function bootstrapOwnedReceiptBackupIntents(
  db: SQLite.SQLiteDatabase,
  userId: string,
  nowMs: number = Date.now()
): Promise<BootstrapResult> {
  const uid = userId.trim();
  if (!uid) {
    return { attempted: false, queued: 0, alreadyMarked: false };
  }

  await ensureAppKv(db);
  const key = cloudBackupBootstrapKvKey(uid);
  const done = await db.getFirstAsync<{ v: string }>(
    `SELECT v FROM app_kv WHERE k = ?`,
    [key]
  );
  if (done?.v === '1') {
    return { attempted: false, queued: 0, alreadyMarked: true };
  }

  const missing = await db.getAllAsync<{ id: string }>(
    `
    SELECT r.id
    FROM receipts r
    WHERE r.user_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM sync_outbox o WHERE o.receipt_id = r.id
      )
    `,
    [uid]
  );

  let queued = 0;
  await db.withTransactionAsync(async () => {
    for (const row of missing ?? []) {
      await replaceSyncOutboxIntent(db, {
        receiptId: row.id,
        userId: uid,
        operation: 'upsert',
        intentId: generateSyncIntentId(),
        nowMs,
      });
      queued += 1;
    }

    await db.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
      key,
      '1',
    ]);
  });

  return { attempted: true, queued, alreadyMarked: false };
}

/** Queue upsert intents for specific newly adopted receipt IDs (idempotent replace). */
export async function enqueueUpsertIntentsForReceiptIds(
  db: SQLite.SQLiteDatabase,
  userId: string,
  receiptIds: string[],
  nowMs: number = Date.now()
): Promise<number> {
  const uid = userId.trim();
  if (!uid || receiptIds.length === 0) return 0;
  let n = 0;
  await db.withTransactionAsync(async () => {
    for (const id of receiptIds) {
      await replaceSyncOutboxIntent(db, {
        receiptId: id,
        userId: uid,
        operation: 'upsert',
        intentId: generateSyncIntentId(),
        nowMs,
      });
      n += 1;
    }
  });
  return n;
}
