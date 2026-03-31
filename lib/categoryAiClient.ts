// lib/categoryAiClient.ts
// AI classification client via Supabase Edge Function
// Handles timeout, retry, error handling, and graceful degradation

import { getSupabaseUrl, getSupabaseAnonKey, isJwtLike } from './env';
import { getCategoryAiTimeoutMs, getCategoryAiRetries } from './env';
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

export type ClassifyFailureReason = 'timeout' | 'non_2xx' | 'network';

const TIMEOUT_MS = getCategoryAiTimeoutMs();
const RETRY_DELAY_MS = 250;
const CONCURRENCY = 2;

let _lastFailure: { code: ClassifyFailureReason; message?: string } | null = null;

// Promise queue: global concurrency limit (no new deps)
let _running = 0;
const _waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (_running < CONCURRENCY) {
    _running++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _waitQueue.push(() => {
      _running++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  _running--;
  const next = _waitQueue.shift();
  if (next) next();
}

/**
 * Return last classify-item API failure reason (timeout / non_2xx / network).
 * Cleared on next successful call or when caller explicitly resets.
 */
export function getLastClassifyError(): { code: ClassifyFailureReason; message?: string } | null {
  return _lastFailure;
}

export function clearLastClassifyError(): void {
  _lastFailure = null;
}

function setFailure(code: ClassifyFailureReason, message?: string): void {
  _lastFailure = { code, message };
  if (__DEV__) {
    console.warn(`[CategoryAI] classify-item failed: ${code}${message ? ` — ${message}` : ''}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type LogStatus = 'success' | 'timeout' | 'non_2xx';

function logRequest(
  host: string,
  timeoutMs: number,
  attempt: number,
  requestId: string,
  elapsedMs: number,
  status: LogStatus
): void {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[CategoryAI]', { host, timeoutMs, attempt, requestId, elapsedMs, status });
  }
}

/**
 * Classify item via Supabase Edge Function.
 * Timeout 6s, max 1 retry with 300ms backoff.
 * Returns null on failure; use getLastClassifyError() for reason (timeout / non_2xx / network).
 */
export async function classifyViaEdgeFunction(
  input: AiClassifyInput
): Promise<AiClassifyResult | null> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  if (!isJwtLike(supabaseAnonKey)) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        '[Env] Anon key 不是 JWT（你可能填了 publishable key），请去 Supabase Settings → API → Legacy anon key(eyJ...)'
      );
    }
    throw new Error(
      'Anon key 不是 JWT（你可能填了 publishable key），请到 Supabase 设置 → API → Legacy anon key (eyJ...)'
    );
  }

  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/classify-item`;
  let host = '';
  try {
    host = new URL(supabaseUrl).host;
  } catch {
    host = 'unknown';
  }
  const requestId = `app-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${supabaseAnonKey}`,
  };

  const doFetch = async (attempt: number): Promise<AiClassifyResult | null> => {
    clearLastClassifyError();
    const startMs = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

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

      if (__DEV__) {
        console.log('[CategoryAI] classify-item request', {
          url: edgeFunctionUrl,
          attempt,
          requestId,
          body: {
            rawName: requestBody.rawName,
            normalizedName: requestBody.normalizedName,
            merchantName: requestBody.merchantName,
            price: requestBody.price,
            locale: requestBody.locale,
            deviceIdPrefix: deviceId ? `${deviceId.slice(0, 8)}...` : '',
            appVersion,
            platform,
          },
        });
      }

      const response = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'x-device-id': deviceId,
          'x-client': 'app',
          'x-request-id': requestId,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const elapsedMs = Date.now() - startMs;

      if (!response.ok) {
        logRequest(host, TIMEOUT_MS, attempt, requestId, elapsedMs, 'non_2xx');
        let msg: string;
        try {
          const t = await response.text();
          msg = t.length > 100 ? t.slice(0, 100) + '…' : t;
        } catch {
          msg = `HTTP ${response.status}`;
        }
        if (__DEV__) {
          console.warn('[CategoryAI] classify-item non-2xx', {
            status: response.status,
            bodySnippet: msg,
          });
        }
        setFailure('non_2xx', `status ${response.status}${msg ? ` ${msg}` : ''}`);
        return null;
      }

      const responseData = await response.json();
      if (__DEV__) {
        console.log('[CategoryAI] classify-item response', {
          categoryId: responseData?.categoryId,
          confidence: responseData?.confidence,
          reason: responseData?.reason,
        });
      }
      if (
        !responseData ||
        typeof responseData !== 'object' ||
        !responseData.categoryId ||
        typeof responseData.categoryId !== 'string' ||
        typeof responseData.confidence !== 'number'
      ) {
        logRequest(host, TIMEOUT_MS, attempt, requestId, elapsedMs, 'non_2xx');
        setFailure('non_2xx', 'invalid response format');
        return null;
      }

      logRequest(host, TIMEOUT_MS, attempt, requestId, elapsedMs, 'success');
      return {
        categoryId: responseData.categoryId,
        confidence: Number(responseData.confidence),
        reason: responseData.reason || 'AI classification',
      };
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      const elapsedMs = Date.now() - startMs;
      if (fetchError?.name === 'AbortError') {
        logRequest(host, TIMEOUT_MS, attempt, requestId, elapsedMs, 'timeout');
        setFailure('timeout', `timeout after ${TIMEOUT_MS}ms`);
        return null;
      }
      logRequest(host, TIMEOUT_MS, attempt, requestId, elapsedMs, 'non_2xx');
      setFailure('network', fetchError?.message || 'fetch error');
      return null;
    }
  };

  await acquireSlot();
  try {
    const first = await doFetch(1);
    if (first !== null) return first;
    const retries = getCategoryAiRetries();
    if (retries >= 1) {
      await sleep(RETRY_DELAY_MS);
      return doFetch(2);
    }
    return null;
  } finally {
    releaseSlot();
  }
}
