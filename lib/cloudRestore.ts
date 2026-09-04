/**
 * P0 Phase 6 — safe cloud → local restore (no merge / Apple / re-upload loop).
 *
 * Allowed only when local receipts are empty and sync_outbox has no pending rows.
 */
import type * as SQLite from 'expo-sqlite';

import { getAuthState } from './anonAuth';
import { cloudBackupBootstrapKvKey } from './cloudBackupBootstrap';
import {
  mapCloudReceiptToLocalInsert,
  type CloudUserReceiptRow,
  type LocalRestoredReceiptInsert,
} from './cloudRestorePayload';
import { getOrCreateInstallationId } from './installationId';
import {
  ensureReceiptItemsSchema,
  rebuildReceiptItemIndex,
} from './receiptItemIndex';
import { getSupabaseClient } from './supabaseClient';

export const CLOUD_RESTORE_PAGE_SIZE = 200;

export const RESTORE_KV_LAST_AT = 'last_restore_at';
export const RESTORE_KV_LAST_USER = 'last_restore_user_id';

export type CloudRestoreStatus =
  | 'ok'
  | 'auth_unavailable'
  | 'blocked_local_data_present'
  | 'blocked_pending_local_changes'
  | 'client_unavailable'
  | 'fetch_failed'
  | 'validation_failed'
  | 'write_failed';

export type CloudRestoreResult = {
  status: CloudRestoreStatus;
  restored: number;
  error?: string;
};

export type CloudRestoreDeps = {
  getDb: () => Promise<SQLite.SQLiteDatabase>;
  getAuth: () => ReturnType<typeof getAuthState>;
  getClient: typeof getSupabaseClient;
  getInstallationId: () => Promise<string>;
  pageSize?: number;
  nowMs?: () => number;
  /** Test seam: replace paginated cloud fetch */
  fetchActiveCloudReceipts?: (
    userId: string,
    pageSize: number
  ) => Promise<CloudUserReceiptRow[]>;
};

const CLOUD_SELECT = `
  id, user_id, installation_id, transaction_source, social_source,
  created_at, transaction_at, scanned_at,
  merchant_raw, merchant_normalized, merchant_type,
  store_raw, store_normalized,
  total, tax, tax_is_known, currency,
  analysis_json, recognition_snapshot_json, user_items_json,
  user_edited, final_total, final_category, note,
  ocr_request_id, client_updated_at, deleted_at
`.replace(/\s+/g, ' ').trim();

const INSERT_RESTORE_SQL = `
  INSERT INTO receipts (
    id, created_at, transaction_at, scanned_at,
    image_uri, source,
    merchant_raw, merchant_normalized, merchant_type,
    store_raw, store_normalized,
    total, tax, tax_is_known, currency,
    analysis_json, recognition_snapshot_json,
    user_edited, final_total, final_category, note, user_items_json,
    user_id, installation_id, transaction_source, ocr_request_id,
    client_updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function insertParams(row: LocalRestoredReceiptInsert): SQLite.SQLiteBindValue[] {
  return [
    row.id,
    row.created_at,
    row.transaction_at,
    row.scanned_at,
    row.image_uri,
    row.source,
    row.merchant_raw,
    row.merchant_normalized,
    row.merchant_type,
    row.store_raw,
    row.store_normalized,
    row.total,
    row.tax,
    row.tax_is_known,
    row.currency,
    row.analysis_json,
    row.recognition_snapshot_json,
    row.user_edited,
    row.final_total,
    row.final_category,
    row.note,
    row.user_items_json,
    row.user_id,
    row.installation_id,
    row.transaction_source,
    row.ocr_request_id,
    row.client_updated_at,
  ];
}

async function ensureAppKv(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
  );
}

async function countLocalReceipts(db: SQLite.SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM receipts`
  );
  return row?.c ?? 0;
}

