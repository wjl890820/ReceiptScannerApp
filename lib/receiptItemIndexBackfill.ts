import type * as SQLite from 'expo-sqlite';

import {
  ensureReceiptItemsSchema,
  rebuildReceiptItemIndex,
  type ReceiptItemIndexDatabase,
  type ReceiptItemIndexReceipt,
} from './receiptItemIndex';
import { logger } from './logger';

export const RECEIPT_ITEM_INDEX_VERSION = 1;
export const DEFAULT_RECEIPT_ITEM_BACKFILL_BATCH_SIZE = 25;
export const MAX_RECEIPT_ITEM_BACKFILL_FAILED_IDS = 500;

const STATE_PREFIX = 'receipt_item_index_backfill_';
const STATE_KEYS = {
  version: `${STATE_PREFIX}version`,
  cursor: `${STATE_PREFIX}cursor`,
  scanned: `${STATE_PREFIX}scanned`,
  succeeded: `${STATE_PREFIX}succeeded`,
  failed: `${STATE_PREFIX}failed`,
  failedIds: `${STATE_PREFIX}failed_ids`,
  failedOverflow: `${STATE_PREFIX}failed_overflow`,
  completedAt: `${STATE_PREFIX}completed_at`,
} as const;

type ReceiptItemIndexBackfillDatabase = ReceiptItemIndexDatabase & {
  getFirstAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T | null>;
};

export type ReceiptItemIndexBackfillCursor = {
  createdAt: number;
  id: string;
};

export type ReceiptItemIndexBackfillStatus = {
  version: number;
  complete: boolean;
  cursor: ReceiptItemIndexBackfillCursor | null;
  scanned: number;
  succeeded: number;
  failed: number;
  failedReceiptIds: string[];
  failedOverflow: boolean;
  completedAt: number | null;
};

export type ReceiptItemIndexBackfillBatchResult = {
  scanned: number;
  succeeded: number;
  failed: number;
  hasMore: boolean;
  cursor: ReceiptItemIndexBackfillCursor | null;
  version: number;
};

export type ReceiptItemIndexJoinReadiness = {
  receiptCount: number;
  itemRowCount: number;
  joinedItemRowCount: number;
  orphanRowCount: number;
};

export type ReceiptItemIndexJoinReadinessRow = {
  itemId: string;
  receiptId: string;
  normalizedName: string;
  transactionAt: number;
  merchantNormalized: string | null;
  merchantType: string | null;
};

type BackfillReceiptRow = ReceiptItemIndexReceipt & {
  created_at: number;
};

type PersistedState = ReceiptItemIndexBackfillStatus;

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function parseCursor(value: string | undefined): ReceiptItemIndexBackfillCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const createdAt = Number(parsed.createdAt);
    const id = typeof parsed.id === 'string' ? parsed.id : '';
    return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

function parseFailedIds(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0
        )
      ),
    ].slice(0, MAX_RECEIPT_ITEM_BACKFILL_FAILED_IDS);
  } catch {
    return [];
  }
}

