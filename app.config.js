// 确保 dotenv 配置在顶部执行
require('dotenv').config();

/** Semver x.y.z：仅递增 patch（如 1.0.4 → 1.0.5） */
function bumpPatchVersion(version) {
  const s = String(version ?? '1.0.0').trim();
  const parts = s.split('.');
  if (parts.length >= 3) {
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1], 10);
    const patch = parseInt(parts[2], 10);
    if ([major, minor, patch].every((n) => Number.isFinite(n))) {
      return `${major}.${minor}.${patch + 1}`;
    }
  }
  return '1.0.1';
}

export default ({ config }) => {
  // Safe plugins merge: avoid duplicates
  const existingPlugins = config.plugins ?? [];
  const hasWebBrowser = existingPlugins.some(
    (plugin) =>
      plugin === 'expo-web-browser' ||
      (Array.isArray(plugin) && plugin[0] === 'expo-web-browser')
  );
  const plugins = hasWebBrowser
    ? existingPlugins
    : [...existingPlugins, 'expo-web-browser'];

  // Add expo-secure-store plugin if not already present
  const hasSecureStore = plugins.some(
    (plugin) =>
      plugin === 'expo-secure-store' ||
      (Array.isArray(plugin) && plugin[0] === 'expo-secure-store')
  );
  const finalPluginsAfterSecure = hasSecureStore
    ? plugins
    : [...plugins, 'expo-secure-store'];

  const hasFont = finalPluginsAfterSecure.some(
    (plugin) =>
      plugin === 'expo-font' ||
      (Array.isArray(plugin) && plugin[0] === 'expo-font')
  );
  const finalPluginsAfterFont = hasFont
    ? finalPluginsAfterSecure
    : [...finalPluginsAfterSecure, 'expo-font'];

  const hasLocalization = finalPluginsAfterFont.some(
    (plugin) =>
      plugin === 'expo-localization' ||
      (Array.isArray(plugin) && plugin[0] === 'expo-localization')
  );
  const finalPluginsAfterLocalization = hasLocalization
    ? finalPluginsAfterFont
    : [...finalPluginsAfterFont, 'expo-localization'];

  const hasAppleAuth = finalPluginsAfterLocalization.some(
    (plugin) =>
      plugin === 'expo-apple-authentication' ||
      (Array.isArray(plugin) && plugin[0] === 'expo-apple-authentication')
  );
  const finalPlugins = hasAppleAuth
    ? finalPluginsAfterLocalization
    : [...finalPluginsAfterLocalization, 'expo-apple-authentication'];

  return {
    ...config,
    version: bumpPatchVersion(config.version),
    slug: 'receiptscannerapp',
    scheme: 'receiptscannerapp',
    plugins: finalPlugins,
    ios: {
      ...(config.ios ?? {}),
      bundleIdentifier: 'com.receiptscannerapp.app',
      usesAppleSignIn: true,
    },
    android: {
      ...(config.android ?? {}),
      package: 'com.receiptscannerapp.app',
    },
    extra: {
      ...(config.extra ?? {}),
      SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY,
      // GEMINI_API_KEY 已移除：客户端不再需要，OCR 通过 Supabase Edge Function 处理
      // 仅开发调试时可通过 DEV_DIRECT_GEMINI=true 启用直连 Gemini fallback
      DEV_DIRECT_GEMINI: process.env.DEV_DIRECT_GEMINI || 'false',
      // P0 Phase 3: anonymous auth + installation identity (default OFF)
      ENABLE_ANON_AUTH: process.env.ENABLE_ANON_AUTH || process.env.EXPO_PUBLIC_ENABLE_ANON_AUTH || 'false',
      // P0 Phase 5: cloud backup worker flush (default OFF); outbox still written locally
      ENABLE_CLOUD_BACKUP:
        process.env.ENABLE_CLOUD_BACKUP || process.env.EXPO_PUBLIC_ENABLE_CLOUD_BACKUP || 'false',
      // P0 Phase 7: Apple protect/restore flows (default OFF)
      ENABLE_APPLE_LINK:
        process.env.ENABLE_APPLE_LINK || process.env.EXPO_PUBLIC_ENABLE_APPLE_LINK || 'false',
      // Analysis D real-data diagnostics (default OFF). Validation builds set true.
      ENABLE_ANALYSIS_D_DIAGNOSTICS:
        process.env.ENABLE_ANALYSIS_D_DIAGNOSTICS ||
        process.env.EXPO_PUBLIC_ENABLE_ANALYSIS_D_DIAGNOSTICS ||
        'false',
      // Internal Diagnostics V1 timeline export (default OFF). Validation builds set true.
      // __DEV__ also enables at runtime via isInternalDiagnosticsEnabled().
      ENABLE_INTERNAL_DIAGNOSTICS:
        process.env.ENABLE_INTERNAL_DIAGNOSTICS ||
        process.env.EXPO_PUBLIC_ENABLE_INTERNAL_DIAGNOSTICS ||
        'false',
    },
  };
};
