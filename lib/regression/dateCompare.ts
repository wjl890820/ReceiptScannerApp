/**
 * Semantic receipt timestamp comparison for regression grading/matching.
 * Uses production parseReceiptDateTime — no broad fuzzy matching.
 */

import { parseReceiptDateTime } from '../dateParser';

function hasExplicitSeconds(raw: string): boolean {
  // time with seconds: HH:MM:SS (not just HH:MM)
  return /(?:[T\s]\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2}:\d{2}\b)/.test(raw);
}

function toEpochMs(
  value: unknown,
  merchantHint?: string | null
): { ms: number; raw: string; hasSeconds: boolean } | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { ms: value, raw: String(value), hasSeconds: true };
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const ms = parseReceiptDateTime(raw, {
    merchant: merchantHint ?? undefined,
    fallbackToNow: false,
  });
  if (ms == null) {
    const iso = Date.parse(raw);
    if (!Number.isFinite(iso)) return null;
    return { ms: iso, raw, hasSeconds: hasExplicitSeconds(raw) };
  }
  return { ms, raw, hasSeconds: hasExplicitSeconds(raw) };
}

function truncateToMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * True when two timestamp representations denote the same receipt instant.
 * - If either side lacks seconds → compare at minute precision.
 * - If both have seconds → compare at second precision (truncate ms).
 */
export function receiptTimestampsEqual(
  a: unknown,
  b: unknown,
  merchantHint?: string | null
): boolean {
  const pa = toEpochMs(a, merchantHint);
  const pb = toEpochMs(b, merchantHint);
  if (!pa || !pb) return false;
  if (!pa.hasSeconds || !pb.hasSeconds) {
    return truncateToMinute(pa.ms) === truncateToMinute(pb.ms);
  }
  return Math.floor(pa.ms / 1000) === Math.floor(pb.ms / 1000);
}

export type TokyoClockParts = {
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number | null;
};

/** Asia/Tokyo wall-clock parts for epoch ms. */
export function tokyoClockParts(ms: number): TokyoClockParts | null {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  if (![month, day, hour, minute, second].every((n) => Number.isFinite(n))) {
    return null;
  }
  return { month, day, hour, minute, second };
}

/**
 * Compare local M/D H:M(/S) ignoring year (OCR year disagreement).
 * Seconds: if selector has seconds and row has seconds, require equal seconds;
 * if either lacks seconds, compare minute only.
 */
export function tokyoClockEqualIgnoreYear(
  selectorIso: string,
  rowEpochMs: number | null,
  rowDateString: string | null,
  merchantHint?: string | null
): boolean {
  const sel = toEpochMs(selectorIso, merchantHint);
  if (!sel) return false;
  const rowMs =
    rowEpochMs != null && Number.isFinite(rowEpochMs)
      ? rowEpochMs
      : toEpochMs(rowDateString, merchantHint)?.ms ?? null;
  if (rowMs == null) return false;
  const a = tokyoClockParts(sel.ms);
  const b = tokyoClockParts(rowMs);
  if (!a || !b) return false;
  if (a.month !== b.month || a.day !== b.day) return false;
  if (a.hour !== b.hour || a.minute !== b.minute) return false;
  if (sel.hasSeconds && a.second != null && b.second != null) {
    return a.second === b.second;
  }
  return true;
}
