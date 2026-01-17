// supabase/functions/ocr/index.ts
// Production-grade OCR Edge Function with idempotency, rate limiting, structured errors

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as log from './_shared/log.ts';
import * as response from './_shared/response.ts';
import * as idempotency from './_shared/idempotency.ts';
import * as ratelimit from './_shared/ratelimit.ts';

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const PARSER_VERSION = '2026-01-18';

// Configuration from secrets
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';
const SERVER_SALT = Deno.env.get('SERVER_SALT') || '';
const REQUEST_TIMEOUT_MS = parseInt(Deno.env.get('REQUEST_TIMEOUT_MS') || '25000', 10);
const MAX_IMAGE_SIZE_BYTES = 2.5 * 1024 * 1024; // 2.5MB decoded

// MOCK_OCR for testing (returns fixed fixture)
const MOCK_OCR = Deno.env.get('MOCK_OCR') === '1';

interface OCRRequest {
  imageBase64?: string;
  mimeType?: 'image/jpeg' | 'image/png';
}

/**
 * Compute SHA256 hash
 */
async function computeSHA256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash device ID for privacy-preserving tracking
 */
async function hashDeviceId(deviceId: string): Promise<string> {
  const combined = `${deviceId}${SERVER_SALT}`;
  return computeSHA256(combined);
}

/**
 * Check if token is JWT
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
 * Extract JSON from Gemini response text
 */
function extractJsonFromText(text: string): any {
  try {
    return JSON.parse(text);
  } catch {}

  try {
    const matchJson = text.match(/```json([\s\S]*?)```/i);
    if (matchJson?.[1]) return JSON.parse(matchJson[1].trim());
  } catch {}

  try {
    const matchFence = text.match(/```([\s\S]*?)```/);
    if (matchFence?.[1]) return JSON.parse(matchFence[1].trim());
  } catch {}

  try {
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch?.[0]) return JSON.parse(braceMatch[0]);
  } catch {}

  throw new Error('No valid JSON found in response');
}

/**
 * Call Gemini API (or return mock for testing)
 */
async function callGeminiOCR(imageBase64: string): Promise<{
  merchant?: string;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    categoryKey?: string;
  }>;
  total: number;
  tax: number;
  currency: string;
  transactionDate?: string;
  usageMetadata?: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
}> {
  if (MOCK_OCR) {
    // Return fixed fixture for testing
    await new Promise((r) => setTimeout(r, 100)); // Simulate latency
    return {
      merchant: 'Test Store',
      items: [
        {
          name: 'Test Item',
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          categoryKey: 'other',
        },
      ],
      total: 108,
      tax: 8,
      currency: 'JPY',
      transactionDate: '2026-01-18 12:34',
      usageMetadata: {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
      },
    };
  }

  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const categorySpec = `
categoryKey 必须从以下枚举中选择一个：
- fresh（生鲜：肉/鱼/蔬菜/水果/菌菇）
- staple（主食：米/面/面包/麦片/薯类）
- dairy_egg（乳制品/蛋）
- snack（零食/甜品/巧克力/饼干）
- drink（饮料：水/茶/咖啡/汽水/乳饮料）
- frozen_deli（冷冻/熟食/便当/炸物/加工品）
- seasoning（调味料/油/盐/酱/味噌等）
- household（日用品：纸品/清洁/洗护/杂货）
- alcohol（酒类）
- other（其它/无法判断）
只输出 JSON，不要解释。
  `.trim();

  const body = {
    contents: [
      {
        parts: [
          {
            text:
              '这是一张日本超市或便利店的小票照片。请识别并输出 JSON。\n' +
              '字段：merchant（可选）、items、total、tax、currency、transactionDate（可选）。\n' +
              'items 每项：name, quantity, unitPrice, lineTotal, categoryKey。\n' +
              categorySpec,
          },
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: imageBase64,
            },
          },
        ],
      },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fetchResponse = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!fetchResponse.ok) {
      if (fetchResponse.status === 429 || fetchResponse.status === 503) {
        throw new Error('UPSTREAM_ERROR: Rate limited or unavailable');
      }
      const errorText = await fetchResponse.text();
      throw new Error(`UPSTREAM_ERROR: ${fetchResponse.status} - ${errorText.substring(0, 200)}`);
    }

    const rawText = await fetchResponse.text();
    const data = JSON.parse(rawText);
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
      throw new Error('PARSE_ERROR: Invalid Gemini response structure');
    }

    const usageMetadata = data?.usageMetadata || null;
    const modelReplyText = parts
      .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
      .join('\n');

    if (!modelReplyText) {
      throw new Error('PARSE_ERROR: Gemini returned no text content');
    }

    const parsed = extractJsonFromText(modelReplyText);

    return {
      merchant: typeof parsed.merchant === 'string' ? parsed.merchant : undefined,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      tax: typeof parsed.tax === 'number' ? parsed.tax : 0,
      currency:
        typeof parsed.currency === 'string' && parsed.currency.trim()
          ? parsed.currency
          : 'JPY',
      transactionDate:
        typeof parsed.transactionDate === 'string' && parsed.transactionDate.trim()
          ? parsed.transactionDate.trim()
          : undefined,
      usageMetadata: {
        inputTokens: usageMetadata?.promptTokenCount || null,
        outputTokens: usageMetadata?.candidatesTokenCount || null,
        totalTokens: usageMetadata?.totalTokenCount || null,
      },
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('UPSTREAM_TIMEOUT: Request timeout');
    }
    throw error;
  }
}

