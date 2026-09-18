/**
 * Manifest matching and representative selection for multi-row physical receipts.
 *
 * Representative selection is truth-independent (historical data only).
 */

import { deriveRetailerIdentity } from '../retailerIdentity';
import { tokyoClockEqualIgnoreYear } from './dateCompare';
import type { LoadedHistoricalRow, RegressionManifest } from './types';

function normalizeLoose(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\s　]/g, '')
    .toLowerCase();
}

function merchantCompatible(a: string, b: string): boolean {
  const na = normalizeLoose(a);
  const nb = normalizeLoose(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ra = deriveRetailerIdentity({ merchantRaw: a });
  const rb = deriveRetailerIdentity({ merchantRaw: b });
  if (
    ra.retailerKey &&
    rb.retailerKey &&
    ra.retailerKey !== 'unresolved' &&
    ra.retailerKey === rb.retailerKey
  ) {
    return true;
  }
  return false;
}

function rowDateString(row: LoadedHistoricalRow): string | null {
  const payload = row.baselinePayload;
  if (!payload) return null;
  if (typeof payload.transactionDate === 'string' && payload.transactionDate.trim()) {
    return payload.transactionDate.trim();
  }
  if (typeof payload.transaction_date === 'string' && payload.transaction_date.trim()) {
    return payload.transaction_date.trim();
  }
  return null;
}

function rowMerchant(row: LoadedHistoricalRow): string {
  return (
    row.merchantRaw ||
    row.merchantNormalized ||
    (typeof row.baselinePayload?.merchant === 'string'
      ? row.baselinePayload.merchant
      : '') ||
    ''
  );
}

function positiveOrderedLineAmounts(row: LoadedHistoricalRow): number[] {
  const items = row.baselinePayload?.items;
  if (!Array.isArray(items)) return [];
  const out: number[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const raw = (it as { lineTotal?: unknown; line_total?: unknown }).lineTotal
      ?? (it as { line_total?: unknown }).line_total;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) out.push(Math.round(n));
  }
  return out;
}

function orderedAmountsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => Math.round(v) === Math.round(b[i]));
}

export type LineAmountsFingerprintStatus =
  | 'exact'
  | 'contains_expected_lines_plus_extra'
  | 'mismatch'
  | 'unavailable';

/**
 * Diagnostic only — never used as a hard membership gate.
 * expected: ordered positive line totals from truth/diagnostic reference.
 * actual: positive line totals from historical row (order preserved).
 */
export function classifyLineAmountsFingerprint(
  expected: number[] | null | undefined,
  actual: number[]
): LineAmountsFingerprintStatus {
  if (!expected || expected.length === 0) return 'unavailable';
  const exp = expected.map((n) => Math.round(n));
  const act = actual.map((n) => Math.round(n));
  if (orderedAmountsEqual(exp, act)) return 'exact';

  // Multiset inclusion: every expected amount consumed from actual bag.
  const bag = new Map<number, number>();
  for (const n of act) bag.set(n, (bag.get(n) ?? 0) + 1);
  let allPresent = true;
  for (const n of exp) {
    const c = bag.get(n) ?? 0;
    if (c <= 0) {
      allPresent = false;
      break;
    }
    bag.set(n, c - 1);
  }
  if (allPresent && act.length > exp.length) {
    return 'contains_expected_lines_plus_extra';
  }
  return 'mismatch';
}

/**
 * exact (default): ±2 min on epoch / Date.parse — NEVER ignores year.
 * local_clock_ignore_year: explicit OCR year-drift opt-in only.
 */
function transactionAtCompatible(
  selectorIso: string,
  row: LoadedHistoricalRow,
  mode: 'exact' | 'local_clock_ignore_year' = 'exact',
  merchantHint?: string | null
): boolean {
  if (mode === 'local_clock_ignore_year') {
    return tokyoClockEqualIgnoreYear(
      selectorIso,
      row.transactionAt,
      rowDateString(row),
      merchantHint ?? row.merchantRaw
    );
  }

  const sel = Date.parse(selectorIso);
  if (!Number.isFinite(sel)) return false;
  if (row.transactionAt != null && Number.isFinite(row.transactionAt)) {
    return Math.abs(row.transactionAt - sel) <= 120_000;
  }
  const td = rowDateString(row);
  if (!td) return false;
  const p = Date.parse(td);
  // No implicit ignore-year fallback when Date.parse fails.
  if (!Number.isFinite(p)) return false;
  return Math.abs(p - sel) <= 120_000;
}

function totalCompatible(selectorTotal: number, row: LoadedHistoricalRow): boolean {
  if (row.total != null && Math.round(row.total) === Math.round(selectorTotal)) {
    return true;
  }
  const t = row.baselinePayload?.total;
  if (typeof t === 'number' && Math.round(t) === Math.round(selectorTotal)) {
    return true;
  }
  return false;
}

/**
 * Selector gate (MATCHING only).
 * For local_clock_ignore_year: merchant + total + clock are mandatory.
 * Line-amount fingerprints are NEVER hard filters here — see
 * classifyLineAmountsFingerprint (diagnostic / grading separation).
 */
