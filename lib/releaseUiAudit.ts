/**
 * Static release UI audit helpers (presentation / visibility only).
 * No runtime cost for the app — used by tests and docs.
 */

/** Formal user locale keys must exist in zh/ja/en with identical shape. */
export const RELEASE_LOCALE_EXCLUDE_POLICY =
  'All app locale keys require zh/ja/en parity. Dev Tools screens may use hardcoded English/Chinese strings instead of locale keys; those strings must remain behind isDevToolsUnlocked / __DEV__ gates and must not appear on normal Settings.';

/** Presentation source roots that normal Release users can reach without unlock. */
export const RELEASE_PRESENTATION_GLOBS = [
  'app/(tabs)/index.tsx',
  'app/(tabs)/analysis.tsx',
  'app/(tabs)/history/**/*.{ts,tsx}',
  'app/(tabs)/settings/index.tsx',
  'app/(tabs)/settings/feedback.tsx',
  'app/(tabs)/_layout.tsx',
  'app/scan-review/**/*.{ts,tsx}',
  'app/post-save-summary/**/*.{ts,tsx}',
  'app/product/**/*.{ts,tsx}',
  'components/**/*.{ts,tsx}',
  'lib/*Presentation.ts',
  'lib/homeProgressiveExperience.ts',
  'lib/engagementMilestones.ts',
  'lib/i18n.ts',
  'lib/settingsPresentation.ts',
  'lib/scanReviewPresentation.ts',
  'lib/analysisPresentation.ts',
] as const;

/** Paths that may contain internal / Dev terminology. */
export const RELEASE_AUDIT_EXCLUDE_PATH_FRAGMENTS = [
  '/uncategorized-items.',
  '/pro-insight.',
  '/review-retrospective.',
  'lib/priceRadar.ts',
  'lib/db.ts',
  'lib/productDictionary',
  'lib/reclassify',
  'lib/missingDictionary',
  '.test.ts',
  '.test.tsx',
  '/locales/native/',
  'node_modules/',
] as const;

export const FORBIDDEN_RELEASE_ENGINEERING_TERMS = [
  'trace_id',
  'transactionDate',
  'normalized_name',
  'normalized_full_name',
  'canonical_product_name',
  'product_family_key',
  'analysis_json',
  'user_items_json',
  'identity_version',
  'spec_confidence',
  'product_dictionary',
  'classification_telemetry',
  'currentVersion',
  'currentBuild',
  'devToolsEnabled',
] as const;

export const FORBIDDEN_RELEASE_UI_PHRASES = [
  'Coming Soon',
  'coming soon',
  'PRIVACY_POLICY.md',
  'Price Radar',
  'price radar',
  '解锁20',
  '/20',
  'Build 15',
  'version 15',
  '1.0.5',
] as const;

export function pathIsExcludedFromReleaseAudit(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return RELEASE_AUDIT_EXCLUDE_PATH_FRAGMENTS.some((frag) =>
    normalized.includes(frag)
  );
}

export function findForbiddenTerms(
  source: string,
  terms: readonly string[]
): string[] {
  const hits: string[] = [];
  for (const term of terms) {
    if (source.includes(term)) hits.push(term);
  }
  return hits;
}