async function ensureBackfillStateSchema(
  db: ReceiptItemIndexBackfillDatabase
): Promise<void> {
  await ensureReceiptItemsSchema(db);
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS app_kv (
      k TEXT PRIMARY KEY NOT NULL,
      v TEXT NOT NULL
    )`
  );
}

async function readState(
  db: ReceiptItemIndexBackfillDatabase
): Promise<PersistedState> {
  const rows = await db.getAllAsync<{ k: string; v: string }>(
    `SELECT k, v FROM app_kv WHERE k LIKE ?`,
    [`${STATE_PREFIX}%`]
  );
  const values = new Map(rows.map((row) => [row.k, row.v]));
  const version = nonNegativeInteger(values.get(STATE_KEYS.version));
  return {
    version,
    complete: version >= RECEIPT_ITEM_INDEX_VERSION,
    cursor: parseCursor(values.get(STATE_KEYS.cursor)),
    scanned: nonNegativeInteger(values.get(STATE_KEYS.scanned)),
    succeeded: nonNegativeInteger(values.get(STATE_KEYS.succeeded)),
    failed: nonNegativeInteger(values.get(STATE_KEYS.failed)),
    failedReceiptIds: parseFailedIds(values.get(STATE_KEYS.failedIds)),
    failedOverflow: values.get(STATE_KEYS.failedOverflow) === '1',
    completedAt: values.get(STATE_KEYS.completedAt)
      ? nonNegativeInteger(values.get(STATE_KEYS.completedAt))
      : null,
  };
}

async function writeState(
  db: ReceiptItemIndexBackfillDatabase,
  state: PersistedState
): Promise<void> {
  const entries: [string, string][] = [
    [STATE_KEYS.version, String(state.version)],
    [STATE_KEYS.cursor, state.cursor ? JSON.stringify(state.cursor) : ''],
    [STATE_KEYS.scanned, String(state.scanned)],
    [STATE_KEYS.succeeded, String(state.succeeded)],
    [STATE_KEYS.failed, String(state.failed)],
    [STATE_KEYS.failedIds, JSON.stringify(state.failedReceiptIds)],
    [STATE_KEYS.failedOverflow, state.failedOverflow ? '1' : '0'],
    [STATE_KEYS.completedAt, state.completedAt == null ? '' : String(state.completedAt)],
  ];
  await db.withTransactionAsync(async () => {
    for (const [key, value] of entries) {
      await db.runAsync(
        `INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`,
        [key, value]
      );
    }
  });
}

function addFailedReceipt(state: PersistedState, receiptId: string): void {
  if (state.failedReceiptIds.includes(receiptId)) return;
  if (state.failedReceiptIds.length < MAX_RECEIPT_ITEM_BACKFILL_FAILED_IDS) {
    state.failedReceiptIds.push(receiptId);
  } else {
    state.failedOverflow = true;
  }
}

function removeFailedReceipt(state: PersistedState, receiptId: string): void {
  state.failedReceiptIds = state.failedReceiptIds.filter((id) => id !== receiptId);
}

async function rebuildOne(
  db: ReceiptItemIndexBackfillDatabase,
  state: PersistedState,
  receipt: BackfillReceiptRow
): Promise<boolean> {
  try {
    await rebuildReceiptItemIndex(db, receipt);
    const latest = await db.getFirstAsync<BackfillReceiptRow>(
      `SELECT id, created_at, analysis_json, user_items_json
       FROM receipts
       WHERE id = ?
       LIMIT 1`,
      [receipt.id]
    );
    if (
      latest &&
      (latest.analysis_json !== receipt.analysis_json ||
        latest.user_items_json !== receipt.user_items_json)
    ) {
      // A concurrent item mutation won the Source-of-Truth write while this
      // receipt was being rebuilt. Re-project the latest row once.
      await rebuildReceiptItemIndex(db, latest);
    }
    removeFailedReceipt(state, receipt.id);
    state.succeeded += 1;
    return true;
  } catch (error) {
    addFailedReceipt(state, receipt.id);
    state.failed += 1;
    logger.warn(
      'ReceiptItemIndexBackfill',
      'receipt_item_index_backfill_receipt_failed',
      {
        receipt_id: receipt.id,
        error,
      }
    );
    return false;
  }
}

async function readSweepBatch(
  db: ReceiptItemIndexBackfillDatabase,
  cursor: ReceiptItemIndexBackfillCursor | null,
  limit: number
): Promise<BackfillReceiptRow[]> {
  return db.getAllAsync<BackfillReceiptRow>(
    `SELECT id, created_at, analysis_json, user_items_json
     FROM receipts
     WHERE (
       ? IS NULL
       OR created_at > ?
       OR (created_at = ? AND id > ?)
     )
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? '',
      limit,
    ]
  );
}