export function rowPassesSelectors(
  row: LoadedHistoricalRow,
  sel: NonNullable<RegressionManifest['selectors']>
): boolean {
  const mode = sel.transactionAtMatch ?? 'exact';

  if (mode === 'local_clock_ignore_year') {
    if (!sel.merchant || sel.total == null || !sel.transactionAt) {
      return false;
    }
  }

  if (sel.merchant) {
    const m = rowMerchant(row);
    if (!m || !merchantCompatible(sel.merchant, String(m))) return false;
  }
  if (sel.total != null && !totalCompatible(sel.total, row)) return false;
  if (sel.transactionAt) {
    if (
      !transactionAtCompatible(
        sel.transactionAt,
        row,
        mode,
        sel.merchant ?? row.merchantRaw
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Match via selectors only.
 * sourceReceiptIds are observational metadata and must NOT drive matching.
 */
export function matchManifestToRows(
  manifest: RegressionManifest,
  rows: LoadedHistoricalRow[]
): LoadedHistoricalRow[] {
  const sel = manifest.selectors;
  if (!sel || (!sel.merchant && sel.transactionAt == null && sel.total == null)) {
    // Fall back to truth header fields as soft selectors (exact date; never ignore year).
    const t = manifest.truth;
    if (!t.merchant && t.transactionAt == null && t.total == null) return [];
    return rows.filter((row) =>
      rowPassesSelectors(row, {
        merchant: t.merchant,
        transactionAt: t.transactionAt,
        total: t.total,
        transactionAtMatch: 'exact',
      })
    );
  }

  return rows.filter((row) => rowPassesSelectors(row, sel));
}

/**
 * Soft probe for unmatched classification: merchant+total only (no date).
 */
export function softMatchMerchantTotal(
  manifest: RegressionManifest,
  rows: LoadedHistoricalRow[]
): LoadedHistoricalRow[] {
  const merchant = manifest.selectors?.merchant ?? manifest.truth.merchant;
  const total = manifest.selectors?.total ?? manifest.truth.total;
  if (!merchant || total == null) return [];
  return rows.filter((row) => {
    const m = rowMerchant(row);
    if (!m || !merchantCompatible(merchant, m)) return false;
    return totalCompatible(total, row);
  });
}

export type UnmatchedReason = 'source_missing' | 'selector_failed';

export function classifyUnmatchedReason(
  manifest: RegressionManifest,
  rows: LoadedHistoricalRow[]
): UnmatchedReason {
  const soft = softMatchMerchantTotal(manifest, rows);
  return soft.length === 0 ? 'source_missing' : 'selector_failed';
}

/**
 * Truth-independent representative among historical matches.
 * 1) recognition_snapshot available
 * 2) newest created_at
 * 3) stable receipt id
 *
 * Deliberately does NOT use human truth (year/tax/item count/etc.).
 */
export function pickRepresentativeRow(
  matches: LoadedHistoricalRow[]
): { row: LoadedHistoricalRow; rule: string } | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return { row: matches[0], rule: 'single_match' };
  }

  const ranked = [...matches].sort((a, b) => {
    const stageScore = (r: LoadedHistoricalRow) =>
      r.baselineStage === 'recognition_snapshot'
        ? 2
        : r.baselineStage === 'analysis_current'
          ? 1
          : 0;
    const ds = stageScore(b) - stageScore(a);
    if (ds !== 0) return ds;

    const ca = a.createdAt ?? 0;
    const cb = b.createdAt ?? 0;
    if (cb !== ca) return cb - ca;

    return a.receiptId.localeCompare(b.receiptId);
  });

  const top = ranked[0];
  const ruleParts: string[] = [];
  if (top.baselineStage === 'recognition_snapshot') {
    ruleParts.push('prefer_recognition_snapshot');
  }
  ruleParts.push('newest_created_at', 'stable_id');
  return { row: top, rule: ruleParts.join('>') };
}

export function hasConnectionPhantom(row: LoadedHistoricalRow): boolean {
  const items = row.baselinePayload?.items;
  if (!Array.isArray(items)) return false;
  return items.some((it) => {
    if (!it || typeof it !== 'object') return false;
    const name = String((it as { name?: unknown }).name ?? '');
    return /コネクション|connection/i.test(name);
  });
}

export function memberObservation(
  row: LoadedHistoricalRow,
  fingerprintExpected?: number[] | null
): {
  receiptId: string;
  date: string | null;
  tax: number | null;
  itemRowCount: number;
  connectionPhantom: boolean;
  baselineStage: string;
  createdAt: number | null;
  lineAmountsFingerprint: LineAmountsFingerprintStatus;
} {
  const items = row.baselinePayload?.items;
  const actual = positiveOrderedLineAmounts(row);
  return {
    receiptId: row.receiptId,
    date: rowDateString(row),
    tax: row.tax ?? (typeof row.baselinePayload?.tax === 'number'
      ? row.baselinePayload.tax
      : null),
    itemRowCount: Array.isArray(items) ? items.length : 0,
    connectionPhantom: hasConnectionPhantom(row),
    baselineStage: row.baselineStage,
    createdAt: row.createdAt,
    lineAmountsFingerprint: classifyLineAmountsFingerprint(
      fingerprintExpected,
      actual
    ),
  };
}

export {
  merchantCompatible,
  normalizeLoose,
  positiveOrderedLineAmounts,
  orderedAmountsEqual,
};
