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

export const MINUTE_SINGLE_NAME_DRIFT_ADVISORY_MATCH_KIND =
  'MINUTE_SINGLE_NAME_DRIFT_ADVISORY' as const;

export const MINUTE_SINGLE_NAME_DRIFT_MIN_ITEM_COUNT = 5;

export const MINUTE_STRICT_RESCAN_ADVISORY_VERSION =
  'meruno-minute-strict-rescan-advisory-v1' as const;

export const MINUTE_SINGLE_NAME_DRIFT_ADVISORY_VERSION =
  'meruno-minute-single-name-drift-advisory-v2' as const;

export const MINUTE_MULTI_NAME_DRIFT_ADVISORY_MATCH_KIND =
  'MINUTE_MULTI_NAME_DRIFT_ADVISORY' as const;

export const MINUTE_MULTI_NAME_DRIFT_ADVISORY_VERSION =
  'meruno-minute-multi-name-drift-advisory-v1' as const;

export const MINUTE_MULTI_NAME_DRIFT_MIN_ITEM_COUNT = 10;

/** Inclusive genuine-name bounds. Whitespace-only rows are not genuine. */
export const MINUTE_MULTI_NAME_DRIFT_MIN_GENUINE = 2;
export const MINUTE_MULTI_NAME_DRIFT_MAX_GENUINE = 3;

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

