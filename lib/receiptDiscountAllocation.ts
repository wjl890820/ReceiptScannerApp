/**
 * Coupon / discount allocation — presentation + analytics amounts only.
 * Source of truth remains analysis_json items + discounts[].
 */

export function isAbsorbedReviewedDiscount(discount: {
  ownershipStatus?: unknown;
  reviewedMonetaryRole?: unknown;
}): boolean {
  return (
    discount.ownershipStatus === 'absorbed' ||
    discount.reviewedMonetaryRole === 'absorbed'
  );
}

function reviewedRoleOf(
  discount: DiscountLine
): 'applied' | 'unapplied' | 'absorbed' | null {
  const role = discount.reviewedMonetaryRole;
  if (role === 'applied' || role === 'unapplied' || role === 'absorbed') return role;
  return null;
}

/**
 * Index of the reviewed item that still hosts this discount.
 * `sourceBoundItemIndex` is the original row. When items carry
 * `review_source_index`, a missing match means the host was removed.
 * Without source indexes, the original index is the current array index.
 */
export function findReviewedDiscountHostIndex(
  items: readonly DiscountableItem[],
  originalIndex: number | null
): number | null {
  if (originalIndex == null || !Number.isInteger(originalIndex)) return null;
  const hasSource = items.some(
    (item) =>
      typeof item.review_source_index === 'number' &&
      Number.isInteger(item.review_source_index)
  );
  if (hasSource) {
    const found = items.findIndex(
      (item) => item.review_source_index === originalIndex
    );
    return found >= 0 ? found : null;
  }
  if (originalIndex >= 0 && originalIndex < items.length) return originalIndex;
  return null;
}

function activeAllocatedAmount(item: DiscountableItem | null | undefined): number {
  if (!item || item.amountUserEdited === true) return 0;
  const allocated = Number(item.discountAllocated);
  if (!Number.isFinite(allocated) || allocated === 0) return 0;
  return allocated < 0 ? allocated : -Math.abs(allocated);
}

export function reviewedDiscountAmount(amount: unknown): number | null {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? n : -Math.abs(n);
}

/**
 * Amount passed into reviewed-role assessment.
 * Rows with a reviewed role keep the persisted sign.
 * Rows without a role keep the historical negative normalization.
 */
export function persistedDiscountAmount(
  amount: unknown,
  reviewedMonetaryRole: unknown
): number | null {
  const reviewed =
    reviewedMonetaryRole === 'applied' ||
    reviewedMonetaryRole === 'unapplied' ||
    reviewedMonetaryRole === 'absorbed';
  if (reviewed) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return null;
    return amount;
  }
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? n : -Math.abs(n);
}

/** Authoritative reviewed rows must already be finite and strictly negative. */
function strictReviewedDiscountAmount(amount: unknown): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount >= 0) return null;
  return amount;
}

/** Persisted allocation, including a stale value on a final-paid line. */
function persistedDiscountAllocation(item: DiscountableItem | null | undefined): number {
  if (!item) return 0;
  const allocated = Number(item.discountAllocated);
  if (!Number.isFinite(allocated) || allocated === 0) return 0;
  return allocated < 0 ? allocated : -Math.abs(allocated);
}

function reviewedIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function itemGrossAmount(item: DiscountableItem): number | null {
  const camel = Number(item.lineTotal);
  const snake = Number(item.line_total);
  const camelOk = Number.isFinite(camel);
  const snakeOk = Number.isFinite(snake);
  if (camelOk && snakeOk && camel !== snake) return null;
  if (camelOk) return camel;
  if (snakeOk) return snake;
  return null;
}

function itemEffectiveAmount(item: DiscountableItem): number | null {
  const effective = Number(item.effectiveLineTotal);
  return Number.isFinite(effective) ? effective : null;
}

function itemAllocatedAmount(item: DiscountableItem): number | null {
  const allocated = Number(item.discountAllocated);
  if (!Number.isFinite(allocated)) return null;
  if (allocated === 0) return 0;
  return allocated < 0 ? allocated : -Math.abs(allocated);
}

/** Gross + negative allocation equals effective. Final-paid lines are not this proof. */
export function hostAllocationEquationHolds(item: DiscountableItem): boolean {
  if (item.amountUserEdited === true) return false;
  const gross = itemGrossAmount(item);
  const allocated = itemAllocatedAmount(item);
  const effective = itemEffectiveAmount(item);
  if (gross == null || allocated == null || effective == null) return false;
  if (allocated >= 0) return false;
  return effective === gross + allocated;
}

/**
 * Host a reviewed discount still points at.
 * `boundItemIndex` must be that current index when both indexes are present.
 * A contradiction yields null so the amount is not treated as inside an item.
 */
export function reviewedDiscountHostIndex(
  items: readonly DiscountableItem[],
  discount: DiscountLine
): number | null {
  const source = reviewedIndex(discount.sourceBoundItemIndex);
  const bound = reviewedIndex(discount.boundItemIndex);
  const original = source ?? bound;
  if (original == null) return null;
  const host = findReviewedDiscountHostIndex(items, original);
  if (host == null) return null;
  if (source != null && bound != null && bound !== host) return null;
  return host;
}

function discountsTargetingHost(
  items: readonly DiscountableItem[],
  discounts: readonly { discount: DiscountLine; amount: number }[],
  hostIndex: number
): { discount: DiscountLine; amount: number }[] {
  return discounts.filter(
    (row) => reviewedDiscountHostIndex(items, row.discount) === hostIndex
  );
}

