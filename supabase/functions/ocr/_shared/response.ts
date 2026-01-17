// supabase/functions/ocr/_shared/response.ts
// Unified response structure and error mapping

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'IN_PROGRESS'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'PARSE_ERROR'
  | 'INTERNAL_ERROR';

export interface ErrorResponse {
  ok: false;
  request_id: string;
  idempotency_key: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retry_after_ms?: number;
    details?: Record<string, any>;
  };
}

export interface SuccessResponse {
  ok: true;
  request_id: string;
  idempotency_key: string;
  parser_version: string;
  model: string;
  latency_ms: number;
  data: {
    receipt: {
      merchant: { value: string; confidence: number };
      datetime: { value: string; confidence: number };
      total: { value: number; confidence: number; currency: string };
      items: Array<{
        name: { value: string; confidence: number };
        price: { value: number; confidence: number };
        quantity: { value: number; confidence: number };
        meta: { evidence: string[]; warnings: string[] };
      }>;
      meta: { warnings: string[]; raw_text_included: boolean };
    };
  };
}

export type OCRResponse = SuccessResponse | ErrorResponse;

/**
 * Error code to HTTP status mapping
 */
export function getHttpStatusForError(code: ErrorCode): number {
  const mapping: Record<ErrorCode, number> = {
    INVALID_INPUT: 400,
    UNAUTHORIZED: 401,
    RATE_LIMITED: 429,
    IN_PROGRESS: 202,
    UPSTREAM_TIMEOUT: 504,
    UPSTREAM_ERROR: 502,
    PARSE_ERROR: 500,
    INTERNAL_ERROR: 500,
  };
  return mapping[code] || 500;
}

/**
 * Check if error is retryable
 */
export function isRetryable(code: ErrorCode): boolean {
  return ['RATE_LIMITED', 'IN_PROGRESS', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR'].includes(code);
}

/**
 * Create error response
 */
export function createErrorResponse(
  requestId: string,
  idempotencyKey: string,
  code: ErrorCode,
  message: string,
  retryAfterMs?: number,
  details?: Record<string, any>
): ErrorResponse {
  return {
    ok: false,
    request_id: requestId,
    idempotency_key: idempotencyKey,
    error: {
      code,
      message,
      retryable: isRetryable(code),
      ...(retryAfterMs !== undefined && { retry_after_ms: retryAfterMs }),
      ...(details && { details }),
    },
  };
}

/**
 * Create success response
 */
export function createSuccessResponse(
  requestId: string,
  idempotencyKey: string,
  parserVersion: string,
  model: string,
  latencyMs: number,
  receiptData: SuccessResponse['data']['receipt']
): SuccessResponse {
  return {
    ok: true,
    request_id: requestId,
    idempotency_key: idempotencyKey,
    parser_version: parserVersion,
    model,
    latency_ms: latencyMs,
    data: {
      receipt: receiptData,
    },
  };
}

/**
 * Create HTTP response with proper headers
 */
export function createHttpResponse(
  body: OCRResponse,
  status: number,
  retryAfterMs?: number
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-request-id': body.request_id,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id, x-idempotency-key, x-parser-version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (retryAfterMs !== undefined) {
    headers['retry-after'] = Math.ceil(retryAfterMs / 1000).toString();
  }

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}
