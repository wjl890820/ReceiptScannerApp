/**
 * Edge request credentials.
 * The project API key is only an `apikey` header.
 * Authorization is a real user access JWT, never the project key.
 */
import { getAccessTokenIfReady } from './anonAuth';
import { isJwtLike } from './env';

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
export function formatSupabaseEdgeAuthFailure(bodyText: string): string {
  let suffix = '';
  if (typeof bodyText === 'string' && bodyText.length > 0) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } };
      const rawCode = parsed?.error?.code;
      if (typeof rawCode === 'string' && SAFE_EDGE_ERROR_CODE.test(rawCode)) {
        suffix = ` (${rawCode})`;
      }
    } catch {
      // Non-JSON or malformed JSON stays neutral.
    }
  }
  return `${SUPABASE_EDGE_AUTH_FAILURE_MESSAGE}${suffix}`;
}

export function resolveOcrUserAccessToken(projectKey: string): string | null {
  try {
    const token = getAccessTokenIfReady();
    if (token && isJwtLike(token) && token !== projectKey) return token;
  } catch {
    // Anonymous call. Do not substitute the project key.
  }
  return null;
}
