-- A2.1: durable verified purchase occurrence membership on user_receipts.
-- Receipt-centric: no separate group table / FK.
-- Bundle invariant: all three NULL XOR all three valid.
-- verified_at range: >= 1970-01-01T00:00:00.001Z AND < 10000-01-01T00:00:00Z
-- (local: 1 ms <= verifiedAtMs <= 253402300799999).

ALTER TABLE public.user_receipts
  ADD COLUMN IF NOT EXISTS verified_purchase_occurrence_id TEXT;

ALTER TABLE public.user_receipts
  ADD COLUMN IF NOT EXISTS verified_purchase_occurrence_source TEXT;

ALTER TABLE public.user_receipts
  ADD COLUMN IF NOT EXISTS verified_purchase_occurrence_verified_at TIMESTAMPTZ;

ALTER TABLE public.user_receipts
  DROP CONSTRAINT IF EXISTS user_receipts_verified_purchase_occurrence_bundle_check;

ALTER TABLE public.user_receipts
  ADD CONSTRAINT user_receipts_verified_purchase_occurrence_bundle_check
  CHECK (
    (
      verified_purchase_occurrence_id IS NULL
      AND verified_purchase_occurrence_source IS NULL
      AND verified_purchase_occurrence_verified_at IS NULL
    )
    OR
    (
      verified_purchase_occurrence_id IS NOT NULL
      AND verified_purchase_occurrence_source IS NOT NULL
      AND verified_purchase_occurrence_verified_at IS NOT NULL
      AND length(btrim(verified_purchase_occurrence_id)) > 0
      AND length(btrim(verified_purchase_occurrence_id)) <= 128
      AND verified_purchase_occurrence_id = btrim(verified_purchase_occurrence_id)
      AND verified_purchase_occurrence_source IN (
        'research_verified',
        'user_verified',
        'support_verified'
      )
      AND isfinite(verified_purchase_occurrence_verified_at)
      AND verified_purchase_occurrence_verified_at >=
        TIMESTAMPTZ '1970-01-01 00:00:00.001+00'
      AND verified_purchase_occurrence_verified_at <
        TIMESTAMPTZ '10000-01-01 00:00:00+00'
    )
  );

COMMENT ON COLUMN public.user_receipts.verified_purchase_occurrence_id IS
  'Opaque owner-scoped verified purchase occurrence group id (e.g. vpo_…). NULL when unassigned.';
COMMENT ON COLUMN public.user_receipts.verified_purchase_occurrence_source IS
  'How membership was verified: research_verified|user_verified|support_verified.';
COMMENT ON COLUMN public.user_receipts.verified_purchase_occurrence_verified_at IS
  'Audit timestamp when membership was verified (not purchase time).';
