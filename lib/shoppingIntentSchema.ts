/**
 * Additive ShoppingIntent SQLite schema (M1-D).
 * Kept separate from the repository to avoid db ↔ repository import cycles.
 */

export type ShoppingIntentsSchemaDatabase = {
  execAsync(source: string): Promise<void>;
};

export const SHOPPING_INTENTS_SCHEMA_SQL = `
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
  contract_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shopping_intents_status_updated
  ON shopping_intents(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopping_intents_created
  ON shopping_intents(created_at DESC);
`;

export async function ensureShoppingIntentsSchema(
  db: ShoppingIntentsSchemaDatabase
): Promise<void> {
  await db.execAsync(SHOPPING_INTENTS_SCHEMA_SQL);
}