/**
 * Receipt-level portion that keeps every finite discount exactly once.
 * Money already proven inside an item effective amount is not added again.
 * Money that is not proven inside an item is added once and not rebound.
 */
export function conservativeReviewedReceiptLevel(
  items: readonly DiscountableItem[],
  discounts: readonly DiscountLine[]
): number {
  const rows: { discount: DiscountLine; amount: number }[] = [];
  let receiptLevel = 0;
  for (const discount of discounts) {
    const amount = reviewedDiscountAmount(discount?.amount);
    if (amount == null || !discount) continue;
    // Explicit unapplied is receipt-level ownership. A provenance source
    // index, including one that still points at a final-paid host, is not
    // monetary absorption.
    if (reviewedRoleOf(discount) === 'unapplied') {
      receiptLevel += amount;
      continue;
    }
    rows.push({ discount, amount });
  }
  const consumed = new Set<DiscountLine>();
  for (let index = 0; index < items.length; index += 1) {
    const targeted = discountsTargetingHost(items, rows, index);
    if (targeted.length === 0) continue;
    for (const row of targeted) consumed.add(row.discount);
    const host = items[index];
    const sum = targeted.reduce((total, row) => total + row.amount, 0);
    if (host?.amountUserEdited === true && activeAllocatedAmount(host) === 0) {
      continue;
    }
    if (hostAllocationEquationHolds(host)) {
      const allocated = itemAllocatedAmount(host) ?? 0;
      const residual = sum - allocated;
      if (residual < 0) receiptLevel += residual;
      continue;
    }
    const gross = itemGrossAmount(host);
    const effective = itemEffectiveAmount(host);
    if (gross != null && effective != null && effective === gross + sum) {
      continue;
    }
    receiptLevel += sum;
  }
  for (const row of rows) {
    if (!consumed.has(row.discount)) receiptLevel += row.amount;
  }
  return Math.round(receiptLevel);
}

export type ReviewedRoleSetKind = 'legacy' | 'valid_reviewed' | 'invalid_reviewed';

export type ReviewedRoleSetAssessment = {
  kind: ReviewedRoleSetKind;
  /** Null only for legacy. Valid and invalid both carry a once-counted remainder. */
  receiptLevelDiscount: number | null;
  evidence: string;
};

function appliedGroupIsProven(
  items: readonly DiscountableItem[],
  hostIndex: number,
  rows: readonly { discount: DiscountLine; amount: number }[]
): boolean {
  const host = items[hostIndex];
  if (!host || host.amountUserEdited === true) return false;
  if (!hostAllocationEquationHolds(host)) return false;
  const allocated = itemAllocatedAmount(host);
  if (allocated == null || allocated >= 0) return false;
  const sum = rows.reduce((total, row) => total + row.amount, 0);
  if (sum !== allocated) return false;
  return rows.every((row) => {
    if (row.discount.ownershipStatus != null && row.discount.ownershipStatus !== 'bound') {
      return false;
    }
    return reviewedIndex(row.discount.boundItemIndex) === hostIndex;
  });
}

/**
 * LEGACY: no reviewed roles. VALID_REVIEWED: every role is internally consistent.
 * INVALID_REVIEWED: any reviewed role is missing, partial, or contradicted by money.
 */
export function assessReviewedDiscountRoleSet(
  items: readonly DiscountableItem[],
  discounts: readonly DiscountLine[]
): ReviewedRoleSetAssessment {
  const list = Array.isArray(discounts) ? discounts.filter((row) => row && typeof row === 'object') : [];
  if (list.length === 0) {
    return {
      kind: 'legacy',
      receiptLevelDiscount: null,
      evidence: 'reviewed_role_set=legacy',
    };
  }
  const roles = list.map((discount) => reviewedRoleOf(discount));
  const present = roles.filter((role) => role != null).length;
  const receiptLevel = conservativeReviewedReceiptLevel(items, list);
  if (present === 0) {
    return {
      kind: 'legacy',
      receiptLevelDiscount: null,
      evidence: 'reviewed_role_set=legacy',
    };
  }
  if (present !== list.length) {
    return {
      kind: 'invalid_reviewed',
      receiptLevelDiscount: receiptLevel,
      evidence: 'reviewed_role_set=partial',
    };
  }

  const appliedByHost = new Map<number, { discount: DiscountLine; amount: number }[]>();
  let structurallyValid = true;
  for (const discount of list) {
    const role = reviewedRoleOf(discount);
    const amount = strictReviewedDiscountAmount(discount.amount);
    if (!role || amount == null) {
      structurallyValid = false;
      break;
    }
    const hostIndex = reviewedDiscountHostIndex(items, discount);
    if (role === 'applied') {
      if (hostIndex == null) {
        structurallyValid = false;
        break;
      }
      const group = appliedByHost.get(hostIndex) ?? [];
      group.push({ discount, amount });
      appliedByHost.set(hostIndex, group);
      continue;
    }
    if (role === 'absorbed') {
      const host = hostIndex == null ? null : items[hostIndex];
      if (
        !host ||
        host.amountUserEdited !== true ||
        persistedDiscountAllocation(host) !== 0
      ) {
        structurallyValid = false;
        break;
      }
    }
  }

  if (structurallyValid) {
    for (const discount of list) {
      if (reviewedRoleOf(discount) !== 'unapplied') continue;
      const amount = strictReviewedDiscountAmount(discount.amount);
      const hostIndex = reviewedDiscountHostIndex(items, discount);
      if (amount == null || hostIndex == null) continue;
      const host = items[hostIndex];
      const applied = appliedByHost.get(hostIndex) ?? [];
      const appliedExplainsHost =
        applied.length > 0 && appliedGroupIsProven(items, hostIndex, applied);
      if (appliedExplainsHost) continue;
      if (hostAllocationEquationHolds(host)) {
        structurallyValid = false;
        break;
      }
      const gross = itemGrossAmount(host);
      const effective = itemEffectiveAmount(host);
      if (gross != null && effective != null && effective === gross + amount) {
        structurallyValid = false;
        break;
      }
    }
  }

  if (structurallyValid) {
    for (const [hostIndex, group] of appliedByHost) {
      if (!appliedGroupIsProven(items, hostIndex, group)) {
        structurallyValid = false;
        break;
      }
    }
  }

  if (!structurallyValid) {
    return {
      kind: 'invalid_reviewed',
      receiptLevelDiscount: receiptLevel,
      evidence: 'reviewed_role_set=contradictory',
    };
  }
  return {
    kind: 'valid_reviewed',
    receiptLevelDiscount: receiptLevel,
    evidence: 'reviewed_role_set=valid',
  };
}

