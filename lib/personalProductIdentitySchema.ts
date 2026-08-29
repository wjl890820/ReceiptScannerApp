/**
 * G4-1 — durable local personal product-identity decisions.
 *
 * Separate from derived Product Identity entity tables
 * (merchant_products / receipt_item_identity_links).
 */

export type PersonalProductIdentitySchemaDatabase = {
  execAsync(source: string): Promise<void>;
};

export const PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS personal_product_identity_decisions (
  owner_key TEXT NOT NULL,
  left_merchant_product_id TEXT NOT NULL,
  right_merchant_product_id TEXT NOT NULL,
  left_merchant_scope_key TEXT NOT NULL,
  right_merchant_scope_key TEXT NOT NULL,
  left_comparison_key TEXT NOT NULL,
  right_comparison_key TEXT NOT NULL,
  left_structural_signature TEXT NOT NULL,
  right_structural_signature TEXT NOT NULL,
  identity_pipeline_version TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (
      decision IN (
        'same_product',
        'not_same_product',
        'unsure'
      )
    ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    owner_key,
    left_merchant_product_id,
    right_merchant_product_id
  ),
  CHECK (
    left_merchant_product_id < right_merchant_product_id
  )
);

CREATE INDEX IF NOT EXISTS idx_personal_product_identity_owner_left
  ON personal_product_identity_decisions(owner_key, left_merchant_product_id);

CREATE INDEX IF NOT EXISTS idx_personal_product_identity_owner_right
  ON personal_product_identity_decisions(owner_key, right_merchant_product_id);
`;

export async function ensurePersonalProductIdentitySchema(
  db: PersonalProductIdentitySchemaDatabase
): Promise<void> {
  await db.execAsync(PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL);
}
