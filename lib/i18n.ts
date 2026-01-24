// lib/i18n.ts
import * as Localization from 'expo-localization';
import en from '../locales/en.json';
import ja from '../locales/ja.json';
import zh from '../locales/zh.json';

export type Locale = 'en' | 'zh' | 'ja';

const translations: Record<Locale, any> = {
  en,
  zh,
  ja,
};

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

// Initialize locale synchronously at module load
let currentLocale: Locale = detectLocale();
let isInitialized = false;

/**
 * Initialize i18n (call this before app renders)
 * Returns a promise that resolves when initialization is complete
 */
export async function initI18n(): Promise<void> {
  if (isInitialized) {
    return;
  }
  
  // Re-detect locale to ensure we have the latest system language
  currentLocale = detectLocale();
  isInitialized = true;
}

/**
 * Get current locale (synchronous, always available after initI18n)
 */
export function getCurrentLocale(): Locale {
  return currentLocale;
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
