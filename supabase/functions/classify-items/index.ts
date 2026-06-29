// supabase/functions/classify-items/index.ts
// Batch AI fallback classification via Gemini API.
// One request per receipt: classify only the items the client couldn't resolve locally.
// Hard contract:
//   - categoryId is ALWAYS one of the new 8 product categories (else 'uncategorized').
//   - Always returns JSON (never bare 500 / HTML / non-JSON), HTTP 200 with success flag.
//   - Response: { success: true, results: [{ index, categoryId, confidence, reason }] }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const BUILD_ID = `${new Date().toISOString()}_${Math.random().toString(16).slice(2)}`;

const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 12000; // 12s for the single batched Gemini call
const MAX_ITEMS = 60; // safety cap per receipt
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';

// New 8-category taxonomy (must match lib/productCategory.ts ProductCategory).
const ALLOWED_CATEGORIES = [
  'food_ingredients',
  'ready_to_eat',
  'snacks_drinks',
  'household',
  'personal_care',
  'pet_care',
  'uncategorized',
  'other',
] as const;
type AllowedCategory = typeof ALLOWED_CATEGORIES[number];
const ALLOWED_SET = new Set<string>(ALLOWED_CATEGORIES as readonly string[]);

interface BatchItem {
  index: number;
  rawName: string;
  normalizedName?: string;
}

interface BatchRequest {
  items?: Array<{
    index?: number;
    rawName?: string;
    name?: string;
    normalizedName?: string;
  }>;
  merchantName?: string;
  locale?: string;
}

interface ItemResult {
  index: number;
  categoryId: AllowedCategory;
  confidence: number;
  reason: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, x-device-id, x-client, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** AI 正常运行但没有可用分类结果（合法成功响应）。 */
function okResults(results: ItemResult[]): { success: true; results: ItemResult[] } {
  return { success: true, results };
}

/**
 * 真实失败响应（body 解析失败 / 无 key / Gemini 失败 / 解析失败 / 兜底 catch）。
 * 始终 JSON，绝不裸 500 / HTML / 非 JSON。客户端据此 console.warn 并 no-op。
 */
function failureResponse(message: string, requestId: string, status = 502): Response {
  return jsonResponse(
    {
      success: false,
      error: {
        code: 'CLASSIFY_ITEMS_FAILED',
        message: message.slice(0, 300),
        requestId,
      },
    },
    status
  );
}

function generatePrompt(items: BatchItem[], merchantName: string | undefined, locale: string): string {
  const localeHint = locale === 'ja' ? 'Japanese' : locale === 'zh' ? 'Chinese' : 'English';
  const merchantHint = merchantName ? ` The store is "${merchantName}".` : '';

  const lines = items
    .map((it) => {
      const norm = it.normalizedName && it.normalizedName !== it.rawName ? ` (normalized: ${it.normalizedName})` : '';
      return `{"index": ${it.index}, "name": ${JSON.stringify(it.rawName)}${norm ? `, "normalized": ${JSON.stringify(it.normalizedName)}` : ''}}`;
    })
    .join('\n');

  return `You classify Japanese supermarket / convenience-store receipt items into EXACTLY ONE of these 8 categories:

- food_ingredients: raw ingredients to cook with (vegetables, fruits, meat, fish, eggs, milk, tofu, rice, noodles, seasonings, flour, dairy)
- ready_to_eat: prepared / ready meals (bento, onigiri, sandwiches, fried chicken, deli, instant ramen, frozen meals, buns)
- snacks_drinks: snacks, sweets, candy, chocolate, ice cream, and ALL drinks including tea/coffee/juice/soda/water/alcohol (also milk-tea / matcha-latte style sweet drinks)
- household: consumable household goods (tissue, detergent, trash bags, foil, wrap, batteries, sponges, cleaning)
- personal_care: hygiene / health / cosmetics (toothpaste, shampoo, skincare, masks, supplements, vitamins, medicine)
- pet_care: pet food and pet supplies
- other: clearly a real product but none of the above
- uncategorized: genuinely cannot tell from the name

Rules:
- Output ONLY these 8 keys. NEVER output legacy names like meat_seafood, snacks_sweets, prepared_food, beverages, snacks, ingredients, produce, dairy_eggs.
- "牛乳" (plain milk) is food_ingredients, but sweet-drink contexts like "ミルクティー / 抹茶ラテ / 金のミルク" are snacks_drinks.
- If unsure, use "uncategorized" with a low confidence.${merchantHint}
- Language of item names: ${localeHint}.

Items (one JSON object per line):
${lines}

Output ONLY a valid JSON object, no markdown, no code fences:
{
  "results": [
    { "index": <number matching input>, "categoryId": "<one of the 8 keys>", "confidence": <0.0-1.0>, "reason": "<short English>" }
  ]
}
Include exactly one result object per input item, preserving the input index.`;
}

async function callGemini(prompt: string, t0: number): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const modelName = Deno.env.get('GEMINI_MODEL') ?? GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    console.log(`[classify-items] t=${Date.now() - t0}ms gemini_status=${response.status}`);
    if (!response.ok) {
      const text = await response.text();
      console.warn(`[Gemini] status=${response.status} body=${text.slice(0, 500)}`);
      throw new Error(`Gemini API error: ${response.status}`);
    }
    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('Gemini returned no text content');
    }
    return parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error?.name === 'AbortError') throw new Error('Request timeout');
    throw error;
  }
}

