/**
 * Additive Product Identity entity tables (Batch 1 + Batch 3).
 *
 * Empty storage foundation + derived identity links.
 * No mass backfill writers. Live enrichment continues to use analysis_json
 * annotations + receipt_items projection from lib/productIdentity.ts.
 *
 * Derived identity links are rebuildable: DROP / clear → re-resolve → rebuild
 * without touching receipt transaction truth.
 */

export type ProductIdentityEntitySchemaDatabase = {
  execAsync(source: string): Promise<void>;
};

export const PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS merchant_products (
  id TEXT PRIMARY KEY NOT NULL,
  merchant_key TEXT NOT NULL,
  comparison_key TEXT,
  canonical_display_name TEXT,
  normalized_name TEXT,
  brand TEXT,
  attributes_json TEXT,
  semantic_json TEXT,
  semantic_status TEXT,
  semantic_confidence REAL,
  semantic_resolver_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolver_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchant_products_merchant_key
  ON merchant_products(merchant_key);

CREATE INDEX IF NOT EXISTS idx_merchant_products_normalized_name
  ON merchant_products(normalized_name);

CREATE INDEX IF NOT EXISTS idx_merchant_products_merchant_comparison
  ON merchant_products(merchant_key, comparison_key);

CREATE TABLE IF NOT EXISTS canonical_products (
  id TEXT PRIMARY KEY NOT NULL,
  canonical_name TEXT NOT NULL,
  brand TEXT,
  category_id TEXT,
  attributes_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canonical_products_canonical_name
  ON canonical_products(canonical_name);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY NOT NULL,
  canonical_product_id TEXT,
  sku_id TEXT,
  jan_code TEXT,
  attributes_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_variants_canonical_product_id
  ON product_variants(canonical_product_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_sku_id
  ON product_variants(sku_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_jan_code
  ON product_variants(jan_code);

-- Derived / rebuildable identity links (Batch 3). Not receipt SoT.
CREATE TABLE IF NOT EXISTS receipt_item_identity_links (
  id TEXT PRIMARY KEY NOT NULL,
  receipt_id TEXT NOT NULL,
  item_source_index INTEGER NOT NULL,
  item_fingerprint TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  merchant_product_id TEXT,
  canonical_product_id TEXT,
  sku_id TEXT,
  identity_level TEXT NOT NULL,
  identity_confidence REAL NOT NULL,
  identity_source TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (receipt_id, item_source_index)
);

CREATE INDEX IF NOT EXISTS idx_receipt_item_identity_links_receipt
  ON receipt_item_identity_links(receipt_id);

CREATE INDEX IF NOT EXISTS idx_receipt_item_identity_links_merchant_product
  ON receipt_item_identity_links(merchant_product_id);

CREATE INDEX IF NOT EXISTS idx_receipt_item_identity_links_fingerprint
  ON receipt_item_identity_links(item_fingerprint);
`;

/**
 * Additive columns for installs that already ran Batch 1 CREATE TABLE.
 * SQLite ignores duplicate ADD COLUMN failures when wrapped per-statement
 * by callers that tolerate errors — we use IF NOT EXISTS where supported.
 * expo-sqlite / SQLite 3.35+ supports ADD COLUMN without IF NOT EXISTS;
 * ensure is idempotent via try/ignore in ensureProductIdentityEntitySchema.
 */
export const PRODUCT_IDENTITY_ENTITY_SCHEMA_ALTER_SQL = [
  `ALTER TABLE merchant_products ADD COLUMN comparison_key TEXT`,
  `ALTER TABLE merchant_products ADD COLUMN semantic_json TEXT`,
  `ALTER TABLE merchant_products ADD COLUMN semantic_status TEXT`,
  `ALTER TABLE merchant_products ADD COLUMN semantic_confidence REAL`,
  `ALTER TABLE merchant_products ADD COLUMN semantic_resolver_version TEXT`,
];

export async function ensureProductIdentityEntitySchema(
  db: ProductIdentityEntitySchemaDatabase
): Promise<void> {
  await db.execAsync(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL);
  for (const stmt of PRODUCT_IDENTITY_ENTITY_SCHEMA_ALTER_SQL) {
    try {
      await db.execAsync(stmt);
    } catch {
      // Column already present on fresh CREATE — expected.
    }
  }
}
