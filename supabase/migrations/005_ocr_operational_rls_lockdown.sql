-- Migration: 005_ocr_operational_rls_lockdown.sql
-- P0 Phase 1: lock down operational OCR tables that previously had no client RLS.
--
-- NOT applied to production by this change set.
--
-- Scope:
-- - ocr_cache (001): operational OCR result cache — NOT user restore source
-- - ocr_rate_limit (001): legacy rate limit table used by ocr-receipt Edge function
--
-- Already locked in prior migrations (no changes here):
-- - ocr_usage_events (002): deny authenticated/anon; service_role insert
-- - ocr_idempotency (003): deny all clients (USING false)
-- - ocr_ratelimit (003): deny all clients (USING false)
--
-- ocr_cache retention/TTL (unchanged):
-- - Edge env OCR_CACHE_TTL_DAYS defaults to 30 (see ocr-receipt/index.ts)
-- - SQL helper clean_old_ocr_cache() deletes rows where created_at < now() - 30 days
-- - Cache key includes OCR_CACHE_VERSION prefix (Edge); semantics unchanged by this migration
--
-- Edge access: ocr-receipt uses SUPABASE_SERVICE_ROLE_KEY (service_role bypasses RLS).

-- ---------------------------------------------------------------------------
-- ocr_cache: deny all client access
-- ---------------------------------------------------------------------------
ALTER TABLE public.ocr_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny all client access to ocr_cache" ON public.ocr_cache;
CREATE POLICY "Deny all client access to ocr_cache"
  ON public.ocr_cache
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.ocr_cache IS
  'Operational OCR analysis cache (service_role only). Contains serialized analysis_json. Not a user restore source. TTL: 30 days via clean_old_ocr_cache() unless cron/env differs.';

-- ---------------------------------------------------------------------------
-- ocr_rate_limit: deny all client access (legacy table, ocr-receipt)
-- ---------------------------------------------------------------------------
ALTER TABLE public.ocr_rate_limit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny all client access to ocr_rate_limit" ON public.ocr_rate_limit;
CREATE POLICY "Deny all client access to ocr_rate_limit"
  ON public.ocr_rate_limit
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.ocr_rate_limit IS
  'Legacy OCR rate limit counters (service_role only). Used by ocr-receipt Edge function.';
