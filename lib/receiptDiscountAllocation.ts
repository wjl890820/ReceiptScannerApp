/**
 * Coupon / discount allocation — presentation + analytics amounts only.
 * Source of truth remains analysis_json items + discounts[].
 */

export type DiscountLine = { label: string; amount: number };

export type DiscountableItem = {
  name?: string | null;
  lineTotal?: number | null;
  line_total?: number | null;
  quantity?: number | null;
  effectiveLineTotal?: number | null;
  discountAllocated?: number | null;
  [key: string]: unknown;
};

export type DiscountAllocationResult<T extends DiscountableItem> = {
  items: T[];
  /** Discounts that could not be bound to a single item (receipt-level). */
  unboundDiscounts: DiscountLine[];
  boundCount: number;
};

function grossOf(item: DiscountableItem): number {
  const a = Number(item.lineTotal);
  if (Number.isFinite(a)) return a;
  const b = Number(item.line_total);
  return Number.isFinite(b) ? b : 0;
}

function normalizeToken(value: string): string {
  return value
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const COUPON_NOISE = [
  'cpn',
  'coupon',
  'クーポン',
  '値引',
  '値引き',
  '割引',
  'わりびき',
  'セール',
  'discount',
  'off',
];

function couponSearchTokens(label: string): string[] {
  let s = normalizeToken(label);
  for (const noise of COUPON_NOISE) {
    s = s.replace(new RegExp(noise, 'gi'), ' ');
  }
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * Bind a discount to an item when the coupon label strongly references it.
 * Example: "ROCHER ORIGINS CPN" → item containing "ROCHER".
 * Never guesses when ambiguous — leaves receipt-level.
 */
export function findDiscountItemIndex(
  items: DiscountableItem[],
  discount: DiscountLine
): number {
  const tokens = couponSearchTokens(discount.label);
  if (tokens.length === 0) return -1;

  const matches: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const name = normalizeToken(String(items[i]?.name ?? ''));
    if (!name) continue;
    if (grossOf(items[i]) <= 0) continue;
    const hit = tokens.some((token) => name.includes(token));
    if (hit) matches.push(i);
  }
  return matches.length === 1 ? matches[0] : -1;
}

/**
 * Apply product-level coupons onto items as effectiveLineTotal while keeping
 * gross lineTotal. Unbound coupons remain receipt-level.
 */
export function applyReceiptDiscountsToItems<T extends DiscountableItem>(
  items: T[],
  discounts: DiscountLine[]
): DiscountAllocationResult<T> {
  const next = items.map((item) => {
    const gross = grossOf(item);
    return {
      ...item,
      lineTotal: gross,
      effectiveLineTotal: gross,
      discountAllocated: 0,
    } as T;
  });

  const unboundDiscounts: DiscountLine[] = [];
  let boundCount = 0;

  for (const discount of discounts) {
    const amount = Number(discount.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const delta = amount < 0 ? amount : -Math.abs(amount);
    const idx = findDiscountItemIndex(next, discount);
    if (idx < 0) {
      unboundDiscounts.push({
        label: discount.label,
        amount: delta,
      });
      continue;
    }
    const item = next[idx];
    const gross = grossOf(item);
    const prevAllocated = Number(item.discountAllocated) || 0;
    const allocated = prevAllocated + delta;
    const effective = Math.max(0, gross + allocated);
    next[idx] = {
      ...item,
      lineTotal: gross,
      discountAllocated: allocated,
      effectiveLineTotal: effective,
    };
    boundCount += 1;
  }

  return { items: next, unboundDiscounts, boundCount };
}

/** Analytics / category amounts: prefer effective (paid) over gross. */
export function itemAmountForAnalytics(item: DiscountableItem): number {
  const effective = Number(item.effectiveLineTotal);
  if (Number.isFinite(effective)) return effective;
  const gross = grossOf(item);
  return Number.isFinite(gross) ? gross : 0;
}
