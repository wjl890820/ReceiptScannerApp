/**
 * Resolve Authorization bearer for OCR Edge calls.
 * Prefer authenticated access token when ready; otherwise anon key.
 * Never blocks on auth bootstrap / never requires auth success.
 */
import { getAccessTokenIfReady } from './anonAuth';
import { isJwtLike } from './env';

export async function resolveOcrAuthorizationBearer(anonKey: string): Promise<string> {
  try {
    const token = getAccessTokenIfReady();
    if (token && isJwtLike(token) && token !== anonKey) {
      return token;
    }
  } catch {
    // ignore — fall back to anon key
  }
  return anonKey;
}
