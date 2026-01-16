# OCR Cost Tracking Setup

## Required Secrets

Set the following secrets in Supabase Dashboard → Project Settings → Edge Functions → Secrets:

1. **GEMINI_PRICE_INPUT_PER_1K** (required)
   - Example: `0.000125` (for Gemini 2.0 Flash: $0.125 per 1M input tokens = $0.000125 per 1K)
   - Current pricing: https://ai.google.dev/pricing

2. **GEMINI_PRICE_OUTPUT_PER_1K** (required)
   - Example: `0.0005` (for Gemini 2.0 Flash: $0.50 per 1M output tokens = $0.0005 per 1K)

3. **SERVER_SALT** (required for privacy)
   - A random string used to hash actor IDs
   - Generate: `openssl rand -hex 32`
   - Keep this secret and never expose it

4. **EDGE_REGION** (optional)
   - Edge function region identifier (e.g., `us-east-1`, `asia-northeast-1`)
   - Used for regional cost analysis

## Migration

Run the migration to create the usage tracking table:

```bash
supabase db push
# Or manually:
psql $DATABASE_URL -f supabase/migrations/002_ocr_usage_events.sql
```

## Querying Usage Data

### Daily aggregated view (by actor)

```sql
SELECT * FROM v_ocr_usage_daily
WHERE usage_date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY usage_date DESC, estimated_cost_usd DESC;
```

### Total cost by date

```sql
SELECT 
  usage_date,
  SUM(requests) AS total_requests,
  SUM(success_requests) AS total_success,
  SUM(total_tokens) AS total_tokens,
  SUM(estimated_cost_usd) AS total_cost_usd
FROM v_ocr_usage_daily
WHERE usage_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY usage_date
ORDER BY usage_date DESC;
```

### Top actors by cost (last 7 days)

```sql
SELECT 
  actor_hash,
  actor_type,
  SUM(requests) AS total_requests,
  SUM(total_tokens) AS total_tokens,
  SUM(estimated_cost_usd) AS total_cost_usd
FROM v_ocr_usage_daily
WHERE usage_date >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY actor_hash, actor_type
ORDER BY total_cost_usd DESC
LIMIT 20;
```

### Error rate analysis

```sql
SELECT 
  usage_date,
  SUM(requests) AS total,
  SUM(failed_requests) AS failed,
  ROUND(100.0 * SUM(failed_requests) / SUM(requests), 2) AS error_rate_pct
FROM v_ocr_usage_daily
WHERE usage_date >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY usage_date
ORDER BY usage_date DESC;
```

## Privacy Notes

- **NO images stored**: Only image hash (SHA256) for deduplication
- **NO receipt content**: No merchant names, item names, or totals stored in usage events
- **Hashed actor IDs**: Actor IDs are hashed with SERVER_SALT for privacy
- **RLS enabled**: Clients cannot read usage events (service role only)
