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
      kind?: 'item' | 'discount' | 'tax' | 'subtotal';
    }>;
    discounts?: Array<{ label: string; amount: number }>;
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

function buildOcrPrompt(): string {
  return [
    'あなたは日本のスーパー/コンビニのレシート画像を読み取る OCR パーサーです。',
    '出力は有効な JSON のみ。Markdown・コードフェンス・説明文は一切出力しないこと。',
    '',
    'スキーマ:',
    '{',
    '  "merchant": string|null,            // 店名（例: セブン-イレブン）',
    '  "transactionDate": string|null,     // 例 "YYYY/MM/DD HH:MM"（原文の形式のまま）',
    '  "total": number|null,               // 合計（整数 JPY）',
    '  "tax": number|null,                 // 消費税（整数 JPY、無ければ 0）',
    '  "currency": "JPY",',
    '  "items": [ {',
    '     "name": string, "quantity": number, "unitPrice": number, "lineTotal": number,',
    '     "categoryKey": string,            // 下記 enum のみ',
    '     "kind": "item"|"discount"|"tax"|"subtotal"',
    '  } ],',
    '  "discounts": [ { "label": string, "amount": number } ]   // amount は負数（例 -50）',
    '}',
    '',
    'ルール:',
    '- すべての金額は整数の JPY。小数や通貨記号（¥ 等）を付けない。',
    '- 値引・割引・クーポン・セール・ポイント利用 などの行は商品ではない。kind="discount" とし、discounts にも入れる（amount は負数）。',
    '- 消費税・小計・合計の行は商品 items に入れない（税額は tax、合計は total に入れる）。',
    '- 店舗の業態（コンビニ / スーパー / ドラッグストア / 非超市 等）を categoryKey に入れない。',
    '- categoryKey は次の固定 enum のみ: fresh, staple, dairy_egg, snack, drink, frozen_deli, seasoning, household, alcohol, other。',
    '- 分類が判別できない場合は categoryKey を "other" にする（新しい分類を作らない）。',
    '- 日本のコンビニ（セブン-イレブン / ファミリーマート / ローソン / ミニストップ）のレシートは、',
    '  「商品行 → 小計 → 値引 → 消費税(軽減税率含む) → 合計」の構造を優先して解釈する。',
    '- 店名が 7-Eleven / セブンイレブン / セブンーイレブン の場合は merchant を "セブン-イレブン" に正規化してよい。',
    '- レシート上に日時があれば transactionDate に原文の形式のまま入れる。',
  ].join('\n');
}

/**
 * 调用 Gemini 并返回纯文本（含 usage）。上游错误/超时附带明确 error.code。
 */
async function requestGeminiText(
  parts: any[]
): Promise<{ text: string; usage: any }> {
  const body = { contents: [{ parts }] };
  const maxRetry = 1;
  let lastError: any = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
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
        const e = new Error(`Gemini API error (${response.status})`) as Error & { code?: string };
        e.code = response.status === 429 ? 'RATE_LIMIT' : 'GEMINI_UPSTREAM_ERROR';
        throw e;
      }

      const rawText = await response.text();
      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        const e = new Error('Gemini outer JSON parse failed') as Error & { code?: string };
        e.code = 'GEMINI_UPSTREAM_ERROR';
        throw e;
      }
      const partsOut = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(partsOut)) {
        const e = new Error('Invalid Gemini response structure') as Error & { code?: string };
        e.code = 'GEMINI_UPSTREAM_ERROR';
        throw e;
      }
      const usage = data?.usageMetadata || null;
      const text = partsOut.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('\n');
      return { text, usage };
    } catch (error: any) {
      clearTimeout(timeoutId);
      lastError = error;
      if (error?.name === 'AbortError') {
        const e = new Error('Request timeout') as Error & { code?: string };
        e.code = 'OCR_TIMEOUT';
        throw e;
      }
      if (attempt < maxRetry && (error?.message?.includes('429') || error?.message?.includes('503'))) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Gemini API call failed');
}

