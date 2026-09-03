/**
 * Additive ShoppingIntent SQLite schema (M1-D + B3 Shopping List provenance).
 * Kept separate from the repository to avoid db ↔ repository import cycles.
 *
 * Initialization order (critical for existing installs):
 * 1. CREATE TABLE IF NOT EXISTS (base + provenance cols for fresh installs)
 * 2. Base indexes (status/created only — no provenance columns)
 * 3. ensureProvenanceColumns() additive ALTER for legacy installs
 * 4. Provenance-dependent indexes (only after columns exist)
 * 5. Partial UNIQUE index for active trusted identity
 */

export type ShoppingIntentsSchemaDatabase = {
  execAsync(source: string): Promise<void>;
  getAllAsync?<T>(
    source: string,
    params?: unknown
  ): Promise<T[]>;
  runAsync?(source: string, params?: unknown): Promise<unknown>;
};

/** Fresh CREATE includes provenance columns; legacy tables keep old shape until ALTER. */
export const SHOPPING_INTENTS_BASE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS shopping_intents (
  id TEXT PRIMARY KEY NOT NULL,
  raw_text TEXT NOT NULL,
  intent_type TEXT NOT NULL,
  status TEXT NOT NULL,
  desired_quantity REAL,
  desired_spec_json TEXT,
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  contract_version TEXT NOT NULL,
  source_type TEXT,
  source_identity_kind TEXT,
  source_identity_key TEXT
);
`;

/** Indexes that only reference base columns present since M1-D. */
export const SHOPPING_INTENTS_BASE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_shopping_intents_status_updated
  ON shopping_intents(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopping_intents_created
  ON shopping_intents(created_at DESC);
`;

/** Non-unique lookup helper — requires provenance columns. */
export const SHOPPING_INTENTS_PROVENANCE_LOOKUP_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_shopping_intents_active_identity
  ON shopping_intents(status, source_identity_kind, source_identity_key);
`;

/**
 * Atomic uniqueness for Shopping List 1.0:
 * at most one ACTIVE row per exact trusted (kind, key) pair.
 * Null identity (manual/text-only) and non-active rows are unrestricted.
 */
export const SHOPPING_INTENTS_ACTIVE_TRUSTED_UNIQUE_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopping_intents_active_trusted_identity_unique
  ON shopping_intents(source_identity_kind, source_identity_key)
  WHERE status = 'active'
    AND source_identity_kind IS NOT NULL
    AND source_identity_key IS NOT NULL;
`;

/** @deprecated Prefer ordered ensureShoppingIntentsSchema — kept for re-exports. */
export const SHOPPING_INTENTS_SCHEMA_SQL = `
${SHOPPING_INTENTS_BASE_TABLE_SQL}
${SHOPPING_INTENTS_BASE_INDEXES_SQL}
`;

const PROVENANCE_COLUMNS = [
  'source_type',
  'source_identity_kind',
  'source_identity_key',
] as const;

export const SHOPPING_INTENTS_ACTIVE_TRUSTED_DUPLICATE_CHECK_SQL = `
SELECT source_identity_kind AS kind,
       source_identity_key AS key,
       COUNT(*) AS count
  FROM shopping_intents
 WHERE status = 'active'
   AND source_identity_kind IS NOT NULL
   AND source_identity_key IS NOT NULL
 GROUP BY source_identity_kind, source_identity_key
HAVING COUNT(*) > 1
`;

export class ShoppingIntentsDuplicateActiveIdentityError extends Error {
  readonly duplicates: ReadonlyArray<{ kind: string; key: string; count: number }>;

  constructor(
    duplicates: ReadonlyArray<{ kind: string; key: string; count: number }>
  ) {
    const summary = duplicates
      .map((d) => `${d.kind}:${d.key}×${d.count}`)
      .join(', ');
    super(
      `Cannot create active trusted-identity unique index: duplicate active shopping_intents rows exist (${summary}). Refusing to delete or merge user list items.`
    );
    this.name = 'ShoppingIntentsDuplicateActiveIdentityError';
    this.duplicates = duplicates;
  }
}

async function ensureProvenanceColumns(
  db: ShoppingIntentsSchemaDatabase
): Promise<void> {
  if (typeof db.getAllAsync !== 'function' || typeof db.runAsync !== 'function') {
    // Memory/test stubs that only implement execAsync — CREATE TABLE IF NOT EXISTS
    // already includes provenance columns for fresh installs.
    return;
  }
  const tableInfo = await db.getAllAsync<{ name: string }>(
    `PRAGMA table_info(shopping_intents)`
  );
  const names = new Set(tableInfo.map((col) => col.name));
  for (const column of PROVENANCE_COLUMNS) {
    if (names.has(column)) continue;
    await db.runAsync(
      `ALTER TABLE shopping_intents ADD COLUMN ${column} TEXT`
    );
  }
}

/**
 * Fail explicitly if duplicate active trusted identities exist.
 * Does not delete/dedupe rows.
 */
export async function assertNoDuplicateActiveTrustedIdentities(
  db: ShoppingIntentsSchemaDatabase
): Promise<void> {
  if (typeof db.getAllAsync !== 'function') return;
  const duplicates = await db.getAllAsync<{
    kind: string;
    key: string;
    count: number;
  }>(SHOPPING_INTENTS_ACTIVE_TRUSTED_DUPLICATE_CHECK_SQL);
  if (duplicates.length === 0) return;
  throw new ShoppingIntentsDuplicateActiveIdentityError(
    duplicates.map((row) => ({
      kind: String(row.kind),
      key: String(row.key),
      count: Number(row.count),
    }))
  );
}

export async function ensureShoppingIntentsSchema(
  db: ShoppingIntentsSchemaDatabase
): Promise<void> {
  // 1. Base table (fresh includes provenance cols; existing is a no-op).
  await db.execAsync(SHOPPING_INTENTS_BASE_TABLE_SQL);
  // 2. Base indexes only (safe on legacy installs without provenance cols).
  await db.execAsync(SHOPPING_INTENTS_BASE_INDEXES_SQL);
  // 3. Additive provenance columns for existing installs.
  await ensureProvenanceColumns(db);
  // 4–5. Provenance-dependent indexes only after columns exist.
  await assertNoDuplicateActiveTrustedIdentities(db);
  await db.execAsync(SHOPPING_INTENTS_PROVENANCE_LOOKUP_INDEX_SQL);
  await db.execAsync(SHOPPING_INTENTS_ACTIVE_TRUSTED_UNIQUE_INDEX_SQL);
}
