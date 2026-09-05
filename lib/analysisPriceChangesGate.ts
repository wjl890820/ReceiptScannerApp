/**
 * AP-3 Analysis price-changes enablement — SINGLE SSOT, fail-closed.
 *
 * - EAS "validation" profile: ENABLE_ANALYSIS_PRICE_CHANGES=true
 * - All other distributable profiles pin ENABLE_ANALYSIS_PRICE_CHANGES=false
 * - Runtime: ONLY normalized exact "true" => ON (trim + lowercase)
 * - "1" / "yes" / "on" / missing / empty / unknown / __DEV__ alone => OFF
 *
 * Prefer this helper over a hardcoded Analysis-screen constant.
 */

let forceEnabledForTests: boolean | null = null;

/** Test seam: null restores normal gate evaluation. */
export function setAnalysisPriceChangesEnabledForTests(
  enabled: boolean | null
): void {
  forceEnabledForTests = enabled;
}

function readEnvFlag(): string {
  if (typeof process === 'undefined' || !process.env) return '';
  const a = process.env.ENABLE_ANALYSIS_PRICE_CHANGES;
  const b = process.env.EXPO_PUBLIC_ENABLE_ANALYSIS_PRICE_CHANGES;
  const raw =
    (typeof a === 'string' && a.trim() !== '' ? a : '') ||
    (typeof b === 'string' && b.trim() !== '' ? b : '') ||
    '';
  return raw;
}

/**
 * AP-3-only strict enablement: normalized exact "true" only.
 * Does not share semantics with other feature-flag parsers.
 */
function isExactTrueFlag(raw: string): boolean {
  return raw.trim().toLowerCase() === 'true';
}

function readExtraFlag(): string {
  try {
    // Lazy require so unit tests that never touch Expo Constants still work.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getExtraValue } = require('./env') as {
      getExtraValue: (key: string, fallback?: string) => string;
    };
    return getExtraValue('ENABLE_ANALYSIS_PRICE_CHANGES', '');
  } catch {
    return '';
  }
}

/**
 * Central gate for AP-3 purchase price changes on Analysis.
 * Missing / empty / unknown / non-"true" ⇒ false (fail closed).
 */
export function isAnalysisPriceChangesEnabled(): boolean {
  if (forceEnabledForTests != null) return forceEnabledForTests;

  const fromEnv = readEnvFlag();
  if (fromEnv) return isExactTrueFlag(fromEnv);

  const fromExtra = readExtraFlag();
  if (fromExtra) return isExactTrueFlag(fromExtra);

  return false;
}
