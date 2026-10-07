/**
 * Production scan path must validate the project key before preprocessing or fetch.
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(async () => ({ base64: 'abc' })),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', extra: {} } },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('./deviceId', () => ({ getDeviceId: async () => 'device-test' }));
jest.mock('./i18n', () => ({ getCurrentLocale: () => 'ja' }));
jest.mock('./anonAuth', () => ({
  getAccessTokenIfReady: jest.fn(() => null),
  ensureAnonAuth: jest.fn(async () => ({ status: 'unavailable', accessToken: null })),
}));
jest.mock('expo/fetch', () => ({
  fetch: jest.fn((...args: unknown[]) =>
    (globalThis as { fetch?: (...call: unknown[]) => unknown }).fetch?.(...args)
  ),
}));

jest.mock('./supabaseClient', () => ({
  getSupabaseClient: jest.fn(() => ({
    auth: {
      getSession: jest.fn(async () => {
        const token = (globalThis as { __ocrAnalyzerSessionToken?: string | null })
          .__ocrAnalyzerSessionToken;
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

import { fetch as expoFetch } from 'expo/fetch';
import * as ImageManipulator from 'expo-image-manipulator';

import { ensureAnonAuth, getAccessTokenIfReady } from './anonAuth';
import { __resetSupabaseConfigForTests } from './env';
import { analyzeReceiptImageWithProvenance } from './receiptAnalyzer';

const PUBLISHABLE = `sb_publishable_${'C'.repeat(22)}_${'d'.repeat(8)}`;
const SECRET = 'sb_secret_not_for_client';

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

const serviceJwt = unsignedJwt({ role: 'service_role' });
const userJwt = unsignedJwt({ role: 'authenticated', sub: 'user-1' });

const prevUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const prevAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

function setOcrSessionToken(token: string | null): void {
  (globalThis as { __ocrAnalyzerSessionToken?: string | null }).__ocrAnalyzerSessionToken = token;
}

function configureClientKey(key: string): void {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = key;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.DEV_DIRECT_GEMINI;
  setOcrSessionToken(null);
  __resetSupabaseConfigForTests();
  (ImageManipulator.manipulateAsync as jest.Mock).mockClear();
}

afterAll(() => {
  if (prevUrl === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  else process.env.EXPO_PUBLIC_SUPABASE_URL = prevUrl;
  if (prevAnon === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = prevAnon;
  __resetSupabaseConfigForTests();
});

describe('receiptAnalyzer project key', () => {
  beforeEach(() => {
    (expoFetch as jest.Mock).mockClear();
  });

  it('rejects an unsafe key before image preprocessing or fetch', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
    for (const key of [SECRET, serviceJwt, 'not-a-key']) {
      configureClientKey(key);
      await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow(
        /unsupported/
      );
    }
    expect(ImageManipulator.manipulateAsync).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(expoFetch).not.toHaveBeenCalled();
  });

  it('does not call ocr-receipt-v2 when there is no session and anonymous auth is off', async () => {
    configureClientKey(PUBLISHABLE);
    delete process.env.ENABLE_ANON_AUTH;
    (getAccessTokenIfReady as jest.Mock).mockReturnValue(null);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
    await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow(
      /authentication failed/
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(expoFetch).not.toHaveBeenCalled();
    expect(ImageManipulator.manipulateAsync).not.toHaveBeenCalled();
    expect(ensureAnonAuth).not.toHaveBeenCalled();
  });

  it('signed-in production OCR uses ocr-receipt-v2 and the user access JWT', async () => {
    configureClientKey(PUBLISHABLE);
    (getAccessTokenIfReady as jest.Mock).mockReturnValue('eyJ.stale.cached');
    setOcrSessionToken(userJwt);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '{}',
    }));
    await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow();
    const calls = (expoFetch as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect(new URL(String(calls[0][0])).pathname).toBe('/functions/v1/ocr-receipt-v2');
    const headers = calls[0][1].headers;
    expect(headers.apikey).toBe(PUBLISHABLE);
    expect(headers.Authorization).toBe(`Bearer ${userJwt}`);
    expect(headers.Authorization).not.toContain(PUBLISHABLE);
    expect(headers['x-device-id']).toBe('device-test');
  });

  it('does not fall back from ocr-receipt-v2 to the legacy OCR endpoints', async () => {
    configureClientKey(PUBLISHABLE);
    setOcrSessionToken(userJwt);
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{}' })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: 'fallback failed' } }),
      });
    await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow();
    const calls = (expoFetch as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain('/functions/v1/ocr-receipt-v2');
  });

  it('does not fetch ocr-receipt-v2 when on-demand anonymous auth fails', async () => {
    configureClientKey(PUBLISHABLE);
    process.env.ENABLE_ANON_AUTH = 'true';
    (getAccessTokenIfReady as jest.Mock).mockReturnValue(null);
    (ensureAnonAuth as jest.Mock).mockResolvedValue({ status: 'unavailable', accessToken: null });
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
    try {
      await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow(
        /authentication failed/
      );
      expect(ensureAnonAuth).toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(expoFetch).not.toHaveBeenCalled();
      expect(ImageManipulator.manipulateAsync).not.toHaveBeenCalled();
    } finally {
      delete process.env.ENABLE_ANON_AUTH;
    }
  });

  it('on-demand anonymous sign-in sends the resulting user JWT to ocr-receipt-v2', async () => {
    configureClientKey(PUBLISHABLE);
    process.env.ENABLE_ANON_AUTH = 'true';
    (getAccessTokenIfReady as jest.Mock).mockReturnValue('eyJ.stale.cached');
    (ensureAnonAuth as jest.Mock).mockImplementation(async () => {
      setOcrSessionToken(userJwt);
      return { status: 'authenticated', accessToken: 'eyJ.stale.cached' };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          analysis: { merchant: 'Test', items: [], total: 1, currency: 'JPY' },
        }),
    }));
    try {
      const outcome = await analyzeReceiptImageWithProvenance('file://receipt.jpg');
      expect(outcome.analysis.total).toBe(1);
      expect(ensureAnonAuth).toHaveBeenCalled();
      const calls = (expoFetch as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
      expect(String(calls[0][0])).toContain('/functions/v1/ocr-receipt-v2');
      expect(calls[0][1].headers.apikey).toBe(PUBLISHABLE);
      expect(calls[0][1].headers.Authorization).toBe(`Bearer ${userJwt}`);
      expect(calls[0][1].headers.Authorization).not.toContain('eyJ.stale.cached');
    } finally {
      delete process.env.ENABLE_ANON_AUTH;
    }
  });

  it('sanitizes non-2xx Edge bodies and keeps a constrained error code', async () => {
    configureClientKey(PUBLISHABLE);
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
        body: '{"error": sb_secret_should_not_surface',
        code: null,
        absent: ['{"error":', 'sb_secret', '无效 JSON', 'Unexpected'],
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
        (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
          ok: false,
          status: item.status,
          text: async () => item.body,
        }));
        try {
          await analyzeReceiptImageWithProvenance('file://receipt.jpg');
          throw new Error('expected edge failure');
        } catch (error) {
          const message = (error as Error).message;
          expect(message).toMatch(item.expect);
          if (item.code) expect(message).toContain(item.code);
          else expect(message).not.toMatch(/\([A-Z][A-Z0-9_]{0,40}\)/);
          for (const absent of item.absent) expect(message).not.toContain(absent);
          const logged = logs.join('\n');
          expect(logged).toContain('<redacted>');
          expect(logged).not.toContain('sb_secret');
          expect(logged).not.toContain(item.body);
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

  it('does not send a second OCR POST when the HTTP 200 body cannot be read', async () => {
    configureClientKey(PUBLISHABLE);
    setOcrSessionToken(userJwt);
    const globalFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('Unable to resolve data for blob: test-blob');
      },
    }));
    (global as unknown as { fetch: jest.Mock }).fetch = globalFetch;

    await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow(
      /Unable to resolve data for blob/
    );

    expect(expoFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(String((expoFetch as jest.Mock).mock.calls[0][0])).toContain('/functions/v1/ocr-receipt-v2');
    const headers = (expoFetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers.apikey).toBe(PUBLISHABLE);
    expect(headers.Authorization).toBe(`Bearer ${userJwt}`);
    expect(headers['x-device-id']).toBe('device-test');
  });
});
