// lib/deviceId.ts
// Lazy import to avoid initialization issues
let SecureStore: typeof import('expo-secure-store') | null = null;

const DEVICE_ID_KEY = 'receipt_scanner_device_id';

// In-memory fallback device ID (session-only, not persisted)
let _sessionDeviceId: string | null = null;

/**
 * Generate a UUID v4 without external dependencies
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get or create a stable device ID
 * Uses SecureStore to persist across app restarts, with comprehensive fallback
 */
export async function getDeviceId(): Promise<string> {
  // Lazy load SecureStore to avoid initialization crashes
  if (!SecureStore) {
    try {
      SecureStore = await import('expo-secure-store');
    } catch (e) {
      console.warn('[DeviceId] SecureStore import failed, using session fallback:', e);
      // Use session-only fallback
      if (!_sessionDeviceId) {
        _sessionDeviceId = `session-${generateUUID()}`;
      }
      return _sessionDeviceId;
    }
  }

  try {
    // Try to get existing device ID
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing && typeof existing === 'string' && existing.length > 0) {
      return existing;
    }

    // Generate new device ID (UUID v4)
    const deviceId = generateUUID();

    // Try to store for future use (non-blocking)
    try {
      await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
    } catch (storeError) {
      // If storage fails, log but continue with generated ID
      console.warn('[DeviceId] Failed to store device ID, using in-memory:', storeError);
      // Keep in memory for this session
      _sessionDeviceId = deviceId;
    }

    return deviceId;
  } catch (e: any) {
    // Comprehensive fallback: log error and return stable session ID
    console.error('[DeviceId] Failed to get/store device ID:', e?.message || e);
    
    // If we have a session ID, reuse it
    if (_sessionDeviceId) {
      return _sessionDeviceId;
    }
    
    // Generate a new session ID
    _sessionDeviceId = `fallback-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    return _sessionDeviceId;
  }
}
