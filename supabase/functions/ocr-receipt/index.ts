// supabase/functions/ocr-receipt/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GEMINI_MODEL = Deno.env.get('OCR_GEMINI_MODEL') || 'gemini-3-flash-preview';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Configuration from secrets (set in Supabase dashboard)
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';
const OCR_RATE_LIMIT_PER_HOUR = parseInt(Deno.env.get('OCR_RATE_LIMIT_PER_HOUR') || '30', 10);
const OCR_CACHE_TTL_DAYS = parseInt(Deno.env.get('OCR_CACHE_TTL_DAYS') || '30', 10);
/** Bump when OCR prompt / parser semantics change so stale cached totals cannot be reused. */
const OCR_CACHE_VERSION = 6;
const MAX_IMAGE_SIZE_BYTES = 2.5 * 1024 * 1024; // 2.5MB decoded
const REQUEST_TIMEOUT_MS = 25000; // 25 seconds

// Cost tracking configuration
const GEMINI_PRICE_INPUT_PER_1K = parseFloat(Deno.env.get('GEMINI_PRICE_INPUT_PER_1K') || '0.0'); // USD per 1K input tokens
const GEMINI_PRICE_OUTPUT_PER_1K = parseFloat(Deno.env.get('GEMINI_PRICE_OUTPUT_PER_1K') || '0.0'); // USD per 1K output tokens
const SERVER_SALT = Deno.env.get('SERVER_SALT') || ''; // Salt for hashing actor IDs (privacy)

// Log OCR model at cold start (no secrets)
console.log(`[ocr-receipt] boot model=${GEMINI_MODEL} cacheVersion=${OCR_CACHE_VERSION}`);

