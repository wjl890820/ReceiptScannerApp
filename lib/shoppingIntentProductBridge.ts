/**
 * R3-B1 — thin FrequentProductProfile → ShoppingIntent create-input bridge.
 *
 * Does not invent a second shopping-list domain, sku resolution field,
 * quantity inference, dedupe, or receipt auto-complete.
 */

import type { FrequentProductProfile } from './frequentProductProfile';
import { PRODUCT_FAMILY_KEYS, type ProductFamilyKey } from './productFamily';
import type { CreateShoppingIntentInput } from './shoppingIntent';

export type ShoppingIntentCreateInputFromFrequentProductOptions = {
  /**
   * Human-readable label for ShoppingIntent.rawText.
   * Required for family profiles (profile.displayName is the machine key).
   * Optional for canonical/sku (defaults to profile.displayName).
   */
  displayLabel?: string;
  /** Explicit desired quantity only — never inferred from frequency/history. */
  desiredQuantity?: number | null;
};

function resolveFamilyKey(key: string): ProductFamilyKey | null {
  return (PRODUCT_FAMILY_KEYS as readonly string[]).includes(key)
    ? (key as ProductFamilyKey)
    : null;
}

function resolveRawText(
  profile: Pick<FrequentProductProfile, 'targetType' | 'displayName'>,
  options?: ShoppingIntentCreateInputFromFrequentProductOptions
): string {
  const fromCaller =
    typeof options?.displayLabel === 'string' ? options.displayLabel.trim() : '';
  if (fromCaller) return fromCaller;
  return typeof profile.displayName === 'string' ? profile.displayName : '';
}

/**
 * Map a long-term frequent product profile onto the native
 * CreateShoppingIntentInput contract (no parallel create type).
 *
 * - family → manualResolution.familyKey = profile.key; rawText from displayLabel
 * - canonical → manualResolution.canonicalProductName = profile.key
 * - sku → rawText only (no fabricated family/canonical / no sku field)
 */
export function shoppingIntentCreateInputFromFrequentProductProfile(
  profile: Pick<FrequentProductProfile, 'targetType' | 'key' | 'displayName'>,
  options?: ShoppingIntentCreateInputFromFrequentProductOptions
): CreateShoppingIntentInput {
  const rawText = resolveRawText(profile, options);
  const input: CreateShoppingIntentInput = { rawText };

  if (options && 'desiredQuantity' in options) {
    input.desiredQuantity = options.desiredQuantity ?? null;
  }

  if (profile.targetType === 'family') {
    const familyKey = resolveFamilyKey(profile.key);
    if (familyKey) {
      input.manualResolution = { familyKey };
    }
    return input;
  }

  if (profile.targetType === 'canonical') {
    const canonical = profile.key.trim();
    if (canonical) {
      input.manualResolution = { canonicalProductName: canonical };
    }
    return input;
  }

  // sku: no ShoppingIntent sku identity — rawText only; existing resolver may
  // optionally derive semantics from the label without adapter fabrication.
  return input;
}
