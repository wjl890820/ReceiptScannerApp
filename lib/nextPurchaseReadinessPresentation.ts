/**
 * Next Purchase readiness — presentation-only label from existing candidate.state.
 * Does not recompute cadence thresholds; model remains the sole authority.
 */

import type { NextPurchaseState } from './nextPurchaseCandidates';

export type NextPurchaseReadinessTranslate = (
  key: string,
  params?: Record<string, string | number>
) => string;

/**
 * Map existing Next Purchase state → restrained historical-cadence label.
 * Fail closed for missing/unsupported states.
 */
export function formatNextPurchaseReadinessLabel(
  state: NextPurchaseState | null | undefined,
  translate: NextPurchaseReadinessTranslate
): string | null {
  if (state === 'approaching') {
    return translate('home.progressive.nextPurchase.approaching');
  }
  if (state === 'likely_due') {
    return translate('home.progressive.nextPurchase.likelyDue');
  }
  return null;
}
