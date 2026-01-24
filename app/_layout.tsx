import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { initI18n } from '@/lib/i18n';

// Prevent auto-hiding splash screen until i18n is ready
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function prepare() {
      try {
        // Initialize i18n before rendering
        await initI18n();
      } catch (e) {
        console.warn('[RootLayout] Failed to initialize i18n:', e);
      } finally {
        // Hide splash screen after i18n is ready
        setIsReady(true);
        await SplashScreen.hideAsync();
      }
    }

    prepare();
  }, []);

  if (!isReady) {
    return null; // Keep splash screen visible
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
