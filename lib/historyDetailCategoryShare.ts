/**
 * History detail category bars.
 * Denominator is the sum of the category amounts actually rendered,
 * not the receipt payment total.
 */
export function sumCategoryDisplayAmounts(
  rows: readonly { amount: number }[]
): number {
  return rows.reduce((sum, row) => {
    const amount = row.amount;
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
}

export function categoryDisplayPercent(
  amount: number,
  categoryDisplayTotal: number
): number {
  if (!(categoryDisplayTotal > 0) || !Number.isFinite(categoryDisplayTotal)) {
    return 0;
  }
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, (amount / categoryDisplayTotal) * 100);
}
