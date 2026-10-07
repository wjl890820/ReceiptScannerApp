/**
 * Durable merchant/store scope generation, plus a pure scope resolver.
 *
 * NULL / absent = legacy v1. Exact integer 2 = future store-aware v2.
 * Malformed values never become v2.
 *
 * resolveReceiptMerchantScope is not wired into Product Identity yet.
 * H3-B1 still does not write generation 2.
 */

import { scopeMerchantKeyForIdentity } from './productIdentityResolver';
import { deriveRetailerIdentity } from './retailerIdentity';

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

export type ReceiptMerchantScopeKind =
  | 'legacy_merchant'
  | 'store_observed'
  | 'receipt_isolated';

export type ReceiptMerchantScope = {
  generation: EffectiveMerchantScopeGeneration;
  scopeKey: string;
  scopeKind: ReceiptMerchantScopeKind;
  /** Printed residue after a known chain prefix. Not a store id. */
  observedStoreHint: string | null;
  reason: string;
};

export type ResolveReceiptMerchantScopeInput = {
  receiptId?: string | null;
  merchantRaw?: string | null;
  merchantNormalized?: string | null;
  /**
   * Accepted for call-site completeness. These columns mirror merchant_*.
   * They are not used as store evidence.
   */
  storeRaw?: string | null;
  storeNormalized?: string | null;
  merchantScopeGeneration?: unknown;
  /** Omit to treat a missing generation value as absent. */
  merchantScopeGenerationPresence?: 'absent' | 'present';
};

const V2_STORE_PREFIX = 'merchant:v2:store:';
const V2_UNKNOWN_STORE_PREFIX = 'merchant:v2:unknown-store:receipt:';
const V2_UNKNOWN_STORE_ORPHAN = 'merchant:v2:unknown-store:orphan';

function legacyMerchantEvidence(input: ResolveReceiptMerchantScopeInput): string {
  const normalized = input.merchantNormalized;
  if (normalized != null) return normalized;
  return input.merchantRaw ?? '';
}

function legacyScope(
  input: ResolveReceiptMerchantScopeInput,
  malformed: boolean
): ReceiptMerchantScope {
  const evidence = legacyMerchantEvidence(input);
  return {
    generation: 1,
    scopeKey: scopeMerchantKeyForIdentity(evidence, input.receiptId),
    scopeKind: 'legacy_merchant',
    observedStoreHint: null,
    reason: malformed
      ? 'malformed_generation_legacy_v1'
      : 'legacy_merchant_scope',
  };
}

function observedText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').trim();
}

/**
 * Residue already printed on this string. Missing residue is not filled in.
 * store_* mirrors are ignored so they cannot invent a second store.
 */
function printedStoreObservation(
  text: string
): { text: string; hint: string } | null {
  if (!text) return null;
  const hint = deriveRetailerIdentity({ merchantRaw: text }).storeHint;
  if (!hint) return null;
  return { text, hint };
}

function unknownStoreScopeKey(receiptId: string | null | undefined): string {
  const rid = typeof receiptId === 'string' ? receiptId.trim() : '';
  if (!rid) return V2_UNKNOWN_STORE_ORPHAN;
  return `${V2_UNKNOWN_STORE_PREFIX}${rid}`;
}

function v2Scope(input: ResolveReceiptMerchantScopeInput): ReceiptMerchantScope {
  const raw = observedText(input.merchantRaw);
  const normalized = observedText(input.merchantNormalized);
  const fromRaw = printedStoreObservation(raw);
  const fromNormalized = printedStoreObservation(normalized);
  const observed = fromRaw ?? fromNormalized;
  if (observed) {
    return {
      generation: 2,
      scopeKey: `${V2_STORE_PREFIX}${observed.text}`,
      scopeKind: 'store_observed',
      observedStoreHint: observed.hint,
      reason: 'printed_store_residue',
    };
  }

  const anyText = raw || normalized;
  if (!anyText) {
    return {
      generation: 2,
      scopeKey: unknownStoreScopeKey(input.receiptId),
      scopeKind: 'receipt_isolated',
      observedStoreHint: null,
      reason: 'blank_merchant_receipt_isolated',
    };
  }

  const identity = deriveRetailerIdentity({
    merchantRaw: raw || null,
    merchantNormalized: normalized || null,
  });
  return {
    generation: 2,
    scopeKey: unknownStoreScopeKey(input.receiptId),
    scopeKind: 'receipt_isolated',
    observedStoreHint: null,
    reason: identity.retailerKey
      ? 'chain_only_receipt_isolated'
      : 'unresolved_merchant_receipt_isolated',
  };
}

/**
 * Pure merchant scope for a receipt. Does not read the database and does not
 * change Product Identity. Invalid generations stay on the legacy formula.
 */
export function resolveReceiptMerchantScope(
  input: ResolveReceiptMerchantScopeInput
): ReceiptMerchantScope {
  const presence =
    input.merchantScopeGenerationPresence ??
    (input.merchantScopeGeneration === undefined ? 'absent' : 'present');
  const classified = classifyMerchantScopeGeneration(
    input.merchantScopeGeneration,
    presence
  );
  if (classified.state !== 'v2') {
    return legacyScope(input, classified.state === 'invalid');
  }
  return v2Scope(input);
}
