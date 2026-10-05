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
}));

import * as ImageManipulator from 'expo-image-manipulator';

import { getAccessTokenIfReady } from './anonAuth';
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

function configureClientKey(key: string): void {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = key;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.DEV_DIRECT_GEMINI;
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
  });

  it('anonymous production OCR sends apikey and no Authorization', async () => {
    configureClientKey(PUBLISHABLE);
    (getAccessTokenIfReady as jest.Mock).mockReturnValue(null);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '{}',
    }));
    await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow();
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(String(calls[0][0])).toContain('/functions/v1/ocr-receipt');
    expect(calls[0][1].headers.apikey).toBe(PUBLISHABLE);
    expect(calls[0][1].headers.Authorization).toBeUndefined();
    expect(String(calls[0][1].body)).not.toContain(SECRET);
  });

  it('signed-in production OCR uses the user access JWT', async () => {
    configureClientKey(PUBLISHABLE);
    (getAccessTokenIfReady as jest.Mock).mockReturnValue(userJwt);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '{}',
    }));
    await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow();
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers.apikey).toBe(PUBLISHABLE);
    expect(headers.Authorization).toBe(`Bearer ${userJwt}`);
  });

  it('legacy ocr fallback also omits Authorization for an anonymous publishable key', async () => {
    configureClientKey(PUBLISHABLE);
    (getAccessTokenIfReady as jest.Mock).mockReturnValue(null);
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{}' })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: 'fallback failed' } }),
      });
    await expect(analyzeReceiptImageWithProvenance('file://receipt.jpg')).rejects.toThrow(
      /ocr-receipt 404/
    );
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(String(calls[1][0])).toContain('/functions/v1/ocr');
    expect(calls[1][1].headers.apikey).toBe(PUBLISHABLE);
    expect(calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('sanitizes JSON, plain-text, HTML, and malformed HTTP 401 bodies', async () => {
    configureClientKey(PUBLISHABLE);
    const dev = (global as unknown as { __DEV__: boolean }).__DEV__;
    (global as unknown as { __DEV__: boolean }).__DEV__ = true;
    const cases = [
      {
        body: JSON.stringify({
          error: { code: 'UNAUTHORIZED', message: 'leaked sb_secret_should_not_surface' },
        }),
        code: '(UNAUTHORIZED)',
        absent: ['sb_secret', 'leaked'],
      },
      {
        body: JSON.stringify({ error: { message: 'raw credential sb_secret_should_not_surface' } }),
        code: null,
        absent: ['sb_secret', 'raw credential'],
      },
      {
        body: 'plain-text 401 sb_secret_should_not_surface',
        code: null,
        absent: ['plain-text', 'sb_secret'],
      },
      {
        body: '<html><body>sb_secret_should_not_surface</body></html>',
        code: null,
        absent: ['<html>', 'sb_secret'],
      },
      {
        body: '{"error": sb_secret_should_not_surface',
        code: null,
        absent: ['{"error":', 'sb_secret', '无效 JSON', 'Unexpected'],
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
          status: 401,
          text: async () => item.body,
        }));
        try {
          await analyzeReceiptImageWithProvenance('file://receipt.jpg');
          throw new Error('expected authentication failure');
        } catch (error) {
          const message = (error as Error).message;
          expect(message).toMatch(/Supabase\/Edge authentication failed/);
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
});
