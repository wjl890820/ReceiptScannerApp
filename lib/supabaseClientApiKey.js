/**
 * Pure project-API-key checks shared by the app and app.config.js.
 * No Expo/React Native imports. JWT payload role is not signature-verified.
 */
'use strict';

const PUBLISHABLE_CLIENT_KEY = /^sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function isBase64UrlSegment(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return false;
  if (!BASE64URL_SEGMENT.test(segment)) return false;
  // A remainder of 1 is not a valid base64 quantum, with or without padding.
  if (segment.length % 4 === 1) return false;
  return true;
}

function decodeUnverifiedJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || !parts.every(isBase64UrlSegment)) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    let json;
    if (typeof globalThis.atob === 'function') {
      const binary = globalThis.atob(padded);
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0) & 0xff);
      json = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(bytes) : binary;
    } else if (typeof globalThis.Buffer !== 'undefined') {
      json = globalThis.Buffer.from(padded, 'base64').toString('utf8');
    } else {
      return null;
    }
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSupportedSupabaseClientApiKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.trim() !== key) return false;
  if (key.startsWith('sb_secret_')) return false;
  if (PUBLISHABLE_CLIENT_KEY.test(key)) return true;
  if (!key.startsWith('eyJ')) return false;
  const payload = decodeUnverifiedJwtPayload(key);
  return payload != null && payload.role === 'anon';
}

/**
 * Config-time gate.
 * undefined, null, and exact '' stay absent.
 * Any other present value must be a supported client key.
 * Whitespace-only and surrounding whitespace are present-but-invalid.
 * Thrown text never includes the credential.
 */
function embeddableSupabaseClientApiKey(raw) {
  if (raw == null || raw === '') return raw;
  if (typeof raw !== 'string' || !isSupportedSupabaseClientApiKey(raw)) {
    throw new Error(
      'Refusing to embed an unsupported Supabase client API key into Expo config.'
    );
  }
  return raw;
}

/**
 * Same selection app.config.js uses for Expo extra.supabaseAnonKey.
 * EXPO_PUBLIC_SUPABASE_ANON_KEY wins over SUPABASE_ANON_KEY, including ''.
 */
function configuredExpoSupabaseAnonKey(env) {
  const source = env && typeof env === 'object' ? env : {};
  return embeddableSupabaseClientApiKey(
    source.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? source.SUPABASE_ANON_KEY
  );
}

module.exports = {
  isSupportedSupabaseClientApiKey,
  embeddableSupabaseClientApiKey,
  configuredExpoSupabaseAnonKey,
  decodeUnverifiedJwtPayload,
};
