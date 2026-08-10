import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { initI18n, subscribeLocaleChange } from '@/lib/i18n';
import { runCategoryBackfillOnceOnStartup } from '@/lib/categoryBackfill';
import { runReceiptItemIndexMaintenanceBatch } from '@/lib/db';

// Prevent auto-hiding splash screen until i18n is ready
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const [localeEpoch, setLocaleEpoch] = useState(0);

  useEffect(() => {
    async function prepare() {
      try {
        await initI18n();
      } catch (e) {
        console.warn('[RootLayout] Failed to initialize i18n:', e);
      } finally {
        setIsReady(true);
        await SplashScreen.hideAsync();
        // UI 已可交互后串行执行维护：先完成既有 category mutation，
        // 再 best-effort 跑一个小批次 derived-index backfill。
        void runCategoryBackfillOnceOnStartup()
          .catch(() => {})
          .then(() => runReceiptItemIndexMaintenanceBatch())
          .catch(() => {});
      }
    }

    prepare();
  }, []);

  useEffect(() => {
    return subscribeLocaleChange(() => {
      setLocaleEpoch((value) => value + 1);
    });
  }, []);

  // Do not render app until i18n is ready (avoids English flash on zh/ja)
  if (!isReady) {
    return null;
  }

  return (
    <Stack key={localeEpoch} screenOptions={{ headerShown: false }} />
  );
}
