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

  const requestBody = {
    message: payload.message,
    email: payload.email || null,
    locale: payload.locale || locale,
    appVersion: payload.appVersion || appVersion,
    platform: payload.platform || platform,
    deviceId: payload.deviceId || deviceId,
    receiptId: receiptId,
  };

  // Log request (without sensitive data)
  if (__DEV__) {
    console.log('[Feedback] Submitting feedback:', {
      messageLength: requestBody.message.length,
      hasEmail: !!requestBody.email,
      locale: requestBody.locale,
      appVersion: requestBody.appVersion,
      platform: requestBody.platform,
      hasReceiptId: !!requestBody.receiptId,
    });
  }

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

  if (!response.ok) {
    const status = response.status;
    let errorMessage = '提交失败';
    
    try {
      const errorText = await response.text();
      if (errorText) {
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorMessage;
        } catch {
          // Not JSON, use text as-is (truncated)
          errorMessage = errorText.length > 100 ? errorText.substring(0, 100) + '...' : errorText;
        }
      }
    } catch (e) {
      // Failed to read error text
    }

    // Log error (without sensitive data)
    if (__DEV__) {
      console.error(`[Feedback] Submission failed (HTTP ${status}):`, errorMessage);
    }

    // Provide user-friendly error message
    if (status >= 500) {
      throw new Error('提交失败（服务器错误）');
    } else if (status === 429) {
      throw new Error('提交失败（请求过于频繁）');
    } else if (status >= 400) {
      throw new Error('提交失败（请求错误）');
    } else {
      throw new Error(`提交失败（网络错误）`);
    }
  }

  // Success - log once
  if (__DEV__) {
    console.log('[Feedback] Submission successful');
  }
}
