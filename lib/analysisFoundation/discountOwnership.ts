/**
 * A1.2.2 — Discount ownership resolution for amount-basis (read-only).
 *
 * Consumes persisted normalization ownership when consistent.
 * Does NOT reset effectiveLineTotal / discountAllocated and re-guess with weaker evidence.
 * unresolved_ownership ≠ genuine_receipt_level remainder.
 */

import {
  applyReceiptDiscountsToItems,
  discountsHaveAggregateSummaryAmbiguity,
  isBundleSummaryDiscountLabel,
  itemAmountForAnalytics,
  receiptLevelUnallocatedDiscountSum,
  type DiscountableItem,
  type DiscountLine,
} from '../receiptDiscountAllocation';

export const DISCOUNT_OWNERSHIP_TOLERANCE_JPY = 2;

export type DiscountOwnershipStatus =
  | 'persisted_resolved'
  | 'reallocated_with_evidence'
  | 'no_discounts'
  | 'unresolved';

export type DiscountOwnershipResolution = {
  status: DiscountOwnershipStatus;
  /** Items for analytics sum (persisted or freshly allocated). */
  items: DiscountableItem[];
  analyticsItemSum: number;
  /**
   * Genuine receipt-level remainder only when ownership is resolved.
   * Always 0 when status === 'unresolved'.
   */
  genuineReceiptLevelRemainder: number;
  boundDiscountTotal: number;
  evidence: string[];
  reasonCodes: string[];
};

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function moneyClose(a: number, b: number, tol = DISCOUNT_OWNERSHIP_TOLERANCE_JPY): boolean {
  return Math.abs(a - b) <= tol;
}

/**
 * Resolve a single authoritative gross only when aliases agree.
 * Conflicting finite lineTotal vs line_total → NaN (untrustworthy persisted ownership).
 */
function authoritativeGrossOrConflict(item: DiscountableItem): number {
  const camel = Number(item.lineTotal);
  const snake = Number(item.line_total);
  const camelOk = Number.isFinite(camel);
  const snakeOk = Number.isFinite(snake);
  if (camelOk && snakeOk && camel !== snake) {
    return Number.NaN;
  }
  if (camelOk) return camel;
  if (snakeOk) return snake;
  return Number.NaN;
}

/**
 * Persisted allocation is trustworthy only when structural invariants hold:
 * - discountAllocated <= 0 (no positive discounts; no 2JPY forgiveness)
 * - |discountAllocated| <= gross
 * - lineTotal / line_total aliases agree when both finite
 * - effective ≈ gross + discountAllocated within rounding tolerance only
 */
export function isPersistedDiscountAllocationConsistent(
  item: DiscountableItem
): boolean {
  const effective = Number(item.effectiveLineTotal);
  const allocated = Number(item.discountAllocated);

  const hasEffective = Number.isFinite(effective);
  const hasAllocated = Number.isFinite(allocated);
  // No discount fields → nothing to validate for this item.
  if (!hasEffective && !hasAllocated) return true;

  const gross = authoritativeGrossOrConflict(item);
  if (!Number.isFinite(gross)) return false;
  if (!hasEffective) return false;

  const alloc = hasAllocated ? allocated : 0;
  // Structural: discount must not be positive (strict; no tolerance).
  if (alloc > 0) return false;
  // Structural: allocation magnitude must not exceed gross (strict).
  if (Math.abs(alloc) > gross) return false;
  if (effective < 0) return false;
  // Rounding tolerance only for the effective equation.
  if (!moneyClose(effective, gross + alloc)) return false;
  return true;
}

export function itemHasPersistedDiscountOwnership(
  item: DiscountableItem
): boolean {
  const allocated = Number(item.discountAllocated);
  const effective = Number(item.effectiveLineTotal);
  const gross = authoritativeGrossOrConflict(item);
  if (!Number.isFinite(gross)) return false;
  if (Number.isFinite(allocated) && allocated !== 0) {
    return isPersistedDiscountAllocationConsistent(item);
  }
  if (
    Number.isFinite(effective) &&
    Number.isFinite(gross) &&
    !moneyClose(effective, gross)
  ) {
    // Effective differs from gross — only trust if allocated explains it.
    return isPersistedDiscountAllocationConsistent(item);
  }
  return false;
}