/**
 * Receipt-level amount for one persisted reviewed discount.
 * Prefer assessReviewedDiscountRoleSet for a whole discount list.
 * Null means this row has no reviewed role.
 * Applied contributes 0 only when this discount alone reconciles the host.
 */
export function reviewedDiscountReceiptLevelAmount(
  items: readonly DiscountableItem[],
  discount: DiscountLine
): number | null {
  const role = reviewedRoleOf(discount);
  if (!role) return null;
  const normalized = reviewedDiscountAmount(discount.amount);
  if (normalized == null) return 0;
  const hostIndex = reviewedDiscountHostIndex(items, discount);
  const host = hostIndex == null ? null : items[hostIndex];

  if (role === 'unapplied') return normalized;

  if (role === 'applied') {
    if (!host || !hostAllocationEquationHolds(host)) return normalized;
    return itemAllocatedAmount(host) === normalized ? 0 : normalized;
  }

  if (!host || host.amountUserEdited !== true || activeAllocatedAmount(host) !== 0) {
    return normalized;
  }
  return 0;
}

/**
 * Receipt-level sum for a complete valid reviewed set.
 * Null means the set is legacy or invalid — callers must not treat null as zero.
 */
export function authoritativeReviewedReceiptLevelDiscount(
  items: readonly DiscountableItem[],
  discounts: readonly DiscountLine[]
): number | null {
  const assessed = assessReviewedDiscountRoleSet(items, discounts);
  if (assessed.kind !== 'valid_reviewed') return null;
  return assessed.receiptLevelDiscount;
}

export type DiscountLine = {
  label: string;
  amount: number;
  /**
   * Index of the immediately preceding positive item in the kept items list
   * (OCR order). Used only for safe bundle/まとめ売り allocation.
   */
  adjacentPrecedingItemIndex?: number | null;
  /**
   * Optional per-discount ownership attribution (analysis_json only; no SQL).
   * When present, product-affecting coupons must be proven individually —
   * never via aggregate allocated magnitude.
   */
  ownershipStatus?: 'bound' | 'unbound' | 'absorbed' | null;
  boundItemIndex?: number | null;
  ownershipReason?: string | null;
  /**
   * Reviewed monetary role. `absorbed` means a final-paid line edit already
   * includes this discount, so receipt-level summation must skip it.
   * Recognition snapshots do not use this field.
   */
  reviewedMonetaryRole?: 'applied' | 'unapplied' | 'absorbed' | null;
  /** Original item index this discount was bound to, before review compaction. */
  sourceBoundItemIndex?: number | null;
  sourceAdjacentPrecedingItemIndex?: number | null;
};

export type DiscountBinding = {
  label: string;
  amount: number;
  status: 'bound' | 'unbound';
  itemIndex: number | null;
  reason: string;
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
  /** Per-discount ownership outcomes (same order as processed discounts). */
  bindings: DiscountBinding[];
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

/** Complete tokens that are coupon syntax only (never Latin substring-deleted). */
const COUPON_SYNTAX_TOKEN_SET = new Set(
  COUPON_NOISE.map((t) => normalizeToken(t)).filter(Boolean)
);

/**
 * CJK coupon markers may appear inside unspaced compounds (店舗クーポン共通).
 * Substring removal is safe here; Latin markers like "off" must stay token-only
 * so "coffee" is never corrupted.
 */
const CJK_COUPON_SUBSTRING_MARKERS = ['クーポン'] as const;

function splitCjkCouponSubstrings(normalized: string): string {
  let s = normalized;
  for (const marker of CJK_COUPON_SUBSTRING_MARKERS) {
    s = s.split(marker).join(' ');
  }
  return s;
}
/** Tokens that alone never justify named-product coupon ownership. */
const GENERIC_COUPON_OWNER_TOKENS = new Set([
  'メーカー',
  'maker',
  'manufacturer',
  'store',
  '店舗',
  'shop',
]);

/** Store-wide / non-product coupon descriptors (genuine receipt-level OK). */
const STORE_WIDE_COUPON_TOKENS = new Set([
  '店舗',
  'store',
  'shop',
  '共通',
  'common',
  '全体',
  'receipt',
  'レシート',
]);

const MANUFACTURER_COUPON_TOKENS = new Set([
  'メーカー',
  'maker',
  'manufacturer',
]);

function couponSearchTokens(label: string): string[] {
  // Latin coupon syntax: whole-token only (never unanchored "off"→coffee corruption).
  // CJK クーポン: allow compound substring split for unspaced labels.
  return splitCjkCouponSubstrings(normalizeToken(label))
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !COUPON_SYNTAX_TOKEN_SET.has(t));
}

