/**
 * A1 — Analysis eligibility / evidence gates (pure functions).
 *
 * Prevents under-qualified observations from entering price trend / purchase cycle analytics.
 */

import type { ReceiptRow } from '../db';
import {
  evaluatePriceObservationQuality,
  type PriceObservationQualityLevel,
} from '../productIdentityPriceObservationQuality';
import { normalizeProductForIdentity } from '../normalizeProductForIdentity';
import { attributesAreCompatible } from '../productIdentityStructuralConflict';
import { itemAmountForAnalytics, type DiscountableItem } from '../receiptDiscountAllocation';
import {
  hasExactTransactionTime,
  hasValidTransactionAt,
} from '../analysisDDuplicateAudit';
import type { CanonicalReceiptGroup } from './types';
import { isDuplicateReceiptExtra } from './canonicalReceipt';
import { deriveCanonicalMerchant } from './canonicalMerchant';
import type {
  MerchantPatternEligibility,
  MerchantPatternRejectReason,
  PriceComparisonEligibility,
  PriceComparisonRejectReason,
  PurchaseCycleEligibility,
  PurchaseCycleRejectReason,
  TransactionTemporalPrecision,
} from './types';

const MIN_IDENTITY_CONFIDENCE_FOR_PRICE = 0.55;
const MIN_IDENTITY_CONFIDENCE_FOR_CYCLE = 0.45;

export type PriceComparisonEligibilityInput = {
  rawName: string;
  quantity: number | null | undefined;
  lineTotal: number | null | undefined;
  currency: string | null | undefined;
  expectedCurrency?: string | null;
  identityConfidence?: number | null;
  identitySource?: string | null;
  merchantProductId?: string | null;
  canonicalProductId?: string | null;
  /** Peer attributes for variant comparability (optional). */
  peerAttributes?: ReturnType<typeof normalizeProductForIdentity>['attributes'] | null;
  isNonProductRow?: boolean;
  isDuplicateExtra?: boolean;
  peerPurchaseUnitPrices?: readonly number[];
};

export function evaluatePriceComparisonEligibility(
  input: PriceComparisonEligibilityInput
): PriceComparisonEligibility {
  const reasons: PriceComparisonRejectReason[] = [];

  if (input.isDuplicateExtra) {
    reasons.push('duplicate_receipt_observation');
  }
  if (input.isNonProductRow) {
    reasons.push('non_product_row');
  }

  const currency = (input.currency ?? '').trim().toUpperCase();
  const expected = (input.expectedCurrency ?? currency).trim().toUpperCase();
  if (currency && expected && currency !== expected) {
    reasons.push('currency_mismatch');
  }

  const hasStrongIdentity = Boolean(
    input.merchantProductId || input.canonicalProductId
  );
  const conf =
    typeof input.identityConfidence === 'number' &&
    Number.isFinite(input.identityConfidence)
      ? input.identityConfidence
      : 0;
  const src = (input.identitySource ?? 'unknown').trim();

  if (!hasStrongIdentity && src === 'unknown' && conf <= 0) {
    reasons.push('identity_unresolved');
  } else if (!hasStrongIdentity && conf < MIN_IDENTITY_CONFIDENCE_FOR_PRICE) {
    reasons.push('identity_low_confidence');
  }

  const normalized = normalizeProductForIdentity(input.rawName);
  if (input.peerAttributes) {
    const compat = attributesAreCompatible(
      normalized.attributes,
      input.peerAttributes,
      input.rawName,
      input.rawName
    );
    if (!compat.ok) {
      reasons.push('variant_spec_incomparable');
    }
  }

  const qty = input.quantity;
  if (qty != null && (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0)) {
    reasons.push('invalid_quantity_basis');
  }

  const quality = evaluatePriceObservationQuality({
    lineTotal: input.lineTotal,
    quantity: input.quantity,
    rawName: input.rawName,
    isNonProductRow: input.isNonProductRow,
    peerPurchaseUnitPrices: input.peerPurchaseUnitPrices,
    attributes: normalized.attributes,
  });

  if (quality.quality === 'invalid') {
    if (quality.reasons.includes('invalid_price')) reasons.push('invalid_price');
    if (quality.reasons.includes('invalid_quantity')) {
      reasons.push('invalid_quantity_basis');
    }
    if (!reasons.includes('non_product_row')) {
      reasons.push('price_quality_invalid');
    }
  }
  if (quality.quality === 'suspected_anomaly') {
    reasons.push('price_quality_suspected_anomaly');
  }

  return { eligible: reasons.length === 0, reasonCodes: reasons };
}

