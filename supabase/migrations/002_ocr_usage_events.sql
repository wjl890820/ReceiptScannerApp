-- supabase/migrations/002_ocr_usage_events.sql
-- OCR usage tracking for cost analysis and abuse prevention
-- Privacy: Only stores aggregated metrics, NO images, NO receipt content, NO merchant names

-- OCR Usage Events table (event-level tracking)
CREATE TABLE IF NOT EXISTS ocr_usage_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Actor identification (hashed for privacy)
  actor_type TEXT NOT NULL CHECK (actor_type IN ('anon', 'user')),
  actor_hash TEXT NOT NULL, -- SHA256(actorId + SERVER_SALT) for privacy
  
  -- Request metadata
  request_id TEXT NOT NULL UNIQUE, -- UUID for request tracking
  edge_region TEXT, -- Edge function region (e.g., 'us-east-1')
  
  -- Model and usage
  model TEXT NOT NULL DEFAULT 'gemini-2.0-flash',
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost_usd NUMERIC(10, 6), -- Cost in USD
  
  -- Request metadata
  payload_bytes INTEGER, -- Size of image payload in bytes
  duration_ms INTEGER, -- Request duration in milliseconds
  
  -- Result
  success BOOLEAN NOT NULL DEFAULT false,
  error_code TEXT -- Error code if failed (e.g., 'RATE_LIMIT', 'PAYLOAD_TOO_LARGE')
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_ocr_usage_events_created_at ON ocr_usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocr_usage_events_actor_hash ON ocr_usage_events(actor_hash);
CREATE INDEX IF NOT EXISTS idx_ocr_usage_events_request_id ON ocr_usage_events(request_id);
CREATE INDEX IF NOT EXISTS idx_ocr_usage_events_actor_type ON ocr_usage_events(actor_type);
CREATE INDEX IF NOT EXISTS idx_ocr_usage_events_success ON ocr_usage_events(success);

-- Daily aggregated view (for cost analysis)
CREATE OR REPLACE VIEW v_ocr_usage_daily AS
SELECT
  DATE(created_at) AS usage_date,
  actor_hash,
  actor_type,
  COUNT(*) AS requests,
  COUNT(*) FILTER (WHERE success = true) AS success_requests,
  COUNT(*) FILTER (WHERE success = false) AS failed_requests,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
  COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
  COALESCE(SUM(payload_bytes), 0) AS total_payload_bytes
FROM ocr_usage_events
GROUP BY DATE(created_at), actor_hash, actor_type
ORDER BY usage_date DESC, actor_hash;

-- RLS: Deny all access from client (only service role can write)
ALTER TABLE ocr_usage_events ENABLE ROW LEVEL SECURITY;

-- Policy: Deny all for authenticated/anonymous users
CREATE POLICY "Deny all client access to ocr_usage_events"
  ON ocr_usage_events
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Policy: Allow service role to insert (Edge Function uses service role)
CREATE POLICY "Allow service role to insert ocr_usage_events"
  ON ocr_usage_events
  FOR INSERT
  TO service_role
  WITH CHECK (true);

-- RLS: View is read-only for service role only (for admin queries)
-- Note: Views don't have RLS, but underlying table RLS applies
-- Service role can query the view directly

-- Comment for documentation
COMMENT ON TABLE ocr_usage_events IS 'OCR usage events for cost tracking. Privacy: NO images, NO receipt content, NO merchant names stored.';
COMMENT ON COLUMN ocr_usage_events.actor_hash IS 'SHA256(actorId + SERVER_SALT) for privacy-preserving user/device identification';
COMMENT ON VIEW v_ocr_usage_daily IS 'Daily aggregated OCR usage by actor_hash for cost analysis';
