# OCR Cost Tracking Verification Guide

## Setup (One-time)

### 1. Set Secrets in Supabase Dashboard

Go to: Project Settings → Edge Functions → Secrets

Add:
- `GEMINI_PRICE_INPUT_PER_1K` = `0.000125` (example for Gemini 2.0 Flash)
- `GEMINI_PRICE_OUTPUT_PER_1K` = `0.0005` (example for Gemini 2.0 Flash)
- `SERVER_SALT` = `<random hex string>` (generate: `openssl rand -hex 32`)
- `EDGE_REGION` = `us-east-1` (optional, your edge region)

### 2. Run Migration

```bash
# Using Supabase CLI
supabase db push

# Or manually via psql
psql $DATABASE_URL -f supabase/migrations/002_ocr_usage_events.sql
```

### 3. Deploy Edge Function

```bash
supabase functions deploy ocr-receipt --project-ref <your-project-ref>
```

## Local Verification

### 1. Test OCR Request (curl)

```bash
# Replace with your actual values
SUPABASE_URL="https://<project-ref>.supabase.co"
ANON_KEY="<your-anon-key>"
DEVICE_ID="test-device-001"

# Test ping
curl -X POST "${SUPABASE_URL}/functions/v1/ocr-receipt" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "apikey: ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -H "x-device-id: ${DEVICE_ID}" \
  -d '{"ping": true}'

# Expected: {"ok":true,"mode":"anon","userId":null,"deviceId":"test-dev"}
```

### 2. Check Usage Events (SQL)

```sql
-- Connect to your Supabase database
-- View recent usage events
SELECT 
  request_id,
  actor_type,
  actor_hash,
  model,
  input_tokens,
  output_tokens,
  total_tokens,
  estimated_cost_usd,
  success,
  error_code,
  created_at
FROM ocr_usage_events
ORDER BY created_at DESC
LIMIT 10;

-- Check daily aggregated view
SELECT * FROM v_ocr_usage_daily
ORDER BY usage_date DESC, estimated_cost_usd DESC
LIMIT 20;
```

### 3. Verify RLS (Security Check)

```sql
-- As authenticated user (should fail)
-- This should return 0 rows or error
SELECT * FROM ocr_usage_events;

-- As service role (should work)
-- Use service role key in Edge Function only
```

## Production Verification

### 1. Test Real OCR Request

1. Open app
2. Scan a receipt (camera or library)
3. Confirm OCR dialog (should show privacy notice)
4. Wait for OCR to complete

### 2. Query Usage Data

```sql
-- Total cost today
SELECT 
  SUM(estimated_cost_usd) AS total_cost_today,
  COUNT(*) AS total_requests,
  COUNT(*) FILTER (WHERE success = true) AS successful_requests
FROM ocr_usage_events
WHERE DATE(created_at) = CURRENT_DATE;

-- Cost by actor (last 7 days)
SELECT 
  actor_hash,
  actor_type,
  COUNT(*) AS requests,
  SUM(total_tokens) AS total_tokens,
  SUM(estimated_cost_usd) AS total_cost
FROM ocr_usage_events
WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY actor_hash, actor_type
ORDER BY total_cost DESC
LIMIT 10;

-- Daily cost trend
SELECT 
  DATE(created_at) AS date,
  COUNT(*) AS requests,
  SUM(total_tokens) AS tokens,
  SUM(estimated_cost_usd) AS cost_usd
FROM ocr_usage_events
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### 3. Verify Privacy

```sql
-- Confirm NO images stored (only hash)
SELECT 
  request_id,
  payload_bytes,
  -- imageBase64 should NOT exist in table
  CASE 
    WHEN request_id::text LIKE '%image%' THEN 'ERROR: Image found'
    ELSE 'OK'
  END AS privacy_check
FROM ocr_usage_events
LIMIT 1;

-- Confirm NO receipt content
-- (ocr_usage_events should have NO merchant/item fields)
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'ocr_usage_events' 
  AND (column_name LIKE '%merchant%' OR column_name LIKE '%item%' OR column_name LIKE '%receipt%');
-- Should return 0 rows
```

## Cost Analysis Queries

### Top Users by Cost (Last 30 Days)

```sql
SELECT 
  actor_hash,
  actor_type,
  COUNT(*) AS requests,
  SUM(total_tokens) AS total_tokens,
  SUM(estimated_cost_usd) AS total_cost_usd,
  AVG(duration_ms) AS avg_duration_ms
FROM ocr_usage_events
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
  AND success = true
GROUP BY actor_hash, actor_type
ORDER BY total_cost_usd DESC
LIMIT 20;
```

### Error Rate Analysis

```sql
SELECT 
  DATE(created_at) AS date,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE success = false) AS failed,
  COUNT(*) FILTER (WHERE error_code = 'RATE_LIMIT') AS rate_limited,
  ROUND(100.0 * COUNT(*) FILTER (WHERE success = false) / COUNT(*), 2) AS error_rate_pct
FROM ocr_usage_events
WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### Token Usage Distribution

```sql
SELECT 
  CASE 
    WHEN total_tokens < 1000 THEN '<1K'
    WHEN total_tokens < 5000 THEN '1K-5K'
    WHEN total_tokens < 10000 THEN '5K-10K'
    ELSE '10K+'
  END AS token_range,
  COUNT(*) AS request_count,
  AVG(estimated_cost_usd) AS avg_cost,
  SUM(estimated_cost_usd) AS total_cost
FROM ocr_usage_events
WHERE success = true AND total_tokens IS NOT NULL
GROUP BY token_range
ORDER BY token_range;
```

## Troubleshooting

### No usage events recorded?

1. Check Edge Function logs: `supabase functions logs ocr-receipt`
2. Verify secrets are set: Check Supabase Dashboard
3. Verify migration ran: `SELECT COUNT(*) FROM ocr_usage_events;`
4. Check RLS policies: `SELECT * FROM pg_policies WHERE tablename = 'ocr_usage_events';`

### Cost is 0 or NULL?

1. Check if `GEMINI_PRICE_INPUT_PER_1K` and `GEMINI_PRICE_OUTPUT_PER_1K` are set
2. Check if Gemini API returns `usageMetadata` in response
3. Check Edge Function logs for token extraction errors

### RLS blocking writes?

1. Verify Edge Function uses `SUPABASE_SERVICE_ROLE_KEY` (not anon key)
2. Check service role has INSERT permission
3. Verify RLS policy allows service_role: `SELECT * FROM pg_policies WHERE tablename = 'ocr_usage_events';`
