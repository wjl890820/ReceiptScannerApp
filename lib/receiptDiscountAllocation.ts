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
  unitPrice?: number | null;
  unit_price?: number | null;
  effectiveLineTotal?: number | null;
  discountAllocated?: number | null;
  /**
   * Explicit user amount edit marker. When true, analytics must use the
   * user-authored lineTotal and must not prefer a stale effectiveLineTotal.
   */
  amountUserEdited?: boolean | null;
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

const RECEIPT_LEVEL_DISCOUNT_LABEL =
  /合計|総(?:額|計)?|total|subtotal|値引合計|割引合計|クーポン合計/i;

/**
 * Receipt-level aggregate discount summary labels (値引合計 / 割引合計 / …).
 * Shared by allocation + analysis-foundation amount-basis (A1.2.1).
 */
export function isReceiptLevelDiscountSummaryLabel(label: string): boolean {
  const raw = String(label || '').trim();
  if (!raw) return false;
  if (RECEIPT_LEVEL_DISCOUNT_LABEL.test(raw)) return true;
  const n = normalizeToken(raw);
  return Boolean(n && RECEIPT_LEVEL_DISCOUNT_LABEL.test(n));
}

/**
 * True when discounts[] mixes aggregate summary rows with component discounts
 * and additive independence cannot be proven — callers should treat reconciliation
 * as ambiguous rather than summing everything.
 */
export function discountsHaveAggregateSummaryAmbiguity(
  discounts: DiscountLine[] | null | undefined
): boolean {
  const list = (Array.isArray(discounts) ? discounts : []).filter((d) => {
    const amount = Number(d?.amount);
    return Number.isFinite(amount) && amount !== 0;
  });
  if (list.length < 2) return false;
  let hasSummary = false;
  let hasComponent = false;
  for (const d of list) {
    if (isReceiptLevelDiscountSummaryLabel(d.label)) hasSummary = true;
    else hasComponent = true;
    if (hasSummary && hasComponent) return true;
  }
  return false;
}

/**
 * Conservative adjacent product discount labels (値引 / N%割引 / 割引 N% / 値下げ).
 * Excludes bundle/まとめ売り and receipt-level summaries.
 */
export function isOrdinaryAdjacentProductDiscountLabel(label: string): boolean {
  if (isBundleSummaryDiscountLabel(label)) return false;
  const raw = String(label || '').trim();
  if (!raw) return false;
  const n = normalizeToken(raw);
  if (!n || isReceiptLevelDiscountSummaryLabel(label)) return false;
  if (n.includes('クーポン') || n.includes('coupon') || n.includes('cpn')) return false;
  // After normalizeToken, % is whitespace, so "10%割引" → "10 割引" and "割引 10%" → "割引 10".
  if (/^\d{1,2}\s*割引$/.test(n) || /^割引\s*\d{1,2}$/.test(n)) return true;
  if (/^\d{1,2}\s*引$/.test(n) || /^引\s*\d{1,2}$/.test(n)) return true;
  if (n === '値引' || n === '値引き' || n === '割引' || n === 'わりびき') return true;
  if (n === '値下' || n === '値下げ') return true;
  return false;
}

/** Parse N from both "10%割引" and "割引 10%" (full-width digits/% accepted). */
export function parseDiscountPercentFromLabel(label: string): number | null {
  const raw = String(label || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/％/g, '%');
  const m = raw.match(/(\d{1,2})\s*%\s*(?:割引|引)/) || raw.match(/(?:割引|引)\s*(\d{1,2})\s*%/);
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  return pct;
}

/**
 * Bind ordinary adjacent product discounts (値引 / N%割引) to the immediately
 * preceding merchandise line when OCR order + amount evidence is strong.
 */