/**
 * Convert legacy analysis format to new structured format
 */
function convertToStructuredResponse(
  analysis: Awaited<ReturnType<typeof callGeminiOCR>>
): response.SuccessResponse['data']['receipt'] {
  return {
    merchant: {
      value: analysis.merchant || '',
      confidence: analysis.merchant ? 0.9 : 0.0,
    },
    datetime: {
      value: analysis.transactionDate
        ? new Date(analysis.transactionDate).toISOString()
        : new Date().toISOString(),
      confidence: analysis.transactionDate ? 0.85 : 0.5,
    },
    total: {
      value: analysis.total,
      confidence: 0.93,
      currency: analysis.currency || 'JPY',
    },
    items: analysis.items.map((item) => ({
      name: { value: item.name, confidence: 0.81 },
      price: { value: item.unitPrice, confidence: 0.90 },
      quantity: { value: item.quantity, confidence: 0.60 },
      meta: {
        evidence: [`line:${item.lineTotal}`],
        warnings: [],
      },
    })),
    meta: {
      warnings: [],
      raw_text_included: false,
    },
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
    // Initialize Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('INTERNAL_ERROR: Supabase configuration missing');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
      },
    });

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
      log.logError(requestId, 'missing', idempotencyKey || 'missing', 'INVALID_INPUT', 400, latencyMs);
      return response.createHttpResponse(errorResp, 400);
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
      return response.createHttpResponse(errorResp, 400);
    }

    // Validate idempotency key format
    if (!idempotency.validateIdempotencyKey(idempotencyKey)) {
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        'INVALID_INPUT',
        'Invalid x-idempotency-key format (must be >= 32 chars, hex or base64url)'
      );
      log.logError(requestId, deviceId.substring(0, 8), idempotencyKey.substring(0, 8), 'INVALID_INPUT', 400, latencyMs);
      return response.createHttpResponse(errorResp, 400);
    }

    // Hash device ID
    deviceHash = await hashDeviceId(deviceId);

    // Check idempotency
    const existingRecord = await idempotency.getIdempotencyRecord(supabase, idempotencyKey);

    if (existingRecord) {
      // Check if expired
      if (idempotency.isExpired(existingRecord)) {
        // Expired, can proceed
      } else if (existingRecord.status === 'SUCCEEDED' || existingRecord.status === 'FAILED') {
        // Return cached result
        const latencyMs = Date.now() - startTime;
        log.logSuccess(requestId, deviceHash.substring(0, 8), idempotencyKey.substring(0, 8), existingRecord.http_status || 200, latencyMs);
        return response.createHttpResponse(
          existingRecord.response_json as response.OCRResponse,
          existingRecord.http_status || 200
        );
      } else if (existingRecord.status === 'IN_PROGRESS') {
        // Check if stale
        if (idempotency.isStale(existingRecord)) {
          // Stale, can retry
        } else {
          // Still in progress, return 202
          const latencyMs = Date.now() - startTime;
          const errorResp = response.createErrorResponse(
            requestId,
            idempotencyKey,
            'IN_PROGRESS',
            'Same request is being processed.',
            800 // retry after 800ms
          );
          log.logRequest({
            request_id: requestId,
            device_hash_prefix: deviceHash,
            idempotency_key_prefix: idempotencyKey,
            status: 'in_progress',
            http_status: 202,
            latency_ms: latencyMs,
            timestamp: new Date().toISOString(),
          });
          return response.createHttpResponse(errorResp, 202, 800);
        }
      }
    }

    // Check rate limit (before processing)
    const rateLimitResult = await ratelimit.checkRateLimit(supabase, deviceHash);

    if (!rateLimitResult.allowed) {
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        'RATE_LIMITED',
        'Too many requests.',
        rateLimitResult.retryAfterMs,
        {
          limit: rateLimitResult.limit,
          window: rateLimitResult.window,
          count: rateLimitResult.count,
        }
      );
      log.logRequest({
        request_id: requestId,
        device_hash_prefix: deviceHash,
        idempotency_key_prefix: idempotencyKey,
        status: 'rate_limited',
        http_status: 429,
        latency_ms: latencyMs,
        error_code: 'RATE_LIMITED',
        timestamp: new Date().toISOString(),
      });
      return response.createHttpResponse(errorResp, 429, rateLimitResult.retryAfterMs);
    }

    // Try to acquire processing lock
    const lockAcquired = await idempotency.acquireProcessingLock(supabase, idempotencyKey, deviceHash);

    if (!lockAcquired) {
      // Another request is processing, return 202
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        'IN_PROGRESS',
        'Same request is being processed.',
        800
      );
      log.logRequest({
        request_id: requestId,
        device_hash_prefix: deviceHash,
        idempotency_key_prefix: idempotencyKey,
        status: 'in_progress',
        http_status: 202,
        latency_ms: latencyMs,
        timestamp: new Date().toISOString(),
      });
      return response.createHttpResponse(errorResp, 202, 800);
    }

    // Parse request body
    let requestData: OCRRequest;
    try {
      requestData = await req.json();
    } catch (e) {
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
      return response.createHttpResponse(errorResp, 400);
    }

    // Validate input
    if (!requestData.imageBase64 || typeof requestData.imageBase64 !== 'string') {
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        'INVALID_INPUT',
        'Missing or invalid imageBase64'
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
      return response.createHttpResponse(errorResp, 400);
    }

    // Validate image size
    const estimatedSize = (requestData.imageBase64.length * 3) / 4;
    if (estimatedSize > MAX_IMAGE_SIZE_BYTES) {
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        'INVALID_INPUT',
        `Image too large (max ${Math.round(MAX_IMAGE_SIZE_BYTES / 1024)}KB)`
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
      return response.createHttpResponse(errorResp, 400);
    }

    // Validate mime type
    if (!['image/jpeg', 'image/png'].includes(requestData.mimeType || '')) {
      const latencyMs = Date.now() - startTime;
      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        'INVALID_INPUT',
        'Invalid mime type (must be image/jpeg or image/png)'
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
      return response.createHttpResponse(errorResp, 400);
    }

    // Call Gemini OCR
    let analysis: Awaited<ReturnType<typeof callGeminiOCR>>;
    try {
      analysis = await callGeminiOCR(requestData.imageBase64);
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      let errorCode: response.ErrorCode = 'INTERNAL_ERROR';
      let httpStatus = 500;

      if (error.message?.includes('UPSTREAM_TIMEOUT')) {
        errorCode = 'UPSTREAM_TIMEOUT';
        httpStatus = 504;
      } else if (error.message?.includes('UPSTREAM_ERROR')) {
        errorCode = 'UPSTREAM_ERROR';
        httpStatus = 502;
      } else if (error.message?.includes('PARSE_ERROR')) {
        errorCode = 'PARSE_ERROR';
        httpStatus = 500;
      }

      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        errorCode,
        error.message || 'Internal server error'
      );

      await idempotency.saveIdempotencyResult(
        supabase,
        idempotencyKey,
        'FAILED',
        httpStatus,
        errorResp,
        errorCode
      );

      log.logError(requestId, deviceHash.substring(0, 8), idempotencyKey.substring(0, 8), errorCode, httpStatus, latencyMs);
      return response.createHttpResponse(errorResp, httpStatus);
    }

    // Convert to structured format
    const receiptData = convertToStructuredResponse(analysis);
    const latencyMs = Date.now() - startTime;

    const successResp = response.createSuccessResponse(
      requestId,
      idempotencyKey,
      PARSER_VERSION,
      GEMINI_MODEL,
      latencyMs,
      receiptData
    );

    await idempotency.saveIdempotencyResult(
      supabase,
      idempotencyKey,
      'SUCCEEDED',
      200,
      successResp,
      undefined
    );

    log.logSuccess(requestId, deviceHash.substring(0, 8), idempotencyKey.substring(0, 8), 200, latencyMs);

    return response.createHttpResponse(successResp, 200);
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    const errorResp = response.createErrorResponse(
      requestId,
      idempotencyKey || 'unknown',
      'INTERNAL_ERROR',
      error.message || 'Internal server error'
    );

    log.logError(
      requestId,
      deviceHash ? deviceHash.substring(0, 8) : 'unknown',
      idempotencyKey ? idempotencyKey.substring(0, 8) : 'unknown',
      'INTERNAL_ERROR',
      500,
      latencyMs
    );

    return response.createHttpResponse(errorResp, 500);
  }
});
