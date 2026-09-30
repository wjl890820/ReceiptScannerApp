/**
 * Scan Review-only minute-precision rescan advisory.
 *
 * This is not durable duplicate truth. It does not merge, delete, assign
 * verified occurrence provenance, or change analytics selection.
 * Second-precision exact collision stays in evaluateExactTransactionReceiptCollision.
 */

import type { ReceiptRow } from './db';
import { trimMerchantObservation } from './merchantObservationPersist';
import { normalizeMerchant } from './receiptOcrNormalize';
import {
  hasValidTransactionAt,
  resolveReceiptTransactionTimePrecision,
} from './receiptExactTransactionTime';
import { isReceiptTransactionPrecisionToken } from './receiptTransactionTimePrecisionAuthority';
import {
  isShadowAuthorizingCurrency,
  normalizeShadowCurrency,
} from './receiptEvidenceTruth/rawItemValidation';
import { deriveRetailerIdentity } from './retailerIdentity';

export const MINUTE_STRICT_ADVISORY_MATCH_KIND =
  'MINUTE_STRICT_ADVISORY' as const;

export const MINUTE_STRICT_RESCAN_ADVISORY_VERSION =
  'meruno-minute-strict-rescan-advisory-v1' as const;

export type MinuteStrictAdvisoryRejectReason =
  | 'same_receipt'
  | 'unsupported_transaction_source'
  | 'precision_malformed'
  | 'precision_not_both_minute'
  | 'transaction_time_invalid'
  | 'transaction_time_mismatch'
  | 'merchant_missing'
  | 'merchant_conflict'
  | 'currency_not_supported'
  | 'currency_mismatch'
  | 'total_invalid'
  | 'total_mismatch'
  | 'tax_not_known'
  | 'tax_invalid'
  | 'tax_mismatch'
  | 'basket_invalid'
  | 'basket_mismatch';

export type MinuteStrictRescanAdvisoryMatch = {
  matched: true;
  reason: typeof MINUTE_STRICT_ADVISORY_MATCH_KIND;
  evidenceKey: string;
  leftReceiptId: string;
  rightReceiptId: string;
  transactionAt: number;
  total: number;
  currency: string;
  itemCount: number;
  storeHintLeft: string | null;
  storeHintRight: string | null;
};

export type MinuteStrictRescanAdvisoryResult =
  | MinuteStrictRescanAdvisoryMatch
  | {
      matched: false;
      reason: MinuteStrictAdvisoryRejectReason;
    };

