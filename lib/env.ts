// lib/env.ts
// Unified helper to read Expo extra configuration across SDK variants
import Constants from 'expo-constants';

/**
 * Get Expo extra configuration with fallback support for different SDK versions
 * Prefers Constants.expoConfig?.extra, falls back to Constants.manifest?.extra,
 * and Constants.manifest2?.extra if present
 */
export function getExtra(): Record<string, any> {
  try {
    // Prefer expoConfig (SDK 49+)
    if (Constants.expoConfig?.extra) {
      return Constants.expoConfig.extra as Record<string, any>;
    }
    
    // Fallback to manifest (older SDKs / Expo Go)
    const manifest = Constants.manifest as any;
    if (manifest?.extra) {
      return manifest.extra as Record<string, any>;
    }
    
    // Fallback to manifest2 (if present, SDK 50+)
    const manifest2 = (Constants as any).manifest2;
    if (manifest2?.extra) {
      return manifest2.extra as Record<string, any>;
    }
    
    return {};
  } catch (e) {
    console.error('[Env] Failed to get extra from Constants:', e);
    return {};
  }
}

/**
 * Get a specific value from Expo extra
 */
export function getExtraValue(key: string, fallback: string = ''): string {
  const extra = getExtra();
  const value = extra[key] ?? extra[key.toLowerCase()] ?? fallback;
  return typeof value === 'string' ? value.trim() : String(value || fallback).trim();
}

function _envVar(key: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : '';
}

let _supabaseCached: { url: string; key: string } | null = null;
let _supabaseConfigLogged = false;

function _getSupabaseConfig(): { url: string; key: string } {
  if (_supabaseCached) return _supabaseCached;
  const url =
    _envVar('EXPO_PUBLIC_SUPABASE_URL') ||
    _envVar('SUPABASE_URL') ||
    getExtraValue('SUPABASE_URL') ||
    getExtraValue('supabaseUrl');
  const key =
    _envVar('EXPO_PUBLIC_SUPABASE_ANON_KEY') ||
    _envVar('SUPABASE_ANON_KEY') ||
    getExtraValue('SUPABASE_ANON_KEY') ||
    getExtraValue('supabaseAnonKey');
  _supabaseCached = { url: typeof url === 'string' ? url.trim() : '', key: typeof key === 'string' ? key.trim() : '' };
  if (__DEV__ && !_supabaseConfigLogged) {
    _supabaseConfigLogged = true;
    // eslint-disable-next-line no-console
    console.log(
      '[Env] Supabase URL:',
      _supabaseCached.url ? 'configured' : 'not set',
      '| Anon key:',
      _supabaseCached.key ? 'configured' : 'not set'
    );
  }
  return _supabaseCached;
}

/**
 * Get Supabase URL: EXPO_PUBLIC_SUPABASE_URL ?? SUPABASE_URL ?? extra
 */
export function getSupabaseUrl(): string {
  return _getSupabaseConfig().url;
}

/**
 * Get Supabase Anon Key: EXPO_PUBLIC_SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY ?? extra
 */
export function getSupabaseAnonKey(): string {
  return _getSupabaseConfig().key;
}

/**
 * 判断 key 是否为 JWT 形态（eyJ 开头且含 .），用于区分 Legacy anon key 与 publishable key。
 * 若用户误填 sb_publishable_... 会导致 Edge Functions 401 Invalid JWT。
 */
export function isJwtLike(key: string | undefined): boolean {
  return typeof key === 'string' && key.startsWith('eyJ') && key.includes('.');
}

/**
 * Check if DEV_DIRECT_GEMINI is enabled (only in dev mode)
 */
export function isDevDirectGeminiEnabled(): boolean {
  if (!__DEV__) return false;
  const value = getExtraValue('DEV_DIRECT_GEMINI', 'false');
  return value.toLowerCase() === 'true';
}

/**
 * Get Gemini API Key from Expo extra (only if DEV_DIRECT_GEMINI is enabled)
 */
export function getGeminiApiKey(): string {
  if (!isDevDirectGeminiEnabled()) return '';
  return getExtraValue('GEMINI_API_KEY') || getExtraValue('geminiApiKey');
}
