// supabase/functions/classify-item/index.ts
// AI fallback classification via Gemini API
// Returns: { success: true, categoryId, confidence, reason }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// 可配置的 Gemini 模型（默认使用稳定的可用模型）
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 5000; // 5 seconds

// Get GEMINI_API_KEY from Supabase secrets
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';

// Category whitelist (must match lib/categories.ts)
const ALLOWED_CATEGORIES = [
  'produce',
  'meat_seafood',
  'dairy_eggs',
  'bakery',
  'staples',
  'snacks_sweets',
  'quick_meals',
  'condiments',
  'non_alcoholic_drinks',
  'alcohol',
  'household',
  'frozen_foods',
  'canned_preserved',
  'beverages_other',
  'health_supplements',
  'other_grocery',
  'uncategorized',
] as const;

type AllowedCategory = typeof ALLOWED_CATEGORIES[number];

interface ClassifyRequest {
  rawName: string;
  normalizedName?: string;
  merchantName?: string;
  price?: number;
  locale?: string;
  deviceId?: string;
  appVersion?: string;
  platform?: string;
}

interface ClassifyResponse {
  success: true;
  categoryId: string;
  confidence: number;
  reason: string;
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-device-id, x-client, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Generate prompt for Gemini to classify item
 */
function generatePrompt(
  rawName: string,
  normalizedName: string,
  merchantName?: string,
  price?: number,
  locale?: string
): string {
  const localeHint = locale === 'ja' ? 'Japanese' : locale === 'zh' ? 'Chinese' : 'English';
  const merchantHint = merchantName ? ` at ${merchantName}` : '';
  const priceHint = price ? ` (price: ${price})` : '';

  return `You are a grocery item classifier. Classify the following item into one of these categories:

${ALLOWED_CATEGORIES.map((cat) => `- ${cat}`).join('\n')}

Item name: ${rawName}${normalizedName && normalizedName !== rawName ? ` (normalized: ${normalizedName})` : ''}${merchantHint}${priceHint}
Language: ${localeHint}

Output ONLY a valid JSON object with these exact fields:
{
  "categoryId": "one of the allowed categories above",
  "confidence": 0.0 to 1.0 (how confident you are),
  "reason": "brief explanation in English"
}

Do NOT include markdown, do NOT include explanations outside JSON, do NOT include code fences. Only output the JSON object.`;
}

/**
 * Call Gemini API with timeout
 * 使用 v1beta generateContent API，URL 使用 query param key
 */
async function callGemini(prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // 按 v1beta 的 generateContent 正确拼 URL（使用 query param key）
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      // 错误日志增强（但不泄露 key）：打印 status + response.text() 截断 500 字符
      console.warn(`[Gemini] status=${response.status} body=${text.slice(0, 500)}`);
      throw new Error(`Gemini API error: ${response.status} ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('Gemini returned no text content');
    }

    return parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

/**
 * Extract JSON from text (handles markdown code fences)
 */
function extractJsonFromText(text: string): any {
  // Try direct JSON parse first
  try {
    return JSON.parse(text.trim());
  } catch {}

  // Try extracting from markdown code fences
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch?.[1]) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {}
  }

  // Try finding JSON object in text
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch?.[0]) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {}
  }

  throw new Error('No valid JSON found in response');
}

/**
 * Validate and sanitize classification result
 */
function validateClassification(result: any): ClassifyResponse | null {
  // Must have categoryId
  if (!result.categoryId || typeof result.categoryId !== 'string') {
    return null;
  }

  // categoryId must be in whitelist
  if (!ALLOWED_CATEGORIES.includes(result.categoryId as AllowedCategory)) {
    return null;
  }

  // confidence must be valid number between 0 and 1
  const confidence = typeof result.confidence === 'number' ? result.confidence : parseFloat(result.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }

  // reason is optional but should be string
  const reason = typeof result.reason === 'string' ? result.reason : 'classified';

  return {
    success: true,
    categoryId: result.categoryId,
    confidence,
    reason: reason.substring(0, 200), // Limit reason length
  };
}

/**
 * Fallback response (when AI fails or validation fails)
 */
function createFallbackResponse(): ClassifyResponse {
  return {
    success: true,
    categoryId: 'other_grocery',
    confidence: 0.0,
    reason: 'fallback',
  };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const requestId = req.headers.get('x-request-id') || 'unknown';
  const deviceId = req.headers.get('x-device-id') || 'unknown';

  try {
    // Parse request body
    const body: ClassifyRequest = await req.json();

    // 输入校验：rawName/normalizedName
    // 如果 rawName 缺失，直接返回 fallback（success:true, categoryId:other_grocery, confidence:0）
    if (!body.rawName && !body.normalizedName) {
      console.warn(`[${requestId}] Missing rawName/normalizedName, returning fallback`);
      return new Response(
        JSON.stringify(createFallbackResponse()),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const rawName = body.rawName || body.normalizedName || '';
    const normalizedName = body.normalizedName || body.rawName || '';
    const merchantName = body.merchantName;
    const price = body.price;
    const locale = body.locale || 'en';

    // Check GEMINI_API_KEY
    if (!GEMINI_API_KEY) {
      console.error(`[${requestId}] GEMINI_API_KEY not configured`);
      return new Response(
        JSON.stringify(createFallbackResponse()),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generate prompt
    const prompt = generatePrompt(rawName, normalizedName, merchantName, price, locale);

    // Call Gemini
    let geminiText: string;
    try {
      geminiText = await callGemini(prompt);
    } catch (error: any) {
      console.warn(`[${requestId}] Gemini call failed:`, error.message);
      return new Response(
        JSON.stringify(createFallbackResponse()),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract and validate JSON
    let classification: ClassifyResponse | null = null;
    try {
      const parsed = extractJsonFromText(geminiText);
      classification = validateClassification(parsed);
    } catch (error: any) {
      console.warn(`[${requestId}] JSON extraction/validation failed:`, error.message);
    }

    // Use classification or fallback
    const result = classification || createFallbackResponse();

    // Log (only in DEV or for debugging)
    if (Deno.env.get('ENVIRONMENT') === 'development' || requestId !== 'unknown') {
      console.log(`[${requestId}] Classified: ${rawName} -> ${result.categoryId} (confidence: ${result.confidence})`);
    }

    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error(`[${requestId}] Error:`, error.message);
    // Always return success: true with fallback (don't break App logic)
    return new Response(
      JSON.stringify(createFallbackResponse()),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