function extractJsonFromText(text: string): any {
  try {
    return JSON.parse(text.trim());
  } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace?.[0]) {
    try {
      return JSON.parse(brace[0]);
    } catch {}
  }
  throw new Error('No valid JSON found in response');
}

/** Coerce an arbitrary AI category string to the allowed 8; unknown/legacy -> 'uncategorized'. */
function sanitizeCategory(raw: unknown): AllowedCategory {
  if (typeof raw !== 'string') return 'uncategorized';
  const v = raw.trim().toLowerCase();
  return ALLOWED_SET.has(v) ? (v as AllowedCategory) : 'uncategorized';
}

function clampConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function validateResults(parsed: any, validIndices: Set<number>): ItemResult[] {
  const arr = Array.isArray(parsed?.results) ? parsed.results : Array.isArray(parsed) ? parsed : [];
  const out: ItemResult[] = [];
  const seen = new Set<number>();
  for (const r of arr) {
    const index = Number(r?.index);
    if (!Number.isInteger(index) || !validIndices.has(index) || seen.has(index)) continue;
    seen.add(index);
    const categoryId = sanitizeCategory(r?.categoryId);
    const confidence = clampConfidence(r?.confidence);
    const reason = typeof r?.reason === 'string' ? r.reason.slice(0, 160) : 'batch';
    out.push({ index, categoryId, confidence, reason });
  }
  return out;
}

serve(async (req) => {
  console.log(`[classify-items] ENTRY build=${BUILD_ID}`);
  const t0 = Date.now();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const requestId = req.headers.get('x-request-id') || 'unknown';

  if (req.method !== 'POST') {
    return failureResponse('Method not allowed', requestId, 405);
  }

  try {
    let body: BatchRequest;
    try {
      body = (await req.json()) as BatchRequest;
    } catch (error: any) {
      // body 解析失败属于真实失败（但仍返回 JSON）。
      console.warn(`[${requestId}] invalid JSON body: ${error?.message}`);
      return failureResponse('Invalid JSON body', requestId, 400);
    }

    const rawItems = Array.isArray(body?.items) ? body.items : [];
    const items: BatchItem[] = [];
    for (const it of rawItems) {
      const rawName = (it?.rawName || it?.name || '').toString();
      if (!rawName.trim()) continue;
      const index = Number.isInteger(it?.index) ? (it!.index as number) : items.length;
      items.push({
        index,
        rawName: rawName.slice(0, 120),
        normalizedName: it?.normalizedName ? String(it.normalizedName).slice(0, 120) : undefined,
      });
      if (items.length >= MAX_ITEMS) break;
    }

    // 客户端没有 unknown items 时不会调用本函数；若真的发来空集，视为坏请求。
    if (items.length === 0) {
      console.warn(`[${requestId}] empty items`);
      return failureResponse('No classifiable items', requestId, 400);
    }

    if (!GEMINI_API_KEY) {
      console.warn(`[${requestId}] GEMINI_API_KEY not configured`);
      return failureResponse('GEMINI_API_KEY not configured', requestId, 502);
    }

    const locale = body?.locale || 'ja';
    const prompt = generatePrompt(items, body?.merchantName, locale);

    let geminiText: string;
    try {
      geminiText = await callGemini(prompt, t0);
    } catch (error: any) {
      console.warn(`[${requestId}] Gemini call failed: ${error?.message}`);
      return failureResponse(`Gemini call failed: ${error?.message || 'unknown'}`, requestId, 502);
    }

    let results: ItemResult[];
    try {
      const parsed = extractJsonFromText(geminiText);
      const validIndices = new Set(items.map((it) => it.index));
      results = validateResults(parsed, validIndices);
    } catch (error: any) {
      console.warn(`[${requestId}] parse/validate failed: ${error?.message}`);
      return failureResponse(`Parse/validate failed: ${error?.message || 'unknown'}`, requestId, 502);
    }

    // AI 正常返回（即便没有可用分类）→ success:true，results 可为空。
    console.log(`[classify-items] t=${Date.now() - t0}ms items=${items.length} results=${results.length}`);
    return jsonResponse(okResults(results), 200);
  } catch (error: any) {
    // 兜底：始终 JSON，绝不裸 500 / HTML。属真实失败 → success:false。
    console.error(`[${requestId}] Error: ${error?.message}`);
    return failureResponse(error?.message || 'Internal error', requestId, 500);
  }
});
