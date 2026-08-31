/**
 * Advisory exact-transaction collision evidence.
 *
 * This is intentionally NOT canonical analytics duplicate truth. It may only
 * authorize low-consequence suppression and the non-destructive Scan Review
 * "may already be saved" surface.
 */

import type { ReceiptRow } from './db';
import { AMOUNT_BASIS_TOLERANCE_JPY } from './analysisFoundation/amountBasis';
import { hasExactTransactionTime } from './receiptExactTransactionTime';
import { buildReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/monetaryCoherenceEvidence';
import {
  isShadowAuthorizingCurrency,
  normalizeShadowCurrency,
} from './receiptEvidenceTruth/rawItemValidation';
import { deriveRetailerIdentity } from './retailerIdentity';

export const EXACT_TRANSACTION_COLLISION_VERSION =
  'meruno-exact-transaction-collision-v1' as const;

export type ExactTransactionCollisionReason =
  | 'same_receipt'
  | 'unsupported_transaction_source'
  | 'transaction_time_not_exact'
  | 'transaction_time_mismatch'
  | 'retailer_not_exact'
  | 'retailer_mismatch'
  | 'store_hint_conflict'
  | 'currency_not_supported'
  | 'currency_mismatch'
  | 'total_invalid'
  | 'total_mismatch'
  | 'tax_not_known'
  | 'tax_invalid'
  | 'tax_mismatch'
  | 'basket_invalid'
  | 'basket_mismatch'
  | 'monetary_evidence_not_coherent';

export type ExactTransactionReceiptCollision = {
  collided: true;
  version: typeof EXACT_TRANSACTION_COLLISION_VERSION;
  evidenceKey: string;
  leftReceiptId: string;
  rightReceiptId: string;
  retailerKey: string;
  transactionAt: number;
  total: number;
  tax: number;
  itemCount: number;
  storeHintLeft: string | null;
  storeHintRight: string | null;
  evidence: readonly string[];
};

export type ExactTransactionReceiptNoCollision = {
  collided: false;
  reason: ExactTransactionCollisionReason;
};

export type ExactTransactionReceiptCollisionResult =
  | ExactTransactionReceiptCollision
  | ExactTransactionReceiptNoCollision;

function moneyUnits(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function hasEffectiveUserItems(receipt: ReceiptRow): boolean {
  return (
    typeof receipt.user_items_json === 'string' &&
    receipt.user_items_json.trim().length > 0
  );
}

type CollisionMonetaryBasketRow = {
  quantity: number;
  lineAmount: number;
};

const COLLISION_AMOUNT_KEYS = [
  'lineTotal',
  'line_total',
  'amount',
  'effectiveLineTotal',
] as const;

function parseCollisionBasketItems(
  receipt: ReceiptRow
): readonly unknown[] | null {
  const raw = hasEffectiveUserItems(receipt)
    ? receipt.user_items_json
    : receipt.analysis_json;
  try {
    const parsed = JSON.parse(raw || (hasEffectiveUserItems(receipt) ? 'null' : '{}'));
    if (hasEffectiveUserItems(receipt)) {
      return Array.isArray(parsed) ? parsed : null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const items = (parsed as { items?: unknown }).items;
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

function collisionQuantity(row: Record<string, unknown>): number | null {
  if (!Object.prototype.hasOwnProperty.call(row, 'quantity')) return 1;
  const value = row.quantity;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function collisionLineAmount(row: Record<string, unknown>): number | null {
  const values: number[] = [];
  for (const key of COLLISION_AMOUNT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return null;
    }
    values.push(value);
  }
  if (values.length === 0) return null;
  const first = values[0]!;
  if (
    values.some(
      (value) => Math.abs(value - first) > AMOUNT_BASIS_TOLERANCE_JPY
    )
  ) {
    return null;
  }
  return first;
}

function validateEffectiveBasket(
  receipt: ReceiptRow
): readonly CollisionMonetaryBasketRow[] | null {
  const items = parseCollisionBasketItems(receipt);
  if (!items || items.length === 0) return null;
  const rows: CollisionMonetaryBasketRow[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const quantity = collisionQuantity(row);
    const lineAmount = collisionLineAmount(row);
    if (quantity == null || lineAmount == null) return null;
    rows.push({ quantity, lineAmount });
  }
  return rows;
}

function collisionBasketVectorsEqual(
  left: readonly CollisionMonetaryBasketRow[],
  right: readonly CollisionMonetaryBasketRow[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    return (
      other != null &&
      row.quantity === other.quantity &&
      moneyUnits(row.lineAmount) === moneyUnits(other.lineAmount)
    );
  });
}

function normalizeStoreHintEvidence(value: string | null): string | null {
  if (value == null) return null;
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/[\s　]+/g, ' ');
  return normalized || null;
}

function normalizedStoreEvidence(
  left: string | null,
  right: string | null
): readonly string[] {
  return [
    ...new Set(
      [left, right]
        .map(normalizeStoreHintEvidence)
        .filter((value): value is string => value != null)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function buildEvidenceKey(input: {
  retailerKey: string;
  storeHintLeft: string | null;
  storeHintRight: string | null;
  transactionAt: number;
  currency: string;
  totalUnits: number;
  taxUnits: number;
  basket: readonly CollisionMonetaryBasketRow[];
}): string {
  return JSON.stringify([
    EXACT_TRANSACTION_COLLISION_VERSION,
    input.retailerKey,
    normalizedStoreEvidence(input.storeHintLeft, input.storeHintRight),
    input.transactionAt,
    input.currency,
    input.totalUnits,
    input.taxUnits,
    input.basket.map((row) => [row.quantity, moneyUnits(row.lineAmount)]),
  ]);
}

/**
 * Prove a low-consequence exact-transaction collision.
 * Product OCR names are deliberately not compared and never enter evidenceKey.
 */
export function evaluateExactTransactionReceiptCollision(
  left: ReceiptRow,
  right: ReceiptRow
): ExactTransactionReceiptCollisionResult {
  if (!left.id || !right.id || left.id === right.id) {
    return { collided: false, reason: 'same_receipt' };
  }

  if (
    left.transaction_source !== 'receipt_ocr' ||
    right.transaction_source !== 'receipt_ocr'
  ) {
    return { collided: false, reason: 'unsupported_transaction_source' };
  }

  if (!hasExactTransactionTime(left) || !hasExactTransactionTime(right)) {
    return { collided: false, reason: 'transaction_time_not_exact' };
  }
  if (left.transaction_at !== right.transaction_at) {
    return { collided: false, reason: 'transaction_time_mismatch' };
  }

  const leftRetailer = deriveRetailerIdentity({
    merchantRaw: left.merchant_raw,
    merchantNormalized: left.merchant_normalized,
    merchantType: left.merchant_type,
  });
  const rightRetailer = deriveRetailerIdentity({
    merchantRaw: right.merchant_raw,
    merchantNormalized: right.merchant_normalized,
    merchantType: right.merchant_type,
  });
  if (
    !leftRetailer.retailerKey ||
    !rightRetailer.retailerKey ||
    leftRetailer.confidence !== 'exact' ||
    rightRetailer.confidence !== 'exact'
  ) {
    return { collided: false, reason: 'retailer_not_exact' };
  }
  if (leftRetailer.retailerKey !== rightRetailer.retailerKey) {
    return { collided: false, reason: 'retailer_mismatch' };
  }
  if (
    leftRetailer.storeHint &&
    rightRetailer.storeHint &&
    leftRetailer.storeHint !== rightRetailer.storeHint
  ) {
    return { collided: false, reason: 'store_hint_conflict' };
  }

  const leftCurrency = normalizeShadowCurrency(left);
  const rightCurrency = normalizeShadowCurrency(right);
  if (
    !isShadowAuthorizingCurrency(leftCurrency) ||
    !isShadowAuthorizingCurrency(rightCurrency)
  ) {
    return { collided: false, reason: 'currency_not_supported' };
  }
  if (leftCurrency !== rightCurrency) {
    return { collided: false, reason: 'currency_mismatch' };
  }

  const leftTotalUnits = moneyUnits(left.total);
  const rightTotalUnits = moneyUnits(right.total);
  if (
    leftTotalUnits == null ||
    rightTotalUnits == null ||
    leftTotalUnits <= 0 ||
    rightTotalUnits <= 0
  ) {
    return { collided: false, reason: 'total_invalid' };
  }
  if (leftTotalUnits !== rightTotalUnits) {
    return { collided: false, reason: 'total_mismatch' };
  }

  if (left.tax_is_known !== 1 || right.tax_is_known !== 1) {
    return { collided: false, reason: 'tax_not_known' };
  }
  const leftTaxUnits = moneyUnits(left.tax);
  const rightTaxUnits = moneyUnits(right.tax);
  if (leftTaxUnits == null || rightTaxUnits == null) {
    return { collided: false, reason: 'tax_invalid' };
  }
  if (leftTaxUnits !== rightTaxUnits) {
    return { collided: false, reason: 'tax_mismatch' };
  }

  const leftBasket = validateEffectiveBasket(left);
  const rightBasket = validateEffectiveBasket(right);
  if (!leftBasket || !rightBasket || leftBasket.length === 0 || rightBasket.length === 0) {
    return { collided: false, reason: 'basket_invalid' };
  }
  if (!collisionBasketVectorsEqual(leftBasket, rightBasket)) {
    return { collided: false, reason: 'basket_mismatch' };
  }

  const leftMonetary = buildReceiptMonetaryCoherenceEvidence(left);
  const rightMonetary = buildReceiptMonetaryCoherenceEvidence(right);
  if (
    leftMonetary.state !== 'known_coherent' ||
    rightMonetary.state !== 'known_coherent' ||
    !leftMonetary.monetaryProvenanceSufficient ||
    !rightMonetary.monetaryProvenanceSufficient
  ) {
    return { collided: false, reason: 'monetary_evidence_not_coherent' };
  }

  const transactionAt = left.transaction_at as number;
  const evidenceKey = buildEvidenceKey({
    retailerKey: leftRetailer.retailerKey,
    storeHintLeft: leftRetailer.storeHint,
    storeHintRight: rightRetailer.storeHint,
    transactionAt,
    currency: leftCurrency,
    totalUnits: leftTotalUnits,
    taxUnits: leftTaxUnits,
    basket: leftBasket,
  });

  return {
    collided: true,
    version: EXACT_TRANSACTION_COLLISION_VERSION,
    evidenceKey,
    leftReceiptId: left.id,
    rightReceiptId: right.id,
    retailerKey: leftRetailer.retailerKey,
    transactionAt,
    total: leftTotalUnits / 100,
    tax: leftTaxUnits / 100,
    itemCount: leftBasket.length,
    storeHintLeft: leftRetailer.storeHint,
    storeHintRight: rightRetailer.storeHint,
    evidence: [
      'distinct_receipt_observations',
      'transaction_source=receipt_ocr',
      'exact_non_midnight_transaction_at',
      'exact_retailer_identity',
      'no_conflicting_store_hint',
      'currency=JPY',
      'exact_positive_total',
      'both_tax_known_equal',
      'exact_ordered_quantity_line_amount_vector',
      'monetary_provenance_coherent',
      'product_names_not_used',
    ],
  };
}
