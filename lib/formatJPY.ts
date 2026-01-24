// lib/formatJPY.ts
// Unified JPY currency formatting

/**
 * Format amount as Japanese Yen with ¥ symbol and thousand separators
 * Example: formatJPY(5541) => "¥5,541"
 * 
 * Requirements:
 * - Use ¥ symbol (not JPY, 円, or E)
 * - Use thousand separators
 * - No decimal places for JPY
 * - Handle null/undefined/NaN gracefully (returns "¥0")
 */
export function formatJPY(amount: number | null | undefined): string {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: 0,
  }).format(n);
}