/** Cache lookup key: prompt/parser version + image content hash (not image hash alone). */
function buildOcrCacheKey(imageContentHash: string): string {
  return `v${OCR_CACHE_VERSION}:${imageContentHash}`;
}

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
    '  "total": number|null,               // 印刷された最終支払合計（整数 JPY）。自己計算しない',
    '  "tax": number|null,                 // 印刷された消費税額（整数 JPY）。無ければ null（0 で埋めない）',
    '  "taxBreakdown": [ { "rate": number, "amount": number } ]|null, // 8%/10% 等の内訳があれば amount を転記',
    '  "currency": "JPY",',
    '  "items": [ {',
    '     "name": string, "quantity": number, "unitPrice": number, "lineTotal": number,',
    '     "categoryKey": string,            // 下記 enum のみ（参考用。最終分類はクライアントが決定）',
    '     "kind": "item"|"discount"|"tax"|"subtotal"',
    '  } ],',
    '  "discounts": [ { "label": string, "amount": number } ]   // amount は負数（例 -50）',
    '}',
    '',
    'ルール:',
    '- すべての金額は整数の JPY。小数や通貨記号（¥ 等）を付けない。',
    '- 値引・割引・クーポン・セール・ポイント利用 などの行は商品ではない。kind="discount"。amount は負数。',
    '  【商品直下の値引・印刷順を保持】商品行の直後に印刷された商品値引は、items 配列内に kind="discount" の負数行として、',
    '  印刷された順序のまま残すこと。クライアントが直前商品へ割当する（adjacent index は計算しない）。',
    '  対象ラベル例: 値引 / 割引 / 10%割引 / 割引 10% / 20%割引 / 割引 20% / 50%割引 / 割引 50% / ○%引 / 値下 / 値下げ。',
    '  例: {name:"鶏肉",lineTotal:372} の次に {name:"割引 10%",lineTotal:-38,kind:"discount"}。',
    '  同じ文言・同じ金額の値引が2行印刷されていれば items にも2行残す（1行にまとめない）。',
    '  これらの直近商品値引は discounts[] に重複して入れない（未紐付けの discounts[] だけだと割当できない）。',
    '  まとめ売り値引 / まとめ値引 は従来どおり discounts に入れるだけでなく、items にも kind="discount" の負数行として残す',
    '  （直前商品への割当に必要）。組価格（例: 2個¥203）が印刷されていれば label か隣接行名に残す。',
    '  Costco の CPN 等、どの商品に付くか不明なレシート全体クーポンは discounts[] のみ（items に商品として入れない）。',
    '- 消費税・小計・合計の行は商品 items に入れない（税額は tax、合計は total に入れる）。',
    '  ただし Costco の「御買上げ点数」行は items に残してよい（合計金額ではない）。',
    '- quantity は「購入点数」のみ。商品名中の包装数（例: 4個 / 10PC / 3PK）は quantity に入れない（購入証拠が無い限り 1）。',
    '  明示的な購入数量（例: (¥108 × 3個) や数量欄）があるときだけその N を quantity にする。',
    '',
    '【total / tax の厳守ルール】',
    '- total は、レシート上に明確に印刷された最終支払合計行を優先してそのまま転記すること。',
    '  例ラベル: 合計 / お買上計 / お買上げ計 / 支払合計 / 合計金額。',
    '- 最終合計（final printed total）が印刷されている場合、その金額を必ず total に入れる。',
    '  items / 小計 / tax / discounts から total を再計算・再構成してはならない。',
    '- 支払手段の金額は total ではない。現金 / クレジット / プリカ / リワード / クオ・カード支払 /',
    '  電子マネー などは tender（支払内訳）であり、分割払いの一部でも total に選ばない。',
    '  例: お買上計 18229・プリカ/リワード 7002・現金 11227 → total=18229（11227 は禁止）。',
    '- クオ・カード預り / 残高 / お釣り も total ではない。支払額と合計が一致しても、',
    '  total は「合計」行を優先（例: 合計 814・クオ支払 814 → total=814）。',
    '- ヘッダーが欠けて WHOLESALE / BIZ/GOLD だけ読める Costco レシートは、merchant を',
    '  「コストコ」または "WHOLESALE BIZ/GOLD" の両方を含む文字列にしてよい（WHOLESALE 単独不可）。',
    '- tax は印刷された消費税額を転記する。total に税を足し直してはならない。',
    '- 税率から税額を推算しない。tax が読めない場合は null（0 で埋めない）。',
    '- 【重要】課税対象額 / 対象額 / 税抜対象額 / 「税率10%対象 ¥N」は税額ではない。',
    '  これらを tax や taxBreakdown[].amount に入れない（N は taxable base）。',
    '- taxBreakdown[].amount には実際の税額のみ（消費税 / 消費税等 / 外税額 / 内消費税等 / 税額）。',
    '  例: 8%税額72・10%対象額3・合計985 → tax=72, taxBreakdown=[{rate:8,amount:72}]（amount:3 は禁止）。',
    '- 内税の「（内消費税等 8%）¥129」なども含め、印刷された税額は必ず tax に入れる（null にしない）。',
    '- 8%/10% の税額内訳が印刷されていれば taxBreakdown[].amount に転記し、tax にはその合計を入れてよい。',
    '- 日本のレシートは内税（total に税込み）でも外税（小計+税=合計が印刷）でもよい。',
    '  どちらの場合も、印刷された最終合計があれば total はその金額であり、税を二重加算しない。',
    '- 例（内税・正しい）: 合計 8351・消費税 619 → total=8351, tax=619。total=8970（8351+619）は禁止。',
    '- 例（外税・正しい）: 小計 2442・税 195・合計 2637 → total=2637, tax=195。',
    '- 「買上点数 / お買上点数 / 御買上げ点数」は商品ではない（summary metadata）。items に入れない。',
    '- 直近の商品値引は上述のとおり items(kind=discount) に印刷順で残し、discounts[] へ重複させない。',
    '  まとめ売り値引は discounts と items(kind=discount) の両方。曖昧な全体クーポンは discounts[] のみ。',
    '  印刷された最終合計がある限り、items±discounts+tax で total を上書きしない。',
    '',
    '- 商品分類(categoryKey)は次の固定 enum のみから選ぶ:',
    '  food_ingredients(食材), ready_to_eat(弁当・惣菜・即食), snacks_drinks(飲料・お菓子・酒),',
    '  household(日用消耗品), uncategorized(不明), other(その他)。',
    '- personal_care / pet_care は出力しない（V1 非アクティブ）。該当しそうでも household か uncategorized。',
    '- 判別できない場合は "uncategorized" を返す（"other" を多用しない、新しい分類を作らない）。',
    '- 中文/日本語などの分類名は返さない（必ず上記の英語 enum キーのみ）。',
    '- 店舗の業態（コンビニ / スーパー / ドラッグストア / 非超市 / store / merchant 等）を商品分類に入れない。',
    '- 商品分類はあくまで参考。最終的な分類はクライアント側のローカル分類器が決定する。',
    '- 日本のコンビニ（セブン-イレブン / ファミリーマート / ローソン / ミニストップ）のレシートは、',
    '  「商品行 → 小計 → 値引 → 消費税(軽減税率含む) → 合計」の構造を優先して解釈する。',
    '- 店名が 7-Eleven / セブンイレブン / セブンーイレブン の場合は merchant を "セブン-イレブン" に正規化してよい。',
    '- イオンは店名を短くしない（例: イオン古川店 はそのまま）。',
    '- レシート上に日時があれば transactionDate に原文の形式のまま入れる。',
  ].join('\n');
}

