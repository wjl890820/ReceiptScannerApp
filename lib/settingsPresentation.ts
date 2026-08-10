/**
 * Presentation helpers for the Settings release surface.
 * Visibility / labels / metadata display only — no DB mutations.
 */

import type { Locale } from './i18n';

export type LocalePreference = 'system' | Locale;

export function shouldShowSettingsDevTools(
  unlocked: boolean,
  isDevBuild: boolean
): boolean {
  return Boolean(unlocked || isDevBuild);
}

/**
 * Secret About-area tap unlock is intentional only for development /
 * internal builds. Production Release must not unlock by accident.
 */
export function canUnlockDevToolsViaSecretTap(isDevBuild: boolean): boolean {
  return Boolean(isDevBuild);
}

/** Coming-soon Pro is hidden from the normal release Settings list. */
export function shouldShowSettingsProEntry(options: {
  comingSoon: boolean;
}): boolean {
  return !options.comingSoon;
}

export function resolveInstalledAppMetadata(source: {
  nativeAppVersion?: string | null;
  nativeBuildVersion?: string | null;
  expoConfig?: {
    version?: string | null;
    name?: string | null;
    ios?: { buildNumber?: string | null } | null;
  } | null;
  manifest2?: {
    extra?: { expoClient?: { name?: string | null } | null } | null;
  } | null;
}): { name: string; version: string; build: string } {
  const nativeVersion = String(source.nativeAppVersion ?? '').trim();
  const nativeBuild = String(source.nativeBuildVersion ?? '').trim();
  const cfgVersion = String(source.expoConfig?.version ?? '').trim();
  const name = String(
    source.expoConfig?.name ||
      source.manifest2?.extra?.expoClient?.name ||
      'Receipt Scanner'
  ).trim();

  // Build must come from the installed native binary.
  // Never fall back to expoConfig.ios.buildNumber — that value commonly lags
  // behind TestFlight / App Store binaries (and embeds repo app.json).
  return {
    name: name || 'Receipt Scanner',
    version: nativeVersion || cfgVersion || '—',
    build: nativeBuild || '—',
  };
}

export function formatAboutVersionLine(
  version: string,
  build: string
): string {
  const safeVersion = version && version !== 'unknown' ? version : '—';
  const safeBuild = build && build !== 'unknown' && build !== '—' ? build : null;
  return safeBuild ? `${safeVersion} (${safeBuild})` : safeVersion;
}

export function localePreferenceLabelKey(
  preference: LocalePreference
): string {
  switch (preference) {
    case 'system':
      return 'settings.language.options.system';
    case 'zh':
      return 'settings.language.options.zh';
    case 'ja':
      return 'settings.language.options.ja';
    case 'en':
      return 'settings.language.options.en';
  }
}

/** Release Settings rows must never surface these engineering tokens. */
export const SETTINGS_RELEASE_FORBIDDEN_TOKENS = [
  'normalized_name',
  'canonical_name',
  'product_dictionary',
  'trace_id',
  'currentVersion',
  'currentBuild',
  'devToolsEnabled',
  'Default receipt source',
] as const;
