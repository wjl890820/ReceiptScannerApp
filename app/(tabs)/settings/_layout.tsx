import { Stack } from 'expo-router';

/**
 * Build 53 — Settings nested stack for subordinate push pages.
 * Enables native edge-swipe and preserves return to Settings.
 */
export default function SettingsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: true,
        animation: 'slide_from_right',
      }}
    />
  );
}
