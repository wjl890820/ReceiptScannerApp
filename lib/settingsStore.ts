// lib/settingsStore.ts
// Lightweight settings store using SecureStore
// Persists user preferences across app restarts

let SecureStore: typeof import('expo-secure-store') | null = null;

const HOME_TIME_RANGE_KEY = 'home_time_range';

/**
 * Get home time range preference (7D | 30D | ALL)
 * Defaults to '7D' if not set
 */
export async function getHomeTimeRange(): Promise<'7D' | '30D' | 'ALL'> {
  try {
    if (!SecureStore) {
      SecureStore = await import('expo-secure-store');
    }

    const stored = await SecureStore.getItemAsync(HOME_TIME_RANGE_KEY);
    if (stored === '7D' || stored === '30D' || stored === 'ALL') {
      return stored;
    }
  } catch (e) {
    // If SecureStore fails, fallback to default
    if (__DEV__) {
      console.warn('[SettingsStore] Failed to get home time range, using default:', e);
    }
  }

  return '7D';
}

/**
 * Set home time range preference
 */
export async function setHomeTimeRange(range: '7D' | '30D' | 'ALL'): Promise<void> {
  try {
    if (!SecureStore) {
      SecureStore = await import('expo-secure-store');
    }

    await SecureStore.setItemAsync(HOME_TIME_RANGE_KEY, range);
  } catch (e) {
    // If SecureStore fails, log but don't throw (non-critical)
    if (__DEV__) {
      console.warn('[SettingsStore] Failed to save home time range:', e);
    }
  }
}
