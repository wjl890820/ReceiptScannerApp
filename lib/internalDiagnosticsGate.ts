/**
 * Internal diagnostics enablement gate — SINGLE SSOT.
 *
 * - development (__DEV__): enabled
 * - EAS "validation" profile: ENABLE_INTERNAL_DIAGNOSTICS=true
 * - production / preview default: disabled
 *
 * Do not duplicate this logic in lib/env.ts.
 */

let forceEnabledForTests: boolean | null = null;

/** Test seam: null restores normal gate evaluation. */
export function setInternalDiagnosticsEnabledForTests(
  enabled: boolean | null
): void {
  forceEnabledForTests = enabled;
}

function readEnvFlag(): string {
  if (typeof process === 'undefined' || !process.env) return '';
  const a = process.env.ENABLE_INTERNAL_DIAGNOSTICS;
  const b = process.env.EXPO_PUBLIC_ENABLE_INTERNAL_DIAGNOSTICS;
  const raw = (typeof a === 'string' && a.trim()) || (typeof b === 'string' && b.trim()) || '';
  return raw;
}

function parseBool(raw: string, defaultValue: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return defaultValue;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultValue;
}

function readExtraFlag(): string {
  try {
    // Lazy require so unit tests that never touch Expo Constants still work.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getExtraValue } = require('./env') as {
      getExtraValue: (key: string, fallback?: string) => string;
    };
    return getExtraValue('ENABLE_INTERNAL_DIAGNOSTICS', '');
  } catch {
    return '';
  }
}

/**
 * Central gate for Internal Diagnostics V1.
 * High-frequency recording and Settings entry must both respect this.
 */
export function isInternalDiagnosticsEnabled(): boolean {
  if (forceEnabledForTests != null) return forceEnabledForTests;
  if (typeof __DEV__ !== 'undefined' && __DEV__) return true;

  const fromEnv = readEnvFlag();
  if (fromEnv) return parseBool(fromEnv, false);

  const fromExtra = readExtraFlag();
  if (fromExtra) return parseBool(fromExtra, false);

  return false;
}

export function shouldShowInternalDiagnosticsSettingsEntry(
  diagnosticsEnabled: boolean
): boolean {
  return diagnosticsEnabled === true;
}