function labelHasCouponMarker(label: string): boolean {
  const n = normalizeToken(label);
  if (!n) return false;
  return (
    n.includes('cpn') ||
    n.includes('coupon') ||
    n.includes('クーポン')
  );
}

/**
 * Count Latin letters (incl. full-width) vs CJK/kana letters in a label.
 * Exported for tests / diagnostics; not used as ownership evidence.
 */
export function couponLabelScriptCounts(label: string): {
  latinLetters: number;
  cjkLetters: number;
} {
  const raw = String(label || '');
  let latinLetters = 0;
  let cjkLetters = 0;
  for (const ch of raw) {
    if (/[A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A]/.test(ch)) latinLetters += 1;
    else if (/[\u3040-\u30FF\u3400-\u9FFF\uFF66-\uFF9D]/.test(ch)) cjkLetters += 1;
  }
  return { latinLetters, cjkLetters };
}

function isStoreWideCouponResidual(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  return tokens.every(
    (t) => STORE_WIDE_COUPON_TOKENS.has(t) || GENERIC_COUPON_OWNER_TOKENS.has(t)
  ) && !tokens.every((t) => MANUFACTURER_COUPON_TOKENS.has(t));
}

/**
 * Named product coupon: coupon marker + residual product tokens.
 * Excludes bare クーポン/CPN, manufacturer-generic, and store-wide coupons.
 */
export function isNamedProductCouponLabel(label: string): boolean {
  if (!labelHasCouponMarker(label)) return false;
  if (isReceiptLevelDiscountSummaryLabel(label)) return false;
  if (isBundleSummaryDiscountLabel(label)) return false;
  if (isReceiptLevelLoyaltyRedemptionLabel(label)) return false;
  const tokens = couponSearchTokens(label);
  if (tokens.length === 0) return false;
  if (tokens.every((t) => GENERIC_COUPON_OWNER_TOKENS.has(t))) return false;
  if (isStoreWideCouponResidual(tokens)) return false;
  // At least one token must look product-descriptive (not store-wide / generic).
  const hasProductToken = tokens.some(
    (t) => !STORE_WIDE_COUPON_TOKENS.has(t) && !GENERIC_COUPON_OWNER_TOKENS.has(t)
  );
  return hasProductToken;
}

/**
 * Unallocated coupon that must fail closed for merchandise price trust.
 * Narrow: named product CPN, bare coupon, manufacturer coupon.
 * Does NOT include genuine store-wide coupons (店舗クーポン共通) or loyalty.
 */
export function isProductAffectingCouponLabel(label: string): boolean {
  if (!labelHasCouponMarker(label)) return false;
  if (isReceiptLevelLoyaltyRedemptionLabel(label)) return false;
  if (isBundleSummaryDiscountLabel(label)) return false;
  if (isReceiptLevelDiscountSummaryLabel(label)) return false;
  if (isNamedProductCouponLabel(label)) return true;
  const tokens = couponSearchTokens(label);
  if (tokens.length === 0) return true; // bare クーポン / CPN
  if (tokens.every((t) => MANUFACTURER_COUPON_TOKENS.has(t))) return true;
  return false;
}

/**
 * Ownership allocation agreement uses exact canonical money equality.
 * Do NOT reuse receipt-reconciliation ±2 tolerance here (Receipt074 Round 5).
 */
