/**
 * Local-first ShoppingIntent repository (M1-D + B3 Shopping List provenance).
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

export type ShoppingIntentProvenance = {
  sourceType: string | null;
  sourceIdentityKind: string | null;
  sourceIdentityKey: string | null;
};

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
  source_type: string | null;
  source_identity_kind: string | null;
  source_identity_key: string | null;
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

function normalizeProvenance(
  provenance?: ShoppingIntentProvenance | null
): ShoppingIntentProvenance {
  return {
    sourceType: provenance?.sourceType?.trim() || null,
    sourceIdentityKind: provenance?.sourceIdentityKind?.trim() || null,
    sourceIdentityKey: provenance?.sourceIdentityKey?.trim() || null,
  };
}

function serializeIntent(
  intent: ShoppingIntent,
  provenance?: ShoppingIntentProvenance | null
): ShoppingIntentRow {
  const prov = normalizeProvenance(provenance);
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
    source_type: prov.sourceType,
    source_identity_kind: prov.sourceIdentityKind,
    source_identity_key: prov.sourceIdentityKey,
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

export function rowToShoppingIntentProvenance(
  row: ShoppingIntentRow
): ShoppingIntentProvenance {
  return {
    sourceType: row.source_type ?? null,
    sourceIdentityKind: row.source_identity_kind ?? null,
    sourceIdentityKey: row.source_identity_key ?? null,
  };
}

async function insertRow(
  db: ShoppingIntentDatabase,
  intent: ShoppingIntent,
  provenance?: ShoppingIntentProvenance | null
): Promise<void> {
  const row = serializeIntent(intent, provenance);
  await db.runAsync(
    `INSERT INTO shopping_intents (
      id, raw_text, intent_type, status, desired_quantity,
      desired_spec_json, resolution_json, created_at, updated_at,
      completed_at, contract_version,
      source_type, source_identity_kind, source_identity_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.source_type,
      row.source_identity_kind,
      row.source_identity_key,
    ]
  );
}

async function updateRow(
  db: ShoppingIntentDatabase,
  intent: ShoppingIntent,
  provenance?: ShoppingIntentProvenance | null
): Promise<void> {
  const existing = await getShoppingIntentRowWithDb(db, intent.id);
  const mergedProvenance =
    provenance !== undefined
      ? provenance
      : existing
        ? rowToShoppingIntentProvenance(existing)
        : null;
  const row = serializeIntent(intent, mergedProvenance);
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
      contract_version = ?,
      source_type = ?,
      source_identity_kind = ?,
      source_identity_key = ?
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
      row.source_type,
      row.source_identity_kind,
      row.source_identity_key,
      row.id,
    ]
  );
}

export async function createShoppingIntentWithDb(
  db: ShoppingIntentDatabase,
  input: CreateShoppingIntentInput,
  provenance?: ShoppingIntentProvenance | null
): Promise<ShoppingIntent> {
  await ensureShoppingIntentsSchema(db);
  const intent = buildShoppingIntent(input);
  await insertRow(db, intent, provenance);
  return intent;
}

export async function createShoppingIntent(
  input: CreateShoppingIntentInput,
  provenance?: ShoppingIntentProvenance | null
): Promise<ShoppingIntent> {
  const db = await getSqliteDb();
  return createShoppingIntentWithDb(db, input, provenance);
}

export async function getShoppingIntentRowWithDb(
  db: ShoppingIntentDatabase,
  id: string
): Promise<ShoppingIntentRow | null> {
  await ensureShoppingIntentsSchema(db);
  return db.getFirstAsync<ShoppingIntentRow>(
    `SELECT * FROM shopping_intents WHERE id = ?`,
    [id]
  );
}

export async function getShoppingIntentWithDb(
  db: ShoppingIntentDatabase,
  id: string
): Promise<ShoppingIntent | null> {
  const row = await getShoppingIntentRowWithDb(db, id);
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
 * Shopping List UX uses its own sort over mapped rows.
 */
export async function listShoppingIntentRowsWithDb(
  db: ShoppingIntentDatabase,
  filter: ListShoppingIntentsFilter = {}
): Promise<ShoppingIntentRow[]> {
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

  return db.getAllAsync<ShoppingIntentRow>(sql, params);
}

export async function listShoppingIntentsWithDb(
  db: ShoppingIntentDatabase,
  filter: ListShoppingIntentsFilter = {}
): Promise<ShoppingIntent[]> {
  const rows = await listShoppingIntentRowsWithDb(db, filter);
  return rows.map(rowToShoppingIntent);
}

export async function listShoppingIntents(
  filter: ListShoppingIntentsFilter = {}
): Promise<ShoppingIntent[]> {
  const db = await getSqliteDb();
  return listShoppingIntentsWithDb(db, filter);
}

