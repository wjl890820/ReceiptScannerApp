/**
 * A1.4A — Receipt transaction evidence (read-only).
 *
 * Shadow authorization requires provenance that specifically establishes the
 * receipt transaction timestamp. Historical schema mostly yields diagnostic-only
 * structured derived evidence sharing lineage with transaction_at.
 */

import type { ReceiptRow } from '../db';
import type {
  ParsedLocalDateTimeComponents,
  ReceiptTransactionConsistencyState,
  ReceiptTransactionEvidence,
  ReceiptTransactionPrecision,
} from './types';

const TOKYO = 'Asia/Tokyo';

function parseAnalysisJson(receipt: ReceiptRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(receipt.analysis_json || '{}');
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readStructuredTransactionDateText(
  analysis: Record<string, unknown> | null
): string | null {
  if (!analysis) return null;
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
  return null;
}

function readOcrRawText(analysis: Record<string, unknown> | null): string {
  if (!analysis) return '';
  for (const key of ['ocr_raw_text', 'rawText']) {
    const value = analysis[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function isValidLocalDateTimeComponents(
  components: ParsedLocalDateTimeComponents
): boolean {
  const { year, month, day, hour, minute, second } = components;
  if (year == null || !Number.isFinite(year) || year < 1) return false;
  if (month == null || !Number.isFinite(month) || month < 1 || month > 12) {
    return false;
  }
  if (day == null || !Number.isFinite(day) || day < 1) return false;
  if (day > daysInMonth(year, month)) return false;
  if (hour != null && (!Number.isFinite(hour) || hour < 0 || hour > 23)) {
    return false;
  }
  if (minute != null && (!Number.isFinite(minute) || minute < 0 || minute > 59)) {
    return false;
  }
  if (second != null && (!Number.isFinite(second) || second < 0 || second > 59)) {
    return false;
  }
  return true;
}

type TextDateParse = {
  text: string;
  components: ParsedLocalDateTimeComponents;
  precision: ReceiptTransactionPrecision;
};

function buildComponents(
  year: number,
  month: number,
  day: number,
  hour: number | null,
  minute: number | null,
  second: number | null
): ParsedLocalDateTimeComponents | null {
  const components: ParsedLocalDateTimeComponents = {
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
  return isValidLocalDateTimeComponents(components) ? components : null;
}

function parseTextDateString(text: string): TextDateParse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let m = trimmed.match(
    /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\([^)]*\))?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (m) {
    const second = m[6] != null ? Number(m[6]) : null;
    const components = buildComponents(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      second
    );
    if (!components) return null;
    return {
      text: trimmed,
      components,
      precision: second != null ? 'second' : 'minute',
    };
  }

  m = trimmed.match(
    /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const second = m[6] != null ? Number(m[6]) : null;
    const minute = m[5] != null ? Number(m[5]) : null;
    const hour = m[4] != null ? Number(m[4]) : null;
    const precision: ReceiptTransactionPrecision =
      second != null
        ? 'second'
        : hour != null && minute != null
          ? 'minute'
          : 'date';
    const components = buildComponents(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      hour,
      minute,
      second
    );
    if (!components) return null;
    return { text: trimmed, components, precision };
  }

  m = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const second = m[6] != null ? Number(m[6]) : null;
    const minute = m[5] != null ? Number(m[5]) : null;
    const hour = m[4] != null ? Number(m[4]) : null;
    const precision: ReceiptTransactionPrecision =
      second != null
        ? 'second'
        : hour != null && minute != null
          ? 'minute'
          : 'date';
    const components = buildComponents(
      Number(m[3]),
      Number(m[1]),
      Number(m[2]),
      hour,
      minute,
      second
    );
    if (!components) return null;
    return { text: trimmed, components, precision };
  }

  return null;
}

/** Diagnostic-only — never shadow-authorizing. */
function findDiagnosticOcrBlobDateCandidate(ocrText: string): TextDateParse | null {
  if (!ocrText.trim()) return null;
  const blobMatch = ocrText.match(
    /(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!blobMatch) return null;
  const parsed = parseTextDateString(blobMatch[0]!);
  if (!parsed) return null;
  return parsed;
}

function persistedTokyoComponents(
  ms: number
): ParsedLocalDateTimeComponents | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TOKYO,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(d);
  const read = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return buildComponents(
    read('year'),
    read('month'),
    read('day'),
    read('hour'),
    read('minute'),
    read('second')
  );
}

function resolveConsistency(
  persistedMs: number | null,
  parsed: ParsedLocalDateTimeComponents | null,
  precision: ReceiptTransactionPrecision
): ReceiptTransactionConsistencyState {
  if (!parsed || persistedMs == null) return 'unknown';
  const persisted = persistedTokyoComponents(persistedMs);
  if (!persisted) return 'unknown';

  if (parsed.year !== persisted.year) return 'conflict';
  if (parsed.month !== persisted.month) return 'conflict';
  if (parsed.day !== persisted.day) return 'conflict';
  if (parsed.hour !== persisted.hour || parsed.minute !== persisted.minute) {
    return 'conflict';
  }
  if (precision === 'second' && parsed.second != null && persisted.second != null) {
    if (parsed.second !== persisted.second) return 'conflict';
  }

  return 'derived_lineage';
}

export function buildReceiptTransactionEvidence(
  receipt: ReceiptRow
): ReceiptTransactionEvidence {
  const analysis = parseAnalysisJson(receipt);
  const structuredText = readStructuredTransactionDateText(analysis);
  const ocrText = readOcrRawText(analysis);

  const structuredParse = structuredText ? parseTextDateString(structuredText) : null;
  const diagnosticOcrParse = findDiagnosticOcrBlobDateCandidate(ocrText);

  const persisted =
    typeof receipt.transaction_at === 'number' &&
    Number.isFinite(receipt.transaction_at) &&
    receipt.transaction_at > 0
      ? receipt.transaction_at
      : null;

  const evidence: string[] = [];
  const reasonCodes: string[] = [];

  const structuredDerivedDateText = structuredParse?.text ?? null;
  const parsedFromStructuredDerived = structuredParse?.components ?? null;
  const diagnosticOcrDateCandidate = diagnosticOcrParse?.text ?? null;
  const parsedFromDiagnosticOcr = diagnosticOcrParse?.components ?? null;

  let precision: ReceiptTransactionPrecision = 'unknown';
  let textProvenance: ReceiptTransactionEvidence['textProvenance'] = 'unavailable';

  if (structuredParse) {
    precision = structuredParse.precision;
    textProvenance = 'structured_derived_analysis_field';
    evidence.push(`structured_derived_date_text=${structuredParse.text}`);
    evidence.push('structured_field_shares_ocr_parser_lineage_not_independently_printed');
  } else if (diagnosticOcrParse) {
    precision = diagnosticOcrParse.precision;
    textProvenance = 'diagnostic_ocr_blob_candidate';
    evidence.push(`diagnostic_ocr_blob_date_candidate=${diagnosticOcrParse.text}`);
    reasonCodes.push('ocr_blob_date_non_authoritative');
  } else if (structuredText || ocrText) {
    reasonCodes.push('transaction_date_text_unparseable');
  } else {
    reasonCodes.push('transaction_date_text_unavailable');
  }

  if (persisted != null) {
    evidence.push(`persisted_transaction_at_ms=${persisted}`);
  } else {
    reasonCodes.push('persisted_transaction_at_missing');
  }

  const parsedForConsistency = parsedFromStructuredDerived ?? parsedFromDiagnosticOcr;
  const consistencyState = resolveConsistency(
    persisted,
    parsedForConsistency,
    precision
  );
  if (consistencyState === 'conflict') {
    reasonCodes.push('derived_text_vs_persisted_datetime_conflict');
  }

  // A1.4A/V1: no field-level provenance in historical schema to authorize shadow matching.
  const shadowAuthorizable = false;
  reasonCodes.push('transaction_provenance_insufficient_for_shadow_authorization');

  if (persisted != null && precision === 'unknown') {
    reasonCodes.push('persisted_timestamp_alone_not_authorizing');
  }

  return {
    receiptId: receipt.id,
    persistedTimestampMs: persisted,
    structuredDerivedDateText,
    diagnosticOcrDateCandidate,
    parsedFromStructuredDerived,
    parsedFromDiagnosticOcr,
    precision,
    textProvenance,
    consistencyState,
    shadowAuthorizable,
    evidence: [...new Set(evidence)].sort(),
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}

export function calendarYearFromTransactionEvidence(
  evidence: ReceiptTransactionEvidence
): number | null {
  return (
    evidence.parsedFromStructuredDerived?.year ??
    evidence.parsedFromDiagnosticOcr?.year ??
    null
  );
}

function coarsestSharedPrecision(
  a: ReceiptTransactionPrecision,
  b: ReceiptTransactionPrecision
): 'second' | 'minute' | null {
  if (a === 'date' || b === 'date' || a === 'unknown' || b === 'unknown') {
    return null;
  }
  if (a === 'second' && b === 'second') return 'second';
  if (a === 'minute' || b === 'minute') return 'minute';
  if (a === 'second' || b === 'second') return 'minute';
  return null;
}

/** Shadow duplicate authorization — requires shadowAuthorizable on both sides. */
export function precisionCompatibleClockMatch(
  a: ReceiptTransactionEvidence,
  b: ReceiptTransactionEvidence
): boolean {
  if (!a.shadowAuthorizable || !b.shadowAuthorizable) return false;
  if (a.consistencyState === 'conflict' || b.consistencyState === 'conflict') {
    return false;
  }
  const pa = a.parsedFromStructuredDerived ?? a.parsedFromDiagnosticOcr;
  const pb = b.parsedFromStructuredDerived ?? b.parsedFromDiagnosticOcr;
  if (!pa || !pb) return false;
  if (pa.year !== pb.year) return false;
  if (pa.month !== pb.month || pa.day !== pb.day) return false;

  const shared = coarsestSharedPrecision(a.precision, b.precision);
  if (shared == null) return false;
  if (pa.hour !== pb.hour || pa.minute !== pb.minute) return false;
  if (shared === 'second' && pa.second !== pb.second) return false;
  return true;
}

/** Diagnostic-only clock comparison (may differ in year). */
export function diagnosticClockSimilarity(
  a: ReceiptTransactionEvidence,
  b: ReceiptTransactionEvidence
): 'compatible_minute_or_second' | 'partial' | 'unknown' {
  const pa = a.parsedFromStructuredDerived ?? a.parsedFromDiagnosticOcr;
  const pb = b.parsedFromStructuredDerived ?? b.parsedFromDiagnosticOcr;
  if (!pa || !pb) return 'unknown';
  if (pa.month !== pb.month || pa.day !== pb.day) return 'partial';
  const shared = coarsestSharedPrecision(a.precision, b.precision);
  if (shared == null) return 'partial';
  if (pa.hour !== pb.hour || pa.minute !== pb.minute) return 'partial';
  if (shared === 'second' && pa.second !== pb.second) return 'partial';
  return 'compatible_minute_or_second';
}
