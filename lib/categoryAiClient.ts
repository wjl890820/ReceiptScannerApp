// lib/categoryAiClient.ts
// AI classification client via Supabase Edge Function
// Handles timeout, error handling, and graceful degradation

import { getSupabaseUrl, getSupabaseAnonKey } from './env';
import { getDeviceId } from './deviceId';
import { getCurrentLocale } from './i18n';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type AiClassifyInput = {
  rawName: string;
  normalizedName: string;
  merchantName?: string;
  price?: number;
  locale?: string;
};

export type AiClassifyResult = {
  categoryId: string;
  confidence: number;
  reason?: string;
};

// Session-level log deduplication
let _lastLogKey: string | null = null;

/**
 * Classify item via Supabase Edge Function
 * Returns null on any failure (timeout, network error, invalid response)
 * Enforces 5000ms timeout via AbortController
 */
export async function classifyViaEdgeFunction(
  input: AiClassifyInput
): Promise<AiClassifyResult | null> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  if (!supabaseUrl || !supabaseAnonKey) {
    // No Supabase config - silently return null (graceful degradation)
    return null;
  }

  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/classify-item`;

  try {
    const deviceId = await getDeviceId();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
    const locale = getCurrentLocale();

    const requestBody = {
      rawName: input.rawName,
      normalizedName: input.normalizedName,
      merchantName: input.merchantName || null,
      price: input.price || null,
      locale: input.locale || locale,
      deviceId,
      appVersion,
      platform,
    };

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000); // 5 second timeout

    try {
      const response = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${supabaseAnonKey}`,
          apikey: supabaseAnonKey,
          'x-device-id': deviceId,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // If HTTP status is not 2xx, return null
      if (!response.ok) {
        const status = response.status;
        const logKey = `ai-fail-${status}`;
        
        // Log once per session per status code
        if (_lastLogKey !== logKey) {
          _lastLogKey = logKey;
          if (__DEV__) {
            console.warn(`[CategoryAI] Edge function returned status ${status}`);
          }
        }
        
        return null;
      }

      const responseData = await response.json();

      // Validate response has required fields
      if (
        !responseData ||
        typeof responseData !== 'object' ||
        !responseData.categoryId ||
        typeof responseData.categoryId !== 'string' ||
        typeof responseData.confidence !== 'number'
      ) {
        // Invalid response format
        const logKey = 'ai-invalid-response';
        if (_lastLogKey !== logKey) {
          _lastLogKey = logKey;
          if (__DEV__) {
            console.warn('[CategoryAI] Invalid response format from edge function');
          }
        }
        return null;
      }

      return {
        categoryId: responseData.categoryId,
        confidence: Number(responseData.confidence),
        reason: responseData.reason || 'AI classification',
      };
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      // Handle AbortError (timeout)
      if (fetchError.name === 'AbortError') {
        const logKey = 'ai-timeout';
        if (_lastLogKey !== logKey) {
          _lastLogKey = logKey;
          if (__DEV__) {
            console.warn('[CategoryAI] Request timeout (5s)');
          }
        }
        return null;
      }

      // Other network errors
      const logKey = 'ai-network-error';
      if (_lastLogKey !== logKey) {
        _lastLogKey = logKey;
        if (__DEV__) {
          console.warn('[CategoryAI] Network error:', fetchError.message);
        }
      }
      return null;
    }
  } catch (error: any) {
    // Unexpected errors
    const logKey = 'ai-unexpected-error';
    if (_lastLogKey !== logKey) {
      _lastLogKey = logKey;
      if (__DEV__) {
        console.warn('[CategoryAI] Unexpected error:', error.message);
      }
    }
    return null;
  }
}
