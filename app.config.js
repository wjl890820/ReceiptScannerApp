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

  return {
    ...config,
    slug: 'receiptscannerapp',
    scheme: 'receiptscannerapp',
    plugins,
    ios: {
      ...(config.ios ?? {}),
      bundleIdentifier: 'com.receiptscannerapp.app',
      buildNumber: '1',
    },
    android: {
      ...(config.android ?? {}),
      package: 'com.receiptscannerapp.app',
      versionCode: 1,
    },
    extra: {
      ...(config.extra ?? {}),
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    },
  };
};
