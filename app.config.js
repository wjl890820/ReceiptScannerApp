import 'dotenv/config';

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
  const finalPlugins = hasSecureStore
    ? plugins
    : [...plugins, 'expo-secure-store'];

  return {
    ...config,
    slug: 'receiptscannerapp',
    scheme: 'receiptscannerapp',
    plugins: finalPlugins,
    ios: {
      ...(config.ios ?? {}),
      bundleIdentifier: 'com.receiptscannerapp.app',
      buildNumber: '2',
    },
    android: {
      ...(config.android ?? {}),
      package: 'com.receiptscannerapp.app',
      versionCode: 2,
    },
    extra: {
      ...(config.extra ?? {}),
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    },
  };
};
