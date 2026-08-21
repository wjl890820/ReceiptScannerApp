/**
 * Apple ↔ Supabase ID-token nonce pair (ephemeral; never persist).
 *
 * Correct Supabase native Apple contract:
 * - AppleAuthentication.signInAsync({ nonce: hashedNonce })
 * - supabase linkIdentity / signInWithIdToken({ nonce: rawNonce })
 *
 * hashedNonce = SHA-256(rawNonce) as lowercase hex (expo-crypto HEX).
 *
 * Do NOT pass the same raw string to both sides.
 * Do NOT treat GOTRUE_*SKIP_NONCE_CHECK as normal production setup.
 * Do NOT use Node built-in `crypto` here — Metro / RN cannot resolve it.
 */
import * as ExpoCrypto from 'expo-crypto';

export type AppleNoncePair = {
  rawNonce: string;
  hashedNonce: string;
};

export type AppleNonceDeps = {
  generateRaw: () => string;
  sha256Hex: (data: string) => Promise<string>;
};

/** Cryptographically strong raw nonce (hex / UUID). Never reuse across attempts. */
export function generateAppleRawNonce(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (Math.random() * 256) | 0;
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 hex digest of `data` via expo-crypto (native / RN runtime).
 * Always returns lowercase hex (64 chars for SHA-256).
 */
export async function sha256Hex(data: string): Promise<string> {
  const digest = await ExpoCrypto.digestStringAsync(
    ExpoCrypto.CryptoDigestAlgorithm.SHA256,
    data
  );
  return String(digest).toLowerCase();
}

/** Create a one-shot raw/hashed nonce pair for a single Apple authorization attempt. */
export async function createAppleNoncePair(
  depsPartial: Partial<AppleNonceDeps> = {}
): Promise<AppleNoncePair> {
  const generateRaw = depsPartial.generateRaw ?? generateAppleRawNonce;
  const digest = depsPartial.sha256Hex ?? sha256Hex;
  const rawNonce = generateRaw();
  if (!rawNonce || typeof rawNonce !== 'string') {
    throw new Error('nonce_generation_failed');
  }
  const hashedNonce = await digest(rawNonce);
  if (!hashedNonce || hashedNonce === rawNonce) {
    throw new Error('nonce_hash_failed');
  }
  return { rawNonce, hashedNonce };
}
