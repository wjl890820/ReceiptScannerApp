/**
 * A1 / A1.2.2 — Analysis eligibility / evidence gates (pure functions).
 *
 * Exact price comparison =
 *   self observation eligibility
 *   AND peer observation eligibility
 *   AND pairwise compatibility
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
import {
  assessReceiptAmountBasis,
  exactPriceAmountEvidenceFromAssessment,
  evaluateExactPriceAmountBasisGate,
  isExactPriceAmountEvidenceTrusted,
} from './amountBasis';
import type {
  ExactPriceAmountEvidence,
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

export type PriceObservationSideInput = {
  rawName: string;
  quantity: number | null | undefined;
  lineTotal: number | null | undefined;
  currency: string | null | undefined;
  identityConfidence?: number | null;
  identitySource?: string | null;
  merchantProductId?: string | null;
  canonicalProductId?: string | null;
  isNonProductRow?: boolean;
  isDuplicateExtra?: boolean;
  peerPurchaseUnitPrices?: readonly number[];
  amountEvidence: ExactPriceAmountEvidence | null | undefined;
};

/**
 * Single observation: is this row eligible to participate in exact price comparison?
 * Does NOT authorize pairwise comparison alone.
 */
export function evaluateSinglePriceObservationEligibility(
  input: PriceObservationSideInput
): PriceComparisonEligibility {
  const reasons: PriceComparisonRejectReason[] = [];

  if (input.isDuplicateExtra) {
    reasons.push('duplicate_receipt_observation');
  }
  if (input.isNonProductRow) {
    reasons.push('non_product_row');
  }

  const currency = (input.currency ?? '').trim().toUpperCase();
  if (!currency) {
    reasons.push('currency_mismatch');
  }

  if (!isExactPriceAmountEvidenceTrusted(input.amountEvidence)) {
    reasons.push('amount_basis_unknown');
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

  const qty = input.quantity;
  if (qty != null && (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0)) {
    reasons.push('invalid_quantity_basis');
  }

  const normalized = normalizeProductForIdentity(input.rawName);
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

function observationsShareComparableIdentity(
  self: PriceObservationSideInput,
  peer: PriceObservationSideInput
): boolean {
  if (
    self.merchantProductId &&
    peer.merchantProductId &&
    self.merchantProductId === peer.merchantProductId
  ) {
    return true;
  }
  if (
    self.canonicalProductId &&
    peer.canonicalProductId &&
    self.canonicalProductId === peer.canonicalProductId
  ) {
    return true;
  }
  const selfNorm = normalizeProductForIdentity(self.rawName);
  const peerNorm = normalizeProductForIdentity(peer.rawName);
  const selfConf =
    typeof self.identityConfidence === 'number' ? self.identityConfidence : 0;
  const peerConf =
    typeof peer.identityConfidence === 'number' ? peer.identityConfidence : 0;
  if (
    selfNorm.comparisonKey &&
    selfNorm.comparisonKey === peerNorm.comparisonKey &&
    selfConf >= MIN_IDENTITY_CONFIDENCE_FOR_PRICE &&
    peerConf >= MIN_IDENTITY_CONFIDENCE_FOR_PRICE
  ) {
    return true;
  }
  return false;
}

/**
 * Pairwise compatibility between two already single-eligible observations.
 */
export function evaluatePairwisePriceObservationCompatibility(
  self: PriceObservationSideInput,
  peer: PriceObservationSideInput
): PriceComparisonEligibility {
  const reasons: PriceComparisonRejectReason[] = [];

  const selfCur = (self.currency ?? '').trim().toUpperCase();
  const peerCur = (peer.currency ?? '').trim().toUpperCase();
  if (!selfCur || !peerCur || selfCur !== peerCur) {
    reasons.push('currency_mismatch');
  }

  const amountGate = evaluateExactPriceAmountBasisGate(
    self.amountEvidence,
    peer.amountEvidence
  );
  if (!amountGate.pass) {
    reasons.push(amountGate.reason);
  }

  if (!observationsShareComparableIdentity(self, peer)) {
    reasons.push('identity_mismatch');
  }

  const selfNorm = normalizeProductForIdentity(self.rawName);
  const peerNorm = normalizeProductForIdentity(peer.rawName);
  const compat = attributesAreCompatible(
    selfNorm.attributes,
    peerNorm.attributes,
    self.rawName,
    peer.rawName
  );
  if (!compat.ok) {
    reasons.push('variant_spec_incomparable');
  }

  return { eligible: reasons.length === 0, reasonCodes: reasons };
}

export type PriceComparisonEligibilityInput = {
  self: PriceObservationSideInput;
  peer: PriceObservationSideInput;
};

const PEER_REASON_MAP: Partial<
  Record<PriceComparisonRejectReason, PriceComparisonRejectReason>
> = {
  identity_unresolved: 'peer_identity_unresolved',
  identity_low_confidence: 'peer_identity_low_confidence',
  invalid_quantity_basis: 'peer_invalid_quantity_basis',
  invalid_price: 'peer_invalid_price',
  price_quality_invalid: 'peer_price_quality_invalid',
  price_quality_suspected_anomaly: 'peer_price_quality_suspected_anomaly',
  duplicate_receipt_observation: 'peer_duplicate_receipt_observation',
  non_product_row: 'peer_non_product_row',
  amount_basis_unknown: 'peer_amount_basis_unknown',
  currency_mismatch: 'peer_currency_mismatch',
};

/**
 * Exact pairwise price comparison:
 * self eligibility AND peer eligibility AND pairwise compatibility.
 */
export function evaluatePriceComparisonEligibility(
  input: PriceComparisonEligibilityInput
): PriceComparisonEligibility {
  const selfResult = evaluateSinglePriceObservationEligibility(input.self);
  const peerResult = evaluateSinglePriceObservationEligibility(input.peer);
  const pairResult = evaluatePairwisePriceObservationCompatibility(
    input.self,
    input.peer
  );

  const reasonCodes: PriceComparisonRejectReason[] = [...selfResult.reasonCodes];
  for (const c of peerResult.reasonCodes) {
    reasonCodes.push(PEER_REASON_MAP[c] ?? c);
  }
  reasonCodes.push(...pairResult.reasonCodes);

  const seen = new Set<string>();
  const merged: PriceComparisonRejectReason[] = [];
  for (const c of reasonCodes) {
    if (seen.has(c)) continue;
    seen.add(c);
    merged.push(c);
  }

  return {
    eligible:
      selfResult.eligible && peerResult.eligible && pairResult.eligible,
    reasonCodes: merged,
  };
}

export type PurchaseCycleEligibilityInput = {
  receipt: ReceiptRow;
  canonicalGroups: CanonicalReceiptGroup[];
  itemIdentityConfidence?: number | null;
  itemIdentitySource?: string | null;
  merchantProductId?: string | null;
  canonicalProductId?: string | null;
};

export function resolveTransactionTemporalPrecision(
  receipt: ReceiptRow
): TransactionTemporalPrecision | null {
  if (!hasValidTransactionAt(receipt)) return null;
  return hasExactTransactionTime(receipt) ? 'exact_time' : 'date_only';
}

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

function readItemFields(item: Record<string, unknown>) {
  const quantity = typeof item.quantity === 'number' ? item.quantity : 1;
  const lineTotal = itemAmountForAnalytics(item as DiscountableItem);
  const identityConfidence =
    typeof item.identity_confidence === 'number'
      ? item.identity_confidence
      : null;
  const identitySource =
    typeof item.identity_source === 'string' ? item.identity_source : null;
  const rawName =
    typeof item.name === 'string'
      ? item.name
      : typeof item.raw_name === 'string'
        ? item.raw_name
        : '';
  const merchantProductId =
    typeof item.merchant_product_id === 'string'
      ? item.merchant_product_id
      : null;
  const canonicalProductId =
    typeof item.canonical_product_id === 'string'
      ? item.canonical_product_id
      : null;
  return {
    quantity,
    lineTotal,
    identityConfidence,
    identitySource,
    rawName,
    merchantProductId,
    canonicalProductId,
  };
}

function sideFromReceiptItem(args: {
  receipt: ReceiptRow;
  item: Record<string, unknown>;
  canonicalGroups: CanonicalReceiptGroup[];
  amountEvidence: ExactPriceAmountEvidence;
}): PriceObservationSideInput {
  const fields = readItemFields(args.item);
  return {
    rawName: fields.rawName,
    quantity: fields.quantity,
    lineTotal: fields.lineTotal,
    currency: args.receipt.currency,
    identityConfidence: fields.identityConfidence,
    identitySource: fields.identitySource,
    merchantProductId: fields.merchantProductId,
    canonicalProductId: fields.canonicalProductId,
    isDuplicateExtra: isDuplicateReceiptExtra(
      args.receipt.id,
      args.canonicalGroups
    ),
    amountEvidence: args.amountEvidence,
  };
}

/**
 * Exact pairwise convenience API for two receipt items.
 * Independently gates self item AND peer item, then pairwise compatibility.
 */
export function evaluateReceiptItemPriceComparisonEligibility(args: {
  receipt: ReceiptRow;
  item: Record<string, unknown>;
  peerReceipt: ReceiptRow;
  peerItem: Record<string, unknown>;
  canonicalGroups: CanonicalReceiptGroup[];
}): PriceComparisonEligibility {
  const selfAssessment = assessReceiptAmountBasis(args.receipt);
  const peerAssessment = assessReceiptAmountBasis(args.peerReceipt);

  const self = sideFromReceiptItem({
    receipt: args.receipt,
    item: args.item,
    canonicalGroups: args.canonicalGroups,
    amountEvidence: exactPriceAmountEvidenceFromAssessment(selfAssessment),
  });
  const peer = sideFromReceiptItem({
    receipt: args.peerReceipt,
    item: args.peerItem,
    canonicalGroups: args.canonicalGroups,
    amountEvidence: exactPriceAmountEvidenceFromAssessment(peerAssessment),
  });

  return evaluatePriceComparisonEligibility({ self, peer });
}

export type { PriceObservationQualityLevel };