function allItemsPersistedConsistent(items: DiscountableItem[]): boolean {
  return items.every(isPersistedDiscountAllocationConsistent);
}

function anyPersistedOwnership(items: DiscountableItem[]): boolean {
  return items.some(itemHasPersistedDiscountOwnership);
}

function sumAnalytics(items: DiscountableItem[]): number {
  return roundMoney(
    items.reduce((s, it) => s + itemAmountForAnalytics(it), 0)
  );
}

function sumAllocated(items: DiscountableItem[]): number {
  return roundMoney(
    items.reduce((s, it) => {
      const a = Number(it.discountAllocated);
      if (!Number.isFinite(a) || a === 0) return s;
      return s + (a < 0 ? a : -Math.abs(a));
    }, 0)
  );
}

/**
 * Reconstruct evidenceTexts-like input from analysis_json when available.
 * Mirrors normalizeOcrAnalysis sources: ocr_raw_text/rawText + まとめ/個¥ names.
 */
export function extractDiscountEvidenceTexts(
  analysis: Record<string, unknown> | null,
  ocrItems: DiscountableItem[]
): string[] {
  const texts: string[] = [];
  if (!analysis) {
    for (const it of ocrItems) {
      const name = typeof it.name === 'string' ? it.name : '';
      if (/個\s*[¥￥]?\s*\d+|まとめ/.test(name)) texts.push(name);
    }
    return texts;
  }
  const rawText =
    typeof analysis.ocr_raw_text === 'string'
      ? analysis.ocr_raw_text
      : typeof analysis.rawText === 'string'
        ? analysis.rawText
        : '';
  for (const it of ocrItems) {
    const name = typeof it.name === 'string' ? it.name : '';
    if (/個\s*[¥￥]?\s*\d+|まとめ/.test(name)) texts.push(name);
  }
  // Also scan raw analysis.items names (pre-kept) if present as strings in discounts labels
  const rawItems = analysis.items;
  if (Array.isArray(rawItems)) {
    for (const row of rawItems) {
      if (!row || typeof row !== 'object') continue;
      const name = typeof (row as { name?: unknown }).name === 'string'
        ? (row as { name: string }).name
        : '';
      if (/個\s*[¥￥]?\s*\d+|まとめ/.test(name)) texts.push(name);
    }
  }
  if (rawText) texts.push(rawText);
  return texts;
}

function discountsNeedEvidenceForSafeRebind(
  discounts: DiscountLine[]
): boolean {
  return discounts.some(
    (d) =>
      isBundleSummaryDiscountLabel(d.label) &&
      !(
        typeof d.adjacentPrecedingItemIndex === 'number' &&
        d.adjacentPrecedingItemIndex >= 0
      )
  );
}

/**
 * Resolve discount ownership for OCR/analysis items.
 * Prefer persisted resolved ownership over weaker re-derivation.
 */
