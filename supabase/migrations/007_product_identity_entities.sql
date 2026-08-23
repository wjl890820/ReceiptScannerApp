/**
 * Supabase: Product Identity entity tables (Batch 1+3 — prepared only).
 *
 * DO NOT apply to production yet (no db push).
 * Local SQLite mirror: lib/productIdentityEntitySchema.ts
 *
 * Cloud receipt SoT remains user_receipts.analysis_json / user_items_json.
 * These tables are optional future sync targets for Merchant/Canonical/Variant
 * entities and derived identity links — not required for restore of receipts.
 *
 * Batch 3 changes vs Batch 1 draft:
 * - merchant_products.comparison_key for deterministic same-merchant lookup
 * - receipt_item_identity_links derived table (rebuildable, fingerprint/stale)
 */

-- merchant_products: per-merchant stable product entity
CREATE TABLE IF NOT EXISTS public.merchant_products (
  id TEXT PRIMARY KEY NOT NULL,
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,
  comparison_key TEXT,
  canonical_display_name TEXT,
  normalized_name TEXT,
  brand TEXT,
  attributes_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolver_version TEXT NOT NULL,
  CONSTRAINT merchant_products_attributes_json_valid
    CHECK (
      attributes_json IS NULL
      OR attributes_json::json IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_merchant_products_user_merchant
  ON public.merchant_products (user_id, merchant_key);

CREATE INDEX IF NOT EXISTS idx_merchant_products_normalized_name
  ON public.merchant_products (normalized_name);

CREATE INDEX IF NOT EXISTS idx_merchant_products_user_merchant_comparison
  ON public.merchant_products (user_id, merchant_key, comparison_key);

-- canonical_products: cross-receipt (potentially cross-merchant) product concept
CREATE TABLE IF NOT EXISTS public.canonical_products (
  id TEXT PRIMARY KEY NOT NULL,
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  brand TEXT,
  category_id TEXT,
  attributes_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT canonical_products_attributes_json_valid
    CHECK (
      attributes_json IS NULL
      OR attributes_json::json IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_canonical_products_user_name
  ON public.canonical_products (user_id, canonical_name);

-- product_variants: optional SKU / JAN layer (all identity columns nullable)
CREATE TABLE IF NOT EXISTS public.product_variants (
  id TEXT PRIMARY KEY NOT NULL,
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
  canonical_product_id TEXT,
  sku_id TEXT,
  jan_code TEXT,
  attributes_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_variants_attributes_json_valid
    CHECK (
      attributes_json IS NULL
      OR attributes_json::json IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_product_variants_user_canonical
  ON public.product_variants (user_id, canonical_product_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_sku_id
  ON public.product_variants (sku_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_jan_code
  ON public.product_variants (jan_code);

-- Derived identity links (rebuildable; not receipt SoT)
CREATE TABLE IF NOT EXISTS public.receipt_item_identity_links (
  id TEXT PRIMARY KEY NOT NULL,
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
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
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, receipt_id, item_source_index)
);

CREATE INDEX IF NOT EXISTS idx_receipt_item_identity_links_user_receipt
  ON public.receipt_item_identity_links (user_id, receipt_id);

CREATE INDEX IF NOT EXISTS idx_receipt_item_identity_links_merchant_product
  ON public.receipt_item_identity_links (merchant_product_id);

CREATE INDEX IF NOT EXISTS idx_receipt_item_identity_links_fingerprint
  ON public.receipt_item_identity_links (item_fingerprint);

ALTER TABLE public.merchant_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_item_identity_links ENABLE ROW LEVEL SECURITY;

-- Own-rows policies (mirror user_receipts ownership model)
CREATE POLICY merchant_products_select_own
  ON public.merchant_products FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY merchant_products_insert_own
  ON public.merchant_products FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY merchant_products_update_own
  ON public.merchant_products FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY merchant_products_delete_own
  ON public.merchant_products FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY canonical_products_select_own
  ON public.canonical_products FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY canonical_products_insert_own
  ON public.canonical_products FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY canonical_products_update_own
  ON public.canonical_products FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY canonical_products_delete_own
  ON public.canonical_products FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY product_variants_select_own
  ON public.product_variants FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY product_variants_insert_own
  ON public.product_variants FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY product_variants_update_own
  ON public.product_variants FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY product_variants_delete_own
  ON public.product_variants FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY receipt_item_identity_links_select_own
  ON public.receipt_item_identity_links FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY receipt_item_identity_links_insert_own
  ON public.receipt_item_identity_links FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY receipt_item_identity_links_update_own
  ON public.receipt_item_identity_links FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY receipt_item_identity_links_delete_own
  ON public.receipt_item_identity_links FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.merchant_products IS
  'Product Identity: per-merchant product entity. Prepared only — not required for receipt restore.';
COMMENT ON TABLE public.canonical_products IS
  'Product Identity: canonical product concept. Prepared only. Cross-merchant only with strong evidence.';
COMMENT ON TABLE public.product_variants IS
  'Product Identity: optional SKU/JAN variant. Prepared only. JAN not required.';
COMMENT ON TABLE public.receipt_item_identity_links IS
  'Product Identity Batch 3: derived rebuildable identity links. Fingerprint staleness forces recompute. Not receipt SoT.';
