import type { ReceiptRow } from './db';
import {
  parseReceiptDateTimeWithPrecision,
  type ReceiptTransactionPrecision,
} from './dateParser';

export type { ReceiptTransactionPrecision };

const PRECISION_VALUES = new Set<ReceiptTransactionPrecision>([
  'second',
  'minute',
  'date',
  'unknown',
]);

const STRUCTURED_DATE_KEYS = [
  'transactionDate',
  'transaction_date',
  'transactionAt',
  'purchasedAt',
  'datetime',
] as const;

export function hasValidTransactionAt(receipt: ReceiptRow): boolean {
  const value = receipt.transaction_at;
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPrecisionValue(
  value: unknown
): value is ReceiptTransactionPrecision {
  return (
    typeof value === 'string' &&
    PRECISION_VALUES.has(value as ReceiptTransactionPrecision)
  );
}

/**
 * DB column provenance — must not collapse missing and invalid.
 * Storage contract writes exact lowercase tokens; no trim/case normalize.
 */
type ColumnPrecisionRead =
  | { state: 'missing' }
  | { state: 'valid'; value: ReceiptTransactionPrecision }
  | { state: 'invalid' };

/**
 * Analysis_json.transaction_time_precision — absent vs valid vs invalid.
 * Explicit invalid (incl. null when key exists) fails closed.
 */
type AnalysisPrecisionRead =
  | { state: 'absent' }
  | { state: 'valid'; value: ReceiptTransactionPrecision }
  | { state: 'invalid' };

function readColumnPrecision(receipt: ReceiptRow): ColumnPrecisionRead {
  if (
    !Object.prototype.hasOwnProperty.call(receipt, 'transaction_time_precision')
  ) {
    return { state: 'missing' };
  }
  const raw = (receipt as { transaction_time_precision?: unknown })
    .transaction_time_precision;
  // Genuine legacy absence: null / undefined on the row.
  if (raw === null || raw === undefined) {
    return { state: 'missing' };
  }
  if (isPrecisionValue(raw)) {
    return { state: 'valid', value: raw };
  }
  // Explicit malformed persisted token (e.g. "SECOND", "", 123).
  return { state: 'invalid' };
}

type AnalysisJsonRead = {
  analysisPrecision: AnalysisPrecisionRead;
  structuredDateText: string | null;
  merchantHint: string | null;
};

function readAnalysisJson(receipt: ReceiptRow): AnalysisJsonRead {
  const empty: AnalysisJsonRead = {
    analysisPrecision: { state: 'absent' },
    structuredDateText: null,
    merchantHint: null,
  };
  try {
    const parsed = JSON.parse(receipt.analysis_json || '{}');
    if (!parsed || typeof parsed !== 'object') return empty;
    const analysis = parsed as Record<string, unknown>;

    let analysisPrecision: AnalysisPrecisionRead = { state: 'absent' };
    if (
      Object.prototype.hasOwnProperty.call(
        analysis,
        'transaction_time_precision'
      )
    ) {
      const rawPrecision = analysis.transaction_time_precision;
      analysisPrecision = isPrecisionValue(rawPrecision)
        ? { state: 'valid', value: rawPrecision }
        : { state: 'invalid' };
    }

    let structuredDateText: string | null = null;
    for (const key of STRUCTURED_DATE_KEYS) {
      const value = analysis[key];
      if (typeof value === 'string' && value.trim()) {
        structuredDateText = value.trim();
        break;
      }
    }

    const rawMerchant =
      analysis.merchant ||
      analysis.merchant_normalized ||
      analysis.merchantNormalized;
    const merchantHint =
      typeof rawMerchant === 'string' && rawMerchant.trim()
        ? rawMerchant.trim()
        : null;

    return {
      analysisPrecision,
      structuredDateText,
      merchantHint,
    };
  } catch {
    return empty;
  }
}

function resolveMerchantHint(
  receipt: ReceiptRow,
  analysisMerchant: string | null
): string | null {
  if (analysisMerchant) return analysisMerchant;
  if (
    typeof receipt.merchant_raw === 'string' &&
    receipt.merchant_raw.trim()
  ) {
    return receipt.merchant_raw.trim();
  }
  if (
    typeof receipt.merchant_normalized === 'string' &&
    receipt.merchant_normalized.trim()
  ) {
    return receipt.merchant_normalized.trim();
  }
  return null;
}

/**
 * Attempt legacy reconstruction from structured date text when the DB column
 * is unknown/missing and analysis did not persist an explicit precision key.
 * Accepts only exact reparse equality with transaction_at.
 */
function reconstructLegacyPrecision(
  receipt: ReceiptRow,
  dateText: string,
  merchantHint: string | null
): ReceiptTransactionPrecision {
  if (!hasValidTransactionAt(receipt)) return 'unknown';
  try {
    const parsed = parseReceiptDateTimeWithPrecision(dateText, {
      fallbackToNow: false,
      merchant: merchantHint,
    });
    const parsedMs = parsed.ms;
    if (
      typeof parsedMs !== 'number' ||
      !Number.isFinite(parsedMs) ||
      parsedMs <= 0
    ) {
      return 'unknown';
    }
    if (parsedMs !== receipt.transaction_at) {
      return 'unknown';
    }
    return parsed.precision;
  } catch {
    return 'unknown';
  }
}

/**
 * Resolve durable transaction-time precision.
 *
 * DB column authority:
 * - second | minute | date → return immediately
 * - unknown | missing → continue to analysis / legacy reconstruction
 * - invalid explicit token → unknown (no analysis, no reconstruction)
 *
 * Never infer precision from epoch second==0 / % 60000 / % 1000.
 */
export function resolveReceiptTransactionTimePrecision(
  receipt: ReceiptRow
): ReceiptTransactionPrecision {
  const column = readColumnPrecision(receipt);

  if (column.state === 'valid') {
    if (
      column.value === 'second' ||
      column.value === 'minute' ||
      column.value === 'date'
    ) {
      return column.value;
    }
    // valid unknown — fall through to analysis / reconstruction
  } else if (column.state === 'invalid') {
    // Explicit malformed persisted provenance — fail closed.
    return 'unknown';
  }
  // missing or valid unknown

  const analysis = readAnalysisJson(receipt);

  if (analysis.analysisPrecision.state === 'valid') {
    return analysis.analysisPrecision.value;
  }
  if (analysis.analysisPrecision.state === 'invalid') {
    // Explicit invalid analysis provenance — fail closed, no reconstruction.
    return 'unknown';
  }

  // Legacy reconstruction: DB unknown|missing, analysis key absent, text present.
  const mayReconstruct =
    column.state === 'missing' ||
    (column.state === 'valid' && column.value === 'unknown');
  if (
    mayReconstruct &&
    analysis.analysisPrecision.state === 'absent' &&
    analysis.structuredDateText
  ) {
    return reconstructLegacyPrecision(
      receipt,
      analysis.structuredDateText,
      resolveMerchantHint(receipt, analysis.merchantHint)
    );
  }

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
