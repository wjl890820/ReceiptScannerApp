/**
 * P0 Phase 6 — safe cloud → local restore (no merge / Apple / re-upload loop).
 *
 * Allowed only when local receipts, sync_outbox, and this account's personal
 * decisions / unsynced decision state are empty.
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
import { invalidatePersonalProductEndpointInventory } from './personalProductEndpointInventoryCache';
import { invalidateAnalyticsReceiptSelection } from './analyticsReceiptSelectionCache';
import {
  fetchAllActiveCloudPersonalDecisionsForUser,
  isPersonalDecisionTableMissingError,
  mapCloudPersonalDecisionToLocalInsert,
  personalDecisionBackupBootstrapKvKey,
  personalDecisionBackupDirtyKvKey,
  personalDecisionBackupGenerationKvKey,
  personalDecisionRestoreBlocked,
  readPersonalDecisionRestoreBlocked,
  type LocalPersonalDecisionBackupRow,
} from './personalDecisionCloudSync';
import { withPersonalDecisionLocalMutationGate } from './personalDecisionLocalMutationGate';
import { ensurePersonalProductIdentitySchema } from './personalProductIdentitySchema';

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
  | 'write_failed'
  | 'decision_schema_unavailable';

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
  /** Test seam: replace paginated personal-decision fetch */
  fetchActiveCloudDecisions?: (
    userId: string
  ) => Promise<Record<string, unknown>[]>;
  /**
   * Runs inside the personal-decision mutation gate, after the protected
   * eligibility recheck and before the remote fetch. Production callers omit it.
   */
  beforeLocalMutationGate?: () => Promise<void>;
  /**
   * Re-read the authoritative session.
   * Called before each remote query and again after validation, before any local write.
   * Null, a thrown read, or a different user id aborts with no local writes.
   */
  confirmAuthenticatedUserId?: () => Promise<string | null>;
};

type RestoreSql = Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'runAsync' | 'execAsync' | 'getAllAsync'>;

class RestoreEligibilityRefusal extends Error {
  constructor(
    readonly restoreStatus: 'blocked_local_data_present' | 'blocked_pending_local_changes'
  ) {
    super(restoreStatus);
    this.name = 'RestoreEligibilityRefusal';
  }
}

class RestoreSessionChangedError extends Error {
  constructor() {
    super('session_user_changed');
    this.name = 'RestoreSessionChangedError';
  }
}

async function confirmRestoreUserStillCurrent(
  deps: CloudRestoreDeps,
  userId: string
): Promise<void> {
  if (!deps.confirmAuthenticatedUserId) return;
  let confirmed = '';
  try {
    confirmed = (await deps.confirmAuthenticatedUserId())?.trim() ?? '';
  } catch {
    throw new RestoreSessionChangedError();
  }
  if (!confirmed || confirmed !== userId) {
    throw new RestoreSessionChangedError();
  }
}

const CLOUD_SELECT = `
  id, user_id, installation_id, transaction_source, social_source,
  created_at, transaction_at, transaction_time_precision, scanned_at,
  merchant_raw, merchant_normalized, merchant_type,
  store_raw, store_normalized,
  total, tax, tax_is_known, currency,
  analysis_json, recognition_snapshot_json, user_items_json,
  user_edited, final_total, final_category, note,
  ocr_request_id, client_updated_at, deleted_at,
  verified_purchase_occurrence_id,
  verified_purchase_occurrence_source,
  verified_purchase_occurrence_verified_at,
  merchant_scope_generation
`.replace(/\s+/g, ' ').trim();