async function readFailedReceipts(
  db: ReceiptItemIndexBackfillDatabase,
  receiptIds: string[]
): Promise<BackfillReceiptRow[]> {
  if (receiptIds.length === 0) return [];
  const placeholders = receiptIds.map(() => '?').join(',');
  return db.getAllAsync<BackfillReceiptRow>(
    `SELECT id, created_at, analysis_json, user_items_json
     FROM receipts
     WHERE id IN (${placeholders})`,
    receiptIds
  );
}

export async function getReceiptItemIndexBackfillStatus(
  db: ReceiptItemIndexBackfillDatabase
): Promise<ReceiptItemIndexBackfillStatus> {
  await ensureBackfillStateSchema(db);
  return readState(db);
}

export async function resetReceiptItemIndexBackfillProgress(
  db: ReceiptItemIndexBackfillDatabase
): Promise<void> {
  await ensureBackfillStateSchema(db);
  await db.runAsync(
    `DELETE FROM app_kv WHERE k LIKE ?`,
    [`${STATE_PREFIX}%`]
  );
}

export async function reconcileReceiptItemIndex(
  db: ReceiptItemIndexBackfillDatabase
): Promise<number> {
  await ensureReceiptItemsSchema(db);
  const result = await db.runAsync(
    `DELETE FROM receipt_items
     WHERE NOT EXISTS (
       SELECT 1
       FROM receipts
       WHERE receipts.id = receipt_items.receipt_id
     )`,
    []
  );
  const changes = (result as { changes?: unknown } | null)?.changes;
  return nonNegativeInteger(changes);
}

export async function getReceiptItemIndexJoinReadiness(
  db: ReceiptItemIndexBackfillDatabase
): Promise<ReceiptItemIndexJoinReadiness> {
  await ensureReceiptItemsSchema(db);
  const row = await db.getFirstAsync<ReceiptItemIndexJoinReadiness>(
    `SELECT
       (SELECT COUNT(*) FROM receipts) AS receiptCount,
       (SELECT COUNT(*) FROM receipt_items) AS itemRowCount,
       (
         SELECT COUNT(*)
         FROM receipt_items
         INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
       ) AS joinedItemRowCount,
       (
         SELECT COUNT(*)
         FROM receipt_items
         WHERE NOT EXISTS (
           SELECT 1
           FROM receipts
           WHERE receipts.id = receipt_items.receipt_id
         )
       ) AS orphanRowCount`,
    []
  );
  return {
    receiptCount: nonNegativeInteger(row?.receiptCount),
    itemRowCount: nonNegativeInteger(row?.itemRowCount),
    joinedItemRowCount: nonNegativeInteger(row?.joinedItemRowCount),
    orphanRowCount: nonNegativeInteger(row?.orphanRowCount),
  };
}

/**
 * Diagnostic-only sample proving the mandatory receipt_items INNER JOIN
 * receipts shape for future user-visible reads. This is not a search API.
 */
export async function getReceiptItemIndexJoinReadinessSample(
  db: ReceiptItemIndexBackfillDatabase,
  limit = 10
): Promise<ReceiptItemIndexJoinReadinessRow[]> {
  await ensureReceiptItemsSchema(db);
  const safeLimit = Math.max(1, Math.min(100, positiveInteger(limit, 10)));
  return db.getAllAsync<ReceiptItemIndexJoinReadinessRow>(
    `SELECT
       receipt_items.id AS itemId,
       receipt_items.receipt_id AS receiptId,
       receipt_items.normalized_name AS normalizedName,
       COALESCE(receipts.transaction_at, receipts.created_at) AS transactionAt,
       receipts.merchant_normalized AS merchantNormalized,
       receipts.merchant_type AS merchantType
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     ORDER BY transactionAt ASC, receiptId ASC, receipt_items.source_index ASC
     LIMIT ?`,
    [safeLimit]
  );
}

