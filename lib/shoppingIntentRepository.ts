/**
 * Local-first ShoppingIntent repository (M1-D).
 *
 * Persistence: additive SQLite table in receipts_v2.db.
 * Cloud sync: deferred — LOCAL-ONLY FOR V1 FOUNDATION.
 */

import * as SQLite from 'expo-sqlite';

import {
  applyShoppingIntentUpdate,
  buildShoppingIntent,
  markShoppingIntentArchived,
  markShoppingIntentCompleted,
  type CreateShoppingIntentInput,
  type ListShoppingIntentsFilter,
  type ShoppingIntent,
  type ShoppingIntentResolution,
  type ShoppingIntentStatus,
  type ShoppingIntentType,
  type UpdateShoppingIntentInput,
} from './shoppingIntent';
import type { ProductSpecification } from './productSpecification';
import {
  SHOPPING_INTENTS_SCHEMA_SQL,
  ensureShoppingIntentsSchema,
} from './shoppingIntentSchema';

const DB_NAME = 'receipts_v2.db';

export type ShoppingIntentRow = {
  id: string;
  raw_text: string;
  intent_type: string;
  status: string;
  desired_quantity: number | null;
  desired_spec_json: string | null;
  resolution_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  contract_version: string;
};

export type ShoppingIntentDatabase = {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params?: SQLite.SQLiteBindParams): Promise<unknown>;
  getFirstAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T | null>;
  getAllAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T[]>;
};

let _db: SQLite.SQLiteDatabase | null = null;
let _schemaReady = false;

export { SHOPPING_INTENTS_SCHEMA_SQL, ensureShoppingIntentsSchema };

/** Lazy db import so memory/WithDb tests never load Expo Constants. */
async function getSqliteDb(): Promise<SQLite.SQLiteDatabase> {
  const { initIfNeeded } = await import('./db');
  await initIfNeeded();
  if (!_db) {
    _db = await SQLite.openDatabaseAsync(DB_NAME);
  }
  if (!_schemaReady) {
    await ensureShoppingIntentsSchema(_db);
    _schemaReady = true;
  }
  return _db;
}

/** Test helper: reset module DB handle. */
export function __resetShoppingIntentDbForTests(): void {
  _db = null;
  _schemaReady = false;
}

