/**
 * Coupon / discount allocation — presentation + analytics amounts only.
 * Source of truth remains analysis_json items + discounts[].
 */

export type DiscountLine = {
  label: string;
  amount: number;
  /**
   * Index of the immediately preceding positive item in the kept items list
   * (OCR order). Used only for safe bundle/まとめ売り allocation.
   */
  adjacentPrecedingItemIndex?: number | null;
};

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
 * Bundle / まとめ売り値引 labels that may safely attach to the preceding item
 * when token binding fails. Do NOT broaden to arbitrary receipt-level coupons.
 */
export function isBundleSummaryDiscountLabel(label: string): boolean {
  const raw = String(label || '');
  const n = normalizeToken(raw);
  return (
    /まとめ\s*売り?\s*値?引/.test(raw) ||
    n.includes('まとめ売り') ||
    n.includes('まとめ値引')
  );
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
 * When Edge places まとめ売り only in discounts[] (no negative item row),
 * bind using group-price evidence (e.g. label/nearby "2個¥203") or a single
 * safe preceding index — never arbitrary receipt-level coupons.
 */
export function findBundleDiscountItemIndex(
  items: DiscountableItem[],
  discount: DiscountLine,
  evidenceTexts: string[] = []
): number {
  if (!isBundleSummaryDiscountLabel(discount.label)) return -1;
  const amount = Number(discount.amount);
  if (!Number.isFinite(amount) || amount === 0) return -1;
  const delta = amount < 0 ? amount : -Math.abs(amount);
  const absDisc = Math.abs(delta);

  const evidence = [discount.label, ...evidenceTexts].join('\n');
  const priceHits = Array.from(evidence.matchAll(/[¥￥]?\s*(\d{2,6})/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);

  const byGroupPrice: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const gross = grossOf(items[i]);
    if (gross <= 0) continue;
    const effective = gross + delta;
    if (effective < 0) continue;
    if (priceHits.includes(effective) || priceHits.includes(gross)) {
      byGroupPrice.push(i);
    }
  }
  if (byGroupPrice.length === 1) return byGroupPrice[0];

  const adj = discount.adjacentPrecedingItemIndex;
  if (typeof adj === 'number' && adj >= 0 && adj < items.length && grossOf(items[adj]) > 0) {
    return adj;
  }

  // Edge-only single bundle discount: unique item whose gross equals absDisc + a listed price.
  if (byGroupPrice.length === 0 && priceHits.length > 0) {
    const matches: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const gross = grossOf(items[i]);
      if (priceHits.some((p) => p + absDisc === gross || p === gross + delta)) {
        matches.push(i);
      }
    }
    if (matches.length === 1) return matches[0];
  }

  return -1;
}

/**
 * Apply product-level coupons onto items as effectiveLineTotal while keeping
 * gross lineTotal. Unbound coupons remain receipt-level.
 *
 * Bundle/まとめ売り値引 may bind via adjacency, group-price evidence, or
 * adjacentPrecedingItemIndex when token binding fails.
 */
export function applyReceiptDiscountsToItems<T extends DiscountableItem>(
  items: T[],
  discounts: DiscountLine[],
  options?: { evidenceTexts?: string[] }
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
  const evidenceTexts = options?.evidenceTexts ?? [];

  for (const discount of discounts) {
    const amount = Number(discount.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const delta = amount < 0 ? amount : -Math.abs(amount);
    const absDisc = Math.abs(delta);
    let idx = findDiscountItemIndex(next, discount);
    if (idx < 0 && isBundleSummaryDiscountLabel(discount.label)) {
      idx = findBundleDiscountItemIndex(next, discount, evidenceTexts);
    }
    if (idx < 0) {
      unboundDiscounts.push({
        label: discount.label,
        amount: delta,
      });
      continue;
    }
    const item = next[idx];
    // Same bundle discount represented twice (discounts[] + item line with richer label)
    // must not stack onto one line (Build 27 Sample 058: 210→196).
    if (isBundleSummaryDiscountLabel(discount.label)) {
      const prevAbs = Math.abs(Number(item.discountAllocated) || 0);
      if (prevAbs > 0 && prevAbs === absDisc) {
        continue;
      }
    }
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

/**
 * Sum of discount amounts that are NOT confidently bound to a product line.
 * Both discounts[] and item.discountAllocated are negative (or 0).
 * Unallocated = total discounts − already allocated onto items.
 */
export function receiptLevelUnallocatedDiscountSum(
  items: DiscountableItem[],
  discounts: DiscountLine[] | null | undefined
): number {
  const discList = Array.isArray(discounts) ? discounts : [];
  const discountsSum = discList.reduce((s, d) => {
    const amount = Number(d?.amount);
    if (!Number.isFinite(amount) || amount === 0) return s;
    return s + (amount < 0 ? amount : -Math.abs(amount));
  }, 0);
  const boundSum = (Array.isArray(items) ? items : []).reduce((s, it) => {
    const a = Number(it?.discountAllocated);
    if (!Number.isFinite(a) || a === 0) return s;
    return s + (a < 0 ? a : -Math.abs(a));
  }, 0);
  // Remaining receipt-level (unallocated) portion; clamp so we never invent extra discount.
  const unallocated = discountsSum - boundSum;
  return unallocated > 0 ? 0 : unallocated;
}