export function findAdjacentProductDiscountItemIndex(
  items: DiscountableItem[],
  discount: DiscountLine
): number {
  if (!isOrdinaryAdjacentProductDiscountLabel(discount.label)) return -1;
  const amount = Number(discount.amount);
  if (!Number.isFinite(amount) || amount === 0) return -1;
  const delta = amount < 0 ? amount : -Math.abs(amount);
  const absDisc = Math.abs(delta);

  const adj = discount.adjacentPrecedingItemIndex;
  if (typeof adj !== 'number' || adj < 0 || adj >= items.length) return -1;
  const gross = grossOf(items[adj]);
  if (gross <= 0 || absDisc > gross) return -1;

  const pct = parseDiscountPercentFromLabel(discount.label);
  if (pct != null) {
    const expected = Math.round((gross * pct) / 100);
    if (Math.abs(expected - absDisc) > 1) return -1;
  }

  return adj;
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
      idx = findAdjacentProductDiscountItemIndex(next, discount);
    }
    if (idx < 0) {
      unboundDiscounts.push({
        label: discount.label,
        amount: delta,
      });
      continue;
    }
    const item = next[idx];
    // Same discount represented twice (discounts[] + item line) must not stack
    // onto one line (Build 27 Sample 058: 210→196).
    if (
      isBundleSummaryDiscountLabel(discount.label) ||
      isOrdinaryAdjacentProductDiscountLabel(discount.label)
    ) {
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

/**
 * Apply an explicit user line-amount edit while keeping the user-layer
 * monetary representation coherent for analytics.
 *
 * - Writes lineTotal / line_total / effectiveLineTotal to the same amount
 * - Recomputes unitPrice from quantity when possible
 * - Clears discountAllocated (user set the final paid amount)
 * - Marks amountUserEdited so resolvers prefer the override
 *
 * Does NOT touch analysis_json / recognition snapshots (provenance).
 */
export function applyUserLineAmountEdit<T extends DiscountableItem>(
  item: T,
  amount: number
): T {
  const paid = Number(amount);
  if (!Number.isFinite(paid) || paid < 0) {
    return item;
  }
  const rounded = Math.round(paid);
  const qtyRaw = Number(item.quantity);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
  const unit = Math.round(rounded / qty);
  return {
    ...item,
    lineTotal: rounded,
    line_total: rounded,
    effectiveLineTotal: rounded,
    unitPrice: unit,
    unit_price: unit,
    discountAllocated: 0,
    amountUserEdited: true,
  };
}

function hasActiveDiscountAllocation(item: DiscountableItem): boolean {
  const allocated = Number(item.discountAllocated);
  return Number.isFinite(allocated) && allocated !== 0;
}

/**
 * Detect legacy edit rows where only camelCase lineTotal was updated
 * (69→70) while effectiveLineTotal + snake line_total stayed at OCR/net.
 * Do NOT treat legitimate discounted rows (gross lineTotal ≠ effective with
 * discountAllocated) as overrides.
 */
export function isStaleEffectiveAfterUserLineEdit(item: DiscountableItem): boolean {
  if (hasActiveDiscountAllocation(item)) return false;
  const camel = Number(item.lineTotal);
  const effective = Number(item.effectiveLineTotal);
  if (!Number.isFinite(camel) || !Number.isFinite(effective)) return false;
  if (camel === effective) return false;
  const snake = Number(item.line_total);
  // Classic stale-alias pattern from history edit: snake + effective remain OCR.
  if (Number.isFinite(snake) && snake === effective && camel !== snake) {
    return true;
  }
  return false;
}

/**
 * Analytics / category amounts.
 *
 * Precedence:
 * 1) Explicit user amount override (amountUserEdited or stale-alias heal)
 * 2) effectiveLineTotal (discount-aware paid amount)
 * 3) gross lineTotal / line_total
 */
export function itemAmountForAnalytics(item: DiscountableItem): number {
  const gross = grossOf(item);
  if (item.amountUserEdited === true) {
    return Number.isFinite(gross) ? gross : 0;
  }
  if (isStaleEffectiveAfterUserLineEdit(item)) {
    return Number.isFinite(gross) ? gross : 0;
  }
  const effective = Number(item.effectiveLineTotal);
  if (Number.isFinite(effective)) return effective;
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