export type PurchaseCycleEligibilityInput = {
  receipt: ReceiptRow;
  canonicalGroups: CanonicalReceiptGroup[];
  itemIdentityConfidence?: number | null;
  itemIdentitySource?: string | null;
  merchantProductId?: string | null;
  canonicalProductId?: string | null;
};

/**
 * Resolve temporal precision for a valid transaction_at.
 * date_only (Asia/Tokyo midnight) is still a usable calendar date for day-level cycle.
 */
export function resolveTransactionTemporalPrecision(
  receipt: ReceiptRow
): TransactionTemporalPrecision | null {
  if (!hasValidTransactionAt(receipt)) return null;
  return hasExactTransactionTime(receipt) ? 'exact_time' : 'date_only';
}

/**
 * Purchase-cycle eligibility (A1.1):
 * - Valid calendar date (transaction_at) is sufficient.
 * - exact_time vs date_only is preserved as temporalPrecision metadata.
 * - date_only may participate in day-level purchase-cycle analysis.
 * - date_only must still be excluded from shopping-session time-proximity
 *   (enforced in shoppingSessionCandidate, not here).
 */
export function evaluatePurchaseCycleEligibility(
  input: PurchaseCycleEligibilityInput
): PurchaseCycleEligibility {
  const reasons: PurchaseCycleRejectReason[] = [];
  const { receipt } = input;

  if (isDuplicateReceiptExtra(receipt.id, input.canonicalGroups)) {
    reasons.push('duplicate_receipt_extra');
  }

  const temporalPrecision = resolveTransactionTemporalPrecision(receipt);
  if (temporalPrecision == null) {
    reasons.push('transaction_at_missing');
  }

  const hasStrongIdentity = Boolean(
    input.merchantProductId || input.canonicalProductId
  );
  const conf =
    typeof input.itemIdentityConfidence === 'number' &&
    Number.isFinite(input.itemIdentityConfidence)
      ? input.itemIdentityConfidence
      : 0;
  const src = (input.itemIdentitySource ?? 'unknown').trim();

  if (!hasStrongIdentity && src === 'unknown' && conf <= 0) {
    reasons.push('identity_unresolved');
  } else if (!hasStrongIdentity && conf < MIN_IDENTITY_CONFIDENCE_FOR_CYCLE) {
    reasons.push('identity_low_confidence');
  }

  return {
    eligible: reasons.length === 0,
    reasonCodes: reasons,
    temporalPrecision,
  };
}

export function evaluateMerchantPatternEligibility(
  receipt: ReceiptRow
): MerchantPatternEligibility {
  const reasons: MerchantPatternRejectReason[] = [];
  const merchant = deriveCanonicalMerchant(receipt);

  if (!merchant.analyticsKey.trim()) {
    reasons.push('analytics_key_empty');
  }
  if (!merchant.retailerKey && merchant.confidence === 'unknown') {
    reasons.push('merchant_unresolved');
  }

  return { eligible: reasons.length === 0, reasonCodes: reasons };
}

/** Convenience: eligibility for a receipt item row with duplicate context. */
export function evaluateReceiptItemPriceComparisonEligibility(args: {
  receipt: ReceiptRow;
  item: Record<string, unknown>;
  canonicalGroups: CanonicalReceiptGroup[];
  expectedCurrency?: string;
  peerAttributes?: ReturnType<typeof normalizeProductForIdentity>['attributes'] | null;
  peerPurchaseUnitPrices?: readonly number[];
}): PriceComparisonEligibility {
  const quantity =
    typeof args.item.quantity === 'number' ? args.item.quantity : 1;
  const lineTotal = itemAmountForAnalytics(args.item as DiscountableItem);
  const identityConfidence =
    typeof args.item.identity_confidence === 'number'
      ? args.item.identity_confidence
      : null;
  const identitySource =
    typeof args.item.identity_source === 'string'
      ? args.item.identity_source
      : null;
  const rawName =
    typeof args.item.name === 'string'
      ? args.item.name
      : typeof args.item.raw_name === 'string'
        ? args.item.raw_name
        : '';

  return evaluatePriceComparisonEligibility({
    rawName,
    quantity,
    lineTotal,
    currency: args.receipt.currency,
    expectedCurrency: args.expectedCurrency ?? args.receipt.currency,
    identityConfidence,
    identitySource,
    merchantProductId:
      typeof args.item.merchant_product_id === 'string'
        ? args.item.merchant_product_id
        : null,
    canonicalProductId:
      typeof args.item.canonical_product_id === 'string'
        ? args.item.canonical_product_id
        : null,
    peerAttributes: args.peerAttributes,
    isDuplicateExtra: isDuplicateReceiptExtra(args.receipt.id, args.canonicalGroups),
    peerPurchaseUnitPrices: args.peerPurchaseUnitPrices,
  });
}

export type { PriceObservationQualityLevel };