export function resolveDiscountOwnership(input: {
  ocrItems: DiscountableItem[];
  ocrDiscounts: DiscountLine[];
  analysis?: Record<string, unknown> | null;
}): DiscountOwnershipResolution {
  const { ocrItems, ocrDiscounts } = input;
  const evidence: string[] = [];
  const reasonCodes: string[] = [];

  if (discountsHaveAggregateSummaryAmbiguity(ocrDiscounts)) {
    return {
      status: 'unresolved',
      items: ocrItems,
      analyticsItemSum: sumAnalytics(ocrItems),
      genuineReceiptLevelRemainder: 0,
      boundDiscountTotal: 0,
      evidence: ['aggregate_discount_summary_ambiguous'],
      reasonCodes: [
        'aggregate_discount_summary_ambiguous',
        'discount_ownership_unresolved',
      ],
    };
  }

  const hasDiscounts = ocrDiscounts.length > 0;
  const hasPersisted = anyPersistedOwnership(ocrItems);
  const persistedOk = allItemsPersistedConsistent(ocrItems);

  // Persisted fields present but mathematically inconsistent → do not trust.
  if (!persistedOk) {
    evidence.push('persisted_discount_allocation_inconsistent');
    reasonCodes.push('persisted_discount_allocation_inconsistent');
    // Fall through: try full-evidence reallocation if possible; else unresolved.
  }

  // A / C: Prefer consistent persisted ownership.
  if (persistedOk && (hasPersisted || !hasDiscounts)) {
    const analyticsItemSum = sumAnalytics(ocrItems);
    const boundDiscountTotal = sumAllocated(ocrItems);
    let genuineReceiptLevelRemainder = 0;
    if (hasDiscounts) {
      // Consume persisted ownership — do NOT reset and re-bind.
      genuineReceiptLevelRemainder = roundMoney(
        receiptLevelUnallocatedDiscountSum(ocrItems, ocrDiscounts)
      );
      evidence.push('discount_ownership=persisted_resolved');
    } else {
      evidence.push(
        hasPersisted
          ? 'discount_ownership=persisted_without_discounts_array'
          : 'discount_ownership=no_discounts'
      );
    }
    return {
      status: hasDiscounts || hasPersisted ? 'persisted_resolved' : 'no_discounts',
      items: ocrItems,
      analyticsItemSum,
      genuineReceiptLevelRemainder,
      boundDiscountTotal,
      evidence,
      reasonCodes,
    };
  }

  // B: No reliable persisted ownership — reallocate only with adequate evidence.
  if (hasDiscounts) {
    const evidenceTexts = extractDiscountEvidenceTexts(
      input.analysis ?? null,
      ocrItems
    );
    const needsEvidence = discountsNeedEvidenceForSafeRebind(ocrDiscounts);
    if (needsEvidence && evidenceTexts.length === 0) {
      return {
        status: 'unresolved',
        items: ocrItems,
        analyticsItemSum: sumAnalytics(ocrItems),
        genuineReceiptLevelRemainder: 0,
        boundDiscountTotal: 0,
        evidence: [
          'bundle_discount_requires_evidence_texts',
          'evidence_texts_unavailable',
          ...evidence,
        ],
        reasonCodes: [
          'discount_ownership_unresolved',
          'insufficient_evidence_for_reallocation',
          ...reasonCodes,
        ],
      };
    }

    const allocation = applyReceiptDiscountsToItems(ocrItems, ocrDiscounts, {
      evidenceTexts,
    });
    const remainder = roundMoney(
      allocation.unboundDiscounts.reduce((sum, d) => {
        const amount = Number(d.amount);
        if (!Number.isFinite(amount) || amount === 0) return sum;
        return sum + (amount < 0 ? amount : -Math.abs(amount));
      }, 0)
    );
    const analyticsItemSum = roundMoney(
      allocation.items.reduce((s, it) => s + itemAmountForAnalytics(it), 0)
    );
    return {
      status: 'reallocated_with_evidence',
      items: allocation.items,
      analyticsItemSum,
      genuineReceiptLevelRemainder: remainder,
      boundDiscountTotal: roundMoney(
        allocation.items.reduce((s, it) => {
          const a = Number(it.discountAllocated);
          return Number.isFinite(a) ? s + a : s;
        }, 0)
      ),
      evidence: [
        `discount_ownership=reallocated_with_evidence`,
        `evidence_texts_count=${evidenceTexts.length}`,
        `bound_count=${allocation.boundCount}`,
        `unbound_count=${allocation.unboundDiscounts.length}`,
      ],
      reasonCodes,
    };
  }

  // Inconsistent persisted + no discounts to reallocate → unresolved.
  if (!persistedOk) {
    return {
      status: 'unresolved',
      items: ocrItems,
      analyticsItemSum: sumAnalytics(ocrItems),
      genuineReceiptLevelRemainder: 0,
      boundDiscountTotal: 0,
      evidence,
      reasonCodes: [...reasonCodes, 'discount_ownership_unresolved'],
    };
  }

  return {
    status: 'no_discounts',
    items: ocrItems,
    analyticsItemSum: sumAnalytics(ocrItems),
    genuineReceiptLevelRemainder: 0,
    boundDiscountTotal: 0,
    evidence: ['discount_ownership=no_discounts'],
    reasonCodes,
  };
}