async function callGemini(imageBase64: string): Promise<any> {
  if (!GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY not configured') as Error & { code?: string };
    e.code = 'SERVER_ERROR';
    throw e;
  }

  const { text: modelReplyText, usage } = await requestGeminiText([
    { text: buildOcrPrompt() },
    { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
  ]);

  if (!modelReplyText) {
    const e = new Error('Gemini returned no text content') as Error & { code?: string };
    e.code = 'OCR_PARSE_ERROR';
    throw e;
  }

  let parsed: any;
  try {
    parsed = extractJsonFromText(modelReplyText);
  } catch {
    // 目标七：JSON 不合法时做一次 repair retry，仍失败则返回 OCR_PARSE_ERROR（不裸奔 500）
    console.warn(
      `[ocr-receipt] JSON parse failed, attempting repair. raw(0..1000)=${modelReplyText.slice(0, 1000)}`
    );
    try {
      const { text: repairedText } = await requestGeminiText([
        {
          text:
            'あなたは JSON 修復器です。次の内容を、指定スキーマに従う有効な JSON のみに修正して出力してください。' +
            'Markdown や説明は出力しないこと。\n' +
            'スキーマ: {merchant, transactionDate, total, tax, currency, ' +
            'items:[{name,quantity,unitPrice,lineTotal,categoryKey,kind}], discounts:[{label,amount}]}\n\n' +
            '--- 元の内容 ---\n' +
            modelReplyText.slice(0, 6000),
        },
      ]);
      parsed = extractJsonFromText(repairedText);
    } catch {
      const e = new Error('No valid JSON found in response (after repair)') as Error & {
        code?: string;
      };
      e.code = 'OCR_PARSE_ERROR';
      throw e;
    }
  }

  const inputTokens = usage?.promptTokenCount || null;
  const outputTokens = usage?.candidatesTokenCount || null;
  const totalTokens = usage?.totalTokenCount || null;

  return {
    merchant: typeof parsed.merchant === 'string' ? parsed.merchant : undefined,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    discounts: Array.isArray(parsed.discounts) ? parsed.discounts : [],
    total: typeof parsed.total === 'number' ? parsed.total : 0,
    tax: typeof parsed.tax === 'number' ? parsed.tax : 0,
    currency:
      typeof parsed.currency === 'string' && parsed.currency.trim() ? parsed.currency : 'JPY',
    transactionDate:
      typeof parsed.transactionDate === 'string' && parsed.transactionDate.trim()
        ? parsed.transactionDate.trim()
        : undefined,
    _usageMetadata: {
      inputTokens,
      outputTokens,
      totalTokens,
    },
  };
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
  // 在外层声明，确保 catch 块也能安全访问（修复此前 catch 引用 try 内变量导致的 ReferenceError -> 裸 HTTP 500）
  let supabase: any = null;
  let payloadBytesForError = 0;

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
    supabase = createClient(supabaseUrl, supabaseServiceKey, {
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
      payloadBytesForError = payloadBytes;
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
    if (!['image/jpeg', 'image/png'].includes(requestData.mimeType as string)) {
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
    {
      console.log(`[${requestId}] Calling Gemini model=${GEMINI_MODEL}`);
      // callGemini 抛出的错误会带 code（GEMINI_UPSTREAM_ERROR / OCR_TIMEOUT / OCR_PARSE_ERROR / RATE_LIMIT），
      // 由外层 catch 统一映射为稳定 JSON。
      const geminiResult = await callGemini(requestData.imageBase64);
      analysis = {
        merchant: geminiResult.merchant,
        items: geminiResult.items,
        discounts: geminiResult.discounts,
        total: geminiResult.total,
        tax: geminiResult.tax,
        currency: geminiResult.currency,
        transactionDate: geminiResult.transactionDate,
      };
      usageMetadata = geminiResult._usageMetadata || null;
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
    const payloadBytes = payloadBytesForError;

    // Determine error code: prefer explicit code from callGemini, else infer from message
    let errorCode: string = typeof error?.code === 'string' && error.code ? error.code : 'SERVER_ERROR';
    if (errorCode === 'SERVER_ERROR') {
      const msg = String(error?.message || '');
      if (/rate limit/i.test(msg) || /429/.test(msg)) {
        errorCode = 'RATE_LIMIT';
      } else if (/too large|payload/i.test(msg)) {
        errorCode = 'PAYLOAD_TOO_LARGE';
      } else if (/timeout|aborted/i.test(msg)) {
        errorCode = 'OCR_TIMEOUT';
      } else if (/invalid input/i.test(msg)) {
        errorCode = 'INVALID_INPUT';
      } else if (/gemini api error|upstream/i.test(msg)) {
        errorCode = 'GEMINI_UPSTREAM_ERROR';
      } else if (/no valid json|parse/i.test(msg)) {
        errorCode = 'OCR_PARSE_ERROR';
      }
    }

    // HTTP 状态码：尽量与语义一致，但 body 始终是稳定 JSON（客户端不会再收到 HTML/text）
    const statusByCode: Record<string, number> = {
      RATE_LIMIT: 429,
      PAYLOAD_TOO_LARGE: 413,
      INVALID_INPUT: 400,
      OCR_TIMEOUT: 504,
      GEMINI_UPSTREAM_ERROR: 502,
      OCR_PARSE_ERROR: 502,
      SERVER_ERROR: 500,
    };
    const httpStatus = statusByCode[errorCode] ?? 500;

    // 清洗对外消息，避免泄漏内部细节
    const sanitizedMessage =
      errorCode === 'OCR_PARSE_ERROR'
        ? 'OCR 结果解析失败，请重试或更换更清晰的照片'
        : errorCode === 'GEMINI_UPSTREAM_ERROR'
          ? '识别服务暂时不可用，请稍后重试'
          : errorCode === 'OCR_TIMEOUT'
            ? '识别超时，请重试'
            : errorCode === 'RATE_LIMIT'
              ? `请求过于频繁，请稍后重试（每小时上限 ${OCR_RATE_LIMIT_PER_HOUR}）`
              : String(error?.message || 'Internal server error').slice(0, 200);

    console.error(
      `[${requestId}] Error:`,
      String(error?.message || error).slice(0, 300),
      `time=${responseTime}ms code=${errorCode} http=${httpStatus}`
    );

    // Record usage event for failed request (best-effort，绝不让记录失败再抛出)
    if (actorHash && supabase) {
      try {
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
      } catch (logErr) {
        console.error(`[${requestId}] Failed to record error usage event:`, logErr);
      }
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: errorCode,
          message: sanitizedMessage,
          requestId,
          model: GEMINI_MODEL,
        },
      }),
      {
        status: httpStatus,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
