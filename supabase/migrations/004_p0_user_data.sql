-- Migration: 004_p0_user_data.sql
-- P0 Phase 1–3: account-owned durable receipt backup + OCR provenance + installations.
--
-- NOT applied to production by this change set.
-- No profiles table — auth.users is the identity authority.
--
-- Design notes:
-- - user_receipts JSON evidence columns are TEXT (byte-preserving serialized JSON).
--   CHECK constraints validate JSON syntax via ::json cast; storage remains TEXT.
-- - ocr_runs has NO FK to user_receipts (Edge may write before client backup).
--   Join chain: user_receipts.ocr_request_id → ocr_runs.request_id → ocr_usage_events.request_id
-- - receipt id (user_receipts.id) remains the stable client/local identifier.
-- - installations: UNIQUE(user_id, installation_id) so the same installation_id can be
--   registered under a restored Apple-linked user without mutating another user's rows.
-- - user_receipts.installation_id is metadata only (no FK to installations).

-- ---------------------------------------------------------------------------
-- installations: per-user registration of an app installation instance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.installations (
  row_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  platform TEXT,
  app_version TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_installations_user_installation UNIQUE (user_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_installations_user_id
  ON public.installations (user_id);

CREATE INDEX IF NOT EXISTS idx_installations_user_last_seen
  ON public.installations (user_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_installations_installation_id
  ON public.installations (installation_id);

COMMENT ON TABLE public.installations IS
  'Per-user app installation registrations. installation_id is NOT globally owned by one auth user; UNIQUE(user_id, installation_id) allows the same install to register under a restored account.';
COMMENT ON COLUMN public.installations.installation_id IS
  'Client-generated install-scoped ID (cleared on uninstall). Distinct from auth.uid() and legacy x-device-id.';

-- ---------------------------------------------------------------------------
-- user_receipts: cloud durable backup of user-owned receipt/transaction facts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_receipts (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Provenance/metadata only — no FK to installations (receipt durability must not
  -- depend on installation-row lifecycle; account switch must not orphan receipts).
  installation_id TEXT,

  transaction_source TEXT NOT NULL DEFAULT 'receipt_ocr'
    CHECK (transaction_source IN ('receipt_ocr', 'manual', 'import', 'shared', 'other')),
  social_source TEXT,

  created_at TIMESTAMPTZ NOT NULL,
  transaction_at TIMESTAMPTZ,
  scanned_at TIMESTAMPTZ,

  merchant_raw TEXT,
  merchant_normalized TEXT,
  merchant_type TEXT,
  store_raw TEXT,
  store_normalized TEXT,

  total NUMERIC NOT NULL,
  tax NUMERIC NOT NULL DEFAULT 0,
  tax_is_known BOOLEAN NOT NULL DEFAULT FALSE,
  currency TEXT NOT NULL DEFAULT 'JPY',

  -- Byte-preserving serialized JSON (validate syntax only; do not store as jsonb).
  analysis_json TEXT NOT NULL,
  recognition_snapshot_json TEXT,
  user_items_json TEXT,

  user_edited BOOLEAN NOT NULL DEFAULT FALSE,
  final_total NUMERIC,
  final_category TEXT,
  note TEXT,

  ocr_request_id TEXT,

  client_updated_at TIMESTAMPTZ NOT NULL,
  server_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  PRIMARY KEY (user_id, id),

  CONSTRAINT user_receipts_analysis_json_not_empty
    CHECK (length(trim(analysis_json)) > 0),
  CONSTRAINT user_receipts_analysis_json_valid
    CHECK (analysis_json::json IS NOT NULL),
  CONSTRAINT user_receipts_recognition_snapshot_json_valid
    CHECK (
      recognition_snapshot_json IS NULL
      OR recognition_snapshot_json::json IS NOT NULL
    ),
  CONSTRAINT user_receipts_user_items_json_valid
    CHECK (
      user_items_json IS NULL
      OR user_items_json::json IS NOT NULL
    )
);

-- Account-scoped identity is the composite PRIMARY KEY (user_id, id).
-- No redundant UNIQUE(user_id, id).

CREATE INDEX IF NOT EXISTS idx_user_receipts_user_transaction_at
  ON public.user_receipts (user_id, transaction_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_user_receipts_user_active
  ON public.user_receipts (user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_receipts_user_client_updated
  ON public.user_receipts (user_id, client_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_receipts_ocr_request_id
  ON public.user_receipts (ocr_request_id)
  WHERE ocr_request_id IS NOT NULL;

COMMENT ON TABLE public.user_receipts IS
  'Account-owned durable backup of receipt/transaction facts. PK (user_id, id) is account-scoped. analysis_json is TEXT for byte-preserving restore. No receipt images in P0.';
COMMENT ON COLUMN public.user_receipts.analysis_json IS
  'Serialized OCR/enrichment JSON (TEXT). Valid JSON required; original string preserved on upload.';
COMMENT ON COLUMN public.user_receipts.user_items_json IS
  'User override item list (TEXT JSON). Authoritative for restore when present.';
COMMENT ON COLUMN public.user_receipts.deleted_at IS
  'Cloud tombstone for deleted receipts. Local P0 may hard-delete; backup worker sends delete payload.';
COMMENT ON COLUMN public.user_receipts.ocr_request_id IS
  'Summary link to ocr_runs.request_id (full provenance lives in ocr_runs + ocr_usage_events).';
COMMENT ON COLUMN public.user_receipts.installation_id IS
  'Optional install provenance metadata only. No FK to installations.';

-- ---------------------------------------------------------------------------
-- ocr_runs: cloud-authoritative OCR/date-verifier provenance (no receipt FK)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ocr_runs (
  ocr_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  primary_model TEXT NOT NULL,
  cache_version INTEGER NOT NULL,
  cached BOOLEAN NOT NULL DEFAULT FALSE,
  image_content_hash TEXT,

  -- Nullable when unknown (e.g. cache-hit origin). Do not fabricate defaults.
  date_verification_used BOOLEAN,
  date_verify_model TEXT,
  primary_transaction_date TEXT,
  verified_transaction_date TEXT,
  final_transaction_date TEXT,
  verifier_succeeded BOOLEAN,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ocr_runs_user_id
  ON public.ocr_runs (user_id);

CREATE INDEX IF NOT EXISTS idx_ocr_runs_user_created
  ON public.ocr_runs (user_id, created_at DESC);

COMMENT ON TABLE public.ocr_runs IS
  'Cloud-authoritative OCR provenance. Join: user_receipts.ocr_request_id = request_id = ocr_usage_events.request_id. No token/cost fields (see ocr_usage_events).';
COMMENT ON COLUMN public.ocr_runs.request_id IS
  'Stable join key shared with ocr_usage_events.request_id (verifier usage uses request_id#date-verify suffix).';

COMMENT ON COLUMN public.ocr_runs.image_content_hash IS
  'SHA-256 of image bytes (without cache-version prefix). May join to prior ocr_runs for audit; origin cache provenance is not stored in ocr_cache.';
COMMENT ON COLUMN public.ocr_runs.date_verification_used IS
  'Whether date verification ran during THIS request. False on cache hits; null only when genuinely unknown.';

-- ---------------------------------------------------------------------------
-- Row Level Security: client-owned data
-- ---------------------------------------------------------------------------
ALTER TABLE public.installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ocr_runs ENABLE ROW LEVEL SECURITY;

-- installations: own rows only
CREATE POLICY "Users select own installations"
  ON public.installations
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users insert own installations"
  ON public.installations
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own installations"
  ON public.installations
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- user_receipts: own rows only (full CRUD for backup/restore client)
CREATE POLICY "Users select own receipts"
  ON public.user_receipts
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users insert own receipts"
  ON public.user_receipts
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own receipts"
  ON public.user_receipts
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users delete own receipts"
  ON public.user_receipts
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ocr_runs: SELECT own only; writes are service_role (Edge) in later phases
CREATE POLICY "Users select own ocr_runs"
  ON public.ocr_runs
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- service_role bypasses RLS by default (Supabase). Edge Functions continue to work.
