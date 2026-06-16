// supabase/functions/ocr-receipt/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GEMINI_MODEL = Deno.env.get('OCR_GEMINI_MODEL') || 'gemini-3-flash-preview';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Configuration from secrets (set in Supabase dashboard)
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';
const OCR_RATE_LIMIT_PER_HOUR = parseInt(Deno.env.get('OCR_RATE_LIMIT_PER_HOUR') || '30', 10);
const OCR_CACHE_TTL_DAYS = parseInt(Deno.env.get('OCR_CACHE_TTL_DAYS') || '30', 10);
const MAX_IMAGE_SIZE_BYTES = 2.5 * 1024 * 1024; // 2.5MB decoded
const REQUEST_TIMEOUT_MS = 25000; // 25 seconds

// Cost tracking configuration
const GEMINI_PRICE_INPUT_PER_1K = parseFloat(Deno.env.get('GEMINI_PRICE_INPUT_PER_1K') || '0.0'); // USD per 1K input tokens
const GEMINI_PRICE_OUTPUT_PER_1K = parseFloat(Deno.env.get('GEMINI_PRICE_OUTPUT_PER_1K') || '0.0'); // USD per 1K output tokens
const SERVER_SALT = Deno.env.get('SERVER_SALT') || ''; // Salt for hashing actor IDs (privacy)

// Log OCR model at cold start (no secrets)
console.log(`[ocr-receipt] boot model=${GEMINI_MODEL}`);

interface OCRRequest {
  imageBase64?: string;
  mimeType?: 'image/jpeg' | 'image/png';
  deviceId?: string;
  appVersion?: string;
  platform?: string;
  language?: string;
  ping?: boolean;
  clientReceiptId?: string; // Optional client-side receipt ID for debugging (non-sensitive)
}

interface OCRResponse {
  success: boolean;
  analysis?: {
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
  };
  cached?: boolean;
  hash?: string;
  error?: {
    code: string;
    message: string;
  };
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id',
};

async function computeSHA256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash actor ID for privacy-preserving tracking
 * Returns SHA256(actorId + SERVER_SALT)
 */
async function hashActorId(actorId: string): Promise<string> {
  if (!SERVER_SALT) {
    console.warn('SERVER_SALT not configured, using plain hash (less secure)');
  }
  const combined = `${actorId}${SERVER_SALT}`;
  return computeSHA256(combined);
}

/**
 * Calculate estimated cost in USD based on token usage
 */
function calculateCost(inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null && outputTokens === null) return null;
  if (GEMINI_PRICE_INPUT_PER_1K === 0 && GEMINI_PRICE_OUTPUT_PER_1K === 0) return null;

  const inputCost = inputTokens ? (inputTokens / 1000) * GEMINI_PRICE_INPUT_PER_1K : 0;
  const outputCost = outputTokens ? (outputTokens / 1000) * GEMINI_PRICE_OUTPUT_PER_1K : 0;
  return inputCost + outputCost;
}

/**
 * Record OCR usage event (for cost tracking and abuse prevention)
 * Privacy: Only stores metrics, NO images, NO receipt content
 */
async function recordUsageEvent(
  supabase: any,
  params: {
    requestId: string;
    actorType: 'anon' | 'user';
    actorHash: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    estimatedCostUsd: number | null;
    payloadBytes: number;
    durationMs: number;
    success: boolean;
    errorCode: string | null;
    edgeRegion?: string;
  }
): Promise<void> {
  try {
    await supabase.from('ocr_usage_events').insert({
      request_id: params.requestId,
      actor_type: params.actorType,
      actor_hash: params.actorHash,
      model: params.model,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      total_tokens: params.totalTokens,
      estimated_cost_usd: params.estimatedCostUsd,
      payload_bytes: params.payloadBytes,
      duration_ms: params.durationMs,
      success: params.success,
      error_code: params.errorCode,
      edge_region: params.edgeRegion || null,
    });
  } catch (e) {
    // Non-fatal: log but don't fail the request
    console.error(`[${params.requestId}] Failed to record usage event:`, e);
  }
}

async function checkCache(
  supabase: any,
  imageHash: string
): Promise<{ cached: boolean; analysis?: any }> {
  try {
    const { data, error } = await supabase
      .from('ocr_cache')
      .select('analysis_json, created_at')
      .eq('hash', imageHash)
      .single();

    if (error || !data) {
      return { cached: false };
    }

    // Check TTL
    const createdAt = new Date(data.created_at).getTime();
    const now = Date.now();
    const ttlMs = OCR_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

    if (now - createdAt > ttlMs) {
      // Expired, delete and return not cached
      await supabase.from('ocr_cache').delete().eq('hash', imageHash);
      return { cached: false };
    }

    // Update last_access_at
    await supabase
      .from('ocr_cache')
      .update({ last_access_at: new Date().toISOString() })
      .eq('hash', imageHash);

    return { cached: true, analysis: JSON.parse(data.analysis_json) };
  } catch (e) {
    console.error('Cache check error:', e);
    return { cached: false };
  }
}

