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
  const finalPlugins = hasLocalization
    ? finalPluginsAfterFont
    : [...finalPluginsAfterFont, 'expo-localization'];

  return {
    ...config,
    version: bumpPatchVersion(config.version),
    slug: 'receiptscannerapp',
    scheme: 'receiptscannerapp',
    plugins: finalPlugins,
    ios: {
      ...(config.ios ?? {}),
      bundleIdentifier: 'com.receiptscannerapp.app',
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
    },
  };
};
