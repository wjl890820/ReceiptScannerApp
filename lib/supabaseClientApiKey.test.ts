/**
 * Client API-key compatibility. No network. JWT fixtures are unsigned.
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      startAutoRefresh: jest.fn(),
      stopAutoRefresh: jest.fn(),
      getSession: jest.fn(async () => {
        const token = (globalThis as { __ocrServiceSessionToken?: string | null }).__ocrServiceSessionToken;
        return {
          data: {
            session: token ? { access_token: token, user: { id: 'user-1' } } : null,
          },
          error: null,
        };
      }),
    },
  })),
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(async () => ({ base64: 'abc' })),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', extra: {} } },
}));

jest.mock('expo/fetch', () => ({
  fetch: jest.fn((...args: unknown[]) =>
    (globalThis as { fetch?: (...call: unknown[]) => unknown }).fetch?.(...args)
  ),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

jest.mock('./deviceId', () => ({ getDeviceId: async () => 'device-test' }));
jest.mock('./i18n', () => ({ getCurrentLocale: () => 'ja' }));
jest.mock('./db', () => ({ listReceipts: async () => [] }));
jest.mock('./anonAuth', () => ({
  getAccessTokenIfReady: jest.fn(() => null),
  ensureAnonAuth: jest.fn(async () => ({ status: 'unavailable', accessToken: null })),
}));

import fs from 'fs';
import path from 'path';

import { fetch as expoFetch } from 'expo/fetch';

import { createClient } from '@supabase/supabase-js';

import { getAccessTokenIfReady } from './anonAuth';
import { classifyViaEdgeFunction } from './categoryAiClient';
import { classifyItemsBatch } from './categoryBatchAi';
import {
  __resetSupabaseConfigForTests,
  isJwtLike,
  isSupportedSupabaseClientApiKey,
} from './env';
import { submitFeedback } from './feedbackService';
import { resolveOcrUserAccessToken } from './ocrAuthHeaders';
import { analyzeReceiptImageViaEdge, pingOcrEdge } from './ocrService';
import { callSemanticEnrichLive, canRunLiveSemanticEval } from './productIdentitySemanticLiveEval';
import {
  decodeUnverifiedJwtPayload,
  configuredExpoSupabaseAnonKey,
  embeddableSupabaseClientApiKey,
} from './supabaseClientApiKey';
import { __resetSupabaseClientForTests, getSupabaseClient } from './supabaseClient';

const EXAMPLE_URL = 'https://example.supabase.co';
const PUBLISHABLE = `sb_publishable_${'A'.repeat(22)}_${'b'.repeat(8)}`;
const SECRET = 'sb_secret_example_key';

const prevUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const prevAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const prevUrlAlias = process.env.SUPABASE_URL;
const prevAnonAlias = process.env.SUPABASE_ANON_KEY;
const prevLive = process.env.RUN_SEMANTIC_LIVE_EVAL;

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

const anonJwt = unsignedJwt({ role: 'anon' });
const serviceJwt = unsignedJwt({ role: 'service_role' });
const userJwt = unsignedJwt({ role: 'authenticated', sub: 'user-1' });

function useClientKey(key: string): void {
  process.env.EXPO_PUBLIC_SUPABASE_URL = EXAMPLE_URL;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = key;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  __resetSupabaseConfigForTests();
  __resetSupabaseClientForTests();
  (createClient as jest.Mock).mockClear();
}

function jsonResponse(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  };
}

function requestHeaders(call: unknown[]): Record<string, string> {
  return (call[1] as { headers: Record<string, string> }).headers;
}

function setOcrSessionToken(token: string | null): void {
  (globalThis as { __ocrServiceSessionToken?: string | null }).__ocrServiceSessionToken = token;
}

beforeEach(() => {
  setOcrSessionToken(null);
  (expoFetch as jest.Mock).mockClear();
  (getAccessTokenIfReady as jest.Mock).mockReturnValue(null);
  delete process.env.RUN_SEMANTIC_LIVE_EVAL;
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () =>
    jsonResponse({ success: true, analysis: { items: [], total: 1, currency: 'JPY' } })
  );
});

afterAll(() => {
  if (prevUrl === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  else process.env.EXPO_PUBLIC_SUPABASE_URL = prevUrl;
  if (prevAnon === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = prevAnon;
  if (prevUrlAlias === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = prevUrlAlias;
  if (prevAnonAlias === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = prevAnonAlias;
  if (prevLive === undefined) delete process.env.RUN_SEMANTIC_LIVE_EVAL;
  else process.env.RUN_SEMANTIC_LIVE_EVAL = prevLive;
  __resetSupabaseConfigForTests();
  __resetSupabaseClientForTests();
});

describe('isSupportedSupabaseClientApiKey', () => {
  const withHyphen = `sb_publishable_${'A'.repeat(10)}-${'B'.repeat(11)}_${'c'.repeat(8)}`;
  const withUnderscore = `sb_publishable_${'A'.repeat(10)}_${'B'.repeat(11)}_${'c'.repeat(8)}`;
  const withBoth = `sb_publishable_${'A'.repeat(10)}-${'B'.repeat(11)}_${'c'.repeat(3)}_${'d'.repeat(4)}`;

  it('accepts a realistic publishable key shape, including base64url - and _', () => {
    expect(isSupportedSupabaseClientApiKey(PUBLISHABLE)).toBe(true);
    expect(isSupportedSupabaseClientApiKey(withHyphen)).toBe(true);
    expect(isSupportedSupabaseClientApiKey(withUnderscore)).toBe(true);
    expect(isSupportedSupabaseClientApiKey(withBoth)).toBe(true);
  });

  it('rejects malformed publishable keys', () => {
    expect(isSupportedSupabaseClientApiKey('sb_publishable_')).toBe(false);
    expect(isSupportedSupabaseClientApiKey('sb_publishable_x')).toBe(false);
    expect(isSupportedSupabaseClientApiKey('sb_publishable___')).toBe(false);
    expect(isSupportedSupabaseClientApiKey(`sb_publishable_${'A'.repeat(21)}_${'b'.repeat(8)}`)).toBe(
      false
    );
    expect(isSupportedSupabaseClientApiKey(`sb_publishable_${'A'.repeat(23)}_${'b'.repeat(8)}`)).toBe(
      false
    );
    expect(isSupportedSupabaseClientApiKey(`sb_publishable_${'A'.repeat(22)}_${'b'.repeat(7)}`)).toBe(
      false
    );
    expect(isSupportedSupabaseClientApiKey(`sb_publishable_${'A'.repeat(22)}_${'b'.repeat(9)}`)).toBe(
      false
    );
    expect(isSupportedSupabaseClientApiKey(`sb_publishable_${'A'.repeat(21)}!_${'b'.repeat(8)}`)).toBe(
      false
    );
    expect(
      isSupportedSupabaseClientApiKey(`sb_publishable_${'A'.repeat(22)}_${'b'.repeat(8)}_extra`)
    ).toBe(false);
    expect(isSupportedSupabaseClientApiKey(` ${PUBLISHABLE}`)).toBe(false);
    expect(isSupportedSupabaseClientApiKey(`${PUBLISHABLE} `)).toBe(false);
    expect(isSupportedSupabaseClientApiKey(` ${withHyphen}`)).toBe(false);
  });

  it('accepts a legacy anon JWT from an unverified payload', () => {
    expect(isSupportedSupabaseClientApiKey(anonJwt)).toBe(true);
  });

  it('rejects a service_role JWT and non-anon roles', () => {
    expect(isJwtLike(serviceJwt)).toBe(true);
    expect(isSupportedSupabaseClientApiKey(serviceJwt)).toBe(false);
    expect(isSupportedSupabaseClientApiKey(unsignedJwt({ sub: 'x' }))).toBe(false);
    expect(isSupportedSupabaseClientApiKey(unsignedJwt({ role: 1 }))).toBe(false);
    expect(isSupportedSupabaseClientApiKey(userJwt)).toBe(false);
  });

  it('rejects malformed JWT structure', () => {
    expect(isSupportedSupabaseClientApiKey('eyJhbGciOiJub25lIn0.not-json.sig')).toBe(false);
    expect(isSupportedSupabaseClientApiKey('eyJhbGciOiJub25lIn0..sig')).toBe(false);
  });

  it('rejects a payload segment with a trailing illegal character, including the Buffer path', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url');
    const bad = `${header}.${body}!.sig`;
    const atobFn = global.atob;
    // Buffer.from(..., 'base64') would still decode {"role":"anon"} from this segment.
    Reflect.deleteProperty(global, 'atob');
    try {
      expect(decodeUnverifiedJwtPayload(bad)).toBeNull();
      expect(isSupportedSupabaseClientApiKey(bad)).toBe(false);
    } finally {
      global.atob = atobFn;
    }
    expect(isSupportedSupabaseClientApiKey(bad)).toBe(false);
  });

  it('rejects sb_secret keys, empty, whitespace, and arbitrary text', () => {
    expect(isSupportedSupabaseClientApiKey(SECRET)).toBe(false);
    expect(isSupportedSupabaseClientApiKey('')).toBe(false);
    expect(isSupportedSupabaseClientApiKey('   ')).toBe(false);
    expect(isSupportedSupabaseClientApiKey(' not-a-key ')).toBe(false);
    expect(isSupportedSupabaseClientApiKey('hello')).toBe(false);
  });
});

describe('config-time embedding', () => {
  function expectRejected(value: string): void {
    expect(() => embeddableSupabaseClientApiKey(value)).toThrow(/Refusing to embed/);
    expect(() => configuredExpoSupabaseAnonKey({ EXPO_PUBLIC_SUPABASE_ANON_KEY: value })).toThrow(
      /Refusing to embed/
    );
    try {
      configuredExpoSupabaseAnonKey({ EXPO_PUBLIC_SUPABASE_ANON_KEY: value });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(value.trim() || 'unused');
      expect(String((error as Error).message)).not.toContain(PUBLISHABLE);
    }
  }

  it('keeps genuinely absent config and an exact empty string', () => {
    expect(embeddableSupabaseClientApiKey(undefined)).toBeUndefined();
    expect(embeddableSupabaseClientApiKey(null)).toBeNull();
    expect(embeddableSupabaseClientApiKey('')).toBe('');
    expect(configuredExpoSupabaseAnonKey(undefined)).toBeUndefined();
    expect(configuredExpoSupabaseAnonKey(null)).toBeUndefined();
    expect(configuredExpoSupabaseAnonKey({})).toBeUndefined();
    expect(configuredExpoSupabaseAnonKey({ EXPO_PUBLIC_SUPABASE_ANON_KEY: '' })).toBe('');
    expect(
      configuredExpoSupabaseAnonKey({
        EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
        SUPABASE_ANON_KEY: PUBLISHABLE,
      })
    ).toBe('');
    expect(configuredExpoSupabaseAnonKey({ SUPABASE_ANON_KEY: PUBLISHABLE })).toBe(PUBLISHABLE);
    expect(embeddableSupabaseClientApiKey(PUBLISHABLE)).toBe(PUBLISHABLE);
    expect(embeddableSupabaseClientApiKey(anonJwt)).toBe(anonJwt);
  });

  it('rejects whitespace-only and surrounded keys before they can be embedded', () => {
    for (const value of [' ', '   ', '\t', '\n', ` ${PUBLISHABLE}`, `${PUBLISHABLE} `, `\n${anonJwt}`]) {
      expectRejected(value);
    }
    expect(() => embeddableSupabaseClientApiKey(SECRET)).toThrow(/Refusing to embed/);
    expect(() => embeddableSupabaseClientApiKey(serviceJwt)).toThrow(/Refusing to embed/);
    try {
      configuredExpoSupabaseAnonKey({ SUPABASE_ANON_KEY: SECRET });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(SECRET);
    }
    const config = fs.readFileSync(path.join(__dirname, '../app.config.js'), 'utf8');
    expect(config).toContain('configuredExpoSupabaseAnonKey(process.env)');
    expect(config).toContain('SUPABASE_ANON_KEY: configuredExpoSupabaseAnonKey(process.env)');
  });
});

describe('getSupabaseClient', () => {
  it('creates a client for a publishable key', () => {
    useClientKey(PUBLISHABLE);
    expect(getSupabaseClient()).not.toBeNull();
    expect(createClient).toHaveBeenCalledWith(EXAMPLE_URL, PUBLISHABLE, expect.any(Object));
  });

  it('creates a client for a legacy anon JWT', () => {
    useClientKey(anonJwt);
    expect(getSupabaseClient()).not.toBeNull();
    expect(createClient).toHaveBeenCalledWith(EXAMPLE_URL, anonJwt, expect.any(Object));
  });

  it('stays unavailable for a secret or service_role key', () => {
    useClientKey(SECRET);
    expect(getSupabaseClient()).toBeNull();
    useClientKey(serviceJwt);
    expect(getSupabaseClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('user access token shape stays separate', () => {
  it('keeps isJwtLike and does not fall back to the project key', () => {
    expect(isJwtLike(userJwt)).toBe(true);
    expect(isJwtLike(PUBLISHABLE)).toBe(false);
    expect(isJwtLike('not-a-jwt')).toBe(false);
    (getAccessTokenIfReady as jest.Mock).mockReturnValue(userJwt);
    expect(resolveOcrUserAccessToken(PUBLISHABLE)).toBe(userJwt);
    (getAccessTokenIfReady as jest.Mock).mockReturnValue('not-a-jwt');
    expect(resolveOcrUserAccessToken(PUBLISHABLE)).toBeNull();
    (getAccessTokenIfReady as jest.Mock).mockReturnValue(null);
    expect(resolveOcrUserAccessToken(anonJwt)).toBeNull();
  });
});

describe('Edge callers', () => {
  it('OCR without a session does not call ocr-receipt-v2', async () => {
    useClientKey(PUBLISHABLE);
    delete process.env.ENABLE_ANON_AUTH;
    const ping = await pingOcrEdge();
    expect(ping.status).toBe(401);
    await expect(analyzeReceiptImageViaEdge('file://receipt.jpg')).rejects.toThrow(
      /authentication failed/
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(expoFetch).not.toHaveBeenCalled();
  });

  it('signed-in OCR sends the user JWT to ocr-receipt-v2 and keeps the project key in apikey', async () => {
    useClientKey(PUBLISHABLE);
    (getAccessTokenIfReady as jest.Mock).mockReturnValue('eyJ.stale.cached');
    setOcrSessionToken(userJwt);
    await pingOcrEdge();
    const analysis = await analyzeReceiptImageViaEdge('file://receipt.jpg');
    expect(analysis.total).toBe(1);
    const fetchMock = expoFetch as jest.Mock;
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(fetchMock.mock.calls.length);
    for (const call of fetchMock.mock.calls) {
      const headers = requestHeaders(call);
      expect(new URL(String(call[0])).pathname).toBe('/functions/v1/ocr-receipt-v2');
      expect(headers.apikey).toBe(PUBLISHABLE);
      expect(headers.Authorization).toBe(`Bearer ${userJwt}`);
      expect(headers.Authorization).not.toContain(PUBLISHABLE);
      expect(headers['x-device-id']).toBe('device-test');
    }
  });

  it('OCR does not fetch when the project key is a secret', async () => {
    useClientKey(SECRET);
    const ping = await pingOcrEdge();
    expect(ping.status).toBe(401);
    await expect(analyzeReceiptImageViaEdge('file://receipt.jpg')).rejects.toThrow(/unsupported/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(expoFetch).not.toHaveBeenCalled();
  });

  it('pingOcrEdge does not send a second POST when the HTTP 200 body cannot be read', async () => {
    useClientKey(PUBLISHABLE);
    setOcrSessionToken(userJwt);
    const globalFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('Unable to resolve data for blob: test-blob');
      },
    }));
    (global as unknown as { fetch: jest.Mock }).fetch = globalFetch;

    const ping = await pingOcrEdge();

    expect(ping.status).toBe(0);
    expect(String(ping.body.error)).toMatch(/Unable to resolve data for blob/);
    expect(expoFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(String((expoFetch as jest.Mock).mock.calls[0][0])).toContain('/functions/v1/ocr-receipt-v2');
  });

  it('sanitizes non-2xx Edge bodies and keeps a constrained error code', async () => {
    useClientKey(PUBLISHABLE);
    (getAccessTokenIfReady as jest.Mock).mockReturnValue('eyJ.stale.cached');
    setOcrSessionToken(userJwt);
    const dev = (global as unknown as { __DEV__: boolean }).__DEV__;
    (global as unknown as { __DEV__: boolean }).__DEV__ = true;
    const cases = [
      {
        status: 401,
        expect: /Supabase\/Edge authentication failed/,
        body: JSON.stringify({
          error: { code: 'UNAUTHORIZED', message: 'leaked sb_secret_should_not_surface' },
        }),
        code: '(UNAUTHORIZED)',
        absent: ['sb_secret', 'leaked', 'eyJ.stale.cached'],
      },
      {
        status: 401,
        expect: /Supabase\/Edge authentication failed/,
        body: 'plain-text 401 sb_secret_should_not_surface',
        code: null,
        absent: ['plain-text', 'sb_secret'],
      },
      {
        status: 401,
        expect: /Supabase\/Edge authentication failed/,
        body: '<html><body>sb_secret_should_not_surface</body></html>',
        code: null,
        absent: ['<html>', 'sb_secret'],
      },
      {
        status: 404,
        expect: /OCR service unavailable/,
        body: JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'leaked sb_secret_should_not_surface' },
        }),
        code: '(NOT_FOUND)',
        absent: ['sb_secret', 'leaked'],
      },
      {
        status: 404,
        expect: /OCR service unavailable/,
        body: 'plain-text 404 sb_secret_should_not_surface',
        code: null,
        absent: ['plain-text', 'sb_secret'],
      },
      {
        status: 404,
        expect: /OCR service unavailable/,
        body: '<html>sb_secret_should_not_surface</html>',
        code: null,
        absent: ['<html>', 'sb_secret'],
      },
      {
        status: 404,
        expect: /OCR service unavailable/,
        body: '{"error":',
        code: null,
        absent: ['{"error":', 'Unexpected', '无效 JSON'],
      },
      {
        status: 500,
        expect: /OCR service request failed/,
        body: JSON.stringify({
          error: { code: 'SERVER_ERROR', message: 'leaked sb_secret_should_not_surface eyJ.leaked.token' },
        }),
        code: '(SERVER_ERROR)',
        absent: ['sb_secret', 'leaked', 'eyJ.leaked.token'],
      },
      {
        status: 500,
        expect: /OCR service request failed/,
        body: 'plain-text 500 sb_secret_should_not_surface',
        code: null,
        absent: ['plain-text', 'sb_secret'],
      },
    ];
    try {
      for (const item of cases) {
        const logs: string[] = [];
        const record = (...args: unknown[]) => {
          logs.push(
            args
              .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
              .join(' ')
          );
        };
        const spy = jest.spyOn(console, 'log').mockImplementation(record);
        const warn = jest.spyOn(console, 'warn').mockImplementation(record);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(record);
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: false,
          status: item.status,
          text: async () => item.body,
        });
        try {
          await analyzeReceiptImageViaEdge('file://receipt.jpg');
          throw new Error('expected edge failure');
        } catch (error) {
          const message = (error as Error).message;
          expect(message).toMatch(item.expect);
          expect(message).not.toMatch(/publishable key/i);
          if (item.code) expect(message).toContain(item.code);
          else expect(message).not.toMatch(/\([A-Z][A-Z0-9_]{0,40}\)/);
          for (const absent of item.absent) expect(message).not.toContain(absent);
          const logged = logs.join('\n');
          expect(logged).toContain('<redacted>');
          expect(logged).not.toContain('sb_secret');
          expect(logged).not.toContain(item.body);
          expect(logged).not.toContain('eyJ.leaked.token');
        } finally {
          spy.mockRestore();
          warn.mockRestore();
          errorSpy.mockRestore();
        }
      }
    } finally {
      (global as unknown as { __DEV__: boolean }).__DEV__ = dev;
    }
  });

  it('classify-item and classify-items send apikey without Authorization', async () => {
    useClientKey(PUBLISHABLE);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        jsonResponse({ categoryId: 'snacks_drinks', confidence: 0.9, reason: 'ok' })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          modelVersion: 'gemini-3.5-flash',
          results: [{ index: 0, categoryId: 'snacks_drinks', confidence: 0.9, reason: 'ok' }],
        })
      );
    const single = await classifyViaEdgeFunction({ rawName: 'milk', normalizedName: 'milk' });
    expect(single?.categoryId).toBe('snacks_drinks');
    const batch = await classifyItemsBatch([{ index: 0, rawName: 'milk', normalizedName: 'milk' }], {});
    expect(batch?.results).toHaveLength(1);
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.map((call) => String(call[0])).join(' ')).toContain('/functions/v1/classify-item');
    expect(calls.map((call) => String(call[0])).join(' ')).toContain('/functions/v1/classify-items');
    for (const call of calls) {
      const headers = requestHeaders(call);
      expect(headers.apikey).toBe(PUBLISHABLE);
      expect(headers.Authorization).toBeUndefined();
    }
    expect(expoFetch).not.toHaveBeenCalled();
  });

  it('feedback sends apikey without Authorization', async () => {
    useClientKey(PUBLISHABLE);
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ success: true }));
    await submitFeedback({ message: 'hello' });
    const headers = requestHeaders((global.fetch as jest.Mock).mock.calls[0]);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('/functions/v1/send-feedback');
    expect(headers.apikey).toBe(PUBLISHABLE);
    expect(headers.Authorization).toBeUndefined();
    expect(expoFetch).not.toHaveBeenCalled();
  });

  it('live semantic eval sends apikey without Authorization', async () => {
    useClientKey(PUBLISHABLE);
    process.env.RUN_SEMANTIC_LIVE_EVAL = '1';
    __resetSupabaseConfigForTests();
    expect(canRunLiveSemanticEval()).toBe(true);
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse({ success: true, modelVersion: 'gemini-3.5-flash', results: [] })
    );
    await callSemanticEnrichLive([
      {
        id: 's1',
        rawName: 'milk',
        merchantKey: 'shop',
        gateNeedsEnrichment: true,
        gateStatus: 'enrich',
        nameInformativeness: 'informative',
        localCategory: 'uncategorized',
        role: 'positive',
      },
    ]);
    const headers = requestHeaders((global.fetch as jest.Mock).mock.calls[0]);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('/functions/v1/classify-items');
    expect(headers.apikey).toBe(PUBLISHABLE);
    expect(headers.Authorization).toBeUndefined();
    expect(expoFetch).not.toHaveBeenCalled();
  });

  it('analyzeReceiptImageViaEdge does not send a second POST when the HTTP 200 body cannot be read', async () => {
    useClientKey(PUBLISHABLE);
    setOcrSessionToken(userJwt);
    const globalFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('Unable to resolve data for blob: test-blob');
      },
    }));
    (global as unknown as { fetch: jest.Mock }).fetch = globalFetch;

    await expect(analyzeReceiptImageViaEdge('file://receipt.jpg')).rejects.toThrow(
      /Unable to resolve data for blob/
    );

    expect(expoFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
