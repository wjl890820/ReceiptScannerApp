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
    if (Constants.manifest?.extra) {
      return Constants.manifest.extra as Record<string, any>;
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

/**
 * Get Supabase URL from Expo extra
 */
export function getSupabaseUrl(): string {
  return getExtraValue('SUPABASE_URL') || getExtraValue('supabaseUrl');
}

/**
 * Get Supabase Anon Key from Expo extra
 */
export function getSupabaseAnonKey(): string {
  return getExtraValue('SUPABASE_ANON_KEY') || getExtraValue('supabaseAnonKey');
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
