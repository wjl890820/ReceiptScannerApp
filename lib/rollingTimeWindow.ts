/**
 * Shared rolling time-window helpers (M1-E).
 *
 * Semantics: wall-clock rolling windows (N * 24h from `now`), NOT JST calendar buckets.
 * JST calendar day helpers remain in `dateParser.ts` (`jstCalendarDayStartMs` / `jstCalendarDayKey`).
 *
 * Defaults (presentation) may differ by surface:
 * - Home progressive context historically preferred short windows (7D)
 * - Analysis defaults to month (~30D)
 * Those defaults are intentional product choices; this module only owns the cutoff math.
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Rolling window lengths used by V1 analytics surfaces. */
export type RollingWindowDays = 7 | 30;

/**
 * Inclusive lower bound: timestamps >= cutoff are inside the window.
 * `days <= 0` means "all history" (cutoff = 0).
 */
export function rollingWindowCutoffMs(
  days: number,
  nowMs: number = Date.now()
): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  return nowMs - days * MS_PER_DAY;
}

export function filterByRollingWindowDays<T>(
  items: readonly T[],
  timestampOf: (item: T) => number,
  days: number | null,
  nowMs: number = Date.now()
): T[] {
  if (days == null || days <= 0) return [...items];
  const cutoff = rollingWindowCutoffMs(days, nowMs);
  return items.filter((item) => timestampOf(item) >= cutoff);
}

/** Map Analysis TimeRange → rolling days (null = all). */
export function rollingDaysForAnalysisRange(
  range: 'week' | 'month' | 'all'
): RollingWindowDays | null {
  if (range === 'week') return 7;
  if (range === 'month') return 30;
  return null;
}

/** Map Home preference range → rolling days (null = all). */
export function rollingDaysForHomeRange(
  range: '7D' | '30D' | 'ALL'
): RollingWindowDays | null {
  if (range === '7D') return 7;
  if (range === '30D') return 30;
  return null;
}
