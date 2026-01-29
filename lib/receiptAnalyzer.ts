// lib/receiptAnalyzer.ts
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { getDeviceId } from './deviceId';
import { getCurrentLocale } from './i18n';
import {
  getSupabaseUrl,
  getSupabaseAnonKey,
  getGeminiApiKey,
  isDevDirectGeminiEnabled,
} from './env';

const MODEL = 'gemini-2.0-flash';

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
  transactionDate?: string; // ISO string or date string from receipt
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

/**
 * 调用 Supabase Edge Function 进行 OCR 识别
 */
async function analyzeReceiptImageViaEdgeFunction(
  uri: string,
  functionName: 'ocr-receipt' | 'ocr'
): Promise<ReceiptAnalysis> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  if (!supabaseUrl) {
    throw new Error('Supabase URL 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  if (!supabaseAnonKey) {
    throw new Error('Supabase Anon Key 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  // 压缩并编码图片
  const base64 = await compressToJpegBase64(uri);

  // 获取设备 ID
  const deviceId = await getDeviceId();

  // 获取应用元数据
  const appVersion = Constants.expoConfig?.version || '1.0.0';
  const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
  const language = getCurrentLocale();

  // 准备请求
  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/${functionName}`;
  
  if (__DEV__) {
    console.log(`[ReceiptAnalyzer] Calling Edge Function: ${functionName}`);
  }

  const requestBody = {
    imageBase64: base64,
    mimeType: 'image/jpeg' as const,
    deviceId,
    appVersion,
    platform,
    language,
  };

  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseAnonKey}`,
      apikey: supabaseAnonKey,
      'x-device-id': deviceId,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  let responseData: any;

  try {
    responseData = JSON.parse(responseText);
  } catch (e) {
    throw new Error(`服务器返回无效 JSON (HTTP ${response.status}): ${responseText.substring(0, 200)}`);
  }

  if (!response.ok) {
    // 404 表示 function 不存在，可以尝试 fallback
    if (response.status === 404) {
      throw new Error('FUNCTION_NOT_FOUND');
    }
    
    // 其他错误：包含 status 和 body snippet
    const errorSnippet = responseText.substring(0, 200);
    throw new Error(`Edge Function 请求失败 (HTTP ${response.status}): ${errorSnippet}`);
  }

  if (!responseData.success) {
    const errorMessage = responseData?.error?.message || 'OCR 识别失败';
    throw new Error(`OCR 识别失败: ${errorMessage}`);
  }

  const analysis = responseData.analysis;
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('服务器返回的分析结果格式无效');
  }

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[OCR] datetime candidates:', {
      transactionDate: analysis?.transactionDate,
      transactionAt: (analysis as any)?.transactionAt,
      purchasedAt: (analysis as any)?.purchasedAt,
      datetime: (analysis as any)?.datetime,
      date: (analysis as any)?.date,
      time: (analysis as any)?.time,
    });
  }

  // 交易时间：OCR 可能返回 transactionDate / transactionAt / purchasedAt / datetime
  const txDateStr =
    (typeof analysis.transactionDate === 'string' && analysis.transactionDate.trim()) ||
    (typeof (analysis as any).transactionAt === 'string' && (analysis as any).transactionAt.trim()) ||
    (typeof (analysis as any).purchasedAt === 'string' && (analysis as any).purchasedAt.trim()) ||
    (typeof (analysis as any).datetime === 'string' && (analysis as any).datetime.trim()) ||
    undefined;

  // 转换为 ReceiptAnalysis 格式
  const receiptAnalysis: ReceiptAnalysis = {
    merchant: typeof analysis.merchant === 'string' ? analysis.merchant : undefined,
    items: Array.isArray(analysis.items) ? analysis.items : [],
    total: typeof analysis.total === 'number' ? analysis.total : 0,
    tax: typeof analysis.tax === 'number' ? analysis.tax : 0,
    currency:
      typeof analysis.currency === 'string' && analysis.currency.trim()
        ? analysis.currency
        : '¥',
    transactionDate: txDateStr || undefined,
  };

  return receiptAnalysis;
}

/**
 * 直连 Gemini API（仅用于开发调试）
 */