/** Name-drift advisory tiers only. Removes spaces after canonicalization. Does not fold punctuation or characters. */
function whitespaceInsensitiveAdvisoryName(nameCanonical: string): string {
  return nameCanonical.replace(/\s+/g, '');
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

export type MinuteSingleNameDriftRejectReason =
  | MinuteStrictAdvisoryRejectReason
  | 'strict_already_matched'
  | 'item_count'
  | 'quantity_mismatch'
  | 'amount_mismatch'
  | 'name_drift_count';

export type MinuteSingleNameDriftAdvisoryResult =
  | {
      matched: true;
      reason: typeof MINUTE_SINGLE_NAME_DRIFT_ADVISORY_MATCH_KIND;
      evidenceKey: string;
      leftReceiptId: string;
      rightReceiptId: string;
      transactionAt: number;
      total: number;
      currency: string;
      itemCount: number;
      exactNameMatchCount: number;
      nameMismatchCount: 1;
      nameMismatchIndex: number;
      storeHintLeft: string | null;
      storeHintRight: string | null;
    }
  | {
      matched: false;
      reason: MinuteSingleNameDriftRejectReason;
    };

function rejectDrift(
  reason: MinuteSingleNameDriftRejectReason
): MinuteSingleNameDriftAdvisoryResult {
  return { matched: false, reason };
}

/**
 * Scan-review warning when a minute-strict pair differs by exactly one
 * true item name. Internal whitespace is formatting-only and does not
 * consume that budget. Punctuation, characters, and digits still do.
 * Names are not compared for similarity.
 * Runs only after Tier 2 reports basket_mismatch.
 */
export function evaluateMinuteSingleNameDriftRescanAdvisory(
  left: ReceiptRow,
  right: ReceiptRow
): MinuteSingleNameDriftAdvisoryResult {
  const strict = evaluateMinuteStrictRescanAdvisory(left, right);
  if (strict.matched) return rejectDrift('strict_already_matched');
  if (strict.reason !== 'basket_mismatch') return rejectDrift(strict.reason);

  const leftBasket = readStrictAdvisoryBasket(left);
  const rightBasket = readStrictAdvisoryBasket(right);
  if (!leftBasket || !rightBasket) return rejectDrift('basket_invalid');
  if (
    leftBasket.length !== rightBasket.length ||
    leftBasket.length < MINUTE_SINGLE_NAME_DRIFT_MIN_ITEM_COUNT
  ) {
    return rejectDrift('item_count');
  }

  let nameMismatchCount = 0;
  let nameMismatchIndex = -1;
  let exactNameMatchCount = 0;
  for (let index = 0; index < leftBasket.length; index += 1) {
    const leftLine = leftBasket[index]!;
    const rightLine = rightBasket[index]!;
    if (leftLine.quantity !== rightLine.quantity) return rejectDrift('quantity_mismatch');
    if (leftLine.lineAmountYen !== rightLine.lineAmountYen) {
      return rejectDrift('amount_mismatch');
    }
    if (leftLine.nameCanonical === rightLine.nameCanonical) {
      exactNameMatchCount += 1;
      continue;
    }
    if (
      whitespaceInsensitiveAdvisoryName(leftLine.nameCanonical) ===
      whitespaceInsensitiveAdvisoryName(rightLine.nameCanonical)
    ) {
      continue;
    }
    nameMismatchCount += 1;
    nameMismatchIndex = index;
  }
  if (nameMismatchCount !== 1 || nameMismatchIndex < 0) {
    return rejectDrift('name_drift_count');
  }

  const merchant = merchantRelation(left, right);
  if (!merchant.ok) return rejectDrift(merchant.reason);
  const leftCurrency = normalizeShadowCurrency(left);
  const rightCurrency = normalizeShadowCurrency(right);
  if (
    !isShadowAuthorizingCurrency(leftCurrency) ||
    !isShadowAuthorizingCurrency(rightCurrency)
  ) {
    return rejectDrift('currency_not_supported');
  }
  if (leftCurrency !== rightCurrency) return rejectDrift('currency_mismatch');
  const totalYen = exactPositiveIntegerYen(left.total);
  const otherTotalYen = exactPositiveIntegerYen(right.total);
  if (totalYen == null || otherTotalYen == null) return rejectDrift('total_invalid');
  if (totalYen !== otherTotalYen) return rejectDrift('total_mismatch');
  if (left.tax_is_known !== 1 || right.tax_is_known !== 1) {
    return rejectDrift('tax_not_known');
  }
  const taxYen = exactIntegerYen(left.tax);
  const otherTaxYen = exactIntegerYen(right.tax);
  if (taxYen == null || otherTaxYen == null) return rejectDrift('tax_invalid');
  if (taxYen !== otherTaxYen) return rejectDrift('tax_mismatch');

  return {
    matched: true,
    reason: MINUTE_SINGLE_NAME_DRIFT_ADVISORY_MATCH_KIND,
    evidenceKey: JSON.stringify([
      MINUTE_SINGLE_NAME_DRIFT_ADVISORY_VERSION,
      merchant.merchantKey,
      left.transaction_at,
      leftCurrency,
      totalYen,
      taxYen,
      nameMismatchIndex,
      leftBasket.map((row, index) => [
        row.nameCanonical,
        rightBasket[index]!.nameCanonical,
        row.quantity,
        row.lineAmountYen,
      ]),
    ]),
    leftReceiptId: left.id,
    rightReceiptId: right.id,
    transactionAt: left.transaction_at as number,
    total: totalYen,
    currency: leftCurrency,
    itemCount: leftBasket.length,
    exactNameMatchCount,
    nameMismatchCount: 1,
    nameMismatchIndex,
    storeHintLeft: merchant.storeHintLeft,
    storeHintRight: merchant.storeHintRight,
  };
}

export type MinuteMultiNameDriftRejectReason =
  | MinuteSingleNameDriftRejectReason
  | 'single_name_already_matched'
  | 'genuine_name_count'
  | 'aligned_name_support';

export type MinuteMultiNameDriftAdvisoryResult =
  | {
      matched: true;
      reason: typeof MINUTE_MULTI_NAME_DRIFT_ADVISORY_MATCH_KIND;
      evidenceKey: string;
      leftReceiptId: string;
      rightReceiptId: string;
      transactionAt: number;
      total: number;
      currency: string;
      itemCount: number;
      strictNameMatchCount: number;
      whitespaceOnlyDifferenceCount: number;
      genuineNameMismatchCount: number;
      genuineNameMismatchIndices: number[];
      alignedNameSupportCount: number;
      storeHintLeft: string | null;
      storeHintRight: string | null;
    }
  | {
      matched: false;
      reason: MinuteMultiNameDriftRejectReason;
    };

function rejectMulti(
  reason: MinuteMultiNameDriftRejectReason
): MinuteMultiNameDriftAdvisoryResult {
  return { matched: false, reason };
}

/**
 * Lower-confidence scan-review warning for two or three genuine name drifts.
 * Requires itemCount >= 10 and aligned-name support of at least 3/4.
 * Whitespace-only rows support alignment and are not genuine drifts.
 * Runs only after Tier 3 reports name_drift_count.
 */
export function evaluateMinuteMultiNameDriftRescanAdvisory(
  left: ReceiptRow,
  right: ReceiptRow
): MinuteMultiNameDriftAdvisoryResult {
  const single = evaluateMinuteSingleNameDriftRescanAdvisory(left, right);
  if (single.matched) return rejectMulti('single_name_already_matched');
  if (single.reason !== 'name_drift_count') return rejectMulti(single.reason);

  const leftBasket = readStrictAdvisoryBasket(left);
  const rightBasket = readStrictAdvisoryBasket(right);
  if (!leftBasket || !rightBasket) return rejectMulti('basket_invalid');
  if (
    leftBasket.length !== rightBasket.length ||
    leftBasket.length < MINUTE_MULTI_NAME_DRIFT_MIN_ITEM_COUNT
  ) {
    return rejectMulti('item_count');
  }

  let strictNameMatchCount = 0;
  let whitespaceOnlyDifferenceCount = 0;
  const genuineNameMismatchIndices: number[] = [];
  for (let index = 0; index < leftBasket.length; index += 1) {
    const leftLine = leftBasket[index]!;
    const rightLine = rightBasket[index]!;
    if (leftLine.quantity !== rightLine.quantity) return rejectMulti('quantity_mismatch');
    if (leftLine.lineAmountYen !== rightLine.lineAmountYen) {
      return rejectMulti('amount_mismatch');
    }
    if (leftLine.nameCanonical === rightLine.nameCanonical) {
      strictNameMatchCount += 1;
      continue;
    }
    if (
      whitespaceInsensitiveAdvisoryName(leftLine.nameCanonical) ===
      whitespaceInsensitiveAdvisoryName(rightLine.nameCanonical)
    ) {
      whitespaceOnlyDifferenceCount += 1;
      continue;
    }
    genuineNameMismatchIndices.push(index);
  }
  const genuineNameMismatchCount = genuineNameMismatchIndices.length;
  if (
    genuineNameMismatchCount < MINUTE_MULTI_NAME_DRIFT_MIN_GENUINE ||
    genuineNameMismatchCount > MINUTE_MULTI_NAME_DRIFT_MAX_GENUINE
  ) {
    return rejectMulti('genuine_name_count');
  }
  const alignedNameSupportCount = strictNameMatchCount + whitespaceOnlyDifferenceCount;
  if (alignedNameSupportCount * 4 < leftBasket.length * 3) {
    return rejectMulti('aligned_name_support');
  }

  const merchant = merchantRelation(left, right);
  if (!merchant.ok) return rejectMulti(merchant.reason);
  const leftCurrency = normalizeShadowCurrency(left);
  const rightCurrency = normalizeShadowCurrency(right);
  if (
    !isShadowAuthorizingCurrency(leftCurrency) ||
    !isShadowAuthorizingCurrency(rightCurrency)
  ) {
    return rejectMulti('currency_not_supported');
  }
  if (leftCurrency !== rightCurrency) return rejectMulti('currency_mismatch');
  const totalYen = exactPositiveIntegerYen(left.total);
  const otherTotalYen = exactPositiveIntegerYen(right.total);
  if (totalYen == null || otherTotalYen == null) return rejectMulti('total_invalid');
  if (totalYen !== otherTotalYen) return rejectMulti('total_mismatch');
  if (left.tax_is_known !== 1 || right.tax_is_known !== 1) {
    return rejectMulti('tax_not_known');
  }
  const taxYen = exactIntegerYen(left.tax);
  const otherTaxYen = exactIntegerYen(right.tax);
  if (taxYen == null || otherTaxYen == null) return rejectMulti('tax_invalid');
  if (taxYen !== otherTaxYen) return rejectMulti('tax_mismatch');

  return {
    matched: true,
    reason: MINUTE_MULTI_NAME_DRIFT_ADVISORY_MATCH_KIND,
    evidenceKey: JSON.stringify([
      MINUTE_MULTI_NAME_DRIFT_ADVISORY_VERSION,
      merchant.merchantKey,
      left.transaction_at,
      leftCurrency,
      totalYen,
      taxYen,
      genuineNameMismatchIndices,
      leftBasket.map((row, index) => [
        row.nameCanonical,
        rightBasket[index]!.nameCanonical,
        row.quantity,
        row.lineAmountYen,
      ]),
    ]),
    leftReceiptId: left.id,
    rightReceiptId: right.id,
    transactionAt: left.transaction_at as number,
    total: totalYen,
    currency: leftCurrency,
    itemCount: leftBasket.length,
    strictNameMatchCount,
    whitespaceOnlyDifferenceCount,
    genuineNameMismatchCount,
    genuineNameMismatchIndices,
    alignedNameSupportCount,
    storeHintLeft: merchant.storeHintLeft,
    storeHintRight: merchant.storeHintRight,
  };
}
