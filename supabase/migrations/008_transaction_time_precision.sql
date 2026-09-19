-- Additive: durable transaction-time precision provenance for user_receipts.
-- Values: second | minute | date | unknown
-- Legacy / unrestorable rows default to unknown. Never infer from epoch second==0.

ALTER TABLE public.user_receipts
  ADD COLUMN IF NOT EXISTS transaction_time_precision TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE public.user_receipts
  DROP CONSTRAINT IF EXISTS user_receipts_transaction_time_precision_check;

ALTER TABLE public.user_receipts
  ADD CONSTRAINT user_receipts_transaction_time_precision_check
  CHECK (
    transaction_time_precision IN ('second', 'minute', 'date', 'unknown')
  );

COMMENT ON COLUMN public.user_receipts.transaction_time_precision IS
  'Source precision of transaction_at: second|minute|date|unknown. Independent of epoch value; never inferred from seconds==00.';
