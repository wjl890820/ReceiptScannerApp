// lib/receiptAnalyzer.ts
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { getDeviceId } from './deviceId';
import { getCurrentLocale } from './i18n';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import type { ProductCategory } from './productCategory';
import {
  getSupabaseUrl,
  getSupabaseAnonKey,
  getGeminiApiKey,
  getOcrGeminiModel,
  isDevDirectGeminiEnabled,
} from './env';

const DEFAULT_OCR_MODEL = 'gemini-3-flash-preview';

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
  /** Gross merchandise line amount (before product-level coupon). */
  lineTotal: number;
  // OCR 既可能给旧枚举 CategoryKey，也可能给新一级分类（ProductCategory），
  // 统一在 normalize 阶段保留、在 enricher 通过 normalizeProductCategory 归一。
  categoryKey?: CategoryKey | ProductCategory;
  /** Paid/net line amount after bound product coupons (optional additive). */
  effectiveLineTotal?: number;
  /** Sum of negative coupon amounts bound to this line. */
  discountAllocated?: number;
};

export type ReceiptAnalysis = {
  merchant?: string;
  items: ReceiptItem[];
  total: number;
  /** Printed tax amount; null when OCR provided no tax evidence. */
  tax: number | null;
  currency: string;
  transactionDate?: string; // ISO string or date string from receipt
  /** Optional 8%/10% printed breakdown — used only when top-level tax is missing. */
  taxBreakdown?: Array<{ rate?: number; amount?: number; tax?: number; taxAmount?: number }>;
  /** Set by normalize / review: whether `tax` is known printed evidence. */
  tax_is_known?: boolean;
  /** 可选：模型/OCR 侧原始文本，供审核页展示（有则填，无则省略） */
  ocr_raw_text?: string;
  /** Optional OCR-edge discount lines (merged again in normalize). */
  discounts?: Array<{ label: string; amount: number }>;
};

