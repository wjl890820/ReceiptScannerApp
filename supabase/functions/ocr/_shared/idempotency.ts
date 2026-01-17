// supabase/functions/ocr/_shared/idempotency.ts
// Idempotency handling: read/write idempotency table, in-progress locking

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { OCRResponse } from './response.ts';

export interface IdempotencyRecord {
  idempotency_key: string;
  device_hash: string;
  status: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';
  http_status: number | null;
  response_json: OCRResponse | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

const IDEMPOTENCY_TTL_HOURS = parseInt(Deno.env.get('IDEMPOTENCY_TTL_HOURS') || '24', 10);
const IN_PROGRESS_STALE_SECONDS = parseInt(Deno.env.get('IN_PROGRESS_STALE_SECONDS') || '90', 10);

/**
 * Validate idempotency key format
 */
export function validateIdempotencyKey(key: string): boolean {
  if (!key || key.length < 32) return false;
  // Allow hex (0-9a-f) or base64url (A-Za-z0-9_-)
  return /^[0-9a-fA-Z_-]+$/.test(key);
}

/**
 * Get existing idempotency record
 */
export async function getIdempotencyRecord(
  supabase: ReturnType<typeof createClient>,
  idempotencyKey: string
): Promise<IdempotencyRecord | null> {
  const { data, error } = await supabase
    .from('ocr_idempotency')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // Not found
      return null;
    }
    throw error;
  }

  return data as IdempotencyRecord;
}

/**
 * Check if record is expired
 */
export function isExpired(record: IdempotencyRecord): boolean {
  return new Date(record.expires_at) < new Date();
}

/**
 * Check if IN_PROGRESS record is stale (can be retried)
 */
export function isStale(record: IdempotencyRecord): boolean {
  if (record.status !== 'IN_PROGRESS') return false;
  const updatedAt = new Date(record.updated_at);
  const now = new Date();
  const ageSeconds = (now.getTime() - updatedAt.getTime()) / 1000;
  return ageSeconds > IN_PROGRESS_STALE_SECONDS;
}

/**
 * Try to acquire processing lock (upsert IN_PROGRESS)
 * Returns true if lock acquired, false if already in progress
 */
export async function acquireProcessingLock(
  supabase: ReturnType<typeof createClient>,
  idempotencyKey: string,
  deviceHash: string
): Promise<boolean> {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + IDEMPOTENCY_TTL_HOURS);

  // Try to insert or update to IN_PROGRESS
  // If status is already SUCCEEDED/FAILED and not expired, this will fail (expected)
  const { error } = await supabase
    .from('ocr_idempotency')
    .upsert(
      {
        idempotency_key: idempotencyKey,
        device_hash: deviceHash,
        status: 'IN_PROGRESS',
        http_status: null,
        response_json: null,
        error_code: null,
        expires_at: expiresAt.toISOString(),
      },
      {
        onConflict: 'idempotency_key',
        ignoreDuplicates: false,
      }
    );

  if (error) {
    // Check if it's a constraint violation (status already SUCCEEDED/FAILED)
    // or if another request is already IN_PROGRESS
    const existing = await getIdempotencyRecord(supabase, idempotencyKey);
    if (existing && existing.status === 'IN_PROGRESS' && !isStale(existing)) {
      return false; // Lock already held
    }
    if (existing && (existing.status === 'SUCCEEDED' || existing.status === 'FAILED') && !isExpired(existing)) {
      return false; // Already completed
    }
    // If stale or expired, try to force update
    if (existing && (isStale(existing) || isExpired(existing))) {
      const { error: updateError } = await supabase
        .from('ocr_idempotency')
        .update({
          status: 'IN_PROGRESS',
          updated_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .eq('idempotency_key', idempotencyKey);
      return !updateError;
    }
    throw error;
  }

  return true;
}

/**
 * Save final result (SUCCEEDED or FAILED)
 */
export async function saveIdempotencyResult(
  supabase: ReturnType<typeof createClient>,
  idempotencyKey: string,
  status: 'SUCCEEDED' | 'FAILED',
  httpStatus: number,
  response: OCRResponse,
  errorCode?: string
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + IDEMPOTENCY_TTL_HOURS);

  const { error } = await supabase
    .from('ocr_idempotency')
    .update({
      status,
      http_status: httpStatus,
      response_json: response,
      error_code: errorCode || null,
      updated_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .eq('idempotency_key', idempotencyKey);

  if (error) {
    throw error;
  }
}
