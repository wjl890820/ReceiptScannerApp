// lib/ocrService.ts
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { getDeviceId } from './deviceId';
import { getCurrentLocale } from './i18n';
import type { ReceiptAnalysis } from './receiptAnalyzer';
import { getSupabaseUrl, getSupabaseAnonKey } from './env';

/**
 * Compress and encode image to base64
 */
async function compressToJpegBase64(uri: string): Promise<{ base64: string; mimeType: string }> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 1280 } }], // Target width for compression
    {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    }
  );

  if (!result.base64) {
    throw new Error('图片压缩失败：未获取到 base64');
  }

  return {
    base64: result.base64,
    mimeType: 'image/jpeg',
  };
}

export type OCRServiceError = {
  code: 'RATE_LIMIT' | 'PAYLOAD_TOO_LARGE' | 'NETWORK_ERROR' | 'SERVER_ERROR' | 'INVALID_RESPONSE';
  message: string;
};

// Track if we've already logged probe/ping failure in this session
let _probeFailureLogged = false;
let _pingFailureLogged = false;

/**
 * Temporary network probe: Test basic connectivity to Supabase
 */
export async function probeSupabaseNetwork(): Promise<{ success: boolean; status?: number; error?: string }> {
  const supabaseUrl = getSupabaseUrl();
  
  if (!supabaseUrl) {
    // Only log once per session to avoid spam
    if (!_probeFailureLogged) {
      console.warn('[Network Probe] SUPABASE_URL not configured in extra');
      _probeFailureLogged = true;
    }
    return { success: false, error: 'SUPABASE_URL not configured' };
  }
  
  // Test basic connectivity with a simple GET request
  const probeUrl = `${supabaseUrl}/rest/v1/`;
  
  if (__DEV__) {
    console.log('[Network Probe] Testing connectivity to:', probeUrl);
  }
  
  try {
    const response = await fetch(probeUrl, {
      method: 'GET',
      // No headers needed for basic connectivity test
    });
    
    if (__DEV__) {
      console.log('[Network Probe] Response status:', response.status);
    }
    
    return {
      success: true,
      status: response.status,
    };
  } catch (error: any) {
    // Network failure, not config issue - only log once per session
    if (!_probeFailureLogged) {
      console.warn('[Network Probe] Network request failed:', error.message);
      _probeFailureLogged = true;
    }
    return {
      success: false,
      error: error.message || 'Network request failed',
    };
  }
}

/**
 * Temporary debug: Ping OCR Edge Function
 */
export async function pingOcrEdge(): Promise<{ status: number; body: any }> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  // Only return error if config is actually missing, not if network fails
  if (!supabaseUrl) {
    if (!_pingFailureLogged) {
      console.warn('[OCR] SUPABASE_URL not configured in extra');
      _pingFailureLogged = true;
    }
    return {
      status: 0,
      body: { error: 'SUPABASE_URL not configured' },
    };
  }

  if (!supabaseAnonKey) {
    if (!_pingFailureLogged) {
      console.warn('[OCR] SUPABASE_ANON_KEY not configured in extra');
      _pingFailureLogged = true;
    }
    return {
      status: 0,
      body: { error: 'SUPABASE_ANON_KEY not configured' },
    };
  }

  const deviceId = await getDeviceId();
  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/ocr-receipt`;

  if (__DEV__) {
    console.log('[OCR] Ping edge function');
  }

  try {
    const response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supabaseAnonKey}`,
        apikey: supabaseAnonKey,
        'x-device-id': deviceId,
      },
      body: JSON.stringify({ ping: true }),
    });

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      responseData = { error: 'Invalid JSON', raw: responseText.substring(0, 200) };
    }

    return {
      status: response.status,
      body: responseData,
    };
  } catch (error: any) {
    // Network failure, not config issue - only log once per session
    if (!_pingFailureLogged) {
      console.warn('[OCR] Ping network error:', error.message);
      _pingFailureLogged = true;
    }
    return {
      status: 0,
      body: { error: error.message || 'Network error' },
    };
  }
}

/**
 * Analyze receipt image via Supabase Edge Function
 */
export async function analyzeReceiptImageViaEdge(uri: string): Promise<ReceiptAnalysis> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  if (!supabaseUrl) {
    throw new Error('Supabase URL 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  if (!supabaseAnonKey) {
    throw new Error('Supabase Anon Key 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  // Compress and encode image
  const { base64, mimeType } = await compressToJpegBase64(uri);

  // Get device ID
  const deviceId = await getDeviceId();

  // Get app metadata
  const appVersion = Constants.expoConfig?.version || '1.0.0';
  const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
  const language = getCurrentLocale();

  // Prepare request
  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/ocr-receipt`;
  
  if (__DEV__) {
    console.log('[OCR] Analyzing receipt image');
  }

  // Optional: Generate client-side receipt ID for debugging (non-sensitive)
  // This is only used for request tracking, does not contain any receipt content
  const clientReceiptId = `client-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const requestBody = {
    imageBase64: base64,
    mimeType,
    deviceId,
    appVersion,
    platform,
    language,
    clientReceiptId, // Optional: for request tracking/debugging
  };

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
    });

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`服务器返回无效 JSON: ${responseText.substring(0, 200)}`);
    }

    if (!response.ok) {
      // Handle specific error codes
      if (response.status === 429) {
        const error: OCRServiceError = {
          code: 'RATE_LIMIT',
          message: responseData?.error?.message || '请求过于频繁，请稍后再试',
        };
        throw error;
      }

      if (response.status === 413) {
        const error: OCRServiceError = {
          code: 'PAYLOAD_TOO_LARGE',
          message: responseData?.error?.message || '图片过大，请重新拍摄更清晰的照片',
        };
        throw error;
      }

      if (response.status >= 500) {
        const error: OCRServiceError = {
          code: 'SERVER_ERROR',
          message: responseData?.error?.message || '服务器错误，请稍后重试',
        };
        throw error;
      }

      const error: OCRServiceError = {
        code: 'INVALID_RESPONSE',
        message: responseData?.error?.message || `请求失败 (HTTP ${response.status})`,
      };
      throw error;
    }

    if (!responseData.success) {
      const error: OCRServiceError = {
        code: 'INVALID_RESPONSE',
        message: responseData?.error?.message || 'OCR 识别失败',
      };
      throw error;
    }

    const analysis = responseData.analysis;
    if (!analysis || typeof analysis !== 'object') {
      throw new Error('服务器返回的分析结果格式无效');
    }

    // Convert to ReceiptAnalysis format
    const receiptAnalysis: ReceiptAnalysis = {
      merchant: typeof analysis.merchant === 'string' ? analysis.merchant : undefined,
      items: Array.isArray(analysis.items) ? analysis.items : [],
      total: typeof analysis.total === 'number' ? analysis.total : 0,
      tax: typeof analysis.tax === 'number' ? analysis.tax : 0,
      currency:
        typeof analysis.currency === 'string' && analysis.currency.trim()
          ? analysis.currency
          : 'JPY',
      transactionDate:
        typeof analysis.transactionDate === 'string' && analysis.transactionDate.trim()
          ? analysis.transactionDate.trim()
          : undefined,
    };

    return receiptAnalysis;
  } catch (error: any) {
    // Re-throw OCRServiceError as-is
    if (error.code && error.message) {
      throw error;
    }

    // Wrap other errors
    if (error.message) {
      throw new Error(`OCR 请求失败: ${error.message}`);
    }

    throw new Error('OCR 请求失败: 未知错误');
  }
}
