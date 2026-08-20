/**
 * App installation identity — distinct from auth.uid() and legacy x-device-id.
 *
 * Storage: AsyncStorage (app sandbox). Cleared on uninstall/reinstall → new ID.
 * Do NOT use SecureStore/Keychain (may survive uninstall on some platforms).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const INSTALLATION_ID_STORAGE_KEY = 'p0_installation_id_v1';

let _memoryInstallationId: string | null = null;

function generateInstallationId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // UUID v4 fallback without SecureStore / external deps
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export type InstallationIdStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

/**
 * Get or create a stable installation_id for this app install.
 * Same install → same ID; uninstall/reinstall → new ID (AsyncStorage wiped).
 */
export async function getOrCreateInstallationId(
  storage: InstallationIdStorage = AsyncStorage
): Promise<string> {
  if (_memoryInstallationId) {
    return _memoryInstallationId;
  }

  try {
    const existing = await storage.getItem(INSTALLATION_ID_STORAGE_KEY);
    if (existing && typeof existing === 'string' && existing.trim().length > 0) {
      _memoryInstallationId = existing.trim();
      return _memoryInstallationId;
    }
  } catch (e) {
    console.warn('[InstallationId] read failed, generating new id:', e);
  }

  const id = generateInstallationId();
  _memoryInstallationId = id;

  try {
    await storage.setItem(INSTALLATION_ID_STORAGE_KEY, id);
  } catch (e) {
    console.warn('[InstallationId] persist failed; using in-memory id for this process:', e);
  }

  return id;
}

/** Test-only memory reset. */
export function __resetInstallationIdMemoryForTests(): void {
  _memoryInstallationId = null;
}