/**
 * 调用 Gemini 并返回纯文本（含 usage）。上游错误/超时附带明确 error.code。
 */
async function requestGeminiText(
  parts: any[]
): Promise<{ text: string; usage: any }> {
  // Low temperature for structured OCR extraction (not guaranteed absolute determinism).
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
    },
  };
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
            'Markdown や説明は出力しないこと。' +
            'total は印刷された最終合計の転記であり、items/小計/tax/discounts から再計算しないこと。' +
            '印刷済み total に tax を足し直さないこと。\n' +
            'スキーマ: {merchant, transactionDate, total, tax, currency, ' +
            'items:[{name,quantity,unitPrice,lineTotal,categoryKey,kind}], discounts:[{label,amount}]}。' +
            '商品直下の値引（割引 10% 等）は印刷順で items に kind=discount 負数行として残し、discounts に重複させない。' +
            'Costco CPN 等の全体クーポンは discounts のみ。まとめ売り値引は両方。\n\n' +
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
    // Prefer explicit number (including 0 only when model sent 0); otherwise null.
    tax: typeof parsed.tax === 'number' && Number.isFinite(parsed.tax) ? parsed.tax : null,
    taxBreakdown: Array.isArray(parsed.taxBreakdown) ? parsed.taxBreakdown : undefined,
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

    // Compute image content hash, then versioned cache key (invalidates old prompt results).
    const imageContentHash = await computeSHA256(requestData.imageBase64);
    const cacheKey = buildOcrCacheKey(imageContentHash);
    const hashPrefix = imageContentHash.substring(0, 8);

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
    const cacheResult = await checkCache(supabase, cacheKey);
    if (cacheResult.cached && cacheResult.analysis) {
      const responseTime = Date.now() - startTime;
      const payloadBytes = Math.round((requestData.imageBase64.length * 3) / 4);
      
      console.log(
        `[${requestId}] Cache hit: deviceId=${deviceId.substring(0, 8)} userId=${userId || 'none'} hash=${hashPrefix} cacheKeyPrefix=v${OCR_CACHE_VERSION} time=${responseTime}ms`
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
          hash: imageContentHash,
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
        taxBreakdown: geminiResult.taxBreakdown,
        currency: geminiResult.currency,
        transactionDate: geminiResult.transactionDate,
      };
      usageMetadata = geminiResult._usageMetadata || null;
    }

    // Save to cache
    await saveToCache(supabase, cacheKey, analysis, deviceId);

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
        hash: imageContentHash,
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
