-- Migration: 006_lockdown_v_ocr_usage_daily.sql
-- Security: close SECURITY DEFINER / client-readable exposure of operational OCR usage view.
--
-- Confirmed issue: anon/authenticated had SELECT on public.v_ocr_usage_daily while the view
-- ran as owner (postgres), bypassing ocr_usage_events RLS deny policies.
--
-- Intent: internal/service operational cost reporting only. Not client-readable.
-- No OCR semantic changes. No Auth/Apple changes.

-- Prefer invoker rights so any future accidental client GRANT cannot bypass table RLS.
ALTER VIEW public.v_ocr_usage_daily
  SET (security_invoker = true);

-- Remove all client privileges (default public grants included SELECT).
REVOKE ALL ON TABLE public.v_ocr_usage_daily FROM anon, authenticated;

-- Keep explicit internal/service read access.
GRANT SELECT ON TABLE public.v_ocr_usage_daily TO service_role;

COMMENT ON VIEW public.v_ocr_usage_daily IS
  'Daily aggregated OCR usage by actor_hash for internal/operational cost analysis only. Not client-readable (anon/authenticated revoked). security_invoker=true.';
