// lib/deviceId.ts
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

const DEVICE_ID_KEY = 'receipt_scanner_device_id';

/**
 * Get or create a stable device ID
 * Uses SecureStore to persist across app restarts
 */
export async function getDeviceId(): Promise<string> {
  try {
    // Try to get existing device ID
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing && typeof existing === 'string' && existing.length > 0) {
      return existing;
    }

    // Generate new device ID (UUID v4)
    // Simple UUID v4 generation (good enough for our use case)
    const deviceId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });

    // Store for future use
    await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);

    return deviceId;
  } catch (e) {
    // Fallback if SecureStore fails
    console.error('Failed to get/store device ID:', e);
    // Generate a temporary ID (will be different each time, but better than nothing)
    return `temp-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}