const INSERT_RESTORE_SQL = `
  INSERT INTO receipts (
    id, created_at, transaction_at, transaction_time_precision, scanned_at,
    image_uri, source,
    merchant_raw, merchant_normalized, merchant_type,
    store_raw, store_normalized,
    total, tax, tax_is_known, currency,
    analysis_json, recognition_snapshot_json,
    user_edited, final_total, final_category, note, user_items_json,
    user_id, installation_id, transaction_source, ocr_request_id,
    client_updated_at,
    verified_purchase_occurrence_id,
    verified_purchase_occurrence_source,
    verified_purchase_occurrence_verified_at,
    merchant_scope_generation
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function insertParams(row: LocalRestoredReceiptInsert): SQLite.SQLiteBindValue[] {
  return [
    row.id,
    row.created_at,
    row.transaction_at,
    row.transaction_time_precision,
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
    row.verified_purchase_occurrence_id,
    row.verified_purchase_occurrence_source,
    row.verified_purchase_occurrence_verified_at,
    row.merchant_scope_generation,
  ];
}

async function ensureAppKv(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
  );
}

async function countLocalReceipts(db: Pick<RestoreSql, 'getFirstAsync'>): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM receipts`
  );
  return row?.c ?? 0;
}

async function countPendingOutbox(db: Pick<RestoreSql, 'getFirstAsync'>): Promise<number> {
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

const INSERT_PERSONAL_DECISION_SQL = `
  INSERT INTO personal_product_identity_decisions (
    owner_key,
    left_merchant_product_id,
    right_merchant_product_id,
    left_merchant_scope_key,
    right_merchant_scope_key,
    left_comparison_key,
    right_comparison_key,
    left_structural_signature,
    right_structural_signature,
    identity_pipeline_version,
    decision,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function personalDecisionInsertParams(
  row: LocalPersonalDecisionBackupRow
): SQLite.SQLiteBindValue[] {
  return [
    row.owner_key,
    row.left_merchant_product_id,
    row.right_merchant_product_id,
    row.left_merchant_scope_key,
    row.right_merchant_scope_key,
    row.left_comparison_key,
    row.right_comparison_key,
    row.left_structural_signature,
    row.right_structural_signature,
    row.identity_pipeline_version,
    row.decision,
    row.created_at,
    row.updated_at,
  ];
}

async function assertRestoreEligibleInTransaction(
  txn: RestoreSql,
  userId: string
): Promise<void> {
  if ((await countLocalReceipts(txn)) > 0) {
    throw new RestoreEligibilityRefusal('blocked_local_data_present');
  }
  if ((await countPendingOutbox(txn)) > 0) {
    throw new RestoreEligibilityRefusal('blocked_pending_local_changes');
  }
  if (await readPersonalDecisionRestoreBlocked(txn, userId)) {
    throw new RestoreEligibilityRefusal('blocked_local_data_present');
  }
}

async function materializeRestoreInTransaction(
  db: SQLite.SQLiteDatabase,
  rows: LocalRestoredReceiptInsert[],
  decisions: LocalPersonalDecisionBackupRow[],
  userId: string,
  nowMs: number,
  markDecisionBackupCurrent: boolean
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await assertRestoreEligibleInTransaction(txn, userId);

    for (const row of rows) {
      await txn.runAsync(INSERT_RESTORE_SQL, insertParams(row));
      await rebuildReceiptItemIndex(
        txn,
        {
          id: row.id,
          analysis_json: row.analysis_json,
          user_items_json: row.user_items_json,
        },
        { indexedAt: nowMs, skipTransaction: true }
      );
    }

    for (const decision of decisions) {
      await txn.runAsync(INSERT_PERSONAL_DECISION_SQL, personalDecisionInsertParams(decision));
    }

    if (markDecisionBackupCurrent) {
      await txn.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
        personalDecisionBackupBootstrapKvKey(userId),
        '1',
      ]);
      await txn.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
        personalDecisionBackupDirtyKvKey(userId),
        '0',
      ]);
      await txn.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
        personalDecisionBackupGenerationKvKey(userId),
        '0',
      ]);
    }

    // generation is a local mutation epoch for backup ack races, not a cloud revision.
    // Restored cloud state is the new local baseline, so generation starts at 0.
    // Prevent Phase 5 bootstrap from treating restored rows as legacy unbacked-up data.
    await txn.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
      cloudBackupBootstrapKvKey(userId),
      '1',
    ]);
    await txn.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
      RESTORE_KV_LAST_AT,
      String(nowMs),
    ]);
    await txn.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
      RESTORE_KV_LAST_USER,
      userId,
    ]);
  });
}

function localRestoreWriteFailure(error: unknown): CloudRestoreResult {
  const message = error instanceof Error ? error.message : String(error || 'write_failed');
  return {
    status: 'write_failed',
    restored: 0,
    error: message || 'write_failed',
  };
}

function resolveDeps(partial: Partial<CloudRestoreDeps>): CloudRestoreDeps {
  return {
    getAuth: partial.getAuth ?? getAuthState,
    getClient: partial.getClient ?? getSupabaseClient,
    getInstallationId: partial.getInstallationId ?? getOrCreateInstallationId,
    pageSize: partial.pageSize ?? CLOUD_RESTORE_PAGE_SIZE,
    nowMs: partial.nowMs ?? (() => Date.now()),
    fetchActiveCloudReceipts: partial.fetchActiveCloudReceipts,
    fetchActiveCloudDecisions: partial.fetchActiveCloudDecisions,
    beforeLocalMutationGate: partial.beforeLocalMutationGate,
    confirmAuthenticatedUserId: partial.confirmAuthenticatedUserId,
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
 * Clean-local predicate shared by startup restore and Apple restore.
 * Receipts and outbox are global. Personal decisions and dirty are per user.
 */
export async function evaluateCleanLocalRestoreEligibility(
  db: SQLite.SQLiteDatabase,
  userId: string
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: 'blocked_local_data_present' | 'blocked_pending_local_changes';
    }
> {
  if ((await countLocalReceipts(db)) > 0) {
    return { ok: false, status: 'blocked_local_data_present' };
  }
  if ((await countPendingOutbox(db)) > 0) {
    return { ok: false, status: 'blocked_pending_local_changes' };
  }
  if (await personalDecisionRestoreBlocked(db, userId)) {
    return { ok: false, status: 'blocked_local_data_present' };
  }
  return { ok: true };
}

/**
 * Restore the authenticated user's cloud receipts and personal decisions into an
 * empty local DB. Does not sign in and does not change the account.
 * Does NOT call saveReceipt/updateReceipt (no outbox intents).
 *
 * Once the local database is eligible, the personal-decision mutation gate is
 * held across the remote fetch so a later decision cannot commit first.
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
  try {
    const early = await evaluateCleanLocalRestoreEligibility(db, userId);
    if (!early.ok) {
      return { status: early.status, restored: 0 };
    }
  } catch (e: unknown) {
    return localRestoreWriteFailure(e);
  }

  if (!deps.getClient() && !deps.fetchActiveCloudReceipts) {
    return { status: 'client_unavailable', restored: 0 };
  }

  const pageSize = deps.pageSize ?? CLOUD_RESTORE_PAGE_SIZE;
  const nowMs = deps.nowMs?.() ?? Date.now();
  let mapped: LocalRestoredReceiptInsert[] = [];

  try {
    await withPersonalDecisionLocalMutationGate(async () => {
      const held = await evaluateCleanLocalRestoreEligibility(db, userId);
      if (!held.ok) {
        throw new RestoreEligibilityRefusal(held.status);
      }
      if (deps.beforeLocalMutationGate) await deps.beforeLocalMutationGate();
      const afterHook = await evaluateCleanLocalRestoreEligibility(db, userId);
      if (!afterHook.ok) {
        throw new RestoreEligibilityRefusal(afterHook.status);
      }
      await confirmRestoreUserStillCurrent(deps, userId);

      let cloudRows: CloudUserReceiptRow[];
      try {
        cloudRows = deps.fetchActiveCloudReceipts
          ? await deps.fetchActiveCloudReceipts(userId, pageSize)
          : await fetchAllActiveCloudReceiptsForUser(userId, pageSize, deps.getClient);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e || 'fetch_failed');
        throw Object.assign(new Error(message || 'fetch_failed'), {
          restoreStatus: 'fetch_failed' as const,
        });
      }

      await confirmRestoreUserStillCurrent(deps, userId);

      let rawDecisions: Record<string, unknown>[];
      try {
        rawDecisions = deps.fetchActiveCloudDecisions
          ? await deps.fetchActiveCloudDecisions(userId)
          : await fetchAllActiveCloudPersonalDecisionsForUser(userId, deps.getClient);
      } catch (e: unknown) {
        if (isPersonalDecisionTableMissingError(e)) {
          throw Object.assign(new Error('decision_schema_unavailable'), {
            restoreStatus: 'decision_schema_unavailable' as const,
          });
        }
        const message = e instanceof Error ? e.message : String(e || 'fetch_failed');
        throw Object.assign(new Error(message || 'fetch_failed'), {
          restoreStatus: 'fetch_failed' as const,
        });
      }

      let installationId: string;
      try {
        installationId = await deps.getInstallationId();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e || 'installation_id_failed');
        throw Object.assign(new Error(message || 'installation_id_failed'), {
          restoreStatus: 'validation_failed' as const,
        });
      }

      try {
        mapped = cloudRows.map((row) =>
          mapCloudReceiptToLocalInsert(row, {
            expectedUserId: userId,
            currentInstallationId: installationId,
            fallbackClientUpdatedAtMs: nowMs,
          })
        );
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e || 'validation_failed');
        throw Object.assign(new Error(message || 'validation_failed'), {
          restoreStatus: 'validation_failed' as const,
        });
      }

      let mappedDecisions: LocalPersonalDecisionBackupRow[];
      try {
        const seenPairs = new Set<string>();
        mappedDecisions = rawDecisions.map((row) => {
          const decision = mapCloudPersonalDecisionToLocalInsert(row, userId);
          const pairKey = `${decision.left_merchant_product_id}\0${decision.right_merchant_product_id}`;
          if (seenPairs.has(pairKey)) {
            throw new Error('Cloud personal decision pair is duplicated');
          }
          seenPairs.add(pairKey);
          return decision;
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e || 'validation_failed');
        throw Object.assign(new Error(message || 'validation_failed'), {
          restoreStatus: 'validation_failed' as const,
        });
      }

      await confirmRestoreUserStillCurrent(deps, userId);

      try {
        // Schema changes happen only after the post-fetch UID check, still before inserts.
        await ensureReceiptItemsSchema(db);
        await ensurePersonalProductIdentitySchema(db);
        await ensureAppKv(db);
      } catch (e: unknown) {
        throw Object.assign(
          e instanceof Error ? e : new Error(String(e || 'write_failed')),
          { restoreStatus: 'write_failed' as const }
        );
      }

      await materializeRestoreInTransaction(
        db,
        mapped,
        mappedDecisions,
        userId,
        nowMs,
        true
      );
    });
  } catch (e: unknown) {
    if (e instanceof RestoreEligibilityRefusal) {
      return { status: e.restoreStatus, restored: 0 };
    }
    if (e instanceof RestoreSessionChangedError) {
      return { status: 'auth_unavailable', restored: 0, error: 'session_user_changed' };
    }
    const status = (e as { restoreStatus?: CloudRestoreStatus } | null)?.restoreStatus;
    if (status === 'fetch_failed') {
      return {
        status: 'fetch_failed',
        restored: 0,
        error: e instanceof Error ? e.message : 'fetch_failed',
      };
    }
    if (status === 'validation_failed') {
      return {
        status: 'validation_failed',
        restored: 0,
        error: e instanceof Error ? e.message : 'validation_failed',
      };
    }
    if (status === 'decision_schema_unavailable') {
      return {
        status: 'decision_schema_unavailable',
        restored: 0,
        error: e instanceof Error ? e.message : 'decision_schema_unavailable',
      };
    }
    return localRestoreWriteFailure(e);
  }

  void import('./analysisPriceSessionCache')
    .then((m) => m.notifyAnalysisPriceTruthInvalidated())
    .catch(() => undefined);
  invalidatePersonalProductEndpointInventory('cloud_restore');
  invalidateAnalyticsReceiptSelection('cloud_restore');

  return { status: 'ok', restored: mapped.length };
}
