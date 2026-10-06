/**
 * ocr-receipt-v2 auth gate. No network. Gemini is processAuthorized and must not run on failure.
 */
import fs from 'fs';
import path from 'path';

import {
  authorizeOcrReceiptV2,
  handleOcrReceiptV2Request,
  isThreePartJwt,
  type OcrV2AuthEnv,
} from '../supabase/functions/ocr-receipt-v2/auth';

const PUBLIC_KEY = `sb_publishable_${'P'.repeat(20)}_${'k'.repeat(8)}`;
const ANON_KEY = 'legacy-anon-key';
const SERVICE_ROLE = 'service-role-credential';
const SECRET_KEY = 'sb_secret_not_a_project_key';
const USER_ID = 'user-verified';
const ANON_USER_ID = 'anon-auth-user';

function envOf(values: Record<string, string | undefined>): OcrV2AuthEnv {
  return {
    get(name: string) {
      return values[name];
    },
  };
}

const publicEnv = envOf({
  SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_PUBLISHABLE_ANON_KEY: 'publishable-anon-alias',
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'hosted-public-key' }),
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }),
});

function threePart(header: Record<string, unknown>, payload: Record<string, unknown> = { sub: 'x' }): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode(header)}.${encode(payload)}.sig`;
}

const userJwt = threePart({ alg: 'ES256', typ: 'JWT' }, { role: 'authenticated', sub: USER_ID });

function headers(values: Record<string, string | null>): { get(name: string): string | null } {
  const lower: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(values)) lower[key.toLowerCase()] = value;
  return {
    get(name: string) {
      return lower[name.toLowerCase()] ?? null;
    },
  };
}

describe('ocr-receipt-v2 auth gate', () => {
  it('accepts a public project key plus a verified user JWT', async () => {
    const seen: string[] = [];
    const decision = await authorizeOcrReceiptV2({
      apiKey: PUBLIC_KEY,
      authorization: `Bearer ${userJwt}`,
      env: publicEnv,
      verifyUser: async (jwt) => {
        seen.push(jwt);
        return { id: USER_ID };
      },
    });
    expect(decision).toEqual({ kind: 'authorized', userId: USER_ID });
    expect(seen).toEqual([userJwt]);
  });

  it('accepts a verified anonymous-auth user the same way', async () => {
    const decision = await authorizeOcrReceiptV2({
      apiKey: ANON_KEY,
      authorization: `Bearer ${userJwt}`,
      env: publicEnv,
      verifyUser: async () => ({ id: ANON_USER_ID }),
    });
    expect(decision).toEqual({ kind: 'authorized', userId: ANON_USER_ID });
  });

  it('forwards an ES256-shaped JWT to Auth verification', async () => {
    expect(isThreePartJwt(userJwt)).toBe(true);
    expect(JSON.parse(Buffer.from(userJwt.split('.')[0], 'base64url').toString()).alg).toBe('ES256');
    let forwarded = '';
    const decision = await authorizeOcrReceiptV2({
      apiKey: 'hosted-public-key',
      authorization: `Bearer ${userJwt}`,
      env: publicEnv,
      verifyUser: async (jwt) => {
        forwarded = jwt;
        return { id: USER_ID };
      },
    });
    expect(decision.kind).toBe('authorized');
    expect(forwarded).toBe(userJwt);
  });

  it('rejects missing, wrong, secret, and service-role API keys before user verification', async () => {
    const verifyUser = jest.fn(async () => ({ id: USER_ID }));
    for (const apiKey of [null, '', 'wrong-key', SECRET_KEY, SERVICE_ROLE]) {
      const decision = await authorizeOcrReceiptV2({
        apiKey,
        authorization: `Bearer ${userJwt}`,
        env: publicEnv,
        verifyUser,
      });
      expect(decision.kind).toBe('denied');
      if (decision.kind === 'denied') {
        expect(decision.status).toBe(401);
        expect(decision.body.error.code).toBe('UNAUTHORIZED');
        expect(JSON.stringify(decision.body)).not.toContain(String(apiKey || 'unused'));
      }
    }
    expect(verifyUser).not.toHaveBeenCalled();
  });

  it('rejects missing, malformed, expired, forged, and getUser failures without downgrade', async () => {
    const cases: {
      authorization: string | null;
      verifyUser: jest.Mock;
    }[] = [
      { authorization: null, verifyUser: jest.fn(async () => ({ id: USER_ID })) },
      { authorization: 'Bearer', verifyUser: jest.fn(async () => ({ id: USER_ID })) },
      { authorization: 'Token abc.def.ghi', verifyUser: jest.fn(async () => ({ id: USER_ID })) },
      { authorization: 'Bearer not-a-jwt', verifyUser: jest.fn(async () => ({ id: USER_ID })) },
      { authorization: 'random text', verifyUser: jest.fn(async () => ({ id: USER_ID })) },
      { authorization: `Bearer ${userJwt}`, verifyUser: jest.fn(async () => null) },
      {
        authorization: `Bearer ${userJwt}`,
        verifyUser: jest.fn(async () => {
          throw new Error('expired');
        }),
      },
      {
        authorization: `Bearer ${threePart({ alg: 'none' }, { sub: 'forged' })}`,
        verifyUser: jest.fn(async () => null),
      },
    ];
    for (const item of cases) {
      const processAuthorized = jest.fn(async () => ({ gemini: true }));
      const result = await handleOcrReceiptV2Request(
        {
          method: 'POST',
          headers: headers({
            apikey: PUBLIC_KEY,
            authorization: item.authorization,
            'x-device-id': 'device-should-not-authorize',
          }),
        },
        { env: publicEnv, verifyUser: item.verifyUser, processAuthorized }
      );
      expect(result.kind).toBe('denied');
      if (result.kind === 'denied') expect(result.status).toBe(401);
      expect(processAuthorized).not.toHaveBeenCalled();
    }
  });

  it('does not let x-device-id alone reach the OCR core', async () => {
    const processAuthorized = jest.fn(async () => ({ gemini: true }));
    const verifyUser = jest.fn(async () => ({ id: USER_ID }));
    const result = await handleOcrReceiptV2Request(
      {
        method: 'POST',
        headers: headers({ apikey: PUBLIC_KEY, 'x-device-id': 'device-only' }),
      },
      { env: publicEnv, verifyUser, processAuthorized }
    );
    expect(result.kind).toBe('denied');
    expect(verifyUser).not.toHaveBeenCalled();
    expect(processAuthorized).not.toHaveBeenCalled();
  });

  it('calls the OCR core only after both checks succeed', async () => {
    const processAuthorized = jest.fn(async (userId: string) => ({ userId }));
    const result = await handleOcrReceiptV2Request(
      {
        method: 'POST',
        headers: headers({
          apikey: 'publishable-anon-alias',
          authorization: `Bearer ${userJwt}`,
          'x-device-id': 'metadata-only',
        }),
      },
      {
        env: publicEnv,
        verifyUser: async () => ({ id: USER_ID }),
        processAuthorized,
      }
    );
    expect(processAuthorized).toHaveBeenCalledTimes(1);
    expect(processAuthorized).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({ kind: 'authorized', response: { userId: USER_ID } });
  });
});

describe('ocr-receipt-v2 config and legacy preservation', () => {
  const config = fs.readFileSync(path.resolve(__dirname, '../supabase/config.toml'), 'utf8');
  const legacy = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/ocr-receipt/index.ts'),
    'utf8'
  );
  const v2 = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/ocr-receipt-v2/index.ts'),
    'utf8'
  );

  it('sets verify_jwt false only for ocr-receipt-v2', () => {
    expect(config).toMatch(/\[functions\.ocr-receipt-v2\][\s\S]*?verify_jwt = false/);
    expect(config).not.toMatch(/\[functions\.ocr-receipt\]/);
    expect(config).toMatch(/\[functions\.privacy-policy\][\s\S]*?verify_jwt = false/);
  });

  it('keeps the legacy endpoint source and does not import v2', () => {
    expect(legacy).toContain('proceeding as anonymous');
    expect(legacy).toContain('OCR_DEVICE_ID_REQUIRED');
    expect(legacy).toContain('auth.getUser');
    expect(legacy).toContain('handleOcrReceiptAfterAuth');
    expect(legacy).not.toContain('ocr-receipt-v2/auth');
  });

  it('v2 verifies with getUser and shares the OCR handler', () => {
    expect(v2).toContain('auth.getUser');
    expect(v2).toContain('handleOcrReceiptAfterAuth');
    expect(v2).not.toContain('proceeding as anonymous');
    expect(v2).not.toMatch(/alg[^\\n]{0,40}HS256/);
  });
});
