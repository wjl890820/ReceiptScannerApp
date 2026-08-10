/* eslint-disable import/first -- AsyncStorage mock must run before i18n import. */
const storage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    storage.set(key, value);
  }),
}));

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en' }],
}));

import {
  getCurrentLocale,
  getCurrentLocalePreference,
  getLocalePreference,
  initI18n,
  LOCALE_PREFERENCE_KEY,
  setLocalePreference,
  subscribeLocaleChange,
  t,
} from './i18n';

describe('locale preference persistence', () => {
  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
  });

  it('defaults to system and follows the detected locale', async () => {
    expect(await getLocalePreference()).toBe('system');
    await initI18n();
    expect(getCurrentLocalePreference()).toBe('system');
    expect(getCurrentLocale()).toBe('en');
  });

  it('persists an explicit locale and notifies listeners', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeLocaleChange(listener);

    await setLocalePreference('ja');
    expect(storage.get(LOCALE_PREFERENCE_KEY)).toBe('ja');
    expect(getCurrentLocale()).toBe('ja');
    expect(getCurrentLocalePreference()).toBe('ja');
    expect(t('settings.language.title')).toBe('言語');
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it('persists and restores an explicit locale preference', async () => {
    await setLocalePreference('zh');
    expect(storage.get(LOCALE_PREFERENCE_KEY)).toBe('zh');
    expect(await getLocalePreference()).toBe('zh');
    expect(getCurrentLocale()).toBe('zh');
    expect(t('settings.language.options.zh')).toBe('简体中文');
  });

  it('returns to system preference when selected', async () => {
    await setLocalePreference('ja');
    await setLocalePreference('system');
    expect(storage.get(LOCALE_PREFERENCE_KEY)).toBe('system');
    expect(getCurrentLocalePreference()).toBe('system');
    expect(getCurrentLocale()).toBe('en');
  });
});
