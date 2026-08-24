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

/**
 * OCR Gemini model (Edge + DEV direct Gemini).
 * Prefer OCR_GEMINI_MODEL (to avoid conflicting with other modules like classify-item).
 * Default: gemini-3.5-flash-lite — SEPARATE from semantic classify-items model.
 */
export function getOcrGeminiModel(): string {
  return getExtraValue('OCR_GEMINI_MODEL') || getExtraValue('ocrGeminiModel') || 'gemini-3.5-flash-lite';
}

/**
 * Semantic classify-items Gemini model SSOT (client mirror of Edge GEMINI_MODEL).
 * Default: gemini-3.5-flash — NEVER fall back to OCR_GEMINI_MODEL.
 */
export const DEFAULT_SEMANTIC_GEMINI_MODEL = 'gemini-3.5-flash' as const;

export function getSemanticGeminiModel(): string {
  return (
    getExtraValue('SEMANTIC_GEMINI_MODEL') ||
    getExtraValue('EXPO_PUBLIC_SEMANTIC_GEMINI_MODEL') ||
    getExtraValue('GEMINI_MODEL') ||
    getExtraValue('semanticGeminiModel') ||
    DEFAULT_SEMANTIC_GEMINI_MODEL
  );
}

export function getCategoryAiItemCap(): number {
  const v = getExtraValue('CATEGORY_AI_ITEM_CAP', '3');
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

export function getCategoryAiTimeoutMs(): number {
  const v = getExtraValue('CATEGORY_AI_TIMEOUT_MS', '3500');
  const n = Number(v);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 3500;
}

export function getCategoryAiRetries(): number {
  const v = getExtraValue('CATEGORY_AI_RETRIES', '0');
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Batch AI fallback (classify-items): 单张小票最多一次请求的整体超时。
 * 比逐项 classify-item 更长（一次请求承载多商品），默认 9000ms。
 */
export function getCategoryBatchAiTimeoutMs(): number {
  const v = getExtraValue('CATEGORY_BATCH_AI_TIMEOUT_MS', '9000');
  const n = Number(v);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 9000;
}

/** Batch AI fallback：单张小票最多发送的 uncategorized 商品数上限（默认 40）。 */
export function getCategoryBatchAiMaxItems(): number {
  const v = getExtraValue('CATEGORY_BATCH_AI_MAX_ITEMS', '40');
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 40;
}

function parseEnvBool(raw: string, defaultValue: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return defaultValue;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultValue;
}

/**
 * Batch AI 分类 fallback 开关（ENABLE_BATCH_AI_CLASSIFICATION）。
 * 默认 true，保持与当前生产行为兼容；设为 false/0/off 时跳过 classify-items。
 */
export function isBatchAiClassificationEnabled(): boolean {
  const fromEnv =
    _envVar('ENABLE_BATCH_AI_CLASSIFICATION') ||
    _envVar('EXPO_PUBLIC_ENABLE_BATCH_AI_CLASSIFICATION');
  if (fromEnv) return parseEnvBool(fromEnv, true);
  const fromExtra = getExtraValue('ENABLE_BATCH_AI_CLASSIFICATION', '');
  if (fromExtra) return parseEnvBool(fromExtra, true);
  return true;
}

/**
 * P0 Anonymous Auth + installation identity (ENABLE_ANON_AUTH).
 * Default OFF — Build 34-like behavior until explicitly enabled.
 */
export function isAnonAuthEnabled(): boolean {
  const fromEnv =
    _envVar('ENABLE_ANON_AUTH') ||
    _envVar('EXPO_PUBLIC_ENABLE_ANON_AUTH');
  if (fromEnv) return parseEnvBool(fromEnv, false);
  const fromExtra = getExtraValue('ENABLE_ANON_AUTH', '');
  if (fromExtra) return parseEnvBool(fromExtra, false);
  return false;
}

/**
 * P0 cloud receipt backup worker flush (ENABLE_CLOUD_BACKUP).
 * Default OFF. Outbox intents are still written when schema is present;
 * this flag only gates network flush.
 */
export function isCloudBackupEnabled(): boolean {
  const fromEnv =
    _envVar('ENABLE_CLOUD_BACKUP') ||
    _envVar('EXPO_PUBLIC_ENABLE_CLOUD_BACKUP');
  if (fromEnv) return parseEnvBool(fromEnv, false);
  const fromExtra = getExtraValue('ENABLE_CLOUD_BACKUP', '');
  if (fromExtra) return parseEnvBool(fromExtra, false);
  return false;
}

/**
 * P0 Sign in with Apple protect/restore UI + flows (ENABLE_APPLE_LINK).
 * Default OFF until internal validation.
 */
export function isAppleLinkEnabled(): boolean {
  const fromEnv =
    _envVar('ENABLE_APPLE_LINK') ||
    _envVar('EXPO_PUBLIC_ENABLE_APPLE_LINK');
  if (fromEnv) return parseEnvBool(fromEnv, false);
  const fromExtra = getExtraValue('ENABLE_APPLE_LINK', '');
  if (fromExtra) return parseEnvBool(fromExtra, false);
  return false;
}

/**
 * Analysis D real-data diagnostics (ENABLE_ANALYSIS_D_DIAGNOSTICS).
 * Default OFF. When ON in a validation build, Settings may expose a
 * read-only report generate / summary / manual JSON share action.
 * Never auto-uploads; never enters Product Analytics / Supabase telemetry.
 */
export function isAnalysisDDiagnosticsEnabled(): boolean {
  const fromEnv =
    _envVar('ENABLE_ANALYSIS_D_DIAGNOSTICS') ||
    _envVar('EXPO_PUBLIC_ENABLE_ANALYSIS_D_DIAGNOSTICS');
  if (fromEnv) return parseEnvBool(fromEnv, false);
  const fromExtra = getExtraValue('ENABLE_ANALYSIS_D_DIAGNOSTICS', '');
  if (fromExtra) return parseEnvBool(fromExtra, false);
  return false;
}

/**
 * Product Identity Batch 5B — identity-backed price history + frequent products.
 * Default ON for this branch; set ENABLE_PRODUCT_IDENTITY_PRICE_HISTORY_V1=0 to
 * force legacy consumers immediately.
 */
export function isProductIdentityPriceHistoryV1Enabled(): boolean {
  const fromEnv =
    _envVar('ENABLE_PRODUCT_IDENTITY_PRICE_HISTORY_V1') ||
    _envVar('EXPO_PUBLIC_ENABLE_PRODUCT_IDENTITY_PRICE_HISTORY_V1');
  if (fromEnv) return parseEnvBool(fromEnv, true);
  const fromExtra = getExtraValue('ENABLE_PRODUCT_IDENTITY_PRICE_HISTORY_V1', '');
  if (fromExtra) return parseEnvBool(fromExtra, true);
  return true;
}

/**
 * 获取备用反馈邮箱（用于 send-feedback 不可用时的兜底渠道）。
 */
export function getSupportEmail(): string {
  return (
    _envVar('EXPO_PUBLIC_SUPPORT_EMAIL') ||
    _envVar('SUPPORT_EMAIL') ||
    getExtraValue('SUPPORT_EMAIL') ||
    getExtraValue('supportEmail') ||
    ''
  );
}
