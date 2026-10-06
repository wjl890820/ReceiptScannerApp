/**
 * Edge request credentials.
 * The project API key is only an `apikey` header.
 * Authorization is a real user access JWT, never the project key.
 */
import { ensureAnonAuth, getAccessTokenIfReady } from './anonAuth';
import { isAnonAuthEnabled, isJwtLike } from './env';
import { getSupabaseClient } from './supabaseClient';

/**
 * User access token suitable for Authorization, or null when the caller stays anonymous.
 * Does not fall back to the project API key.
 */
const SAFE_EDGE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,40}$/;

export const SUPABASE_EDGE_AUTH_FAILURE_MESSAGE =
  'Supabase/Edge authentication failed. Check the configured client API key, authentication state, and Edge Function authorization settings.';

/**
 * Neutral HTTP 401 text. JSON parsing is best-effort and never echoes the body.
 * A constrained error code may be appended; arbitrary messages are dropped.
 */
export function extractSafeEdgeErrorCode(bodyText: string): string | null {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } };
    const rawCode = parsed?.error?.code;
    if (typeof rawCode === 'string' && SAFE_EDGE_ERROR_CODE.test(rawCode)) return rawCode;
  } catch {
    // Non-JSON or malformed JSON contributes no code.
  }
  return null;
}

function edgeFailureMessage(status: number): string {
  if (status === 401 || status === 403) return SUPABASE_EDGE_AUTH_FAILURE_MESSAGE;
  if (status === 404) return 'OCR service unavailable.';
  if (status === 429) return 'OCR is temporarily unavailable. Please try again later.';
  return 'OCR service request failed.';
}

/**
 * Status-based Edge failure text. A constrained error code may be appended.
 * Response body text, HTML, and arbitrary server messages are dropped.
 */
export function formatSupabaseEdgeHttpFailure(status: number, bodyText: string): string {
  const code = extractSafeEdgeErrorCode(bodyText);
  return code ? `${edgeFailureMessage(status)} (${code})` : edgeFailureMessage(status);
}

export function formatSupabaseEdgeAuthFailure(bodyText: string): string {
  return formatSupabaseEdgeHttpFailure(401, bodyText);
}

export function resolveOcrUserAccessToken(projectKey: string): string | null {
  try {
    const token = getAccessTokenIfReady();
    if (token && isJwtLike(token) && token !== projectKey) return token;
  } catch {
    // No usable session. Do not substitute the project key.
  }
  return null;
}

function usableSessionAccessToken(
  token: string | null | undefined,
  projectKey: string
): string | null {
  if (token && isJwtLike(token) && token !== projectKey) return token;
  return null;
}

/** Current Supabase Auth session token. Ignores the copied anonAuth access token. */
async function readCurrentSupabaseAccessToken(projectKey: string): Promise<string | null> {
  try {
    const client = getSupabaseClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return usableSessionAccessToken(data?.session?.access_token, projectKey);
  } catch {
    return null;
  }
}

/**
 * Cloud OCR user access token from the current Supabase Auth session.
 * When that session is missing and ENABLE_ANON_AUTH is on, waits for the
 * existing anonymous sign-in helper, then reads the session again.
 * A copied anonAuth token is never returned on its own.
 */
export async function ensureOcrUserAccessToken(projectKey: string): Promise<string> {
  const current = await readCurrentSupabaseAccessToken(projectKey);
  if (current) return current;
  if (!isAnonAuthEnabled()) {
    throw new Error(SUPABASE_EDGE_AUTH_FAILURE_MESSAGE);
  }
  try {
    await ensureAnonAuth();
  } catch {
    throw new Error(SUPABASE_EDGE_AUTH_FAILURE_MESSAGE);
  }
  const refreshed = await readCurrentSupabaseAccessToken(projectKey);
  if (!refreshed) throw new Error(SUPABASE_EDGE_AUTH_FAILURE_MESSAGE);
  return refreshed;
}
