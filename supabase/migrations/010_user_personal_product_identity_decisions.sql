-- DS1: account-owned personal product identity decisions.
--
-- User truth. Not a product-identity projection and not receipt JSON.
-- Pair identity is the canonical merchant-product id order already enforced locally.
-- No tombstone: the product does not delete or reverse a stored decision.
-- Clients append or verify one row. They must not replace the account set.

CREATE TABLE IF NOT EXISTS public.user_personal_product_identity_decisions (
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  left_merchant_product_id TEXT NOT NULL,
  right_merchant_product_id TEXT NOT NULL,
  left_merchant_scope_key TEXT NOT NULL,
  right_merchant_scope_key TEXT NOT NULL,
  left_comparison_key TEXT NOT NULL,
  right_comparison_key TEXT NOT NULL,
  left_structural_signature TEXT NOT NULL,
  right_structural_signature TEXT NOT NULL,
  identity_pipeline_version TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, left_merchant_product_id, right_merchant_product_id),
  CONSTRAINT user_personal_product_identity_decisions_pair_order_check
    CHECK (left_merchant_product_id < right_merchant_product_id),
  CONSTRAINT user_personal_product_identity_decisions_decision_check
    CHECK (
      decision IN (
        'same_product',
        'not_same_product',
        'unsure'
      )
    )
);

COMMENT ON TABLE public.user_personal_product_identity_decisions IS
  'Account-owned personal product identity decisions (same / not-same / unsure). Append or verify one canonical pair. Do not delete rows absent on a device.';
COMMENT ON COLUMN public.user_personal_product_identity_decisions.identity_pipeline_version IS
  'TEXT pipeline stamp copied from the local decision row. Not a numeric version.';
COMMENT ON COLUMN public.user_personal_product_identity_decisions.created_at IS
  'Client epoch milliseconds. Restored as an integer, not a timestamptz.';
COMMENT ON COLUMN public.user_personal_product_identity_decisions.updated_at IS
  'Client epoch milliseconds from the original insert. Idempotent backup must not refresh it.';

ALTER TABLE public.user_personal_product_identity_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users select own personal product identity decisions"
  ON public.user_personal_product_identity_decisions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users insert own personal product identity decisions"
  ON public.user_personal_product_identity_decisions
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own personal product identity decisions"
  ON public.user_personal_product_identity_decisions
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
