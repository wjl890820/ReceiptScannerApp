// supabase/functions/ocr/index.ts
// HTTP handler: authentication, request parsing, and core orchestration

// deno-lint-ignore no-import-prefix -- Supabase Edge Functions require URL imports for Deno runtime
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
// deno-lint-ignore no-import-prefix -- Supabase Edge Functions require URL imports for Deno runtime
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as response from './_shared/response.ts';
import * as log from './_shared/log.ts';
import * as idempotency from './_shared/idempotency.ts';
import {
  processOCRRequest,
  hashDeviceId,
  DefaultOCRUpstream,
  type OCRRequest,
  type OCRContext,
} from './core.ts';

const REQUEST_TIMEOUT_MS = parseInt(Deno.env.get('REQUEST_TIMEOUT_MS') || '25000', 10);
const DENO_TESTING = Deno.env.get('DENO_TESTING') === '1';

// A) Lock DENO_TESTING bypass to local environment only
const IS_LOCAL =
  (Deno.env.get('SUPABASE_URL') || '').includes('127.0.0.1') ||
  (Deno.env.get('SUPABASE_URL') || '').includes('localhost') ||
  Deno.env.get('SUPABASE_ENV') === 'local';

/**
 * Check if token is JWT (3 parts separated by dots)
 */
function isJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * Parse authorization header
 */
