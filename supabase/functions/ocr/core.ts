// supabase/functions/ocr/core.ts
// Core OCR processing logic (idempotency, rate limiting, OCR call, response construction)
// This module is testable without HTTP handler concerns

import * as log from './_shared/log.ts';
import * as response from './_shared/response.ts';
import * as idempotency from './_shared/idempotency.ts';
import * as ratelimit from './_shared/ratelimit.ts';

const GEMINI_MODEL = Deno.env.get('OCR_GEMINI_MODEL') || 'gemini-3.5-flash-lite';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const PARSER_VERSION = '2026-01-18';
const MAX_IMAGE_SIZE_BYTES = 2.5 * 1024 * 1024; // 2.5MB decoded

// Log OCR model at cold start (no secrets)
console.log(`[ocr] boot model=${GEMINI_MODEL}`);

export interface OCRRequest {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png';
}

// Supabase client type - using unknown to avoid type complexity while maintaining type safety
type SupabaseClient = unknown;

export interface OCRContext {
  requestId: string;
  deviceId: string;
  deviceHash: string;
  idempotencyKey: string;
  supabase: SupabaseClient;
  startTime: number;
  serverSalt: string;
  geminiApiKey?: string;
  requestTimeoutMs: number;
  mockOcr?: boolean;
}

export interface OCRUpstream {
  call(imageBase64: string, mimeType: 'image/jpeg' | 'image/png'): Promise<{
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
  }>;
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
export function hashDeviceId(deviceId: string, serverSalt: string): Promise<string> {
  const combined = `${deviceId}${serverSalt}`;
  return computeSHA256(combined);
}

/**
 * Extract JSON from Gemini response text
 */
function extractJsonFromText(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Ignore parse error, try next method
  }

  try {
    const matchJson = text.match(/```json([\s\S]*?)```/i);
    if (matchJson?.[1]) return JSON.parse(matchJson[1].trim()) as Record<string, unknown>;
  } catch {
    // Ignore parse error, try next method
  }

  try {
    const matchFence = text.match(/```([\s\S]*?)```/);
    if (matchFence?.[1]) return JSON.parse(matchFence[1].trim()) as Record<string, unknown>;
  } catch {
    // Ignore parse error, try next method
  }

  try {
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch?.[0]) return JSON.parse(braceMatch[0]) as Record<string, unknown>;
  } catch {
    // Ignore parse error
  }

  throw new Error('No valid JSON found in response');
}

/**
 * Default Gemini OCR upstream implementation
 */
export class DefaultOCRUpstream implements OCRUpstream {
  constructor(
    private geminiApiKey: string,
    private requestTimeoutMs: number,
    private mockOcr: boolean = false
  ) {}

  async call(imageBase64: string, mimeType: 'image/jpeg' | 'image/png'): Promise<{
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
    if (this.mockOcr) {
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

    if (!this.geminiApiKey) {
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
                mime_type: mimeType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const fetchResponse = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': this.geminiApiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text();
        console.error(
          `[Gemini] Upstream non-OK status=${fetchResponse.status} model=${GEMINI_MODEL} body=${errorText.substring(0, 500)}`
        );
        if (fetchResponse.status === 429 || fetchResponse.status === 503) {
          throw new Error('UPSTREAM_ERROR: Rate limited or unavailable');
        }
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
        .map((p: { text?: string }) => (typeof p.text === 'string' ? p.text : ''))
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
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('UPSTREAM_TIMEOUT: Request timeout');
      }
      throw error;
    }
  }
}

/**
 * Convert legacy analysis format to new structured format
 */
