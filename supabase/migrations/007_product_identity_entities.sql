/**
 * Supabase: Product Identity entity tables (Batch 1 — prepared only).
 *
 * DO NOT apply to production in Batch 1.
 * Local SQLite mirror: lib/productIdentityEntitySchema.ts
 *
 * Cloud receipt SoT remains user_receipts.analysis_json / user_items_json.
 * These tables are optional future sync targets for Merchant/Canonical/Variant
 * entities — not required for restore of historical receipts.
 */

-- merchant_products: per-merchant stable product entity
CREATE TABLE IF NOT EXISTS public.merchant_products (
  id TEXT PRIMARY KEY NOT NULL,
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,
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

ALTER TABLE public.merchant_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;

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

COMMENT ON TABLE public.merchant_products IS
  'Batch 1 Product Identity: per-merchant product entity. Prepared only — not required for receipt restore.';
COMMENT ON TABLE public.canonical_products IS
  'Batch 1 Product Identity: canonical product concept. Prepared only.';
COMMENT ON TABLE public.product_variants IS
  'Batch 1 Product Identity: optional SKU/JAN variant. Prepared only. JAN not required.';
