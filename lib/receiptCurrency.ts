/**
 * Canonical receipt currency for trusted consumer monetary surfaces.
 *
 * Analysis remains JPY-only (see analysisCurrency.ts).
 * Product Detail / History / consumer spend share this allowlist.
 */

/** Currencies the app will format and trust for attributable product spend. */
export const RECEIPT_TRUSTED_CURRENCY_CODES = ['JPY', 'USD'] as const;

export type ReceiptTrustedCurrencyCode =
  (typeof RECEIPT_TRUSTED_CURRENCY_CODES)[number];

const TRUSTED = new Set<string>(RECEIPT_TRUSTED_CURRENCY_CODES);

/**
 * Normalize a persisted receipt currency to a trusted canonical code.
 * Returns null for blank / UNKNOWN / malformed / unsupported values.
 */
export function normalizeReceiptCurrency(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '¥' || trimmed === '￥') return 'JPY';
  const upper = trimmed.toUpperCase();
  if (upper === 'UNKNOWN') return null;
  if (!TRUSTED.has(upper)) return null;
  return upper;
}

export function isTrustedReceiptCurrency(
  value: unknown
): value is ReceiptTrustedCurrencyCode {
  return normalizeReceiptCurrency(value) != null;
}