function convertToStructuredResponse(
  analysis: Awaited<ReturnType<OCRUpstream['call']>>
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

/**
 * Validate OCR request
 */
export function validateOCRRequest(request: OCRRequest): { valid: boolean; error?: string } {
  if (!request.imageBase64 || typeof request.imageBase64 !== 'string') {
    return { valid: false, error: 'Missing or invalid imageBase64' };
  }

  // Validate image size
  const estimatedSize = (request.imageBase64.length * 3) / 4;
  if (estimatedSize > MAX_IMAGE_SIZE_BYTES) {
    return {
      valid: false,
      error: `Image too large (max ${Math.round(MAX_IMAGE_SIZE_BYTES / 1024)}KB)`,
    };
  }

  // Validate mime type
  if (!['image/jpeg', 'image/png'].includes(request.mimeType || '')) {
    return { valid: false, error: 'Invalid mime type (must be image/jpeg or image/png)' };
  }

  return { valid: true };
}

/**
 * Core OCR processing function
 * This is the main business logic that can be tested independently
 */
export async function processOCRRequest(
  ctx: OCRContext,
  request: OCRRequest,
  upstream: OCRUpstream
): Promise<{ response: response.OCRResponse; httpStatus: number }> {
  const { requestId, deviceHash, idempotencyKey, supabase, startTime } = ctx;

  // Validate idempotency key format
  if (!idempotency.validateIdempotencyKey(idempotencyKey)) {
    const latencyMs = Date.now() - startTime;
    const errorResp = response.createErrorResponse(
      requestId,
      idempotencyKey,
      'INVALID_INPUT',
      'Invalid x-idempotency-key format (must be >= 32 chars, hex or base64url)'
    );
    log.logError(requestId, deviceHash.substring(0, 8), idempotencyKey.substring(0, 8), 'INVALID_INPUT', 400, latencyMs);
    return { response: errorResp, httpStatus: 400 };
  }

  // Validate request
  const validation = validateOCRRequest(request);
  if (!validation.valid) {
    const latencyMs = Date.now() - startTime;
    const errorResp = response.createErrorResponse(
      requestId,
      idempotencyKey,
      'INVALID_INPUT',
      validation.error || 'Invalid input'
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
    return { response: errorResp, httpStatus: 400 };
  }

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
      return {
        response: existingRecord.response_json as response.OCRResponse,
        httpStatus: existingRecord.http_status || 200,
      };
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
          device_hash_prefix: deviceHash.substring(0, 8),
          idempotency_key_prefix: idempotencyKey.substring(0, 8),
          status: 'in_progress',
          http_status: 202,
          latency_ms: latencyMs,
          timestamp: new Date().toISOString(),
        });
        return { response: errorResp, httpStatus: 202 };
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
      device_hash_prefix: deviceHash.substring(0, 8),
      idempotency_key_prefix: idempotencyKey.substring(0, 8),
      status: 'rate_limited',
      http_status: 429,
      latency_ms: latencyMs,
      error_code: 'RATE_LIMITED',
      timestamp: new Date().toISOString(),
    });
    return { response: errorResp, httpStatus: 429 };
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
        device_hash_prefix: deviceHash.substring(0, 8),
        idempotency_key_prefix: idempotencyKey.substring(0, 8),
        status: 'in_progress',
        http_status: 202,
        latency_ms: latencyMs,
        timestamp: new Date().toISOString(),
      });
    return { response: errorResp, httpStatus: 202 };
  }

  // Call OCR upstream
  let analysis: Awaited<ReturnType<OCRUpstream['call']>>;
  try {
    analysis = await upstream.call(request.imageBase64, request.mimeType);
    } catch (error: unknown) {
      const latencyMs = Date.now() - startTime;
      let errorCode: response.ErrorCode = 'INTERNAL_ERROR';
      let httpStatus = 500;
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';

      if (errorMessage.includes('UPSTREAM_TIMEOUT')) {
        errorCode = 'UPSTREAM_TIMEOUT';
        httpStatus = 504;
      } else if (errorMessage.includes('UPSTREAM_ERROR')) {
        errorCode = 'UPSTREAM_ERROR';
        httpStatus = 502;
      } else if (errorMessage.includes('PARSE_ERROR')) {
        errorCode = 'PARSE_ERROR';
        httpStatus = 500;
      }

      const errorResp = response.createErrorResponse(
        requestId,
        idempotencyKey,
        errorCode,
        errorMessage
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
    return { response: errorResp, httpStatus };
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

  return { response: successResp, httpStatus: 200 };
}
