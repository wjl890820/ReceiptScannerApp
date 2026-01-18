# OCR Edge Function Deployment Guide

## Prerequisites

1. Supabase project created
2. Supabase CLI installed: `npm install -g supabase`
3. Supabase CLI logged in: `supabase login`

## Step 1: Run Database Migrations

```bash
# Connect to your Supabase project
supabase link --project-ref <your-project-ref>

# Run migrations
supabase db push
```

Or manually run the SQL in Supabase Dashboard:
- Go to SQL Editor
- Run `supabase/migrations/001_ocr_tables.sql`

## Step 2: Set Edge Function Secrets

In Supabase Dashboard → Project Settings → Edge Functions → Secrets:

```bash
GEMINI_API_KEY=<your-gemini-api-key>
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
SUPABASE_ANON_KEY=<your-anon-key>  # Optional: can also use apikey header
OCR_RATE_LIMIT_PER_HOUR=30
OCR_CACHE_TTL_DAYS=30
```

Or via CLI:
```bash
supabase secrets set GEMINI_API_KEY=<your-key>
supabase secrets set SUPABASE_URL=https://<your-project-ref>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
supabase secrets set SUPABASE_ANON_KEY=<your-anon-key>  # Optional
supabase secrets set OCR_RATE_LIMIT_PER_HOUR=30
supabase secrets set OCR_CACHE_TTL_DAYS=30
```

**Note:** `SUPABASE_ANON_KEY` is optional - if not set, the function will use the `apikey` header from the request.

## Step 3: Deploy Edge Function

```bash
# Deploy the function
supabase functions deploy ocr-receipt

# Verify deployment
supabase functions list
```

## Step 4: Test Edge Function

```bash
# Test locally (optional)
supabase functions serve ocr-receipt

# Test via curl
curl -X POST https://<your-project-ref>.supabase.co/functions/v1/ocr-receipt \
  -H "Authorization: Bearer <your-anon-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "imageBase64": "<base64-encoded-image>",
    "mimeType": "image/jpeg",
    "deviceId": "test-device-123",
    "appVersion": "1.0.0",
    "platform": "ios",
    "language": "en"
  }'
```

## Verification Checklist

- [ ] Database tables created (ocr_cache, ocr_rate_limit)
- [ ] Edge Function deployed successfully
- [ ] Secrets configured (GEMINI_API_KEY, rate limits)
- [ ] Function responds to test requests
- [ ] Cache works (second request with same image returns cached=true)
- [ ] Rate limiting works (after 30 requests, returns 429)
