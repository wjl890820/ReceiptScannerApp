/**
 * Asia/Tokyo wall-clock helpers for receipt chronology comparisons.
 */

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
