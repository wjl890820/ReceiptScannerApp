/**
 * Home Frequent Product recency — presentation-only label from existing
 * `lastPurchasedAt` on the Frequent / Repeat row model.
 */

import { formatDate } from './formatDate';

export type FrequentRecencyTranslate = (
  key: string,
  params?: Record<string, string | number>
) => string;

/**
 * Fail closed: missing/invalid timestamps omit the label (no fabricated date).
 * Date portion follows Product Detail: formatDate(ts).slice(0, 10).
 */
export function formatHomeFrequentLastPurchasedLabel(
  lastPurchasedAt: number,
  translate: FrequentRecencyTranslate
): string | null {
  if (!Number.isFinite(lastPurchasedAt) || lastPurchasedAt <= 0) {
    return null;
  }
  const instant = new Date(lastPurchasedAt);
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  const date = formatDate(lastPurchasedAt).slice(0, 10);
  return translate('home.progressive.frequent.lastPurchased', { date });
}
