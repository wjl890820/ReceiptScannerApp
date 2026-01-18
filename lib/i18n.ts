// lib/i18n.ts
// Lazy import to avoid initialization crashes on iOS
let Localization: typeof import('expo-localization') | null = null;

import en from '../locales/en.json';
import ja from '../locales/ja.json';
import zh from '../locales/zh.json';

type Locale = 'en' | 'zh' | 'ja';

const translations: Record<Locale, any> = {
  en,
  zh,
  ja,
};

async function detectLocale(): Promise<Locale> {
  // Lazy load Localization to avoid initialization crashes
  if (!Localization) {
    try {
      Localization = await import('expo-localization');
    } catch (e) {
      console.warn('[i18n] Failed to import Localization, using English:', e);
      return 'en';
    }
  }

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

// Delay locale detection until first use to avoid initialization crashes
let currentLocale: Locale | null = null;
let localePromise: Promise<Locale> | null = null;

function getCurrentLocaleInternal(): Locale {
  // Synchronous fallback: return cached locale or default to 'en'
  if (currentLocale !== null) {
    return currentLocale;
  }
  
  // If not cached, start async detection but return 'en' immediately
  if (!localePromise) {
    localePromise = detectLocale().then((locale) => {
      currentLocale = locale;
      return locale;
    }).catch(() => {
      currentLocale = 'en';
      return 'en';
    });
  }
  
  // Return default while detection is in progress
  return 'en';
}

export function getCurrentLocale(): Locale {
  return getCurrentLocaleInternal();
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
    const locale = getCurrentLocaleInternal();
    const localeTranslations = translations[locale];
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