type ScanTrace = { id: string; t0: number };
function nowMs(): number {
  return Date.now();
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
  functionName: 'ocr-receipt' | 'ocr',
  trace?: ScanTrace
): Promise<ReceiptAnalysis> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  if (!supabaseUrl) {
    throw new Error('Supabase URL 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  if (!supabaseAnonKey) {
    throw new Error('Supabase Anon Key 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  // 1) 图片读取/预处理
  const tPre0 = nowMs();
  const base64 = await compressToJpegBase64(uri);
  const tPre1 = nowMs();
  if (__DEV__ && trace) {
    // eslint-disable-next-line no-console
    console.log('[ScanTiming] image_preprocess_ms', { id: trace.id, ms: tPre1 - tPre0 });
  }

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

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${supabaseAnonKey}`,
    apikey: supabaseAnonKey,
    'x-device-id': deviceId,
  } as const;

  // 2) OCR 请求发出前
  const tOcr0 = nowMs();
  if (__DEV__ && trace) {
    // eslint-disable-next-line no-console
    console.log('[ScanTiming] ocr_request_prepare', { id: trace.id });
  }

  if (__DEV__) {
    const payloadBytes = Math.round((requestBody.imageBase64.length * 3) / 4);
    console.log('[ReceiptAnalyzer][OCR] Request -> Edge', {
      url: edgeFunctionUrl,
      method: 'POST',
      headers: {
        'Content-Type': headers['Content-Type'],
        Authorization: headers.Authorization ? `Bearer <redacted:${headers.Authorization.length}>` : '',
        apikey: headers.apikey ? `<redacted:${headers.apikey.length}>` : '',
        'x-device-id': headers['x-device-id'] ? `${headers['x-device-id'].slice(0, 8)}...` : '',
      },
      body: {
        mimeType: requestBody.mimeType,
        deviceIdPrefix: requestBody.deviceId ? `${requestBody.deviceId.slice(0, 8)}...` : '',
        appVersion: requestBody.appVersion,
        platform: requestBody.platform,
        language: requestBody.language,
        imageBytesApprox: payloadBytes,
      },
    });
  }

  let response: Response;
  try {
    response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
  } catch (e: any) {
    if (__DEV__) {
      console.error('[ReceiptAnalyzer][OCR] Network error calling Edge', {
        url: edgeFunctionUrl,
        method: 'POST',
        message: e?.message || String(e),
      });
    }
    throw e;
  }

  // 3) OCR Edge Function 返回后
  const tOcr1 = nowMs();
  if (__DEV__ && trace) {
    // eslint-disable-next-line no-console
    console.log('[ScanTiming] ocr_edge_roundtrip_ms', { id: trace.id, ms: tOcr1 - tOcr0, status: response.status });
  }

  const responseText = await response.text();
  let responseData: any;

  // 4) OCR 结果解析完成
  const tParse0 = nowMs();
  try {
    responseData = JSON.parse(responseText);
  } catch (e) {
    throw new Error(`服务器返回无效 JSON (HTTP ${response.status}): ${responseText.substring(0, 200)}`);
  }
  const tParse1 = nowMs();
  if (__DEV__ && trace) {
    // eslint-disable-next-line no-console
    console.log('[ScanTiming] ocr_parse_ms', { id: trace.id, ms: tParse1 - tParse0 });
  }

  if (__DEV__) {
    console.log('[ReceiptAnalyzer][OCR] Response <- Edge', {
      url: edgeFunctionUrl,
      status: response.status,
      ok: response.ok,
      bodySnippet: responseText.substring(0, 200),
    });
  }

  if (!response.ok) {
    // 404 表示 function 不存在，可以尝试 fallback
    if (response.status === 404) {
      throw new Error('FUNCTION_NOT_FOUND');
    }

    // Edge Function 即使非 2xx 也返回稳定 JSON（含 error.code）；优先透传 code 给上层映射
    const errCode =
      typeof responseData?.error?.code === 'string' ? responseData.error.code : 'SERVER_ERROR';
    const errMsg = responseData?.error?.message || responseText.substring(0, 200);
    const e = new Error(`Edge Function 请求失败 (HTTP ${response.status}): ${errMsg}`) as Error & {
      code?: string;
    };
    e.code = errCode;
    throw e;
  }

  if (!responseData.success) {
    // Edge Function 始终返回稳定 JSON（含 error.code），把 code 透传给上层用于映射用户友好提示
    const errCode = typeof responseData?.error?.code === 'string' ? responseData.error.code : 'OCR_FAILED';
    const errorMessage = responseData?.error?.message || 'OCR 识别失败';
    const e = new Error(`OCR 识别失败: ${errorMessage}`) as Error & { code?: string };
    e.code = errCode;
    throw e;
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
    tax: typeof analysis.tax === 'number' && Number.isFinite(analysis.tax) ? analysis.tax : null,
    taxBreakdown: Array.isArray(analysis.taxBreakdown) ? analysis.taxBreakdown : undefined,
    currency:
      typeof analysis.currency === 'string' && analysis.currency.trim()
        ? analysis.currency
        : '¥',
    transactionDate: txDateStr || undefined,
    discounts: Array.isArray(analysis.discounts) ? analysis.discounts : undefined,
  };

  // 确定性后处理：剔除折扣/税/小计行、清洗分类、归一化店铺名、金额对账
  return normalizeOcrAnalysis(receiptAnalysis);
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

  const model = getOcrGeminiModel() || DEFAULT_OCR_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
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

        const rawSnippet =
          modelReplyText.length > 80000 ? modelReplyText.slice(0, 80000) + '\n…(truncated)' : modelReplyText;
        const analysis: ReceiptAnalysis = {
          merchant: typeof parsed.merchant === 'string' ? parsed.merchant : undefined,
          items: Array.isArray(parsed.items) ? parsed.items : [],
          total: typeof parsed.total === 'number' ? parsed.total : 0,
          tax: typeof parsed.tax === 'number' && Number.isFinite(parsed.tax) ? parsed.tax : null,
          taxBreakdown: Array.isArray(parsed.taxBreakdown) ? parsed.taxBreakdown : undefined,
          currency:
            typeof parsed.currency === 'string' && parsed.currency.trim()
              ? parsed.currency
              : '¥',
          transactionDate: txDateStr || undefined,
          ocr_raw_text: rawSnippet,
        };

        return normalizeOcrAnalysis(analysis);
    }

    if ((res.status === 429 || res.status === 503) && i < maxRetry) {
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      continue;
    }

    throw new Error('识别失败：' + rawText);
  }

  throw new Error(`识别失败（HTTP ${lastStatus}）：${lastText}`);
}

export async function analyzeReceiptImage(uri: string, trace?: ScanTrace): Promise<ReceiptAnalysis> {
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
    return await analyzeReceiptImageViaEdgeFunction(uri, 'ocr-receipt', trace);
  } catch (error: any) {
    // 如果是 404（function 不存在），尝试回退到 ocr
    if (error.message === 'FUNCTION_NOT_FOUND') {
      console.log('[ReceiptAnalyzer] ocr-receipt not found, falling back to ocr');
      try {
        return await analyzeReceiptImageViaEdgeFunction(uri, 'ocr', trace);
      } catch (fallbackError: any) {
        throw new Error(`Edge Function 调用失败（ocr-receipt 404，ocr 也失败）: ${fallbackError.message}`);
      }
    }
    
    // 其他错误直接抛出
    throw error;
  }
}
