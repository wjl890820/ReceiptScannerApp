/**
 * Canonical comparable projection from a stored analysis/snapshot object.
 * Does NOT re-run normalizeOcrAnalysis as "current OCR".
 */

import { reconcileReceiptTotals } from '../receiptOcrNormalize';
import { normalizeMerchant } from '../receiptOcrNormalize';
import type {
  CanonicalItemProjection,
  CanonicalReceiptProjection,
} from './types';

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readTransactionAt(payload: Record<string, unknown>): string | null {
  return (
    str(payload.transactionDate) ??
    str(payload.transaction_date) ??
    str(payload.transactionAt) ??
    str(payload.purchasedAt) ??
    null
  );
}

function readItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  const items = payload.items;
  if (!Array.isArray(items)) return [];
  return items.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
}

function readDiscountsSum(payload: Record<string, unknown>): number {
  const discounts = payload.discounts;
  let sum = 0;
  if (Array.isArray(discounts)) {
    for (const d of discounts) {
      if (!d || typeof d !== 'object') continue;
      const a = num((d as { amount?: unknown }).amount);
      if (a == null || a === 0) continue;
      sum += a < 0 ? a : -Math.abs(a);
    }
  }
  // Also count negative merchandise lines as discount-like for sum consistency
  // only when discounts array empty — match normalize's discountsSum when present.
  return Math.round(sum);
}

function projectItem(
  item: Record<string, unknown>,
  sourceIndex: number
): CanonicalItemProjection {
  const name = str(item.name);
  const qty = num(item.quantity);
  const lineTotal = num(item.lineTotal) ?? num(item.line_total);
  const unitPrice = num(item.unitPrice) ?? num(item.unit_price);
  const category = str(item.category);
  let categoryMain: string | null = null;
  let categorySub: string | null = null;
  if (category && category.includes('.')) {
    const [m, ...rest] = category.split('.');
    categoryMain = m || null;
    categorySub = rest.join('.') || null;
  } else {
    categoryMain = category;
  }
  return {
    sourceIndex,
    name,
    normalizedName: str(item.normalized_name) ?? str(item.normalizedName),
    quantity: qty,
    unitPrice,
    lineTotal,
    effectiveLineTotal: num(item.effectiveLineTotal) ?? num(item.effective_line_total),
    discountAllocated: num(item.discountAllocated) ?? num(item.discount_allocated),
    category,
    categoryMain,
    categorySub,
    productFamilyKey:
      str(item.product_family_key) ?? str(item.productFamilyKey),
  };
}

/**
 * Extract observed baseline projection directly from stored payload.
 */
export function projectCanonicalFromPayload(
  payload: Record<string, unknown>,
  rowHints?: {
    merchantRaw?: string | null;
    merchantNormalized?: string | null;
    total?: number | null;
    tax?: number | null;
    currency?: string | null;
    transactionAtMs?: number | null;
  }
): CanonicalReceiptProjection {
  const items = readItems(payload).map((it, i) => projectItem(it, i));
  const merchantRaw =
    str(payload.merchant) ?? rowHints?.merchantRaw ?? null;
  const merchantNormalized =
    rowHints?.merchantNormalized ??
    (merchantRaw ? normalizeMerchant(merchantRaw) : null);

  let transactionAt = readTransactionAt(payload);
  if (!transactionAt && rowHints?.transactionAtMs != null) {
    transactionAt = new Date(rowHints.transactionAtMs).toISOString();
  }

  const total =
    num(payload.total) ?? rowHints?.total ?? null;
  const tax = num(payload.tax) ?? rowHints?.tax ?? null;
  const currency =
    str(payload.currency) ?? rowHints?.currency ?? null;

  let itemsPositiveSum = 0;
  let quantityTotal = 0;
  for (const it of items) {
    if (it.lineTotal != null && it.lineTotal > 0) {
      itemsPositiveSum += it.lineTotal;
    }
    if (it.quantity != null && Number.isFinite(it.quantity) && it.quantity > 0) {
      quantityTotal += it.quantity;
    } else if (it.lineTotal != null && it.lineTotal > 0) {
      quantityTotal += 1;
    }
  }
  itemsPositiveSum = Math.round(itemsPositiveSum);
  quantityTotal = Math.round(quantityTotal);

  const discountsSum = readDiscountsSum(payload);
  // Include negative item lines in discount sum when discounts[] empty
  // (historical Costco coupon-as-item pattern).
  let negItemSum = 0;
  for (const it of items) {
    if (it.lineTotal != null && it.lineTotal < 0) negItemSum += it.lineTotal;
  }
  const effectiveDiscountsSum =
    discountsSum !== 0 ? discountsSum : Math.round(negItemSum);

  const taxN = tax != null ? tax : 0;
  const totN = total != null ? total : 0;
  const reconciliation = reconcileReceiptTotals(
    itemsPositiveSum,
    effectiveDiscountsSum,
    taxN,
    totN
  );

  const amountMismatch =
    typeof payload.amount_mismatch === 'boolean'
      ? payload.amount_mismatch
      : typeof (payload as { amountMismatch?: unknown }).amountMismatch ===
          'boolean'
        ? Boolean((payload as { amountMismatch: boolean }).amountMismatch)
        : reconciliation.ok
          ? false
          : true;

  return {
    merchantRaw,
    merchantNormalized,
    transactionAt,
    total,
    tax,
    currency,
    itemRowCount: items.length,
    quantityTotal,
    items,
    discountsTotal: effectiveDiscountsSum,
    reconciliation: {
      ok: reconciliation.ok,
      diff: reconciliation.diff,
      itemsPositiveSum: reconciliation.itemsPositiveSum,
      discountsSum: reconciliation.discountsSum,
    },
    amountMismatch,
  };
}
