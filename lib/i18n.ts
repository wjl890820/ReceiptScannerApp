// lib/i18n.ts
import * as Localization from 'expo-localization';
import en from '../locales/en.json';
import ja from '../locales/ja.json';
import zh from '../locales/zh.json';

type Locale = 'en' | 'zh' | 'ja';

const translations: Record<Locale, any> = {
  en,
  zh,
  ja,
};

function detectLocale(): Locale {
  const systemLocale = Localization.getLocales()[0]?.languageCode || 'en';
  
  if (systemLocale === 'zh' || systemLocale.startsWith('zh')) {
    return 'zh';
  }
  if (systemLocale === 'ja' || systemLocale.startsWith('ja')) {
    return 'ja';
  }
  
  return 'en';
}

const currentLocale = detectLocale();

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
  const localeTranslations = translations[currentLocale];
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
}
