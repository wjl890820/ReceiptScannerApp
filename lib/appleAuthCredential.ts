/**
 * Native Apple credential acquisition (iOS). No token/nonce persistence.
 *
 * Nonce contract:
 * - Apple receives SHA-256(rawNonce) hex
 * - Caller passes rawNonce to Supabase linkIdentity / signInWithIdToken
 */
import { createAppleNoncePair } from './appleNonce';

export type AppleCredentialResult =
  | {
      status: 'ok';
      identityToken: string;
      /** Raw nonce for Supabase ID-token verification only */
      rawNonce: string;
    }
  | { status: 'canceled' }
  | { status: 'unavailable'; error?: string }
  | { status: 'missing_identity_token' }
  | { status: 'error'; error: string };

export type AppleCredentialDeps = {
  isIos: () => boolean;
  isAvailableAsync: () => Promise<boolean>;
  signInAsync: (options: {
    nonce?: string;
    requestedScopes?: never[];
  }) => Promise<{ identityToken: string | null }>;
  createNoncePair: () => Promise<{ rawNonce: string; hashedNonce: string }>;
};

export async function requestAppleIdentityToken(
  depsPartial: Partial<AppleCredentialDeps> = {}
): Promise<AppleCredentialResult> {
  const deps: AppleCredentialDeps = {
    isIos:
      depsPartial.isIos ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Platform } = require('react-native') as typeof import('react-native');
        return Platform.OS === 'ios';
      }),
    isAvailableAsync:
      depsPartial.isAvailableAsync ??
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const AppleAuthentication =
          require('expo-apple-authentication') as typeof import('expo-apple-authentication');
        return AppleAuthentication.isAvailableAsync();
      }),
    signInAsync:
      depsPartial.signInAsync ??
      (async (options) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const AppleAuthentication =
          require('expo-apple-authentication') as typeof import('expo-apple-authentication');
        return AppleAuthentication.signInAsync({
          nonce: options.nonce,
          requestedScopes: [],
        });
      }),
    createNoncePair: depsPartial.createNoncePair ?? (() => createAppleNoncePair()),
  };

  if (!deps.isIos()) {
    return { status: 'unavailable', error: 'apple_ios_only' };
  }

  let available = false;
  try {
    available = await deps.isAvailableAsync();
  } catch (e: any) {
    return { status: 'unavailable', error: String(e?.message || e) };
  }
  if (!available) {
    return { status: 'unavailable', error: 'apple_auth_unavailable' };
  }

  let rawNonce: string;
  let hashedNonce: string;
  try {
    const pair = await deps.createNoncePair();
    rawNonce = pair.rawNonce;
    hashedNonce = pair.hashedNonce;
  } catch (e: any) {
    return { status: 'error', error: String(e?.message || e || 'nonce_generation_failed') };
  }

  try {
    const credential = await deps.signInAsync({
      // Explicit contract: Apple gets SHA-256(raw), not raw.
      nonce: hashedNonce,
      requestedScopes: [],
    });
    const token =
      typeof credential?.identityToken === 'string'
        ? credential.identityToken.trim()
        : '';
    if (!token) {
      return { status: 'missing_identity_token' };
    }
    // Return only rawNonce for Supabase; hashedNonce stays ephemeral (not returned for storage).
    return { status: 'ok', identityToken: token, rawNonce };
  } catch (e: any) {
    const code = String(e?.code || '');
    if (code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED') {
      return { status: 'canceled' };
    }
    return { status: 'error', error: String(e?.message || e || 'apple_sign_in_failed') };
  }
}
