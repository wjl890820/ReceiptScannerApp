import type { ReceiptRow } from './db';
import {
  inferReceiptTransactionTimePrecision,
  type ReceiptTransactionPrecision,
} from './dateParser';

export type { ReceiptTransactionPrecision };

const PRECISION_VALUES = new Set<ReceiptTransactionPrecision>([
  'second',
  'minute',
  'date',
  'unknown',
]);

export function hasValidTransactionAt(receipt: ReceiptRow): boolean {
  const value = receipt.transaction_at;
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function readStructuredTransactionDateText(
  receipt: ReceiptRow
): string | null {
  try {
    const parsed = JSON.parse(receipt.analysis_json || '{}');
    if (!parsed || typeof parsed !== 'object') return null;
    const analysis = parsed as Record<string, unknown>;
    for (const key of [
      'transactionDate',
      'transaction_date',
      'transactionAt',
      'purchasedAt',
      'datetime',
    ]) {
      const value = analysis[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function readStoredPrecision(
  receipt: ReceiptRow
): ReceiptTransactionPrecision | null {
  const raw = receipt.transaction_time_precision;
  if (typeof raw === 'string' && PRECISION_VALUES.has(raw as ReceiptTransactionPrecision)) {
    return raw as ReceiptTransactionPrecision;
  }
  try {
    const parsed = JSON.parse(receipt.analysis_json || '{}');
    const value =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).transaction_time_precision
        : null;
    if (
      typeof value === 'string' &&
      PRECISION_VALUES.has(value as ReceiptTransactionPrecision)
    ) {
      return value as ReceiptTransactionPrecision;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolve durable transaction-time precision.
 * Prefer persisted column / analysis field; else reconstruct from structured
 * date text in analysis_json. Never infer from epoch second==0.
 */
export function resolveReceiptTransactionTimePrecision(
  receipt: ReceiptRow
): ReceiptTransactionPrecision {
  const stored = readStoredPrecision(receipt);
  if (stored) return stored;
  const text = readStructuredTransactionDateText(receipt);
  if (text) return inferReceiptTransactionTimePrecision(text);
  return 'unknown';
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
