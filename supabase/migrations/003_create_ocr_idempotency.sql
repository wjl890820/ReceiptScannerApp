-- Production-grade OCR idempotency and rate limiting
-- Migration: 003_create_ocr_idempotency.sql

-- 1) Idempotency table: stores final response (success or error) and in-progress status
create table if not exists public.ocr_idempotency (
  idempotency_key text primary key,
  device_hash text not null,
  status text not null check (status in ('IN_PROGRESS', 'SUCCEEDED', 'FAILED')),
  http_status int,
  response_json jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_ocr_idempotency_device_hash on public.ocr_idempotency(device_hash);
create index if not exists idx_ocr_idempotency_expires_at on public.ocr_idempotency(expires_at);
create index if not exists idx_ocr_idempotency_status on public.ocr_idempotency(status) where status = 'IN_PROGRESS';

-- 2) Rate limit table: simple window counting (minute/day)
create table if not exists public.ocr_ratelimit (
  device_hash text not null,
  bucket text not null, -- e.g. '1m:2026-01-18T12:34', '1d:2026-01-18'
  count int not null,
  updated_at timestamptz not null default now(),
  primary key (device_hash, bucket)
);

create index if not exists idx_ocr_ratelimit_bucket on public.ocr_ratelimit(bucket);
create index if not exists idx_ocr_ratelimit_updated_at on public.ocr_ratelimit(updated_at);

-- 3) Atomic increment RPC: avoid race conditions
create or replace function public.ocr_ratelimit_incr(
  p_device_hash text,
  p_bucket text,
  p_increment int
) returns int
language plpgsql
as $$
declare
  v_count int;
begin
  insert into public.ocr_ratelimit(device_hash, bucket, count)
  values (p_device_hash, p_bucket, p_increment)
  on conflict (device_hash, bucket)
  do update set count = public.ocr_ratelimit.count + p_increment,
                updated_at = now()
  returning count into v_count;
  return v_count;
end;
$$;

-- 4) Cleanup function for expired idempotency records (optional, can be run via cron)
create or replace function public.ocr_idempotency_cleanup()
returns int
language plpgsql
as $$
declare
  v_deleted int;
begin
  delete from public.ocr_idempotency
  where expires_at < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- 5) RLS policies: deny client access, allow service_role only
alter table public.ocr_idempotency enable row level security;
alter table public.ocr_ratelimit enable row level security;

-- Deny all client access
create policy "Deny all client access to ocr_idempotency" on public.ocr_idempotency
  for all using (false);

create policy "Deny all client access to ocr_ratelimit" on public.ocr_ratelimit
  for all using (false);

-- Service role can do everything (Edge Function uses service_role)
-- No explicit policy needed - service_role bypasses RLS by default