async function analyzeReceiptImageDirectGemini(uri: string): Promise<ReceiptAnalysis> {
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!GEMINI_API_KEY) {
    throw new Error('开发模式直连 Gemini 需要设置 DEV_DIRECT_GEMINI=true 并配置 GEMINI_API_KEY');
  }

  console.log(
    '[ReceiptAnalyzer] [DEV] Using direct Gemini API (fallback mode)',
    'KEY fingerprint:',
    GEMINI_API_KEY.slice(0, 6) + '...' + GEMINI_API_KEY.slice(-4),
    'len=' + GEMINI_API_KEY.length
  );

  const base64 = await compressToJpegBase64(uri);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  console.log('[ReceiptAnalyzer] [DEV] 发送到 Gemini 的 URL:', url);

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

    console.log('[ReceiptAnalyzer] [DEV] Gemini 返回原始文本：', rawText);

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
        console.error('[ReceiptAnalyzer] [DEV] 解析 Gemini 外层 JSON 失败：', e);
        throw new Error('无法解析 Gemini 返回内容');
      }

      if (!modelReplyText) throw new Error('Gemini 没有返回可用文本内容');

      let parsed: any;
      try {
        parsed = extractJsonFromText(modelReplyText);
      } catch (e) {
        console.error('[ReceiptAnalyzer] [DEV] 从文本中抽取 JSON 失败：', e, '原始文本：', modelReplyText);
        throw new Error('无法从 Gemini 返回内容中解析出票据 JSON');
      }

      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[OCR] datetime candidates (Direct Gemini):', {
          transactionDate: parsed?.transactionDate,
          transactionAt: parsed?.transactionAt,
          purchasedAt: parsed?.purchasedAt,
          datetime: parsed?.datetime,
          date: parsed?.date,
          time: parsed?.time,
        });
      }

      // 交易时间：直连 Gemini 可能返回 transactionDate / transactionAt / purchasedAt / datetime
        const txDateStr =
          (typeof parsed.transactionDate === 'string' && parsed.transactionDate.trim()) ||
          (typeof parsed.transactionAt === 'string' && parsed.transactionAt?.trim()) ||
          (typeof parsed.purchasedAt === 'string' && parsed.purchasedAt?.trim()) ||
          (typeof parsed.datetime === 'string' && parsed.datetime?.trim()) ||
          undefined;

        const analysis: ReceiptAnalysis = {
          merchant: typeof parsed.merchant === 'string' ? parsed.merchant : undefined,
          items: Array.isArray(parsed.items) ? parsed.items : [],
          total: typeof parsed.total === 'number' ? parsed.total : 0,
          tax: typeof parsed.tax === 'number' ? parsed.tax : 0,
          currency:
            typeof parsed.currency === 'string' && parsed.currency.trim()
              ? parsed.currency
              : '¥',
          transactionDate: txDateStr || undefined,
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

export async function analyzeReceiptImage(uri: string): Promise<ReceiptAnalysis> {
  // 检查是否启用开发模式直连 Gemini fallback
  const useDirectGemini = isDevDirectGeminiEnabled();
  
  if (useDirectGemini) {
    // 开发调试模式：直连 Gemini
    try {
      return await analyzeReceiptImageDirectGemini(uri);
    } catch (error: any) {
      console.warn('[ReceiptAnalyzer] [DEV] Direct Gemini fallback failed:', error.message);
      // fallback 失败时，继续尝试 Edge Function
    }
  }

  // 主路径：调用 Supabase Edge Function
  // 优先尝试 ocr-receipt，如果 404 则回退到 ocr
  try {
    return await analyzeReceiptImageViaEdgeFunction(uri, 'ocr-receipt');
  } catch (error: any) {
    // 如果是 404（function 不存在），尝试回退到 ocr
    if (error.message === 'FUNCTION_NOT_FOUND') {
      console.log('[ReceiptAnalyzer] ocr-receipt not found, falling back to ocr');
      try {
        return await analyzeReceiptImageViaEdgeFunction(uri, 'ocr');
      } catch (fallbackError: any) {
        throw new Error(`Edge Function 调用失败（ocr-receipt 404，ocr 也失败）: ${fallbackError.message}`);
      }
    }
    
    // 其他错误直接抛出
    throw error;
  }
}