async function countPendingOutbox(db: SQLite.SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM sync_outbox`
  );
  return row?.c ?? 0;
}

/**
 * Fetch all active (non-tombstoned) receipts for the authenticated user.
 * Deterministic pagination: order by id ASC + range pages.
 * RLS enforces user_id = auth.uid(); we still filter deleted_at IS NULL.
 */
export async function fetchAllActiveCloudReceiptsForUser(
  userId: string,
  pageSize: number = CLOUD_RESTORE_PAGE_SIZE,
  getClient: typeof getSupabaseClient = getSupabaseClient
): Promise<CloudUserReceiptRow[]> {
  const client = getClient();
  if (!client) {
    throw new Error('Supabase client unavailable');
  }
  const uid = userId.trim();
  if (!uid) throw new Error('userId required');

  const out: CloudUserReceiptRow[] = [];
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await client
      .from('user_receipts')
      .select(CLOUD_SELECT)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(error.message || 'cloud fetch failed');
    }
    const page = ((data ?? []) as unknown) as CloudUserReceiptRow[];
    // Defense in depth: never accept another user's rows even if RLS misconfigured in tests.
    for (const row of page) {
      if (String(row.user_id).trim() !== uid) {
        throw new Error('Cloud restore refused cross-user receipt');
      }
      if (row.deleted_at != null && String(row.deleted_at).trim() !== '') {
        continue;
      }
      out.push(row);
    }
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function materializeRestoreInTransaction(
  db: SQLite.SQLiteDatabase,
  rows: LocalRestoredReceiptInsert[],
  userId: string,
  nowMs: number
): Promise<void> {
  await ensureReceiptItemsSchema(db);
  await ensureAppKv(db);

  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      await db.runAsync(INSERT_RESTORE_SQL, insertParams(row));
      await rebuildReceiptItemIndex(
        db,
        {
          id: row.id,
          analysis_json: row.analysis_json,
          user_items_json: row.user_items_json,
        },
        { indexedAt: nowMs, skipTransaction: true }
      );
    }

    // Prevent Phase 5 bootstrap from treating restored rows as legacy unbacked-up data.
    await db.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
      cloudBackupBootstrapKvKey(userId),
      '1',
    ]);
    await db.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
      RESTORE_KV_LAST_AT,
      String(nowMs),
    ]);
    await db.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
      RESTORE_KV_LAST_USER,
      userId,
    ]);
  });
}

function resolveDeps(partial: Partial<CloudRestoreDeps>): CloudRestoreDeps {
  return {
    getAuth: partial.getAuth ?? getAuthState,
    getClient: partial.getClient ?? getSupabaseClient,
    getInstallationId: partial.getInstallationId ?? getOrCreateInstallationId,
    pageSize: partial.pageSize ?? CLOUD_RESTORE_PAGE_SIZE,
    nowMs: partial.nowMs ?? (() => Date.now()),
    fetchActiveCloudReceipts: partial.fetchActiveCloudReceipts,
    getDb:
      partial.getDb ??
      (async () => {
        // Lazy require avoids pulling expo-sqlite into unit tests that inject getDb.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getReceiptsDatabase } = require('./db') as typeof import('./db');
        return getReceiptsDatabase();
      }),
  };
}

/**
 * Restore active cloud receipts into an empty local DB for the verified session user.
 * Does NOT call saveReceipt/updateReceipt (no outbox intents).
 */
export async function restoreCloudReceiptsForCurrentUser(
  depsPartial: Partial<CloudRestoreDeps> = {}
): Promise<CloudRestoreResult> {
  const deps = resolveDeps(depsPartial);
  const auth = deps.getAuth();
  if (auth.status !== 'authenticated' || !auth.userId || !auth.accessToken) {
    return { status: 'auth_unavailable', restored: 0 };
  }
  const userId = auth.userId.trim();
  if (!userId) {
    return { status: 'auth_unavailable', restored: 0 };
  }

  const db = await deps.getDb();
  const localCount = await countLocalReceipts(db);
  if (localCount > 0) {
    return { status: 'blocked_local_data_present', restored: 0 };
  }
  const pending = await countPendingOutbox(db);
  if (pending > 0) {
    return { status: 'blocked_pending_local_changes', restored: 0 };
  }

  if (!deps.getClient() && !deps.fetchActiveCloudReceipts) {
    return { status: 'client_unavailable', restored: 0 };
  }

  const pageSize = deps.pageSize ?? CLOUD_RESTORE_PAGE_SIZE;
  let cloudRows: CloudUserReceiptRow[];
  try {
    cloudRows = deps.fetchActiveCloudReceipts
      ? await deps.fetchActiveCloudReceipts(userId, pageSize)
      : await fetchAllActiveCloudReceiptsForUser(userId, pageSize, deps.getClient);
  } catch (e: any) {
    return {
      status: 'fetch_failed',
      restored: 0,
      error: String(e?.message || e || 'fetch_failed'),
    };
  }

  const nowMs = deps.nowMs?.() ?? Date.now();
  let installationId: string;
  try {
    installationId = await deps.getInstallationId();
  } catch (e: any) {
    return {
      status: 'validation_failed',
      restored: 0,
      error: String(e?.message || e || 'installation_id_failed'),
    };
  }

  let mapped: LocalRestoredReceiptInsert[];
  try {
    mapped = cloudRows.map((row) =>
      mapCloudReceiptToLocalInsert(row, {
        expectedUserId: userId,
        currentInstallationId: installationId,
        fallbackClientUpdatedAtMs: nowMs,
      })
    );
  } catch (e: any) {
    return {
      status: 'validation_failed',
      restored: 0,
      error: String(e?.message || e || 'validation_failed'),
    };
  }

  // Re-check emptiness immediately before write (TOCTOU soft guard).
  if ((await countLocalReceipts(db)) > 0) {
    return { status: 'blocked_local_data_present', restored: 0 };
  }
  if ((await countPendingOutbox(db)) > 0) {
    return { status: 'blocked_pending_local_changes', restored: 0 };
  }

  try {
    await materializeRestoreInTransaction(db, mapped, userId, nowMs);
  } catch (e: any) {
    return {
      status: 'write_failed',
      restored: 0,
      error: String(e?.message || e || 'write_failed'),
    };
  }

  void import('./analysisPriceSessionCache')
    .then((m) => m.notifyAnalysisPriceTruthInvalidated())
    .catch(() => undefined);

  return { status: 'ok', restored: mapped.length };
}
