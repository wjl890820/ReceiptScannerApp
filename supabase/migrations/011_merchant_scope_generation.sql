-- H3-B1: durable merchant/store scope generation on account receipts.
-- NULL = legacy v1. Exact 2 = future store-aware v2.
-- No default, no backfill. Older clients omit the column and must not be
-- required to send it. Apply this migration before a client SELECT/upsert
-- that includes merchant_scope_generation = 2.

ALTER TABLE public.user_receipts
  ADD COLUMN IF NOT EXISTS merchant_scope_generation INTEGER;

ALTER TABLE public.user_receipts
  DROP CONSTRAINT IF EXISTS user_receipts_merchant_scope_generation_supported;

ALTER TABLE public.user_receipts
  ADD CONSTRAINT user_receipts_merchant_scope_generation_supported
  CHECK (
    merchant_scope_generation IS NULL
    OR merchant_scope_generation = 2
  );

COMMENT ON COLUMN public.user_receipts.merchant_scope_generation IS
  'Merchant/store scope generation. NULL = legacy v1. 2 = future store-aware v2. No default and no historical backfill. H3-B1 does not write 2.';