export async function findActiveShoppingIntentByTrustedIdentityWithDb(
  db: ShoppingIntentDatabase,
  identityKind: string,
  identityKey: string
): Promise<ShoppingIntentRow | null> {
  await ensureShoppingIntentsSchema(db);
  const kind = identityKind.trim();
  const key = identityKey.trim();
  if (!kind || !key) return null;
  return db.getFirstAsync<ShoppingIntentRow>(
    `SELECT * FROM shopping_intents
     WHERE status = 'active'
       AND source_identity_kind = ?
       AND source_identity_key = ?
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [kind, key]
  );
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

export async function deleteCompletedShoppingIntentsWithDb(
  db: ShoppingIntentDatabase
): Promise<number> {
  await ensureShoppingIntentsSchema(db);
  const result = (await db.runAsync(
    `DELETE FROM shopping_intents WHERE status = 'completed'`
  )) as { changes?: number };
  return result?.changes ?? 0;
}

function assertMemoryActiveTrustedUnique(
  rows: Map<string, ShoppingIntentRow>,
  candidate: Pick<
    ShoppingIntentRow,
    'id' | 'status' | 'source_identity_kind' | 'source_identity_key'
  >
): void {
  if (candidate.status !== 'active') return;
  const kind = candidate.source_identity_kind;
  const key = candidate.source_identity_key;
  if (kind == null || key == null) return;
  for (const row of rows.values()) {
    if (row.id === candidate.id) continue;
    if (row.status !== 'active') continue;
    if (row.source_identity_kind !== kind) continue;
    if (row.source_identity_key !== key) continue;
    throw new Error(
      'UNIQUE constraint failed: shopping_intents.source_identity_kind, shopping_intents.source_identity_key'
    );
  }
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
          source_type: values[11] == null ? null : String(values[11]),
          source_identity_kind: values[12] == null ? null : String(values[12]),
          source_identity_key: values[13] == null ? null : String(values[13]),
        };
        assertMemoryActiveTrustedUnique(rows, row);
        rows.set(row.id, row);
        return { changes: 1 };
      }
      if (/^\s*UPDATE shopping_intents SET/i.test(source)) {
        const id = String(values[values.length - 1]);
        const existing = rows.get(id);
        if (!existing) return { changes: 0 };
        const next: ShoppingIntentRow = {
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
          source_type: values[9] == null ? null : String(values[9]),
          source_identity_kind: values[10] == null ? null : String(values[10]),
          source_identity_key: values[11] == null ? null : String(values[11]),
        };
        assertMemoryActiveTrustedUnique(rows, next);
        rows.set(id, next);
        return { changes: 1 };
      }
      if (/^\s*DELETE FROM shopping_intents WHERE status = 'completed'/i.test(source)) {
        let changes = 0;
        for (const [id, row] of [...rows.entries()]) {
          if (row.status === 'completed') {
            rows.delete(id);
            changes += 1;
          }
        }
        return { changes };
      }
      if (/^\s*DELETE FROM shopping_intents/i.test(source)) {
        const id = String(values[0]);
        const had = rows.delete(id);
        return { changes: had ? 1 : 0 };
      }
      if (/^\s*ALTER TABLE shopping_intents ADD COLUMN/i.test(source)) {
        return { changes: 0 };
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
      if (/status = 'active'/i.test(source) && /source_identity_kind/i.test(source)) {
        const kind = String(values[0]);
        const key = String(values[1]);
        const matches = [...rows.values()]
          .filter(
            (row) =>
              row.status === 'active' &&
              row.source_identity_kind === kind &&
              row.source_identity_key === key
          )
          .sort((a, b) =>
            a.created_at !== b.created_at
              ? a.created_at < b.created_at
                ? -1
                : 1
              : a.id < b.id
                ? -1
                : a.id > b.id
                  ? 1
                  : 0
          );
        return (matches[0] as T) ?? null;
      }
      return null;
    },
    async getAllAsync<T>(
      source: string,
      params: SQLite.SQLiteBindParams = []
    ): Promise<T[]> {
      if (/PRAGMA table_info\(shopping_intents\)/i.test(source)) {
        return [
          { name: 'id' },
          { name: 'raw_text' },
          { name: 'intent_type' },
          { name: 'status' },
          { name: 'desired_quantity' },
          { name: 'desired_spec_json' },
          { name: 'resolution_json' },
          { name: 'created_at' },
          { name: 'updated_at' },
          { name: 'completed_at' },
          { name: 'contract_version' },
          { name: 'source_type' },
          { name: 'source_identity_kind' },
          { name: 'source_identity_key' },
        ] as T[];
      }
      if (
        /GROUP BY source_identity_kind, source_identity_key/i.test(source) &&
        /HAVING COUNT\(\*\) > 1/i.test(source)
      ) {
        const counts = new Map<
          string,
          { kind: string; key: string; count: number }
        >();
        for (const row of rows.values()) {
          if (row.status !== 'active') continue;
          if (
            row.source_identity_kind == null ||
            row.source_identity_key == null
          ) {
            continue;
          }
          const mapKey = `${row.source_identity_kind}\0${row.source_identity_key}`;
          const prev = counts.get(mapKey);
          if (prev) prev.count += 1;
          else {
            counts.set(mapKey, {
              kind: row.source_identity_kind,
              key: row.source_identity_key,
              count: 1,
            });
          }
        }
        return [...counts.values()].filter((entry) => entry.count > 1) as T[];
      }
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
