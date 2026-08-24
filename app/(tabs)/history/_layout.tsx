import { Stack } from 'expo-router';

/**
 * Build 53 — History nested stack.
 * Receipt Detail must be a PUSH screen (native iOS edge-swipe + correct goBack),
 * not a sibling Tabs route that breaks parent return context.
 */
export default function HistoryStackLayout() {
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