function ownershipAmountsEqual(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * Receipt074 Round 5 — per-discount product-coupon unresolved check.
 *
 * Persisted coupon-specific allocation must exactly equal current
 * recomputation at the canonical stored money representation.
 */
export function hasUnresolvedProductAffectingCoupons(
  items: DiscountableItem[],
  discounts: DiscountLine[],
  options?: { evidenceTexts?: string[] }
): boolean {
  const productCoupons = discounts.filter((d) =>
    isProductAffectingCouponLabel(d.label)
  );
  if (productCoupons.length === 0) return false;

  const probe = applyReceiptDiscountsToItems(items, discounts, {
    evidenceTexts: options?.evidenceTexts ?? [],
  });

  for (const d of productCoupons) {
    const amount = Number(d.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const delta = amount < 0 ? amount : -Math.abs(amount);
    const binding = probe.bindings.find(
      (b) =>
        b.label === d.label && Math.abs(b.amount) === Math.abs(delta)
    );

    // Current resolver cannot prove ownership → unresolved.
    if (!binding || binding.status !== 'bound' || binding.itemIndex == null) {
      return true;
    }

    if (!isValidBoundItemIndex(binding.itemIndex, items.length)) {
      return true;
    }

    if (
      !isAcceptedDeterministicOwnershipReason(binding.reason) &&
      binding.reason !== 'duplicate_same_magnitude_skipped'
    ) {
      return true;
    }

    const idx = binding.itemIndex;
    const persistedItem = items[idx];
    const probeItem = probe.items[idx];
    const persistedAlloc = Number(persistedItem?.discountAllocated);
    const probeAlloc = Number(probeItem?.discountAllocated);
    const gross = grossOf(persistedItem ?? {});
    const effective = Number(persistedItem?.effectiveLineTotal);

    const claimingPersistedBound = d.ownershipStatus === 'bound';
    const hasPersistedAllocField = Number.isFinite(persistedAlloc);
    const hasEffectiveField = Number.isFinite(effective);
    const needsPersistedAllocationAgreement =
      claimingPersistedBound ||
      (hasPersistedAllocField && persistedAlloc !== 0) ||
      (hasEffectiveField &&
        Number.isFinite(gross) &&
        !ownershipAmountsEqual(effective, gross));

    if (claimingPersistedBound) {
      if (!isValidBoundItemIndex(d.boundItemIndex, items.length)) {
        return true;
      }
      if (d.boundItemIndex !== binding.itemIndex) {
        return true;
      }
      if (
        d.ownershipReason != null &&
        d.ownershipReason !== '' &&
        !isAcceptedDeterministicOwnershipReason(d.ownershipReason)
      ) {
        return true;
      }
      if (
        binding.reason != null &&
        binding.reason !== '' &&
        !isAcceptedDeterministicOwnershipReason(binding.reason) &&
        binding.reason !== 'duplicate_same_magnitude_skipped'
      ) {
        return true;
      }
    }

    if (!needsPersistedAllocationAgreement) {
      continue;
    }

    // Exact persisted ↔ recomputed item allocation agreement.
    if (!Number.isFinite(probeAlloc) || !Number.isFinite(persistedAlloc)) {
      return true;
    }
    if (!ownershipAmountsEqual(persistedAlloc, probeAlloc)) {
      return true;
    }

    // Effective must agree with gross + allocated discount (exact).
    if (!Number.isFinite(gross) || !Number.isFinite(effective)) {
      return true;
    }
    if (!ownershipAmountsEqual(effective, gross + persistedAlloc)) {
      return true;
    }

    // Coupon-specific attribution: count product-affecting bindings on this item.
    const productBindingsOnItem = probe.bindings.filter(
      (b) =>
        b.status === 'bound' &&
        b.itemIndex === idx &&
        isProductAffectingCouponLabel(b.label)
    );

    if (productBindingsOnItem.length > 1) {
      // No per-discount persisted amount field — refuse aggregate absorption.
      return true;
    }

    // Single product-affecting coupon on the item: coupon delta must equal the
    // product-coupon portion when no other discounts share the item.
    if (productBindingsOnItem.length === 1) {
      const otherBoundOnItem = probe.bindings.filter(
        (b) =>
          b.status === 'bound' &&
          b.itemIndex === idx &&
          !(
            b.label === d.label && Math.abs(b.amount) === Math.abs(delta)
          )
      );
      if (otherBoundOnItem.length === 0) {
        if (!ownershipAmountsEqual(persistedAlloc, delta)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Clear product-affecting coupon ownership stamps so reload recomputes.
 * Used after Review mutations that can invalidate boundItemIndex / lexical proof.
 */
export function invalidateProductCouponOwnershipMetadata(
  discounts: DiscountLine[] | null | undefined
): DiscountLine[] {
  if (!Array.isArray(discounts) || discounts.length === 0) return [];
  return discounts.map((d) => {
    if (!isProductAffectingCouponLabel(d.label)) return { ...d };
    return {
      ...d,
      ownershipStatus: null,
      boundItemIndex: null,
      ownershipReason: null,
    };
  });
}

/** @deprecated Use hasUnresolvedProductAffectingCoupons (per-discount). */
export function hasUnallocatedProductAffectingCoupon(
  items: DiscountableItem[],
  discounts: DiscountLine[],
  _toleranceJpy = 2
): boolean {
  return hasUnresolvedProductAffectingCoupons(items, discounts);
}

function toLoyaltyLabelKey(name: string): string {
  return (name || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .trim();
}

/**
 * Informational point / loyalty metadata — NEVER a receipt discount.
 * Must be checked before generic DISCOUNT_KEYWORDS so
 * 「楽天ポイント利用可能」 cannot match substring 「ポイント利用」.
 */
export function isLoyaltyPointMetadataLabel(name: string): boolean {
  const n = toLoyaltyLabelKey(name);
  if (!n) return false;
  if (!n.includes('ポイント') && !n.includes('point')) return false;
  return (
    n.includes('利用可能') ||
    n.includes('対象金額') ||
    n.includes('獲得予定') ||
    n.includes('ポイント残高') ||
    n.includes('ポイント明細') ||
    n.includes('楽天ポイント明細') ||
    n.includes('ポイントカード') ||
    (n.includes('残高') && n.includes('ポイント')) ||
    (n.includes('明細') && n.includes('ポイント')) ||
    (n.includes('カード') && n.includes('ポイント'))
  );
}

/**
 * Actual loyalty redemption that reduces the receipt total (receipt-level).
 * Shared by OCR classifyLineKind and applyReceiptDiscountsToItems.
 * Do NOT treat bare 「ポイント」 as redemption.
 */
export function isReceiptLevelLoyaltyRedemptionLabel(name: string): boolean {
  const n = toLoyaltyLabelKey(name);
  if (!n) return false;
  if (!n.includes('ポイント') && !n.includes('point')) return false;
  if (isLoyaltyPointMetadataLabel(name)) return false;
  if (/ポイント\s*[（(]\s*税込\s*[）)]/.test(n)) return true;
  if (n.includes('ポイント利用') || n.includes('利用ポイント')) return true;
  if (
    n.includes('ポイント支払') ||
    n.includes('ポイント値引') ||
    n.includes('ポイント割')
  ) {
    return true;
  }
  return false;
}

/** Alias used by OCR normalize / existing tests. */
export const isLoyaltyRedemptionLabel = isReceiptLevelLoyaltyRedemptionLabel;

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
 * Structured inline markdown original-price label, e.g. 値下(元 651) / 値下（元 ¥651）.
 * Entire label must match; bare "元" elsewhere does not parse.
 * Returns a positive integer yen amount, or null.
 */
export function parseInlineOriginalPriceYenFromDiscountLabel(
  label: string
): number | null {
  const raw = String(label ?? '').normalize('NFKC').trim();
  if (!raw) return null;
  const m = raw.match(
    /^値下(?:げ)?\s*[（(]\s*元\s*[¥￥]?\s*(\d{1,7})\s*[）)]\s*$/u
  );
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Conservative adjacent product discount labels (値引 / N%割引 / 割引 N% / 値下げ).
 * Excludes bundle/まとめ売り and receipt-level summaries.
 * Includes structured inline-original morphology 値下(元 N) so ownership can
 * bind after collapsed gross has been lifted to the label original.
 */
export function isOrdinaryAdjacentProductDiscountLabel(label: string): boolean {
  if (isBundleSummaryDiscountLabel(label)) return false;
  const raw = String(label || '').trim();
  if (!raw) return false;
  if (parseInlineOriginalPriceYenFromDiscountLabel(raw) != null) return true;
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

  // Inline-original morphology may bind only after gross equals the label
  // original (lifted or already-correct). Never attach -D onto charged-as-gross.
  const inlineOriginal = parseInlineOriginalPriceYenFromDiscountLabel(
    String(discount.label ?? '')
  );
  if (inlineOriginal != null && gross !== inlineOriginal) {
    return -1;
  }

  const pct = parseDiscountPercentFromLabel(discount.label);
  if (pct != null) {
    const expected = Math.round((gross * pct) / 100);
    if (Math.abs(expected - absDisc) > 1) return -1;
  }

  return adj;
}

/** Tokens that never independently prove coupon→item ownership. */
const GENERIC_LEXICAL_OWNERSHIP_TOKENS = new Set([
  'free',
  'new',
  'original',
  'regular',
  'large',
  'small',
  'organic',
  'natural',
  'fresh',
  'special',
  'sale',
  'pack',
  'set',
  'size',
  'value',
  'select',
  'premium',
  'classic',
  'style',
]);

function isCjkToken(token: string): boolean {
  return /[\u3040-\u30FF\u3400-\u9FFF\uFF66-\uFF9D]/.test(token);
}

/**
 * Informative coupon tokens after noise + generic ownership stop-words.
 */
export function informativeCouponOwnershipTokens(label: string): string[] {
  return couponSearchTokens(label).filter(
    (t) => !GENERIC_LEXICAL_OWNERSHIP_TOKENS.has(t)
  );
}

function singularizeOwnershipToken(token: string): string {
  if (!token || isCjkToken(token)) return token;
  if (token.length >= 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length >= 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Explicit packaging / count / measure tokens (not base product identity). */
function isOwnershipPackageToken(token: string): boolean {
  if (!token) return false;
  if (/^\d+[a-z]*$/i.test(token)) return true;
  if (/^x\d+$/i.test(token)) return true;
  if (/^\d+x\d+$/i.test(token)) return true;
  return false;
}

function normalizeOwnershipPackageKey(token: string): string {
  const lower = token.toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = lower.match(/^(\d+)(?:p|ct|pcs|pc|pk)$/))) return `count:${m[1]}`;
  if ((m = lower.match(/^x(\d+)$/))) return `mult:${m[1]}`;
  if ((m = lower.match(/^(\d+)x(\d+)$/))) return `grid:${m[1]}x${m[2]}`;
  if ((m = lower.match(/^(\d+(?:\.\d+)?)(ml|l|g|kg)$/))) {
    return `meas:${m[1]}${m[2]}`;
  }
  if (/^\d+$/.test(lower)) return `count:${lower}`;
  return lower;
}

function tokenizeForOwnership(label: string): string[] {
  return splitCjkCouponSubstrings(normalizeToken(label))
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function stripCouponSyntaxOwnershipTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !COUPON_SYNTAX_TOKEN_SET.has(t));
}

/**
 * Base product-identity tokens for coupon ownership.
 * Preserves variant-bearing descriptors (large/organic/original/free/…).
 * Removes only coupon syntax tokens and packaging/count tokens.
 */
export function ownershipBaseIdentityTokens(label: string): string[] {
  return stripCouponSyntaxOwnershipTokens(tokenizeForOwnership(label))
    .filter((t) => !isOwnershipPackageToken(t))
    .map(singularizeOwnershipToken)
    .filter((t) => t.length >= 2 || isCjkToken(t));
}

export function ownershipBaseIdentityKey(label: string): string {
  return [...ownershipBaseIdentityTokens(label)].sort().join(' ');
}

/**
 * Explicit packaging/count evidence extracted for ownership compatibility.
 * Coupon omission is allowed; coupon assertion without merchandise proof is not.
 */
export function ownershipPackageEvidenceKeys(label: string): string[] {
  const fromTokens = stripCouponSyntaxOwnershipTokens(tokenizeForOwnership(label))
    .filter(isOwnershipPackageToken)
    .map(normalizeOwnershipPackageKey);
  return [...new Set(fromTokens)].sort();
}

function packageEvidenceCompatible(
  couponKeys: readonly string[],
  itemKeys: readonly string[]
): boolean {
  if (couponKeys.length === 0) return true;
  if (itemKeys.length === 0) return false;
  return couponKeys.every((key) => itemKeys.includes(key));
}

/** @deprecated Prefer ownershipBaseIdentityTokens (Round 6). */
export function productCoreOwnershipTokens(label: string): string[] {
  return ownershipBaseIdentityTokens(label);
}

/** @deprecated Prefer ownershipBaseIdentityKey (Round 6). */
export function productCoreOwnershipKey(label: string): string {
  return ownershipBaseIdentityKey(label);
}

export const ACCEPTED_DETERMINISTIC_OWNERSHIP_REASONS = new Set([
  'strong_lexical_token_coverage',
  'lexical_token_unique', // legacy synonym accepted on revalidation
  'ordinary_adjacent_product_discount',
  'bundle_summary_evidence',
]);

export function isAcceptedDeterministicOwnershipReason(
  reason: string | null | undefined
): boolean {
  if (reason == null || reason === '') return false;
  return ACCEPTED_DETERMINISTIC_OWNERSHIP_REASONS.has(reason);
}

export function isValidBoundItemIndex(
  index: unknown,
  itemCount: number
): index is number {
  return (
    typeof index === 'number' &&
    Number.isInteger(index) &&
    Number.isFinite(index) &&
    index >= 0 &&
    index < itemCount
  );
}

/**
 * Bind a discount when coupon and merchandise base identity match exactly,
 * and explicit packaging/count evidence is compatible (Receipt074 Round 6).
 *
 * - Coupon syntax removed as whole tokens only
 * - Variant descriptors retained (LARGE / ORGANIC / ORIGINAL / FREE / …)
 * - Base identity equality (not subset)
 * - Coupon pack/count assertion must be compatible with merchandise evidence
 * - Coupon pack omission alone does not block
 */
export function findDiscountItemIndex(
  items: DiscountableItem[],
  discount: DiscountLine
): number {
  const couponBase = ownershipBaseIdentityTokens(discount.label);
  if (couponBase.length < 2) return -1;
  const couponKey = [...couponBase].sort().join(' ');
  if (!couponKey) return -1;
  const couponPack = ownershipPackageEvidenceKeys(discount.label);

  const matches: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const itemName = String(items[i]?.name ?? '');
    const itemBase = ownershipBaseIdentityTokens(itemName);
    const itemKey = [...itemBase].sort().join(' ');
    if (!itemKey || itemKey !== couponKey) continue;
    if (
      !packageEvidenceCompatible(
        couponPack,
        ownershipPackageEvidenceKeys(itemName)
      )
    ) {
      continue;
    }

    const gross = grossOf(items[i]);
    if (gross <= 0) continue;
    const amount = Number(discount.amount);
    if (Number.isFinite(amount) && amount !== 0) {
      const absDisc = Math.abs(amount < 0 ? amount : -Math.abs(amount));
      if (absDisc > gross) continue;
    }
    matches.push(i);
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
 * When charged/effective was stored as collapsed gross, but structured discounts[]
 * carry deterministic inline original-price evidence (値下(元 N)), lift lineTotal
 * to that original so subsequent adjacent binding recovers gross/discount/effective.
 *
 * Fail-closed: never invents originals; never lifts without exact yen closure.
 */
export function liftCollapsedGrossUsingInlineOriginalPriceEvidence<
  T extends DiscountableItem,
>(items: T[], discounts: DiscountLine[]): T[] {
  if (!Array.isArray(items) || items.length === 0) return items;
  if (!Array.isArray(discounts) || discounts.length === 0) return items;

  type Cand = { original: number; amount: number };
  const byOwner = new Map<number, Cand[]>();

  for (const discount of discounts) {
    const original = parseInlineOriginalPriceYenFromDiscountLabel(
      String(discount.label ?? '')
    );
    if (original == null) continue;
    const amountRaw = Number(discount.amount);
    // Fail-closed: only negative structured discount amounts.
    if (!Number.isFinite(amountRaw) || !(amountRaw < 0)) continue;
    const amount = amountRaw;
    const adj = discount.adjacentPrecedingItemIndex;
    if (
      typeof adj !== 'number' ||
      !Number.isInteger(adj) ||
      adj < 0 ||
      adj >= items.length
    ) {
      continue;
    }
    const list = byOwner.get(adj) ?? [];
    list.push({ original, amount });
    byOwner.set(adj, list);
  }

  if (byOwner.size === 0) return items;

  let changed = false;
  const next = items.map((item) => ({ ...item })) as T[];

  for (const [itemIndex, cands] of byOwner) {
    // Multiple inline-original discounts for one item → ambiguous; skip item.
    if (cands.length !== 1) continue;
    const { original, amount } = cands[0]!;
    const item = next[itemIndex]!;
    if (item.amountUserEdited === true) continue;

    const camel = Number(item.lineTotal);
    const snake = Number(item.line_total);
    if (Number.isFinite(camel) && Number.isFinite(snake) && camel !== snake) {
      continue;
    }
    const gross = Number.isFinite(camel)
      ? camel
      : Number.isFinite(snake)
        ? snake
        : Number.NaN;
    if (!Number.isFinite(gross) || !(gross > 0)) continue;

    const expectedCharged = original + amount;
    if (!(expectedCharged > 0) || !(original > expectedCharged)) continue;
    // Exact yen arithmetic required.
    if (expectedCharged !== original + amount) continue;

    const eff = Number(item.effectiveLineTotal);
    const discRaw = Number(item.discountAllocated);
    const disc = Number.isFinite(discRaw) ? discRaw : 0;

    // Already-correct canonical tuple — do not touch.
    if (
      gross === original &&
      disc === amount &&
      Number.isFinite(eff) &&
      eff === expectedCharged
    ) {
      continue;
    }

    // Collapsed charged-as-gross only.
    const collapsed =
      gross === expectedCharged &&
      disc === 0 &&
      (!Number.isFinite(eff) || eff === expectedCharged);
    if (!collapsed) continue;

    next[itemIndex] = {
      ...item,
      lineTotal: original,
      line_total: original,
    };
    changed = true;
  }

  return changed ? next : items;
}

/**
 * Apply product-level coupons onto items as effectiveLineTotal while keeping
 * gross lineTotal. Unbound coupons remain receipt-level.
 *
 * Bundle/まとめ売り値引 may bind via adjacency, group-price evidence, or
 * adjacentPrecedingItemIndex when token binding fails.
 *
 * Structured inline-original discounts (値下(元 N)) first lift collapsed
 * charged-as-gross lineTotals when exact yen evidence closes, then bind.
 *
 * Receipt074 Round 2: no cross-script named-adjacent CPN guessing.
 */
export function applyReceiptDiscountsToItems<T extends DiscountableItem>(
  items: T[],
  discounts: DiscountLine[],
  options?: { evidenceTexts?: string[] }
): DiscountAllocationResult<T> {
  const lifted = liftCollapsedGrossUsingInlineOriginalPriceEvidence(
    items,
    discounts
  );
  const next = lifted.map((item) => {
    const gross = grossOf(item);
    return {
      ...item,
      lineTotal: gross,
      effectiveLineTotal: gross,
      discountAllocated: 0,
    } as T;
  });

  const unboundDiscounts: DiscountLine[] = [];
  const bindings: DiscountBinding[] = [];
  let boundCount = 0;
  const evidenceTexts = options?.evidenceTexts ?? [];

  for (const discount of discounts) {
    const amount = Number(discount.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const delta = amount < 0 ? amount : -Math.abs(amount);
    const absDisc = Math.abs(delta);

    // Receipt-level loyalty redemption: never product / bundle / adjacency bind.
    if (isReceiptLevelLoyaltyRedemptionLabel(discount.label)) {
      unboundDiscounts.push({
        label: discount.label,
        amount: delta,
        ownershipStatus: 'unbound',
        boundItemIndex: null,
        ownershipReason: 'loyalty_redemption_receipt_level',
      });
      bindings.push({
        label: discount.label,
        amount: delta,
        status: 'unbound',
        itemIndex: null,
        reason: 'loyalty_redemption_receipt_level',
      });
      continue;
    }

    let idx = findDiscountItemIndex(next, discount);
    let reason = 'strong_lexical_token_coverage';
    if (idx < 0 && isBundleSummaryDiscountLabel(discount.label)) {
      idx = findBundleDiscountItemIndex(next, discount, evidenceTexts);
      reason = 'bundle_summary_evidence';
    }
    if (idx < 0) {
      idx = findAdjacentProductDiscountItemIndex(next, discount);
      reason = 'ordinary_adjacent_product_discount';
    }
    if (idx < 0) {
      unboundDiscounts.push({
        label: discount.label,
        amount: delta,
        ownershipStatus: 'unbound',
        boundItemIndex: null,
        ownershipReason: 'no_deterministic_ownership',
      });
      bindings.push({
        label: discount.label,
        amount: delta,
        status: 'unbound',
        itemIndex: null,
        reason: 'no_deterministic_ownership',
      });
      continue;
    }
    const item = next[idx];
    // Same discount represented twice (discounts[] + item line) must not stack
    // onto one line (Build 27 Sample 058: 210→196).
    if (
      isBundleSummaryDiscountLabel(discount.label) ||
      isOrdinaryAdjacentProductDiscountLabel(discount.label) ||
      isNamedProductCouponLabel(discount.label)
    ) {
      const prevAbs = Math.abs(Number(item.discountAllocated) || 0);
      if (prevAbs > 0 && prevAbs === absDisc) {
        bindings.push({
          label: discount.label,
          amount: delta,
          status: 'bound',
          itemIndex: idx,
          reason: 'duplicate_same_magnitude_skipped',
        });
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
    bindings.push({
      label: discount.label,
      amount: delta,
      status: 'bound',
      itemIndex: idx,
      reason,
    });
  }

  return { items: next, unboundDiscounts, boundCount, bindings };
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
    if (isAbsorbedReviewedDiscount(d)) return s;
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