function serializeIntent(intent: ShoppingIntent): ShoppingIntentRow {
  return {
    id: intent.id,
    raw_text: intent.rawText,
    intent_type: intent.intentType,
    status: intent.status,
    desired_quantity: intent.desiredQuantity,
    desired_spec_json: intent.desiredSpec
      ? JSON.stringify(intent.desiredSpec)
      : null,
    resolution_json: intent.resolution
      ? JSON.stringify(intent.resolution)
      : null,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
    completed_at: intent.completedAt,
    contract_version: intent.contractVersion,
  };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function rowToShoppingIntent(row: ShoppingIntentRow): ShoppingIntent {
  return {
    id: row.id,
    rawText: row.raw_text,
    intentType: row.intent_type as ShoppingIntentType,
    status: row.status as ShoppingIntentStatus,
    desiredQuantity:
      typeof row.desired_quantity === 'number' && Number.isFinite(row.desired_quantity)
        ? row.desired_quantity
        : null,
    desiredSpec: parseJson<ProductSpecification>(row.desired_spec_json),
    resolution: parseJson<ShoppingIntentResolution>(row.resolution_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    contractVersion: row.contract_version as ShoppingIntent['contractVersion'],
  };
}

async function insertRow(
  db: ShoppingIntentDatabase,
  intent: ShoppingIntent
): Promise<void> {
  const row = serializeIntent(intent);
  await db.runAsync(
    `INSERT INTO shopping_intents (
      id, raw_text, intent_type, status, desired_quantity,
      desired_spec_json, resolution_json, created_at, updated_at,
      completed_at, contract_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.raw_text,
      row.intent_type,
      row.status,
      row.desired_quantity,
      row.desired_spec_json,
      row.resolution_json,
      row.created_at,
      row.updated_at,
      row.completed_at,
      row.contract_version,
    ]
  );
}

async function updateRow(
  db: ShoppingIntentDatabase,
  intent: ShoppingIntent
): Promise<void> {
  const row = serializeIntent(intent);
  await db.runAsync(
    `UPDATE shopping_intents SET
      raw_text = ?,
      intent_type = ?,
      status = ?,
      desired_quantity = ?,
      desired_spec_json = ?,
      resolution_json = ?,
      updated_at = ?,
      completed_at = ?,
      contract_version = ?
     WHERE id = ?`,
    [
      row.raw_text,
      row.intent_type,
      row.status,
      row.desired_quantity,
      row.desired_spec_json,
      row.resolution_json,
      row.updated_at,
      row.completed_at,
      row.contract_version,
      row.id,
    ]
  );
}

export async function createShoppingIntentWithDb(
  db: ShoppingIntentDatabase,
  input: CreateShoppingIntentInput
): Promise<ShoppingIntent> {
  await ensureShoppingIntentsSchema(db);
  const intent = buildShoppingIntent(input);
  await insertRow(db, intent);
  return intent;
}

export async function createShoppingIntent(
  input: CreateShoppingIntentInput
): Promise<ShoppingIntent> {
  const db = await getSqliteDb();
  return createShoppingIntentWithDb(db, input);
}

export async function getShoppingIntentWithDb(
  db: ShoppingIntentDatabase,
  id: string
): Promise<ShoppingIntent | null> {
  await ensureShoppingIntentsSchema(db);
  const row = await db.getFirstAsync<ShoppingIntentRow>(
    `SELECT * FROM shopping_intents WHERE id = ?`,
    [id]
  );
  return row ? rowToShoppingIntent(row) : null;
}

export async function getShoppingIntent(
  id: string
): Promise<ShoppingIntent | null> {
  const db = await getSqliteDb();
  return getShoppingIntentWithDb(db, id);
}

/**
 * Default ordering: updated_at DESC, then created_at DESC, then id ASC.
 * Deterministic; no drag-and-drop in M1-D.
 */
export async function listShoppingIntentsWithDb(
  db: ShoppingIntentDatabase,
  filter: ListShoppingIntentsFilter = {}
): Promise<ShoppingIntent[]> {
  await ensureShoppingIntentsSchema(db);
  const statuses = filter.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : null;

  let sql = `SELECT * FROM shopping_intents`;
  const params: SQLite.SQLiteBindValue[] = [];
  if (statuses && statuses.length > 0) {
    sql += ` WHERE status IN (${statuses.map(() => '?').join(', ')})`;
    params.push(...statuses);
  }
  sql += ` ORDER BY updated_at DESC, created_at DESC, id ASC`;

  const rows = await db.getAllAsync<ShoppingIntentRow>(sql, params);
  return rows.map(rowToShoppingIntent);
}

export async function listShoppingIntents(
  filter: ListShoppingIntentsFilter = {}
): Promise<ShoppingIntent[]> {
  const db = await getSqliteDb();
  return listShoppingIntentsWithDb(db, filter);
}

export async function updateShoppingIntentWithDb(
  db: ShoppingIntentDatabase,
  id: string,
  patch: UpdateShoppingIntentInput
): Promise<ShoppingIntent | null> {
  const existing = await getShoppingIntentWithDb(db, id);
  if (!existing) return null;
  const next = applyShoppingIntentUpdate(existing, patch);
  await updateRow(db, next);
  return next;
}

export async function updateShoppingIntent(
  id: string,
  patch: UpdateShoppingIntentInput
): Promise<ShoppingIntent | null> {
  const db = await getSqliteDb();
  return updateShoppingIntentWithDb(db, id, patch);
}

export async function completeShoppingIntentWithDb(
  db: ShoppingIntentDatabase,
  id: string,
  now?: () => Date
): Promise<ShoppingIntent | null> {
  const existing = await getShoppingIntentWithDb(db, id);
  if (!existing) return null;
  const next = markShoppingIntentCompleted(existing, now);
  await updateRow(db, next);
  return next;
}

export async function completeShoppingIntent(
  id: string,
  now?: () => Date
): Promise<ShoppingIntent | null> {
  const db = await getSqliteDb();
  return completeShoppingIntentWithDb(db, id, now);
}

export async function archiveShoppingIntentWithDb(
  db: ShoppingIntentDatabase,
  id: string,
  now?: () => Date
): Promise<ShoppingIntent | null> {
  const existing = await getShoppingIntentWithDb(db, id);
  if (!existing) return null;
  const next = markShoppingIntentArchived(existing, now);
  await updateRow(db, next);
  return next;
}

export async function archiveShoppingIntent(
  id: string,
  now?: () => Date
): Promise<ShoppingIntent | null> {
  const db = await getSqliteDb();
  return archiveShoppingIntentWithDb(db, id, now);
}

/**
 * Physical local delete. Distinct from archive.
 * No tombstone / cloud sync in M1-D.
 */
export async function deleteShoppingIntentWithDb(
  db: ShoppingIntentDatabase,
  id: string
): Promise<boolean> {
  await ensureShoppingIntentsSchema(db);
  const result = (await db.runAsync(`DELETE FROM shopping_intents WHERE id = ?`, [
    id,
  ])) as { changes?: number };
  return (result?.changes ?? 0) > 0;
}

export async function deleteShoppingIntent(id: string): Promise<boolean> {
  const db = await getSqliteDb();
  return deleteShoppingIntentWithDb(db, id);
}

/** In-memory store for deterministic unit tests (no expo-sqlite). */
export function createMemoryShoppingIntentDatabase(): ShoppingIntentDatabase & {
  rows: Map<string, ShoppingIntentRow>;
} {
  const rows = new Map<string, ShoppingIntentRow>();

  const api: ShoppingIntentDatabase & { rows: Map<string, ShoppingIntentRow> } = {
    rows,
    async execAsync() {
      // schema is implicit for memory store
    },
    async runAsync(source, params = []) {
      const values = Array.isArray(params) ? params : [];
      if (/^\s*INSERT INTO shopping_intents/i.test(source)) {
        const row: ShoppingIntentRow = {
          id: String(values[0]),
          raw_text: String(values[1]),
          intent_type: String(values[2]),
          status: String(values[3]),
          desired_quantity: values[4] == null ? null : Number(values[4]),
          desired_spec_json: values[5] == null ? null : String(values[5]),
          resolution_json: values[6] == null ? null : String(values[6]),
          created_at: String(values[7]),
          updated_at: String(values[8]),
          completed_at: values[9] == null ? null : String(values[9]),
          contract_version: String(values[10]),
        };
        rows.set(row.id, row);
        return { changes: 1 };
      }
      if (/^\s*UPDATE shopping_intents SET/i.test(source)) {
        const id = String(values[9]);
        const existing = rows.get(id);
        if (!existing) return { changes: 0 };
        rows.set(id, {
          ...existing,
          raw_text: String(values[0]),
          intent_type: String(values[1]),
          status: String(values[2]),
          desired_quantity: values[3] == null ? null : Number(values[3]),
          desired_spec_json: values[4] == null ? null : String(values[4]),
          resolution_json: values[5] == null ? null : String(values[5]),
          updated_at: String(values[6]),
          completed_at: values[7] == null ? null : String(values[7]),
          contract_version: String(values[8]),
        });
        return { changes: 1 };
      }
      if (/^\s*DELETE FROM shopping_intents/i.test(source)) {
        const id = String(values[0]);
        const had = rows.delete(id);
        return { changes: had ? 1 : 0 };
      }
      return { changes: 0 };
    },
    async getFirstAsync<T>(
      source: string,
      params: SQLite.SQLiteBindParams = []
    ): Promise<T | null> {
      const values = Array.isArray(params) ? params : [];
      if (/WHERE id = \?/i.test(source)) {
        const row = rows.get(String(values[0]));
        return (row as T) ?? null;
      }
      return null;
    },
    async getAllAsync<T>(
      source: string,
      params: SQLite.SQLiteBindParams = []
    ): Promise<T[]> {
      const values = Array.isArray(params) ? [...params] : [];
      let list = [...rows.values()];
      if (/WHERE status IN/i.test(source)) {
        const wanted = new Set(values.map(String));
        list = list.filter((row) => wanted.has(row.status));
      }
      list.sort((a, b) => {
        if (a.updated_at !== b.updated_at) {
          return a.updated_at < b.updated_at ? 1 : -1;
        }
        if (a.created_at !== b.created_at) {
          return a.created_at < b.created_at ? 1 : -1;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return list as T[];
    },
  };

  return api;
}
