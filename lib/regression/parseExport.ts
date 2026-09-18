/**
 * Parse receipts DB export envelope and nested JSON columns.
 */

import type { BaselineStage, LoadedHistoricalRow, ParsedNestedJson } from './types';

export type ExportEnvelope = {
  exportedAt?: string;
  dbName?: string;
  orderBy?: string;
  receiptCount?: number;
  receipts: Record<string, unknown>[];
};

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Safely parse a nested JSON TEXT column into an object. */
export function parseNestedJsonObject(raw: unknown): ParsedNestedJson {
  if (raw == null) {
    return { ok: false, error: 'missing' };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { ok: true, value: raw as Record<string, unknown> };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `unexpected_type:${typeof raw}` };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'empty_string' };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'not_object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'json_parse_error',
    };
  }
}

/**
 * Prefer recognition_snapshot_json; fall back to analysis_json with explicit reason.
 * Malformed preferred snapshot must NOT silently fall through without recording.
 */
export function resolveBaselinePayload(row: Record<string, unknown>): {
  baselineStage: BaselineStage;
  fallbackReason: string | null;
  parseError: string | null;
  snapshotObject: Record<string, unknown> | null;
  analysisObject: Record<string, unknown> | null;
  baselinePayload: Record<string, unknown> | null;
} {
  const snapRaw = row.recognition_snapshot_json;
  const analysisRaw = row.analysis_json;

  const hasSnapColumn =
    snapRaw != null &&
    !(typeof snapRaw === 'string' && !String(snapRaw).trim());

  let snapshotObject: Record<string, unknown> | null = null;
  let analysisObject: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  let fallbackReason: string | null = null;

  if (hasSnapColumn) {
    const snap = parseNestedJsonObject(snapRaw);
    if (snap.ok) {
      snapshotObject = snap.value;
      // Still parse analysis for metadata (non-fatal).
      const an = parseNestedJsonObject(analysisRaw);
      if (an.ok) analysisObject = an.value;
      return {
        baselineStage: 'recognition_snapshot',
        fallbackReason: null,
        parseError: null,
        snapshotObject,
        analysisObject,
        baselinePayload: snapshotObject,
      };
    }
    // Preferred snapshot malformed — report and optionally fall back.
    parseError = `recognition_snapshot_json:${snap.error}`;
    const an = parseNestedJsonObject(analysisRaw);
    if (an.ok) {
      analysisObject = an.value;
      fallbackReason = `malformed_recognition_snapshot:${snap.error}`;
      return {
        baselineStage: 'analysis_current',
        fallbackReason,
        parseError,
        snapshotObject: null,
        analysisObject,
        baselinePayload: analysisObject,
      };
    }
    return {
      baselineStage: 'unavailable',
      fallbackReason: null,
      parseError: `${parseError}; analysis_json:${an.error}`,
      snapshotObject: null,
      analysisObject: null,
      baselinePayload: null,
    };
  }

  const an = parseNestedJsonObject(analysisRaw);
  if (an.ok) {
    analysisObject = an.value;
    fallbackReason = 'missing_recognition_snapshot';
    return {
      baselineStage: 'analysis_current',
      fallbackReason,
      parseError: null,
      snapshotObject: null,
      analysisObject,
      baselinePayload: analysisObject,
    };
  }

  return {
    baselineStage: 'unavailable',
    fallbackReason: null,
    parseError: `analysis_json:${an.error}`,
    snapshotObject: null,
    analysisObject: null,
    baselinePayload: null,
  };
}

export function loadExportEnvelope(raw: unknown): ExportEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Export root must be an object envelope');
  }
  const env = raw as Record<string, unknown>;
  const receipts = env.receipts;
  if (!Array.isArray(receipts)) {
    throw new Error('Export envelope missing receipts[] array');
  }
  return {
    exportedAt: typeof env.exportedAt === 'string' ? env.exportedAt : undefined,
    dbName: typeof env.dbName === 'string' ? env.dbName : undefined,
    orderBy: typeof env.orderBy === 'string' ? env.orderBy : undefined,
    receiptCount:
      typeof env.receiptCount === 'number' ? env.receiptCount : receipts.length,
    receipts: receipts as Record<string, unknown>[],
  };
}

export function loadHistoricalRow(
  row: Record<string, unknown>
): LoadedHistoricalRow {
  const resolved = resolveBaselinePayload(row);
  const id =
    asTrimmedString(row.id) ??
    asTrimmedString(row.receipt_id) ??
    `unknown_${Math.random().toString(16).slice(2, 10)}`;

  const imageUri = asTrimmedString(row.image_uri);
  return {
    receiptId: id,
    createdAt: asFiniteNumber(row.created_at),
    transactionAt: asFiniteNumber(row.transaction_at),
    merchantRaw: asTrimmedString(row.merchant_raw),
    merchantNormalized: asTrimmedString(row.merchant_normalized),
    total: asFiniteNumber(row.total),
    tax: asFiniteNumber(row.tax),
    currency: asTrimmedString(row.currency),
    baselineStage: resolved.baselineStage,
    fallbackReason: resolved.fallbackReason,
    parseError: resolved.parseError,
    imageUriPresent: Boolean(imageUri),
    analysisObject: resolved.analysisObject,
    snapshotObject: resolved.snapshotObject,
    baselinePayload: resolved.baselinePayload,
    rawRowKeys: Object.keys(row),
  };
}

export function loadAllHistoricalRows(
  envelope: ExportEnvelope
): LoadedHistoricalRow[] {
  return envelope.receipts.map((r) =>
    loadHistoricalRow(r && typeof r === 'object' ? (r as Record<string, unknown>) : {})
  );
}
