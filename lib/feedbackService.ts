// lib/feedbackService.ts
// Submit feedback via Supabase Edge Function

import { getSupabaseUrl, getSupabaseAnonKey } from './env';
import { getDeviceId } from './deviceId';
import { getCurrentLocale } from './i18n';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { listReceipts } from './db';

export type FeedbackPayload = {
  message: string; // Required: feedback content
  email?: string; // Optional: contact email
  locale?: string;
  appVersion?: string;
  platform?: string;
  deviceId?: string;
  receiptId?: string | null; // Optional: most recent receipt ID if available
};

/**
 * Submit feedback to Supabase Edge Function
 * POST {SUPABASE_URL}/functions/v1/send-feedback
 */
export async function submitFeedback(payload: FeedbackPayload): Promise<void> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase 未配置');
  }

  // A) 统一 URL
  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/send-feedback`;

  // Get device ID
  const deviceId = await getDeviceId();
  
  // Get app version
  const appVersion = Constants.expoConfig?.version || '1.0.0';
  
  // Get platform
  const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
  
  // Get locale
  const locale = getCurrentLocale();
  
  // Get most recent receipt ID (if available)
  let receiptId: string | null = null;
  try {
    const receipts = await listReceipts(1); // Get only the most recent one
    if (receipts.length > 0) {
      receiptId = receipts[0].id;
    }
  } catch (e) {
    // Ignore errors when fetching receipt ID
    if (__DEV__) {
      console.warn('[Feedback] Failed to get recent receipt ID:', e);
    }
  }

  // Generate request ID for observability
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const requestBody = {
    message: payload.message,
    email: payload.email || null,
    locale: payload.locale || locale,
    appVersion: payload.appVersion || appVersion,
    platform: payload.platform || platform,
    deviceId: payload.deviceId || deviceId,
    receiptId: receiptId,
  };

  // A) 统一 headers（必须包含所有字段）
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${supabaseAnonKey}`,
    apikey: supabaseAnonKey,
    'x-device-id': deviceId,
    'x-client': 'app',
    'x-request-id': requestId,
  };

  // C) DEV 可观测日志
  if (__DEV__) {
    console.log(`[Feedback] POST ${edgeFunctionUrl}`);
  }

  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  // B) 严格成功判定：先读取 status 和 text
  const status = response.status;
  let responseText = '';
  
  try {
    responseText = await response.text();
  } catch (e) {
    // 无法读取响应文本 -> 视为失败
    const error = new Error('提交失败（无法读取服务器响应）');
    if (__DEV__) {
      console.error('[Feedback] Failed to read response text:', e);
      console.error(`[Feedback] status=${status}`);
    }
    throw error;
  }

  // C) DEV 可观测日志
  if (__DEV__) {
    console.log(`[Feedback] status=${status}`);
    const truncatedBody = responseText.length > 300 ? responseText.substring(0, 300) + '...' : responseText;
    console.log(`[Feedback] body=${truncatedBody}`);
  }

  // B) 严格成功判定
  // 1. 如果 !response.ok -> throw
  if (!response.ok) {
    const errorPrefix = responseText.length > 300 ? responseText.substring(0, 300) + '...' : responseText;
    let errorMessage = '提交失败';
    
    // 尝试解析错误 JSON
    if (responseText) {
      try {
        const errorJson = JSON.parse(responseText);
        errorMessage = errorJson.error || errorJson.message || errorMessage;
      } catch {
        // Not JSON, use text as-is
        errorMessage = responseText.length > 100 ? responseText.substring(0, 100) + '...' : responseText;
      }
    }

    // 错误信息包含 status 与 text 前 300 字
    const detailedError = new Error(`提交失败（HTTP ${status}）: ${errorPrefix}`);
    if (__DEV__) {
      console.error(`[Feedback] Submission failed:`, detailedError.message);
    }

    // 根据状态码提供用户友好的错误消息
    if (status >= 500) {
      throw new Error('提交失败（服务器错误）');
    } else if (status === 429) {
      throw new Error('提交失败（请求过于频繁）');
    } else if (status >= 400) {
      throw new Error('提交失败（请求错误）');
    } else {
      throw new Error('提交失败（网络错误）');
    }
  }

  // B) 严格成功判定
  // 2. text 为空 -> throw
  if (!responseText || responseText.trim() === '') {
    const error = new Error('提交失败（服务器返回空响应）');
    if (__DEV__) {
      console.error('[Feedback] Empty response body');
    }
    throw error;
  }

  // B) 严格成功判定
  // 3. JSON parse 失败 -> throw
  let responseJson: any;
  try {
    responseJson = JSON.parse(responseText);
  } catch (e) {
    const error = new Error('提交失败（服务器响应格式错误）');
    if (__DEV__) {
      console.error('[Feedback] Failed to parse JSON response:', e);
      console.error('[Feedback] Response text:', responseText.substring(0, 200));
    }
    throw error;
  }

  // B) 严格成功判定
  // 4. 仅当 json.success === true 才算成功；否则 throw
  if (responseJson.success !== true) {
    const error = new Error('提交失败（服务器未确认成功）');
    // 把 json 原样附带在错误里（DEV 下）
    if (__DEV__) {
      console.error('[Feedback] Response does not indicate success:', JSON.stringify(responseJson, null, 2));
    }
    throw error;
  }

  // 成功：只有满足所有条件才到这里
  if (__DEV__) {
    console.log('[Feedback] Submission successful');
    console.log('[Feedback] Success response:', JSON.stringify(responseJson, null, 2));
  }
}