async function finishIfConsistent(
  db: ReceiptItemIndexBackfillDatabase,
  state: PersistedState,
  result: ReceiptItemIndexBackfillBatchResult
): Promise<ReceiptItemIndexBackfillBatchResult> {
  if (state.failedReceiptIds.length > 0 || state.failedOverflow) {
    await writeState(db, state);
    return { ...result, hasMore: true, cursor: state.cursor };
  }
  try {
    await reconcileReceiptItemIndex(db);
  } catch (error) {
    logger.warn(
      'ReceiptItemIndexBackfill',
      'receipt_item_index_reconcile_failed',
      { error }
    );
    await writeState(db, state);
    return { ...result, hasMore: true, cursor: state.cursor };
  }
  state.version = RECEIPT_ITEM_INDEX_VERSION;
  state.complete = true;
  state.completedAt = Date.now();
  await writeState(db, state);
  return {
    ...result,
    hasMore: false,
    cursor: state.cursor,
    version: state.version,
  };
}

export async function runReceiptItemIndexBackfillBatch(
  db: ReceiptItemIndexBackfillDatabase,
  options: { batchSize?: number } = {}
): Promise<ReceiptItemIndexBackfillBatchResult> {
  const batchSize = positiveInteger(
    options.batchSize,
    DEFAULT_RECEIPT_ITEM_BACKFILL_BATCH_SIZE
  );
  try {
    await ensureBackfillStateSchema(db);
    const state = await readState(db);
    if (
      state.version > 0 &&
      state.version < RECEIPT_ITEM_INDEX_VERSION
    ) {
      state.version = 0;
      state.complete = false;
      state.cursor = null;
      state.scanned = 0;
      state.succeeded = 0;
      state.failed = 0;
      state.failedReceiptIds = [];
      state.failedOverflow = false;
      state.completedAt = null;
      await writeState(db, state);
    }
    const emptyResult: ReceiptItemIndexBackfillBatchResult = {
      scanned: 0,
      succeeded: 0,
      failed: 0,
      hasMore: false,
      cursor: state.cursor,
      version: RECEIPT_ITEM_INDEX_VERSION,
    };
    if (state.complete) return emptyResult;

    const sweepRows = await readSweepBatch(db, state.cursor, batchSize + 1);
    const rowsToProcess = sweepRows.slice(0, batchSize);
    if (rowsToProcess.length > 0) {
      const result = { ...emptyResult };
      for (const receipt of rowsToProcess) {
        state.scanned += 1;
        result.scanned += 1;
        if (await rebuildOne(db, state, receipt)) {
          result.succeeded += 1;
        } else {
          result.failed += 1;
        }
        state.cursor = { createdAt: receipt.created_at, id: receipt.id };
      }
      const sweepHasMore = sweepRows.length > batchSize;
      if (sweepHasMore) {
        result.hasMore = true;
        result.cursor = state.cursor;
        await writeState(db, state);
        return result;
      }
      if (state.failedOverflow) {
        // A bounded failed-ID list overflowed: start another idempotent sweep
        // rather than silently marking untracked failures complete.
        state.cursor = null;
        state.failedOverflow = false;
        result.hasMore = true;
        result.cursor = null;
        await writeState(db, state);
        return result;
      }
      return finishIfConsistent(db, state, result);
    }

    const retryIds = state.failedReceiptIds.slice(0, batchSize);
    if (retryIds.length > 0) {
      const retryRows = await readFailedReceipts(db, retryIds);
      const rowsById = new Map(retryRows.map((row) => [row.id, row]));
      const result = { ...emptyResult, hasMore: true };
      for (const receiptId of retryIds) {
        state.scanned += 1;
        result.scanned += 1;
        const receipt = rowsById.get(receiptId);
        if (!receipt) {
          removeFailedReceipt(state, receiptId);
          state.succeeded += 1;
          result.succeeded += 1;
          continue;
        }
        if (await rebuildOne(db, state, receipt)) {
          result.succeeded += 1;
        } else {
          result.failed += 1;
        }
      }
      return finishIfConsistent(db, state, result);
    }

    return finishIfConsistent(db, state, emptyResult);
  } catch (error) {
    logger.warn(
      'ReceiptItemIndexBackfill',
      'receipt_item_index_backfill_batch_failed',
      { error }
    );
    throw error;
  }
}
