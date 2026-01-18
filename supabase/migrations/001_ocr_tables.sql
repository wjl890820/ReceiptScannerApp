-- supabase/migrations/001_ocr_tables.sql
-- Create tables for OCR caching and rate limiting

-- OCR Cache table
CREATE TABLE IF NOT EXISTS ocr_cache (
  hash TEXT PRIMARY KEY NOT NULL,
  analysis_json TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_access_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_ocr_cache_created_at ON ocr_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_ocr_cache_device_id ON ocr_cache(device_id);

-- Rate limit table
CREATE TABLE IF NOT EXISTS ocr_rate_limit (
  device_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (device_id, window_start)
);

-- Index for rate limit queries
CREATE INDEX IF NOT EXISTS idx_ocr_rate_limit_window_start ON ocr_rate_limit(window_start);

-- Function to clean old cache entries (optional, can be run via cron)
CREATE OR REPLACE FUNCTION clean_old_ocr_cache()
RETURNS void AS $$
BEGIN
  DELETE FROM ocr_cache
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
