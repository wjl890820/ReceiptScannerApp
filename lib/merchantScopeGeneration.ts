/**
 * Durable merchant/store scope generation.
 *
 * NULL / absent = legacy v1. Exact integer 2 = future store-aware v2.
 * H3-B1 only stores and transports the value. Resolvers must not read it yet.
 * Malformed values never become v2.
 */

export const MERCHANT_SCOPE_GENERATION_COLUMN = 'merchant_scope_generation';

/** Future store-aware generation. Not written by H3-B1 saves. */
export const MERCHANT_SCOPE_GENERATION_V2 = 2;

export type EffectiveMerchantScopeGeneration = 1 | 2;

export type MerchantScopeGenerationClassification =
  | { state: 'legacy'; persisted: null; effective: 1 }
  | { state: 'v2'; persisted: 2; effective: 2 }
  | { state: 'invalid'; reason: string };

/**
 * Classify a raw column or payload value.
 * `absent` and JSON/SQLite null both mean legacy v1.
 * Only an exact integer 2 is v2.
 */
export function classifyMerchantScopeGeneration(
  value: unknown,
  presence: 'absent' | 'present' = value === undefined ? 'absent' : 'present'
): MerchantScopeGenerationClassification {
  if (presence === 'absent' || value === undefined || value === null) {
    return { state: 'legacy', persisted: null, effective: 1 };
  }
  if (typeof value === 'number' && Number.isInteger(value) && value === MERCHANT_SCOPE_GENERATION_V2) {
    return { state: 'v2', persisted: MERCHANT_SCOPE_GENERATION_V2, effective: 2 };
  }
  return { state: 'invalid', reason: 'unsupported_merchant_scope_generation' };
}

/**
 * Read path. Unsupported stored values fail closed to legacy v1.
 * They must never be treated as store-aware v2.
 */
export function effectiveMerchantScopeGeneration(
  value: unknown,
  presence: 'absent' | 'present' = value === undefined ? 'absent' : 'present'
): EffectiveMerchantScopeGeneration {
  const classified = classifyMerchantScopeGeneration(value, presence);
  if (classified.state === 'invalid') return 1;
  return classified.effective;
}
