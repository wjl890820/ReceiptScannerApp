import type { ReceiptRow } from './db';
import type { ReceiptTransactionPrecision } from './dateParser';
import {
  columnPrecisionPresenceOf,
  resolveTransactionTimePrecisionAuthority,
} from './receiptTransactionTimePrecisionAuthority';

export type { ReceiptTransactionPrecision };

export function hasValidTransactionAt(receipt: ReceiptRow): boolean {
  const value = receipt.transaction_at;
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Resolve durable transaction-time precision (A1).
 * Delegates to shared pure authority used by cloud restore.
 */
export function resolveReceiptTransactionTimePrecision(
  receipt: ReceiptRow
): ReceiptTransactionPrecision {
  return resolveTransactionTimePrecisionAuthority({
    columnPrecision: (receipt as { transaction_time_precision?: unknown })
      .transaction_time_precision,
    columnPrecisionPresence: columnPrecisionPresenceOf(receipt),
    transactionAtMs: receipt.transaction_at,
    analysisJson: receipt.analysis_json || '',
    merchantRaw: receipt.merchant_raw,
    merchantNormalized: receipt.merchant_normalized,
  });
}

function isTokyoMidnight(transactionAtMs: number): boolean {
  const date = new Date(transactionAtMs);
  if (!Number.isFinite(date.getTime())) return true;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
    const second = parts.find((part) => part.type === 'second')?.value ?? '';
    return hour === '00' && minute === '00' && second === '00';
  } catch {
    return true;
  }
}

/**
 * Exact transaction-time evidence for duplicate / occurrence identity.
 * Requires precision provenance === 'second'. Minute / date / unknown fail closed.
 * Date-only midnight is never exact even if mis-tagged.
 */
export function hasExactTransactionTime(receipt: ReceiptRow): boolean {
  if (!hasValidTransactionAt(receipt)) return false;
  if (resolveReceiptTransactionTimePrecision(receipt) !== 'second') {
    return false;
  }
  return !isTokyoMidnight(receipt.transaction_at as number);
}

/**
 * Usable purchase clock for same-precision collision (second or minute).
 * Date / unknown remain fail-closed. Does not treat mixed precisions as compatible.
 */
export function hasComparableTransactionClock(receipt: ReceiptRow): boolean {
  if (!hasValidTransactionAt(receipt)) return false;
  const precision = resolveReceiptTransactionTimePrecision(receipt);
  if (precision !== 'second' && precision !== 'minute') return false;
  return !isTokyoMidnight(receipt.transaction_at as number);
}

/**
 * True when both sides share the same second-or-minute precision tier.
 * Minute vs explicit-second never compatible (A1 false-merge guard).
 */
export function transactionTimePrecisionsAreCompatible(
  left: ReceiptRow,
  right: ReceiptRow
): boolean {
  const leftPrecision = resolveReceiptTransactionTimePrecision(left);
  const rightPrecision = resolveReceiptTransactionTimePrecision(right);
  if (leftPrecision !== rightPrecision) return false;
  return leftPrecision === 'second' || leftPrecision === 'minute';
}
