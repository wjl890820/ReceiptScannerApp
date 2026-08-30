/**
 * Privacy-H5 — one-time conservative installation provenance recovery for
 * legacy double-null receipts. Never assigns user_id.
 */
import type * as SQLite from 'expo-sqlite';

import { getOrCreateInstallationId } from './installationId';

export const LEGACY_RECEIPT_INSTALLATION_BACKFILL_V1_KEY =
  'legacy_receipt_installation_backfill_v1';

export type LegacyInstallationBackfillOutcome =
  | 'backfilled'
  | 'nothing_to_do'
  | 'quarantined_conflict'
  | 'installation_unavailable'
  | 'already_completed';

export type LegacyInstallationBackfillResult = {
  outcome: LegacyInstallationBackfillOutcome;
  backfilledCount: number;
};

export type LegacyInstallationBackfillDeps = {
  getInstallationId: () => Promise<string>;
};

const UNOWNED_USER_SQL = `(user_id IS NULL OR TRIM(COALESCE(user_id, '')) = '')`;
const UNOWNED_INSTALL_SQL = `(installation_id IS NULL OR TRIM(COALESCE(installation_id, '')) = '')`;
const OWNED_USER_SQL = `(user_id IS NOT NULL AND TRIM(user_id) <> '')`;
const NONEMPTY_INSTALL_SQL = `(installation_id IS NOT NULL AND TRIM(installation_id) <> '')`;

type PersistedMarker = {
  outcome: Exclude<
    LegacyInstallationBackfillOutcome,
    'installation_unavailable' | 'already_completed'
  >;
  backfilledCount?: number;
};

async function ensureAppKvTable(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
  );
}

async function readMarker(
  db: SQLite.SQLiteDatabase
): Promise<PersistedMarker | null> {
  await ensureAppKvTable(db);
  const row = await db.getFirstAsync<{ v: string }>(
    `SELECT v FROM app_kv WHERE k = ?`,
    [LEGACY_RECEIPT_INSTALLATION_BACKFILL_V1_KEY]
  );
  if (!row?.v) return null;
  try {
    return JSON.parse(row.v) as PersistedMarker;
  } catch {
    return null;
  }
}

async function writeMarker(
  db: SQLite.SQLiteDatabase,
  marker: PersistedMarker
): Promise<void> {
  await ensureAppKvTable(db);
  await db.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
    LEGACY_RECEIPT_INSTALLATION_BACKFILL_V1_KEY,
    JSON.stringify(marker),
  ]);
}

function markerToResult(marker: PersistedMarker): LegacyInstallationBackfillResult {
  return {
    outcome: marker.outcome,
    backfilledCount: marker.backfilledCount ?? 0,
  };
}

/**
 * Conservative provenance gate for double-null recovery.
 * Safe only when no user-owned rows exist and every stamped installation matches current.
 */
export async function assessLegacyInstallationBackfillSafety(
  db: SQLite.SQLiteDatabase,
  currentInstallationId: string
): Promise<'safe' | 'quarantined_conflict'> {
  const owned = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM receipts WHERE ${OWNED_USER_SQL}`
  );
  if ((owned?.c ?? 0) > 0) {
    return 'quarantined_conflict';
  }

  const otherInstall = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM receipts
     WHERE ${NONEMPTY_INSTALL_SQL}
       AND installation_id <> ?`,
    [currentInstallationId]
  );
  if ((otherInstall?.c ?? 0) > 0) {
    return 'quarantined_conflict';
  }

  return 'safe';
}

export async function listDoubleNullReceiptIds(
  db: SQLite.SQLiteDatabase
): Promise<string[]> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id
     FROM receipts
     WHERE ${UNOWNED_USER_SQL}
       AND ${UNOWNED_INSTALL_SQL}
     ORDER BY id ASC`
  );
  return rows.map((row) => row.id);
}

export async function runLegacyReceiptInstallationBackfill(
  db: SQLite.SQLiteDatabase,
  deps: LegacyInstallationBackfillDeps = {
    getInstallationId: getOrCreateInstallationId,
  }
): Promise<LegacyInstallationBackfillResult> {
  const existing = await readMarker(db);
  if (existing) {
    return { ...markerToResult(existing), outcome: 'already_completed' };
  }

  let installationId = '';
  try {
    installationId = (await deps.getInstallationId()).trim();
  } catch {
    return { outcome: 'installation_unavailable', backfilledCount: 0 };
  }
  if (!installationId) {
    return { outcome: 'installation_unavailable', backfilledCount: 0 };
  }

  let result: LegacyInstallationBackfillResult = {
    outcome: 'nothing_to_do',
    backfilledCount: 0,
  };

  await db.withExclusiveTransactionAsync(async (txn) => {
    const markerAgain = await txn.getFirstAsync<{ v: string }>(
      `SELECT v FROM app_kv WHERE k = ?`,
      [LEGACY_RECEIPT_INSTALLATION_BACKFILL_V1_KEY]
    );
    if (markerAgain?.v) {
      const parsed = JSON.parse(markerAgain.v) as PersistedMarker;
      result = { ...markerToResult(parsed), outcome: 'already_completed' };
      return;
    }

    const total = await txn.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM receipts`
    );
    if ((total?.c ?? 0) === 0) {
      await writeMarker(txn, { outcome: 'nothing_to_do', backfilledCount: 0 });
      result = { outcome: 'nothing_to_do', backfilledCount: 0 };
      return;
    }

    const safety = await assessLegacyInstallationBackfillSafety(
      txn,
      installationId
    );
    if (safety === 'quarantined_conflict') {
      await writeMarker(txn, {
        outcome: 'quarantined_conflict',
        backfilledCount: 0,
      });
      result = { outcome: 'quarantined_conflict', backfilledCount: 0 };
      return;
    }

    const candidates = await listDoubleNullReceiptIds(txn);
    if (candidates.length === 0) {
      await writeMarker(txn, { outcome: 'nothing_to_do', backfilledCount: 0 });
      result = { outcome: 'nothing_to_do', backfilledCount: 0 };
      return;
    }

    const placeholders = candidates.map(() => '?').join(',');
    const updateResult = await txn.runAsync(
      `UPDATE receipts
       SET installation_id = ?
       WHERE id IN (${placeholders})
         AND ${UNOWNED_USER_SQL}
         AND ${UNOWNED_INSTALL_SQL}`,
      [installationId, ...candidates]
    );
    const changed = updateResult.changes ?? 0;
    if (changed !== candidates.length) {
      throw new Error(
        `legacy installation backfill mismatch: expected ${candidates.length}, got ${changed}`
      );
    }

    await writeMarker(txn, {
      outcome: 'backfilled',
      backfilledCount: changed,
    });
    result = { outcome: 'backfilled', backfilledCount: changed };
  });

  return result;
}

/** Invoked during DB init after ownership columns exist. */
export async function ensureLegacyReceiptInstallationBackfill(
  db: SQLite.SQLiteDatabase
): Promise<LegacyInstallationBackfillResult> {
  return runLegacyReceiptInstallationBackfill(db);
}