function parseAuthHeader(authHeader: string | null): string {
  if (!authHeader) return '';
  const lower = authHeader.toLowerCase();
  if (lower.startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

/**
 * Authenticate request
 * B) Enhanced auth: Bearer must be JWT, apikey must match env keys
 */
function authenticateRequest(
  req: Request,
  requestId: string
): { authenticated: boolean; error?: response.ErrorResponse } {
  // A) Only allow DENO_TESTING bypass in local environment
  if (DENO_TESTING) {
    if (!IS_LOCAL) {
      // DENO_TESTING enabled but not in local environment - security violation
      log.logError(
        requestId,
        'unknown',
        'missing',
        'MISCONFIGURED_TEST_MODE',
        500,
        0
      );
      return {
        authenticated: false,
        error: response.createErrorResponse(
          requestId,
          'missing',
          'INTERNAL_ERROR',
          'Test mode only allowed in local environment'
        ),
      };
    }
    // Local + test mode: skip auth
    return { authenticated: true };
  }

  // B) Enhanced authentication checks
  const authHeader = req.headers.get('authorization');
  const apiKey = req.headers.get('apikey');

  // Check Bearer token path
  if (authHeader) {
    const bearerToken = parseAuthHeader(authHeader);
    if (bearerToken) {
      // Bearer token must be JWT
      if (!isJwt(bearerToken)) {
        return {
          authenticated: false,
          error: response.createErrorResponse(
            requestId,
            'missing',
            'UNAUTHORIZED',
            'Invalid Bearer token format (must be JWT)'
          ),
        };
      }
      // JWT format valid, allow
      return { authenticated: true };
    }
  }

  // Check apikey path
  if (apiKey) {
    const validKeys = [
      Deno.env.get('SUPABASE_ANON_KEY'),
      Deno.env.get('SUPABASE_PUBLISHABLE_KEY'),
      Deno.env.get('SUPABASE_PUBLISHABLE_ANON_KEY'),
    ].filter((k) => k && k.length > 0);

    if (validKeys.includes(apiKey)) {
      return { authenticated: true };
    }
    return {
      authenticated: false,
      error: response.createErrorResponse(
        requestId,
        'missing',
        'UNAUTHORIZED',
        'Invalid apikey'
      ),
    };
  }

  // No valid auth found
  return {
    authenticated: false,
    error: response.createErrorResponse(
      requestId,
      'missing',
      'UNAUTHORIZED',
      'Missing authorization token'
    ),
  };
}

serve(async (req) => {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  let deviceHash = '';
  let idempotencyKey = '';

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers':
          'authorization, x-client-info, apikey, content-type, x-device-id, x-idempotency-key, x-parser-version',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  try {
    // Authenticate request
    const authResult = authenticateRequest(req, requestId);
    if (!authResult.authenticated) {
      const httpStatus = authResult.error?.error.code === 'INTERNAL_ERROR' ? 500 : 401;
      return response.createHttpResponse(authResult.error!, httpStatus, undefined, requestId);
    }

    // Initialize Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      const errorResp = response.createErrorResponse(
        requestId,
        'missing',
        'INTERNAL_ERROR',
        'Supabase configuration missing'
      );
      return response.createHttpResponse(errorResp, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
      },
    }) as OCRContext['supabase'];

    // Parse headers
    const deviceId = req.headers.get('x-device-id') || '';
    idempotencyKey = req.headers.get('x-idempotency-key') || '';

    if (!deviceId) {
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey || 'missing',
        'INVALID_INPUT',
        'Missing x-device-id header'
      );
      log.logError(requestId, 'missing', (idempotencyKey || 'missing').substring(0, 8), 'INVALID_INPUT', 400, latencyMs);
      return response.createHttpResponse(errorResp, 400, undefined, requestId);
    }

    if (!idempotencyKey) {
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        'missing',
        'INVALID_INPUT',
        'Missing x-idempotency-key header'
      );
      log.logError(requestId, deviceId.substring(0, 8), 'missing', 'INVALID_INPUT', 400, latencyMs);
      return response.createHttpResponse(errorResp, 400, undefined, requestId);
    }

    // Hash device ID
    const serverSalt = Deno.env.get('SERVER_SALT') || '';
    deviceHash = await hashDeviceId(deviceId, serverSalt);

    // Parse request body
    let requestData: OCRRequest;
    try {
      const body = await req.json();
      // B) Normalize mimeType to union type (not arbitrary string)
      const mimeType: 'image/jpeg' | 'image/png' = body.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      requestData = {
        imageBase64: body.imageBase64 || '',
        mimeType,
      };
    } catch (_e) {
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        'INVALID_INPUT',
        'Invalid JSON in request body'
      );
      await idempotency.saveIdempotencyResult(
        supabase,
        idempotencyKey,
        'FAILED',
        400,
        errorResp,
        'INVALID_INPUT'
      );
      log.logError(requestId, deviceHash.substring(0, 8), idempotencyKey.substring(0, 8), 'INVALID_INPUT', 400, latencyMs);
      return response.createHttpResponse(errorResp, 400, undefined, requestId);
    }

    // Build context
    const ctx: OCRContext = {
      requestId,
      deviceId,
      deviceHash,
      idempotencyKey,
      supabase,
      startTime,
      serverSalt,
      geminiApiKey: Deno.env.get('GEMINI_API_KEY'),
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      mockOcr: Deno.env.get('MOCK_OCR') === '1',
    };

    // Create upstream
    const upstream = new DefaultOCRUpstream(
      ctx.geminiApiKey || '',
      ctx.requestTimeoutMs,
      ctx.mockOcr
    );

    // C) Process OCR request with mimeType
    const result = await processOCRRequest(ctx, requestData, upstream);

    // Add retry-after header if needed
    let retryAfterMs: number | undefined;
    if (!result.response.ok && result.response.error.retry_after_ms) {
      retryAfterMs = result.response.error.retry_after_ms;
    }

    // D) Ensure x-request-id header is always set to current requestId
    return response.createHttpResponse(result.response, result.httpStatus, retryAfterMs, requestId);
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const errorResp = response.createErrorResponse(
      requestId,
      idempotencyKey || 'unknown',
      'INTERNAL_ERROR',
      errorMessage
    );

      log.logError(
        requestId,
        deviceHash ? deviceHash.substring(0, 8) : 'unknown',
        idempotencyKey ? idempotencyKey.substring(0, 8) : 'unknown',
        'INTERNAL_ERROR',
        500,
        latencyMs
      );

      return response.createHttpResponse(errorResp, 500, undefined, requestId);
  }
});
