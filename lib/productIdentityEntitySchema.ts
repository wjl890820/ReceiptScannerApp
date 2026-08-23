/**
 * Additive Product Identity entity tables (Batch 1).
 *
 * Empty storage foundation only — no writers, no backfill, no analytics reads.
 * Live enrichment continues to use analysis_json annotations + receipt_items
 * projection from lib/productIdentity.ts.
 */

export type ProductIdentityEntitySchemaDatabase = {
  execAsync(source: string): Promise<void>;
};

export const PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS merchant_products (
  id TEXT PRIMARY KEY NOT NULL,
  merchant_key TEXT NOT NULL,
  canonical_display_name TEXT,
  normalized_name TEXT,
  brand TEXT,
  attributes_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolver_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchant_products_merchant_key
  ON merchant_products(merchant_key);

CREATE INDEX IF NOT EXISTS idx_merchant_products_normalized_name
  ON merchant_products(normalized_name);

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
`;

export async function ensureProductIdentityEntitySchema(
  db: ProductIdentityEntitySchemaDatabase
): Promise<void> {
  await db.execAsync(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL);
}
