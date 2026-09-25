/**
 * Pure transaction-time precision authority (A1).
 * Dependency-neutral — no ReceiptRow / db imports.
 * Shared by local resolver and cloud restore.
 */

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

export function isReceiptTransactionPrecisionToken(
  value: unknown
): value is ReceiptTransactionPrecision {
  return (
    typeof value === 'string' &&
    PRECISION_VALUES.has(value as ReceiptTransactionPrecision)
  );
}

export type ColumnPrecisionPresence = 'absent' | 'present';

/**
 * Raw persisted / cloud precision token classification.
 * Distinguishes missing vs valid vs explicit invalid — do not collapse
 * invalid into missing or into resolved `unknown` at transport boundaries.
 */
export type PersistedPrecisionTokenState =
  | { state: 'missing' }
  | { state: 'valid'; value: ReceiptTransactionPrecision }
  | { state: 'invalid' };

export function classifyPersistedPrecisionToken(
  raw: unknown,
  presence: ColumnPrecisionPresence
): PersistedPrecisionTokenState {
  if (presence === 'absent') return { state: 'missing' };
  if (raw === null || raw === undefined) return { state: 'missing' };
  if (isReceiptTransactionPrecisionToken(raw)) {
    return { state: 'valid', value: raw };
  }
  return { state: 'invalid' };
}

export type ResolveTransactionTimePrecisionInput = {
  /**
   * Raw persisted / cloud precision value.
   * Interpreted with columnPrecisionPresence — do not collapse invalid→absent.
   */
  columnPrecision: unknown;
  /** Whether the source object owns the precision property. */
  columnPrecisionPresence: ColumnPrecisionPresence;
  /** Epoch ms; required for exact-equality legacy reconstruction. */
  transactionAtMs: number | null | undefined;
  analysisJson: string;
  merchantRaw?: string | null;
  merchantNormalized?: string | null;
};

type AnalysisPrecisionRead =
  | { state: 'absent' }
  | { state: 'valid'; value: ReceiptTransactionPrecision }
  | { state: 'invalid' };

function readAnalysisJson(analysisJson: string): {
  analysisPrecision: AnalysisPrecisionRead;
  structuredDateText: string | null;
  merchantHint: string | null;
} {
  const empty = {
    analysisPrecision: { state: 'absent' } as AnalysisPrecisionRead,
    structuredDateText: null as string | null,
    merchantHint: null as string | null,
  };
  try {
    const parsed = JSON.parse(analysisJson || '{}');
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
      analysisPrecision = isReceiptTransactionPrecisionToken(rawPrecision)
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

    return { analysisPrecision, structuredDateText, merchantHint };
  } catch {
    return empty;
  }
}

function resolveMerchantHint(
  analysisMerchant: string | null,
  merchantRaw?: string | null,
  merchantNormalized?: string | null
): string | null {
  if (analysisMerchant) return analysisMerchant;
  if (typeof merchantRaw === 'string' && merchantRaw.trim()) {
    return merchantRaw.trim();
  }
  if (typeof merchantNormalized === 'string' && merchantNormalized.trim()) {
    return merchantNormalized.trim();
  }
  return null;
}

function hasValidTransactionAtMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function reconstructLegacyPrecision(
  transactionAtMs: number,
  dateText: string,
  merchantHint: string | null
): ReceiptTransactionPrecision {
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
    if (parsedMs !== transactionAtMs) {
      return 'unknown';
    }
    return parsed.precision;
  } catch {
    return 'unknown';
  }
}

/**
 * A1 authority decision table (local column / cloud precision field).
 *
 * - second | minute | date → return immediately
 * - unknown | missing → analysis / optional exact-ms reconstruction
 * - invalid explicit token → unknown (no analysis, no reconstruction)
 */
export function resolveTransactionTimePrecisionAuthority(
  input: ResolveTransactionTimePrecisionInput
): ReceiptTransactionPrecision {
  const column = classifyPersistedPrecisionToken(
    input.columnPrecision,
    input.columnPrecisionPresence
  );

  if (column.state === 'valid') {
    if (
      column.value === 'second' ||
      column.value === 'minute' ||
      column.value === 'date'
    ) {
      return column.value;
    }
  } else if (column.state === 'invalid') {
    return 'unknown';
  }

  const analysis = readAnalysisJson(input.analysisJson);

  if (analysis.analysisPrecision.state === 'valid') {
    return analysis.analysisPrecision.value;
  }
  if (analysis.analysisPrecision.state === 'invalid') {
    return 'unknown';
  }

  const mayReconstruct =
    column.state === 'missing' ||
    (column.state === 'valid' && column.value === 'unknown');
  if (
    mayReconstruct &&
    analysis.analysisPrecision.state === 'absent' &&
    analysis.structuredDateText &&
    hasValidTransactionAtMs(input.transactionAtMs)
  ) {
    return reconstructLegacyPrecision(
      input.transactionAtMs,
      analysis.structuredDateText,
      resolveMerchantHint(
        analysis.merchantHint,
        input.merchantRaw,
        input.merchantNormalized
      )
    );
  }

  return 'unknown';
}

/** Presence helper for plain source objects (ReceiptRow / cloud row). */
export function columnPrecisionPresenceOf(
  source: object
): ColumnPrecisionPresence {
  return Object.prototype.hasOwnProperty.call(
    source,
    'transaction_time_precision'
  )
    ? 'present'
    : 'absent';
}
