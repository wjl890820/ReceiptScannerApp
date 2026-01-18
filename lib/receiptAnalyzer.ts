// lib/receiptAnalyzer.ts
import Constants from 'expo-constants';
import * as ImageManipulator from 'expo-image-manipulator';

const MODEL = 'gemini-2.0-flash';

function getGeminiApiKey(): string {
  try {
    // Safely access Constants with fallback
    const expoConfig = Constants?.expoConfig;
    const manifest = Constants?.manifest;
    
    // Expo SDK 49+ 推荐：Constants.expoConfig
    const fromExpoConfig =
      (expoConfig?.extra as any)?.geminiApiKey ??
      (expoConfig?.extra as any)?.GEMINI_API_KEY;

    // 兼容旧的 Expo Go：Constants.manifest
    const fromManifest =
      (manifest as any)?.extra?.geminiApiKey ??
      (manifest as any)?.extra?.GEMINI_API_KEY;

    const key = (fromExpoConfig ?? fromManifest ?? '').trim();
    return key;
  } catch (e) {
    console.error('[ReceiptAnalyzer] Failed to get Gemini API key from Constants:', e);
    return '';
  }
}

// 商品分类 key（用于统计）
export type CategoryKey =
  | 'fresh'
  | 'staple'
  | 'dairy_egg'
  | 'snack'
  | 'drink'
  | 'frozen_deli'
  | 'seasoning'
  | 'household'
  | 'alcohol'
  | 'other';

export type ReceiptItem = {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  categoryKey?: CategoryKey;
};

export type ReceiptAnalysis = {
  merchant?: string;
  items: ReceiptItem[];
  total: number;
  tax: number;
  currency: string;
};

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

  throw new Error('Gemini 返回内容中没有找到合法 JSON。');
}

/**
 * 压缩图片并获取 base64（JPEG）
 */
async function compressToJpegBase64(uri: string): Promise<string> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 1200 } }],
    {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    }
  );

  if (!result.base64) {
    throw new Error('图片压缩失败：未获取到 base64');
  }
  return result.base64;
}

export async function analyzeReceiptImage(uri: string): Promise<ReceiptAnalysis> {
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!GEMINI_API_KEY) {
    // 这里报错就说明：你的 app.config.js / .env 没有把 key 注入到 extra
    throw new Error('Gemini API Key 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  console.log(
    'KEY fingerprint:',
    GEMINI_API_KEY.slice(0, 6) + '...' + GEMINI_API_KEY.slice(-4),
    'len=' + GEMINI_API_KEY.length
  );

  const base64 = await compressToJpegBase64(uri);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  console.log('发送到 Gemini 的 URL:', url);

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
              '字段：merchant（可选）、items、total、tax、currency。\n' +
              'items 每项：name, quantity, unitPrice, lineTotal, categoryKey。\n' +
              categorySpec,
          },
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: base64,
            },
          },
        ],
      },
    ],
  };

  // 简单重试（降低 429/503 偶发）
  const maxRetry = 2;
  let lastText = '';
  let lastStatus = 0;

  for (let i = 0; i <= maxRetry; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    });

    lastStatus = res.status;
    const rawText = await res.text();
    lastText = rawText;

    console.log('Gemini 返回原始文本：', rawText);

    if (res.ok) {
      let modelReplyText = '';
      try {
        const data = JSON.parse(rawText);
        const parts = data?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          modelReplyText = parts
            .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
            .join('\n');
        }
      } catch (e) {
        console.error('解析 Gemini 外层 JSON 失败：', e);
        throw new Error('无法解析 Gemini 返回内容');
      }

      if (!modelReplyText) throw new Error('Gemini 没有返回可用文本内容');

      let parsed: any;
      try {
        parsed = extractJsonFromText(modelReplyText);
      } catch (e) {
        console.error('从文本中抽取 JSON 失败：', e, '原始文本：', modelReplyText);
        throw new Error('无法从 Gemini 返回内容中解析出票据 JSON');
      }

      const analysis: ReceiptAnalysis = {
        merchant: typeof parsed.merchant === 'string' ? parsed.merchant : undefined,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        total: typeof parsed.total === 'number' ? parsed.total : 0,
        tax: typeof parsed.tax === 'number' ? parsed.tax : 0,
        currency:
          typeof parsed.currency === 'string' && parsed.currency.trim()
            ? parsed.currency
            : '¥',
      };

      return analysis;
    }

    if ((res.status === 429 || res.status === 503) && i < maxRetry) {
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      continue;
    }

    throw new Error('识别失败：' + rawText);
  }

  throw new Error(`识别失败（HTTP ${lastStatus}）：${lastText}`);
}
