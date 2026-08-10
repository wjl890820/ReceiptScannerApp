// lib/i18n.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import en from '../locales/en.json';
import ja from '../locales/ja.json';
import zh from '../locales/zh.json';

export type Locale = 'en' | 'zh' | 'ja';
export type LocalePreference = 'system' | Locale;

const translations: Record<Locale, any> = {
  en,
  zh,
  ja,
};

export const LOCALE_PREFERENCE_KEY = 'settings.localePreference.v1';

/**
 * Detect system locale and return supported locale
 * Only supports 'zh' | 'ja' | 'en', others fallback to 'en'
 */
function detectLocale(): Locale {
  try {
    const locales = Localization.getLocales();
    const systemLocale = locales?.[0]?.languageCode || 'en';

    if (systemLocale === 'zh' || systemLocale.startsWith('zh')) {
      return 'zh';
    }
    if (systemLocale === 'ja' || systemLocale.startsWith('ja')) {
      return 'ja';
    }

    return 'en';
  } catch (e) {
    // Fallback to English if Localization API fails
    console.warn('[i18n] Failed to detect locale, using English:', e);
    return 'en';
  }
}

function isLocale(value: string | null | undefined): value is Locale {
  return value === 'en' || value === 'zh' || value === 'ja';
}

function isLocalePreference(
  value: string | null | undefined
): value is LocalePreference {
  return value === 'system' || isLocale(value);
}

function resolveLocale(preference: LocalePreference): Locale {
  return preference === 'system' ? detectLocale() : preference;
}

// Initialize locale synchronously at module load (system until initI18n hydrates preference)
let currentLocale: Locale = detectLocale();
let currentPreference: LocalePreference = 'system';
let isInitialized = false;
const localeListeners = new Set<() => void>();

function notifyLocaleListeners(): void {
  for (const listener of localeListeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}

/**
 * Subscribe to locale preference / effective locale changes.
 * Used for a light root remount so screens refresh after language switch.
 */
export function subscribeLocaleChange(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

export async function getLocalePreference(): Promise<LocalePreference> {
  try {
    const stored = await AsyncStorage.getItem(LOCALE_PREFERENCE_KEY);
    if (isLocalePreference(stored)) return stored;
  } catch (e) {
    console.warn('[i18n] Failed to read locale preference:', e);
  }
  return 'system';
}

/**
 * Persist locale preference and update the effective locale immediately.
 */
export async function setLocalePreference(
  preference: LocalePreference
): Promise<Locale> {
  currentPreference = preference;
  currentLocale = resolveLocale(preference);
  try {
    await AsyncStorage.setItem(LOCALE_PREFERENCE_KEY, preference);
  } catch (e) {
    console.warn('[i18n] Failed to save locale preference:', e);
  }
  notifyLocaleListeners();
  return currentLocale;
}

/**
 * Initialize i18n (call this before app renders)
 * Returns a promise that resolves when initialization is complete
 */
export async function initI18n(): Promise<void> {
  if (isInitialized) {
    return;
  }

  try {
    currentPreference = await getLocalePreference();
    currentLocale = resolveLocale(currentPreference);
  } catch (e) {
    console.warn('[i18n] Failed to initialize preference, using system:', e);
    currentPreference = 'system';
    currentLocale = detectLocale();
  }
  isInitialized = true;
}

/**
 * Get current locale (synchronous, always available after initI18n)
 */
export function getCurrentLocale(): Locale {
  return currentLocale;
}

export function getCurrentLocalePreference(): LocalePreference {
  return currentPreference;
}

function getNestedValue(obj: any, path: string): string | undefined {
  const keys = path.split('.');
  let current: any = obj;

  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }

  return typeof current === 'string' ? current : undefined;
}

export function t(key: string, params?: Record<string, string | number>): string {
  try {
    const locale = getCurrentLocale();
    const localeTranslations = translations[locale] || translations.en;
    let value = getNestedValue(localeTranslations, key);
    if (!value) {
      // Fallback to English
      value = getNestedValue(translations.en, key);
    }

    if (!value) {
      // Last resort: return key
      return key;
    }

    // Replace placeholders if params provided
    if (params) {
      return value.replace(/\{(\w+)\}/g, (match, paramKey) => {
        return params[paramKey] !== undefined ? String(params[paramKey]) : match;
      });
    }

    return value;
  } catch (e) {
    // Ultimate fallback: return key if translation fails
    console.warn('[i18n] Translation failed for key:', key, e);
    return key;
  }
}
