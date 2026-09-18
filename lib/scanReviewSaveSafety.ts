/**
 * Scan Review save eligibility for Receipt080 unexplained positive overage.
 * Pure / deterministic — used by Review UI and tests (not a second reconciler).
 */

import { reconcileReceiptTotals } from './receiptOcrNormalize';

export const UNEXPLAINED_POSITIVE_OVERAGE_REASON =
  'unexplained_positive_merchandise_overage' as const;

export type ScanReviewSaveBlockReason =
  | typeof UNEXPLAINED_POSITIVE_OVERAGE_REASON
  | null;

/**
 * True when merchandise net (items + known discounts) exceeds receipt total.
 * Mirrors reconcileReceiptTotals unexplained-positive-overage contract.
 */
export function isUnexplainedPositiveMerchandiseOverage(input: {
  itemsPositiveSum: number;
  discountsSum: number;
  total: number;
}): boolean {
  const items = Math.round(input.itemsPositiveSum);
  const disc = Math.round(input.discountsSum);
  const tot = Math.round(Number.isFinite(input.total) ? input.total : 0);
  if (!tot) return false;
  return items + disc > tot;
}

export type ScanReviewSaveEligibility = {
  allowed: boolean;
  reason: ScanReviewSaveBlockReason;
  reconciliationOk: boolean;
};

/**
 * Gate for persisting a Scan Review draft as a receipt.
 * Only blocks the narrow unexplained positive overage case.
 */
export function evaluateScanReviewSaveEligibility(input: {
  itemsPositiveSum: number;
  discountsSum: number;
  tax: number;
  total: number;
}): ScanReviewSaveEligibility {
  const reconciliation = reconcileReceiptTotals(
    input.itemsPositiveSum,
    input.discountsSum,
    input.tax,
    input.total
  );
  if (
    isUnexplainedPositiveMerchandiseOverage(input) ||
    reconciliation.warnings.some((w) =>
      w.includes(UNEXPLAINED_POSITIVE_OVERAGE_REASON)
    )
  ) {
    return {
      allowed: false,
      reason: UNEXPLAINED_POSITIVE_OVERAGE_REASON,
      reconciliationOk: false,
    };
  }
  return {
    allowed: true,
    reason: null,
    reconciliationOk: reconciliation.ok,
  };
}

/** Sum positive merchandise line amounts from Review/OCR item rows. */
export function sumPositiveMerchandiseLineTotals(
  items: readonly { lineTotal?: unknown; line_total?: unknown }[]
): number {
  let sum = 0;
  for (const row of items) {
    const raw = row.lineTotal ?? row.line_total;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  return Math.round(sum);
}

/** Sum discount amounts as a non-positive total (matches normalizeOcrAnalysis). */
export function sumReceiptDiscountAmounts(
  discounts: readonly { amount?: unknown }[]
): number {
  let sum = 0;
  for (const d of discounts) {
    const n = typeof d.amount === 'number' ? d.amount : Number(d.amount);
    if (!Number.isFinite(n) || n === 0) continue;
    sum += n < 0 ? n : -Math.abs(n);
  }
  return Math.round(sum);
}