/** Same trim/case/whitespace rule as canonicalizeReceiptItemName. */
function canonicalizeAdvisoryItemName(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

const ADVISORY_AMOUNT_KEYS = ['lineTotal', 'line_total', 'amount'] as const;
const ADVISORY_NAME_KEYS = [
  'name',
  'raw_name',
  'normalized_full_name',
  'canonical_product_name',
] as const;

type AdvisoryBasketLine = {
  nameCanonical: string;
  quantity: number;
  lineAmountYen: number;
};

function advisoryItemRows(receipt: ReceiptRow): readonly unknown[] | null {
  const userItems =
    typeof receipt.user_items_json === 'string' && receipt.user_items_json.trim().length > 0;
  const raw = userItems ? receipt.user_items_json : receipt.analysis_json;
  try {
    const parsed = JSON.parse(raw || (userItems ? 'null' : '{}'));
    if (userItems) return Array.isArray(parsed) ? parsed : null;
    if (!parsed || typeof parsed !== 'object') return null;
    const items = (parsed as { items?: unknown }).items;
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

function exactPositiveIntegerYen(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function exactAliasYen(row: Record<string, unknown>): number | null {
  const amounts: number[] = [];
  for (const key of ADVISORY_AMOUNT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const yen = exactPositiveIntegerYen(row[key]);
    if (yen == null) return null;
    amounts.push(yen);
  }
  if (amounts.length === 0) return null;
  const first = amounts[0]!;
  if (amounts.some((value) => value !== first)) return null;
  return first;
}

/**
 * Tier-2 basket. Non-positive, missing, conflicting, or unclassified rows
 * invalidate the whole basket. Nothing is skipped.
 */
function readStrictAdvisoryBasket(
  receipt: ReceiptRow
): readonly AdvisoryBasketLine[] | null {
  const items = advisoryItemRows(receipt);
  if (!items || items.length === 0) return null;
  const rows: AdvisoryBasketLine[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    let rawName: string | null = null;
    for (const key of ADVISORY_NAME_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
      const value = row[key];
      if (typeof value === 'string' && value.trim()) {
        rawName = value;
        break;
      }
    }
    const nameCanonical = rawName ? canonicalizeAdvisoryItemName(rawName) : '';
    if (!Object.prototype.hasOwnProperty.call(row, 'quantity')) return null;
    const quantity = row.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      return null;
    }
    const lineAmountYen = exactAliasYen(row);
    if (lineAmountYen == null || !nameCanonical) return null;
    rows.push({ nameCanonical, quantity, lineAmountYen });
  }
  return rows.length > 0 ? rows : null;
}

function exactIntegerYen(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

function reject(
  reason: MinuteStrictAdvisoryRejectReason
): MinuteStrictRescanAdvisoryResult {
  return { matched: false, reason };
}

function explicitPrecisionIsMalformed(receipt: ReceiptRow): boolean {
  if (
    Object.prototype.hasOwnProperty.call(receipt, 'transaction_time_precision') &&
    receipt.transaction_time_precision != null &&
    !isReceiptTransactionPrecisionToken(receipt.transaction_time_precision)
  ) {
    return true;
  }
  try {
    const parsed = JSON.parse(receipt.analysis_json || '{}') as {
      transaction_time_precision?: unknown;
    };
    if (
      parsed &&
      typeof parsed === 'object' &&
      Object.prototype.hasOwnProperty.call(parsed, 'transaction_time_precision') &&
      parsed.transaction_time_precision != null &&
      !isReceiptTransactionPrecisionToken(parsed.transaction_time_precision)
    ) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

function strictNormalizedRawMerchant(receipt: ReceiptRow): string | null {
  const raw = trimMerchantObservation(receipt.merchant_raw);
  if (!raw) return null;
  const normalized = raw.normalize('NFKC').replace(/[\s　]+/g, ' ').trim();
  return normalized || null;
}

function comparableStoreHint(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize('NFKC').trim().replace(/[\s　]+/g, ' ');
  return normalized || null;
}

function strictUncollapsedMerchant(receipt: ReceiptRow): string | null {
  const raw = receipt.merchant_normalized?.trim() || receipt.merchant_raw?.trim() || '';
  if (!raw) return null;
  const normalized = normalizeMerchant(raw).trim();
  if (!normalized || normalized !== raw) return null;
  return normalized;
}

function merchantRelation(left: ReceiptRow, right: ReceiptRow):
  | {
      ok: true;
      merchantKey: string;
      storeHintLeft: string | null;
      storeHintRight: string | null;
    }
  | { ok: false; reason: 'merchant_missing' | 'merchant_conflict' } {
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
    leftRetailer.confidence === 'exact' &&
    rightRetailer.confidence === 'exact' &&
    leftRetailer.retailerKey &&
    rightRetailer.retailerKey
  ) {
    if (leftRetailer.retailerKey !== rightRetailer.retailerKey) {
      return { ok: false, reason: 'merchant_conflict' };
    }
    const leftHint = comparableStoreHint(leftRetailer.storeHint);
    const rightHint = comparableStoreHint(rightRetailer.storeHint);
    if (leftHint && rightHint) {
      if (leftHint !== rightHint) {
        return { ok: false, reason: 'merchant_conflict' };
      }
      return {
        ok: true,
        merchantKey: leftRetailer.retailerKey,
        storeHintLeft: leftHint,
        storeHintRight: rightHint,
      };
    }
    const leftRaw = strictNormalizedRawMerchant(left);
    const rightRaw = strictNormalizedRawMerchant(right);
    if (!leftRaw || !rightRaw) {
      return { ok: false, reason: 'merchant_missing' };
    }
    if (leftRaw !== rightRaw) {
      return { ok: false, reason: 'merchant_conflict' };
    }
    return {
      ok: true,
      merchantKey: leftRaw,
      storeHintLeft: leftHint,
      storeHintRight: rightHint,
    };
  }

  const leftMerchant = strictUncollapsedMerchant(left);
  const rightMerchant = strictUncollapsedMerchant(right);
  if (!leftMerchant || !rightMerchant) {
    return { ok: false, reason: 'merchant_missing' };
  }
  if (leftMerchant !== rightMerchant) {
    return { ok: false, reason: 'merchant_conflict' };
  }
  return {
    ok: true,
    merchantKey: leftMerchant,
    storeHintLeft: null,
    storeHintRight: null,
  };
}

function basketsEqual(
  left: readonly AdvisoryBasketLine[],
  right: readonly AdvisoryBasketLine[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    return (
      other != null &&
      row.nameCanonical === other.nameCanonical &&
      row.quantity === other.quantity &&
      row.lineAmountYen === other.lineAmountYen
    );
  });
}

function evidenceKey(input: {
  merchantKey: string;
  transactionAt: number;
  currency: string;
  totalYen: number;
  taxYen: number;
  basket: readonly AdvisoryBasketLine[];
}): string {
  return JSON.stringify([
    MINUTE_STRICT_RESCAN_ADVISORY_VERSION,
    input.merchantKey,
    input.transactionAt,
    input.currency,
    input.totalYen,
    input.taxYen,
    input.basket.map((row) => [
      row.nameCanonical,
      row.quantity,
      row.lineAmountYen,
    ]),
  ]);
}

/**
 * Ultra-strict minute/minute rescan advisory.
 * Order of merchandise lines is significant. Both taxes must be known and equal.
 */
export function evaluateMinuteStrictRescanAdvisory(
  left: ReceiptRow,
  right: ReceiptRow
): MinuteStrictRescanAdvisoryResult {
  if (!left.id || !right.id || left.id === right.id) {
    return reject('same_receipt');
  }
  if (
    left.transaction_source !== 'receipt_ocr' ||
    right.transaction_source !== 'receipt_ocr'
  ) {
    return reject('unsupported_transaction_source');
  }
  if (explicitPrecisionIsMalformed(left) || explicitPrecisionIsMalformed(right)) {
    return reject('precision_malformed');
  }
  if (
    resolveReceiptTransactionTimePrecision(left) !== 'minute' ||
    resolveReceiptTransactionTimePrecision(right) !== 'minute'
  ) {
    return reject('precision_not_both_minute');
  }
  if (!hasValidTransactionAt(left) || !hasValidTransactionAt(right)) {
    return reject('transaction_time_invalid');
  }
  if (left.transaction_at !== right.transaction_at) {
    return reject('transaction_time_mismatch');
  }

  const merchant = merchantRelation(left, right);
  if (!merchant.ok) return reject(merchant.reason);

  const leftCurrency = normalizeShadowCurrency(left);
  const rightCurrency = normalizeShadowCurrency(right);
  if (
    !isShadowAuthorizingCurrency(leftCurrency) ||
    !isShadowAuthorizingCurrency(rightCurrency)
  ) {
    return reject('currency_not_supported');
  }
  if (leftCurrency !== rightCurrency) {
    return reject('currency_mismatch');
  }

  const leftTotalUnits = exactPositiveIntegerYen(left.total);
  const rightTotalUnits = exactPositiveIntegerYen(right.total);
  if (
    leftTotalUnits == null ||
    rightTotalUnits == null ||
    leftTotalUnits <= 0 ||
    rightTotalUnits <= 0
  ) {
    return reject('total_invalid');
  }
  if (leftTotalUnits !== rightTotalUnits) {
    return reject('total_mismatch');
  }

  if (left.tax_is_known !== 1 || right.tax_is_known !== 1) {
    return reject('tax_not_known');
  }
  const leftTaxUnits = exactIntegerYen(left.tax);
  const rightTaxUnits = exactIntegerYen(right.tax);
  if (leftTaxUnits == null || rightTaxUnits == null) {
    return reject('tax_invalid');
  }
  if (leftTaxUnits !== rightTaxUnits) {
    return reject('tax_mismatch');
  }

  const leftBasket = readStrictAdvisoryBasket(left);
  const rightBasket = readStrictAdvisoryBasket(right);
  if (!leftBasket || !rightBasket) return reject('basket_invalid');
  if (!basketsEqual(leftBasket, rightBasket)) return reject('basket_mismatch');

  return {
    matched: true,
    reason: MINUTE_STRICT_ADVISORY_MATCH_KIND,
    evidenceKey: evidenceKey({
      merchantKey: merchant.merchantKey,
      transactionAt: left.transaction_at as number,
      currency: leftCurrency,
      totalYen: leftTotalUnits,
      taxYen: leftTaxUnits,
      basket: leftBasket,
    }),
    leftReceiptId: left.id,
    rightReceiptId: right.id,
    transactionAt: left.transaction_at as number,
    total: leftTotalUnits,
    currency: leftCurrency,
    itemCount: leftBasket.length,
    storeHintLeft: merchant.storeHintLeft,
    storeHintRight: merchant.storeHintRight,
  };
}
