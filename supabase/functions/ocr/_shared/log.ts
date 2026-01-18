// supabase/functions/ocr/_shared/log.ts
// Unified JSON logging with sanitization (no sensitive data)

export interface LogEntry {
  request_id: string;
  device_hash_prefix: string; // First 8 chars only
  idempotency_key_prefix: string; // First 8 chars only
  status: 'success' | 'error' | 'rate_limited' | 'in_progress';
  http_status: number;
  latency_ms: number;
  error_code?: string;
  method?: string;
  path?: string;
  timestamp: string;
}

/**
 * Sanitize and log request as JSON (one line)
 * NEVER logs: raw images, base64, receipt text, item details
 * E) Strictly enforce 8-character prefix for all prefix fields
 */
export function logRequest(entry: LogEntry): void {
  // E) Ensure all prefix fields are exactly 8 characters
  const devicePrefix = entry.device_hash_prefix.substring(0, 8).padEnd(8, '0');
  const idempotencyPrefix = entry.idempotency_key_prefix.substring(0, 8).padEnd(8, '0');

  const sanitized: LogEntry = {
    request_id: entry.request_id,
    device_hash_prefix: devicePrefix,
    idempotency_key_prefix: idempotencyPrefix,
    status: entry.status,
    http_status: entry.http_status,
    latency_ms: entry.latency_ms,
    error_code: entry.error_code,
    method: entry.method,
    path: entry.path,
    timestamp: entry.timestamp || new Date().toISOString(),
  };

  console.log(JSON.stringify(sanitized));
}

/**
 * Log error (sanitized)
 * E) Strictly enforce 8-character prefix
 */
export function logError(
  requestId: string,
  deviceHash: string,
  idempotencyKey: string,
  errorCode: string,
  httpStatus: number,
  latencyMs: number
): void {
  logRequest({
    request_id: requestId,
    device_hash_prefix: deviceHash.substring(0, 8),
    idempotency_key_prefix: idempotencyKey.substring(0, 8),
    status: 'error',
    http_status: httpStatus,
    latency_ms: latencyMs,
    error_code: errorCode,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log success (sanitized)
 * E) Strictly enforce 8-character prefix
 */
export function logSuccess(
  requestId: string,
  deviceHash: string,
  idempotencyKey: string,
  httpStatus: number,
  latencyMs: number
): void {
  logRequest({
    request_id: requestId,
    device_hash_prefix: deviceHash.substring(0, 8),
    idempotency_key_prefix: idempotencyKey.substring(0, 8),
    status: 'success',
    http_status: httpStatus,
    latency_ms: latencyMs,
    timestamp: new Date().toISOString(),
  });
}
