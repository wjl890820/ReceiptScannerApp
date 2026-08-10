/** Pure query normalization for History product/receipt search. */

export function normalizeReceiptItemSearchQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
