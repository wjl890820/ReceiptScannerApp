/**
 * Strict gate for ocr-receipt-v2.
 * Requires a current public project API key and a Supabase Auth-confirmed user.
 * JWT-less, project-key-only, and x-device-id callers are rejected.
 * This module does not log credentials and does not call Gemini.
 */
import {
  legacyOcrProjectApiKeyMatches,
  type LegacyOcrKeyEnv,
} from '../ocr/publishableKeys.ts';

export type OcrV2AuthEnv = LegacyOcrKeyEnv;

export type OcrV2DeniedBody = {
  success: false;
  error: { code: 'UNAUTHORIZED'; message: string };
};

export type OcrV2Denied = {
  kind: 'denied';
  status: 401;
  body: OcrV2DeniedBody;
};

export type OcrV2Authorized = {
  kind: 'authorized';
  userId: string;
};

const MISSING_PROJECT_KEY = 'Project API key is missing or invalid';
const MISSING_USER = 'A valid user access token is required';
const USER_NOT_VERIFIED = 'User access token could not be verified';

export function ocrV2Denied(message: string): OcrV2Denied {
  return {
    kind: 'denied',
    status: 401,
    body: {
      success: false,
      error: { code: 'UNAUTHORIZED', message },
    },
  };
}

function bearerToken(authorization: string | null | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) return null;
  const token = match[1];
  if (!token) return null;
  return token;
}

/** Three dot-separated parts only. Algorithm is not inspected. */
export function isThreePartJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export async function authorizeOcrReceiptV2(input: {
  apiKey: string | null;
  authorization: string | null;
  env: OcrV2AuthEnv;
  verifyUser: (jwt: string) => Promise<{ id: string } | null>;
}): Promise<OcrV2Authorized | OcrV2Denied> {
  if (!legacyOcrProjectApiKeyMatches(input.apiKey, input.env)) {
    return ocrV2Denied(MISSING_PROJECT_KEY);
  }

  const token = bearerToken(input.authorization);
  if (!token || !isThreePartJwt(token)) {
    return ocrV2Denied(MISSING_USER);
  }

  let user: { id: string } | null = null;
  try {
    user = await input.verifyUser(token);
  } catch {
    return ocrV2Denied(USER_NOT_VERIFIED);
  }
  if (!user || typeof user.id !== 'string' || user.id.length === 0) {
    return ocrV2Denied(USER_NOT_VERIFIED);
  }
  return { kind: 'authorized', userId: user.id };
}

type HeaderSource = {
  method?: string;
  headers: { get(name: string): string | null };
};

/**
 * OPTIONS skips auth. Every other request must pass authorizeOcrReceiptV2
 * before processAuthorized (the shared OCR core / Gemini path) runs.
 * x-device-id is never read.
 */
export async function handleOcrReceiptV2Request<T>(
  req: HeaderSource,
  deps: {
    env: OcrV2AuthEnv;
    verifyUser: (jwt: string) => Promise<{ id: string } | null>;
    processAuthorized: (userId: string) => Promise<T>;
  }
): Promise<{ kind: 'options' } | OcrV2Denied | { kind: 'authorized'; response: T }> {
  if (req.method === 'OPTIONS') {
    return { kind: 'options' };
  }
  const decision = await authorizeOcrReceiptV2({
    apiKey: req.headers.get('apikey'),
    authorization: req.headers.get('authorization'),
    env: deps.env,
    verifyUser: deps.verifyUser,
  });
  if (decision.kind !== 'authorized') return decision;
  const response = await deps.processAuthorized(decision.userId);
  return { kind: 'authorized', response };
}