async function saveToCache(
  supabase: any,
  imageHash: string,
  analysis: any,
  deviceId: string
): Promise<void> {
  try {
    await supabase.from('ocr_cache').upsert({
      hash: imageHash,
      analysis_json: JSON.stringify(analysis),
      device_id: deviceId,
      created_at: new Date().toISOString(),
      last_access_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Cache save error:', e);
    // Non-fatal, continue
  }
}

async function checkRateLimit(supabase: any, deviceId: string): Promise<boolean> {
  try {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // Clean old entries
    await supabase
      .from('ocr_rate_limit')
      .delete()
      .lt('window_start', new Date(oneHourAgo).toISOString());

    // Count requests in current hour
    const { data, error } = await supabase
      .from('ocr_rate_limit')
      .select('count')
      .eq('device_id', deviceId)
      .gte('window_start', new Date(oneHourAgo).toISOString())
      .single();

    const currentCount = data?.count || 0;

    if (currentCount >= OCR_RATE_LIMIT_PER_HOUR) {
      return false; // Rate limited
    }

    // Increment counter
    const windowStart = new Date(Math.floor(now / (60 * 60 * 1000)) * 60 * 60 * 1000);
    await supabase.from('ocr_rate_limit').upsert({
      device_id: deviceId,
      window_start: windowStart.toISOString(),
      count: currentCount + 1,
    });

    return true;
  } catch (e) {
    console.error('Rate limit check error:', e);
    // On error, allow request (fail open for availability)
    return true;
  }
}

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

async function callGemini(imageBase64: string): Promise<any> {
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
              '字段：merchant（可选）、items、total、tax、currency、transactionDate（可选，收据上的交易日期时间，格式如 YYYY/MM/DD HH:MM 或 YYYY-MM-DD HH:MM）。\n' +
              'items 每项：name, quantity, unitPrice, lineTotal, categoryKey。\n' +
              '如果收据上有日期时间信息，请在 transactionDate 字段中提取（保持原始格式）。\n' +
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

  // Retry logic with timeout
  const maxRetry = 1;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[Gemini] Upstream non-OK status=${response.status} model=${GEMINI_MODEL} body=${errorText.substring(0, 500)}`
        );
        if ((response.status === 429 || response.status === 503) && attempt < maxRetry) {
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
          continue;
        }
        throw new Error(`Gemini API error (${response.status}): ${errorText.substring(0, 200)}`);
      }

      const rawText = await response.text();
      const data = JSON.parse(rawText);
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) {
        throw new Error('Invalid Gemini response structure');
      }

      // Extract usage metadata if available
      const usageMetadata = data?.usageMetadata || null;
      const inputTokens = usageMetadata?.promptTokenCount || null;
      const outputTokens = usageMetadata?.candidatesTokenCount || null;
      const totalTokens = usageMetadata?.totalTokenCount || null;

      const modelReplyText = parts
        .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
        .join('\n');

      if (!modelReplyText) {
        throw new Error('Gemini returned no text content');
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
        // Include usage metadata for cost tracking
        _usageMetadata: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
      };
    } catch (error: any) {
      lastError = error;
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      if (attempt < maxRetry && (error.message?.includes('429') || error.message?.includes('503'))) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Gemini API call failed');
}

/**
 * Check if a token is a JWT (has 3 parts separated by dots)
 */
function isJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * Parse authorization header and extract bearer token
 */
function parseAuthHeader(authHeader: string | null): string {
  if (!authHeader) return '';
  const lower = authHeader.toLowerCase();
  if (lower.startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  let actorType: 'anon' | 'user' = 'anon';
  let actorHash = '';
  let actorId = '';

  try {
    // Initialize Supabase configuration
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase configuration missing');
    }

    // Parse headers
    const authHeader = req.headers.get('authorization') ?? '';
    const bearer = parseAuthHeader(authHeader);
    const apiKey = req.headers.get('apikey') ?? '';
    const deviceIdHeader = req.headers.get('x-device-id') ?? '';

    // Get anon key from env or fallback to apikey header
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || apiKey;

    // Determine authentication mode
    let userId: string | null = null;
    let deviceId: string = '';

    // If bearer token is a JWT, try to resolve user
    if (bearer && isJwt(bearer)) {
      try {
        // Create client with anon key but use bearer token for auth
        const authClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: {
            persistSession: false,
          },
          global: {
            headers: {
              Authorization: `Bearer ${bearer}`,
            },
          },
        });

        const { data: { user }, error: authError } = await authClient.auth.getUser(bearer);
        if (!authError && user) {
          userId = user.id;
          deviceId = user.id; // Use user ID as device ID for logged-in users
          actorType = 'user';
          actorId = user.id;
        }
      } catch (e) {
        // If JWT validation fails, don't throw - just proceed as anonymous
        console.log(`[${requestId}] JWT validation failed, proceeding as anonymous:`, e);
      }
    }

    // For anonymous users, require device ID from header
    if (!userId) {
      if (!deviceIdHeader) {
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'OCR_DEVICE_ID_REQUIRED',
              message: 'x-device-id header is required for anonymous requests',
            },
          } as OCRResponse),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
      deviceId = deviceIdHeader;
      actorType = 'anon';
      actorId = deviceIdHeader;
    }

    // Hash actor ID for privacy-preserving tracking
    actorHash = await hashActorId(actorId);

    // Create admin client with service role for DB operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
      },
    });

    // Parse request body
    let requestData: OCRRequest;
    try {
      requestData = await req.json();
    } catch (e) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Invalid JSON in request body' },
        } as OCRResponse),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Minimal request receipt log (no image content)
    try {
      const payloadBytes = requestData?.imageBase64
        ? Math.round((requestData.imageBase64.length * 3) / 4)
        : 0;
      console.log(
        `[${requestId}] Received OCR request: method=${req.method} actorType=${actorType} payloadBytes=${payloadBytes} model=${GEMINI_MODEL}`
      );
    } catch {
      // ignore logging failures
    }

    // Handle ping request (fast path for deployment validation)
    if (requestData.ping === true) {
      return new Response(
        JSON.stringify({
          ok: true,
          mode: userId ? 'user' : 'anon',
          userId: userId || null,
          deviceId: deviceId.substring(0, 8),
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate input
    if (!requestData.imageBase64 || typeof requestData.imageBase64 !== 'string') {
      const responseTime = Date.now() - startTime;
      await recordUsageEvent(supabase, {
        requestId,
        actorType,
        actorHash,
        model: GEMINI_MODEL,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
        payloadBytes: 0,
        durationMs: responseTime,
        success: false,
        errorCode: 'INVALID_INPUT',
        edgeRegion: Deno.env.get('EDGE_REGION') || undefined,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Missing or invalid imageBase64' },
        } as OCRResponse),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate image size (approximate - base64 is ~33% larger than binary)
    const estimatedSize = (requestData.imageBase64.length * 3) / 4;
    if (estimatedSize > MAX_IMAGE_SIZE_BYTES) {
      const responseTime = Date.now() - startTime;
      await recordUsageEvent(supabase, {
        requestId,
        actorType,
        actorHash,
        model: GEMINI_MODEL,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
        payloadBytes: Math.round(estimatedSize),
        durationMs: responseTime,
        success: false,
        errorCode: 'PAYLOAD_TOO_LARGE',
        edgeRegion: Deno.env.get('EDGE_REGION') || undefined,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Image too large (max ${Math.round(MAX_IMAGE_SIZE_BYTES / 1024)}KB)`,
          },
        } as OCRResponse),
        {
          status: 413,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate mime type
    if (!['image/jpeg', 'image/png'].includes(requestData.mimeType)) {
      const responseTime = Date.now() - startTime;
      const payloadBytes = Math.round((requestData.imageBase64.length * 3) / 4);
      await recordUsageEvent(supabase, {
        requestId,
        actorType,
        actorHash,
        model: GEMINI_MODEL,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
        payloadBytes,
        durationMs: responseTime,
        success: false,
        errorCode: 'INVALID_INPUT',
        edgeRegion: Deno.env.get('EDGE_REGION') || undefined,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Invalid mime type' },
        } as OCRResponse),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Compute image hash
    const imageHash = await computeSHA256(requestData.imageBase64);
    const hashPrefix = imageHash.substring(0, 8);

    // Check rate limit
    const rateLimitOk = await checkRateLimit(supabase, deviceId);
    if (!rateLimitOk) {
      const responseTime = Date.now() - startTime;
      const payloadBytes = Math.round((requestData.imageBase64.length * 3) / 4);
      
      console.log(`[${requestId}] Rate limited: deviceId=${deviceId.substring(0, 8)} userId=${userId || 'none'}`);

      // Record usage event for rate-limited request
      await recordUsageEvent(supabase, {
        requestId,
        actorType,
        actorHash,
        model: GEMINI_MODEL,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
        payloadBytes,
        durationMs: responseTime,
        success: false,
        errorCode: 'RATE_LIMIT',
        edgeRegion: Deno.env.get('EDGE_REGION') || undefined,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'RATE_LIMIT',
            message: `Rate limit exceeded (max ${OCR_RATE_LIMIT_PER_HOUR} per hour)`,
          },
        } as OCRResponse),
        {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Check cache
    const cacheResult = await checkCache(supabase, imageHash);
    if (cacheResult.cached && cacheResult.analysis) {
      const responseTime = Date.now() - startTime;
      const payloadBytes = Math.round((requestData.imageBase64.length * 3) / 4);
      
      console.log(
        `[${requestId}] Cache hit: deviceId=${deviceId.substring(0, 8)} userId=${userId || 'none'} hash=${hashPrefix} time=${responseTime}ms`
      );

      // Record usage event for cache hit (no tokens, but still track request)
      await recordUsageEvent(supabase, {
        requestId,
        actorType,
        actorHash,
        model: GEMINI_MODEL,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null, // Cache hit = no cost
        payloadBytes,
        durationMs: responseTime,
        success: true,
        errorCode: null,
        edgeRegion: Deno.env.get('EDGE_REGION') || undefined,
      });

      return new Response(
        JSON.stringify({
          success: true,
          analysis: cacheResult.analysis,
          cached: true,
          hash: imageHash,
        } as OCRResponse),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Call Gemini
    let analysis: any;
    let usageMetadata: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null = null;
    let geminiError: Error | null = null;

    try {
      console.log(`[${requestId}] Calling Gemini model=${GEMINI_MODEL}`);
      const geminiResult = await callGemini(requestData.imageBase64);
      analysis = {
        merchant: geminiResult.merchant,
        items: geminiResult.items,
        total: geminiResult.total,
        tax: geminiResult.tax,
        currency: geminiResult.currency,
        transactionDate: geminiResult.transactionDate,
      };
      usageMetadata = geminiResult._usageMetadata || null;
    } catch (error: any) {
      geminiError = error;
      throw error; // Re-throw to be caught by outer catch
    }

    // Save to cache
    await saveToCache(supabase, imageHash, analysis, deviceId);

    const responseTime = Date.now() - startTime;
    const payloadBytes = Math.round((requestData.imageBase64.length * 3) / 4);
    
    // Calculate cost
    const inputTokens = usageMetadata?.inputTokens || null;
    const outputTokens = usageMetadata?.outputTokens || null;
    const totalTokens = usageMetadata?.totalTokens || null;
    const estimatedCostUsd = calculateCost(inputTokens, outputTokens);

    console.log(
      `[${requestId}] Cache miss: deviceId=${deviceId.substring(0, 8)} userId=${userId || 'none'} hash=${hashPrefix} time=${responseTime}ms tokens=${totalTokens || 'N/A'} cost=$${estimatedCostUsd?.toFixed(6) || 'N/A'}`
    );

    // Record usage event for successful OCR
    await recordUsageEvent(supabase, {
      requestId,
      actorType,
      actorHash,
      model: GEMINI_MODEL,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd,
      payloadBytes,
      durationMs: responseTime,
      success: true,
      errorCode: null,
      edgeRegion: Deno.env.get('EDGE_REGION') || undefined,
    });

    return new Response(
      JSON.stringify({
        success: true,
        analysis,
        cached: false,
        hash: imageHash,
      } as OCRResponse),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    const responseTime = Date.now() - startTime;
    const payloadBytes = requestData?.imageBase64 ? Math.round((requestData.imageBase64.length * 3) / 4) : 0;
    
    // Determine error code
    let errorCode: string | null = 'SERVER_ERROR';
    if (error.message?.includes('Rate limit')) {
      errorCode = 'RATE_LIMIT';
    } else if (error.message?.includes('too large') || error.message?.includes('PAYLOAD')) {
      errorCode = 'PAYLOAD_TOO_LARGE';
    } else if (error.message?.includes('timeout')) {
      errorCode = 'TIMEOUT';
    } else if (error.message?.includes('Invalid input')) {
      errorCode = 'INVALID_INPUT';
    }

    console.error(`[${requestId}] Error:`, error.message, `time=${responseTime}ms code=${errorCode}`);

    // Record usage event for failed request
    if (actorHash) {
      await recordUsageEvent(supabase, {
        requestId,
        actorType,
        actorHash,
        model: GEMINI_MODEL,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
        payloadBytes,
        durationMs: responseTime,
        success: false,
        errorCode,
        edgeRegion: Deno.env.get('EDGE_REGION') || undefined,
      });
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: errorCode || 'SERVER_ERROR',
          message: error.message || 'Internal server error',
        },
      } as OCRResponse),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
