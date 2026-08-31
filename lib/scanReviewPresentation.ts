/**
 * Presentation helpers for the receipt Review screen.
 * Pure UI visibility logic — no draft/save side effects.
 */

import { formatJPY } from '@/lib/formatJPY';

/**
 * Collapsed review-row amount display. Non-finite values must not coerce to zero.
 */
export function formatCollapsedLineTotal(lineTotal: number, currency?: string): string {
  if (!Number.isFinite(lineTotal)) {
    return '—';
  }
  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (!normalizedCurrency || normalizedCurrency === 'JPY') {
    return formatJPY(lineTotal);
  }
  return `${normalizedCurrency} ${lineTotal.toLocaleString()}`;
}

/**
 * Explicit receipt.total is authoritative for Review/History display.
 * tax is informational and must never be auto-added on top.
 */
export function authoritativeReceiptTotal(input: {
  total: number;
  tax?: number | null;
}): number {
  const total = Number(input.total);
  return Number.isFinite(total) ? total : 0;
}

export function normalizeRecognizedName(
  value: unknown
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Show the OCR original only when the edited name differs from recognition. */
export function shouldShowRecognizedNameHint(
  editedName: string,
  recognizedName: unknown
): boolean {
  const original = normalizeRecognizedName(recognizedName);
  if (!original) return false;
  return editedName.trim() !== original;
}

/**
 * OCR raw text / trace metadata stay behind the developer gate.
 * Feedback tags remain available to all users in a collapsed section.
 */
export function shouldShowReviewDevDetails(
  devToolsUnlocked: boolean,
  isDevBuild: boolean
): boolean {
  return Boolean(devToolsUnlocked || isDevBuild);
}

/**
 * Legacy growth / Price Radar / old milestone Alert after save.
 * Release uses Post-Save Summary only; keep Alert for __DEV__ debugging.
 */
export function shouldShowLegacyPostSaveEasterEggAlert(
  isDevBuild: boolean
): boolean {
  return Boolean(isDevBuild);
}
