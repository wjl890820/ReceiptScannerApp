/**
 * Apple ↔ Supabase ID-token nonce pair (ephemeral; never persist).
 *
 * Correct Supabase native Apple contract:
 * - AppleAuthentication.signInAsync({ nonce: hashedNonce })
 * - supabase linkIdentity / signInWithIdToken({ nonce: rawNonce })
 *
 * hashedNonce = SHA-256(rawNonce) as lowercase hex (expo-crypto default HEX).
 *
 * Do NOT pass the same raw string to both sides.
 * Do NOT treat GOTRUE_*SKIP_NONCE_CHECK as normal production setup.
 */
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
 * SHA-256 hex digest of `data`.
 * Prefers expo-crypto; falls back to Node crypto (Jest) when native module is unavailable.
 */
export async function sha256Hex(data: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Crypto = require('expo-crypto') as typeof import('expo-crypto');
    return await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      data
    );
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('crypto') as typeof import('crypto');
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }
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
