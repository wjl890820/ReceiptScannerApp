import AsyncStorage from '@react-native-async-storage/async-storage';

export type ReceiptSource = 'self' | 'family' | 'friend' | 'found' | 'test' | 'unknown';

export const DEFAULT_RECEIPT_SOURCE_KEY = 'settings.defaultReceiptSource.v1';

export async function getDefaultReceiptSource(): Promise<ReceiptSource> {
  try {
    const v = await AsyncStorage.getItem(DEFAULT_RECEIPT_SOURCE_KEY);
    const s = String(v || '').trim();
    if (s === 'self' || s === 'family' || s === 'friend' || s === 'found' || s === 'test') return s;
    return 'self';
  } catch {
    return 'self';
  }
}

export async function setDefaultReceiptSource(source: ReceiptSource): Promise<void> {
  const s: ReceiptSource =
    source === 'self' || source === 'family' || source === 'friend' || source === 'found' || source === 'test'
      ? source
      : 'self';
  try {
    await AsyncStorage.setItem(DEFAULT_RECEIPT_SOURCE_KEY, s);
  } catch {
    // ignore
  }
}

