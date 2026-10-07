/**
 * Reviewed-truth derived analysis.
 *
 * recognition_snapshot_json stays immutable recognition evidence.
 * One projection, projectReviewedMonetaryTruth, decides which item amounts
 * and which discounts still affect the current receipt. Warning, save
 * eligibility, DB defense, and persisted analysis all use that result.
 *
 * Reviewed merchandise =
 *   sum(item effective / final-paid amounts)
 *   + sum(discounts that are still unapplied at receipt level)
 *
 * A final-paid edit absorbs the discount previously bound to that line.
 * The discount row stays as provenance and is excluded from summation.
 */

import { buildReceiptTemplateL1 } from './analysisTemplatesV1';
import { buildReceiptAnalysisV1 } from './growthAnalysisEngineV1';
import {
  findReviewedDiscountHostIndex,
  hostAllocationEquationHolds,
  isAbsorbedReviewedDiscount,
  itemAmountForAnalytics,
  type DiscountableItem,
  type DiscountLine,
} from './receiptDiscountAllocation';
import { reconcileReceiptTotals, type ReceiptReconciliation } from './receiptOcrNormalize';
import {
  evaluateScanReviewSaveEligibility,
  type ScanReviewSaveEligibility,
} from './scanReviewSaveSafety';
import { buildReceiptStructuredAnalysis } from './structuredAnalysisEngine';

export type ReviewedMonetaryTruth = {
  /** Positive line totals: printed gross, or the final paid amount after an edit. */
  itemsPositiveSum: number;
  /** Applied item discounts plus still-unapplied receipt discounts. Absorbed rows excluded. */
  discountsSum: number;
  /** itemsPositiveSum + discountsSum. */
  netMerchandise: number;
  effectiveItemAmounts: number[];
  unappliedDiscountsSum: number;
  discounts: DiscountLine[];
  /** Item rows after malformed allocation is lifted off an unproven host. */
  items: DiscountableItem[];
};

function nonPositiveAmount(amount: unknown): number | null {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? n : -Math.abs(n);
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function currentIndexForOriginal(
  items: readonly DiscountableItem[],
  originalIndex: number | null
): number | null {
  return findReviewedDiscountHostIndex(items, originalIndex);
}

function originalBoundIndex(discount: DiscountLine): number | null {
  return (
    integerOrNull(discount.sourceBoundItemIndex) ??
    integerOrNull(discount.boundItemIndex)
  );
}

function originalAdjacentIndex(discount: DiscountLine): number | null {
  return (
    integerOrNull(discount.sourceAdjacentPrecedingItemIndex) ??
    integerOrNull(discount.adjacentPrecedingItemIndex)
  );
}

function reviewedRole(discount: DiscountLine): 'applied' | 'unapplied' | 'absorbed' | null {
  const role = discount.reviewedMonetaryRole;
  if (role === 'applied' || role === 'unapplied' || role === 'absorbed') return role;
  return null;
}

function itemGross(item: DiscountableItem): number | null {
  const camel = Number(item.lineTotal);
  const snake = Number(item.line_total);
  const camelOk = Number.isFinite(camel);
  const snakeOk = Number.isFinite(snake);
  if (camelOk && snakeOk && camel !== snake) return null;
  if (camelOk) return camel;
  if (snakeOk) return snake;
  return null;
}

/** Exactly one non-empty subset sums to the host allocation, or null. */
function uniqueSubsetIndexes(amounts: readonly number[], target: number): number[] | null {
  const count = amounts.length;
  if (count === 0 || count > 12) return null;
  let found: number[] | null = null;
  const limit = 1 << count;
  for (let mask = 1; mask < limit; mask += 1) {
    let sum = 0;
    const indexes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      sum += amounts[index];
      indexes.push(index);
    }
    if (sum !== target) continue;
    if (found) return null;
    found = indexes;
  }
  return found;
}

/**
 * Reconcile discount ownership against the current reviewed item list.
 *
 * - Final-paid edit (`amountUserEdited`): the bound discount is absorbed.
 *   Its amount stays on the row for provenance and is not subtracted again.
 * - Bound item removed: the printed discount amount remains a receipt-level
 *   unapplied discount (existing save contract) and no longer points at a row.
 * - Surviving bound item: `boundItemIndex` moves to that item's current index.
 */
type PlannedDiscount = {
  raw: DiscountLine;
  amount: number;
  label: string;
  sourceBound: number | null;
  sourceAdjacent: number | null;
  adjacentNow: number | null;
  hostIndex: number | null;
  kind: 'applied' | 'unapplied' | 'absorbed';
  reason: string | null;
};

function emitDiscount(row: PlannedDiscount): DiscountLine {
  if (row.kind === 'absorbed') {
    return {
      ...row.raw,
      label: row.label,
      amount: row.amount,
      ownershipStatus: 'absorbed',
      reviewedMonetaryRole: 'absorbed',
      boundItemIndex: null,
      sourceBoundItemIndex: row.sourceBound,
      sourceAdjacentPrecedingItemIndex: row.sourceAdjacent,
      adjacentPrecedingItemIndex: row.adjacentNow,
      ownershipReason: 'absorbed_by_reviewed_final_paid',
    };
  }
  if (row.kind === 'applied' && row.hostIndex != null) {
    return {
      ...row.raw,
      label: row.label,
      amount: row.amount,
      ownershipStatus: 'bound',
      reviewedMonetaryRole: 'applied',
      boundItemIndex: row.hostIndex,
      sourceBoundItemIndex: row.sourceBound ?? row.hostIndex,
      sourceAdjacentPrecedingItemIndex: row.sourceAdjacent,
      adjacentPrecedingItemIndex: row.adjacentNow,
      ownershipReason:
        typeof row.raw.ownershipReason === 'string' && row.raw.ownershipReason.trim()
          ? row.raw.ownershipReason
          : 'ordinary_adjacent_product_discount',
    };
  }
  return {
    ...row.raw,
    label: row.label,
    amount: row.amount,
    ownershipStatus: 'unbound',
    reviewedMonetaryRole: 'unapplied',
    boundItemIndex: null,
    sourceBoundItemIndex: row.sourceBound,
    sourceAdjacentPrecedingItemIndex: row.sourceAdjacent,
    adjacentPrecedingItemIndex: row.adjacentNow,
    ownershipReason: row.reason,
  };
}

export function projectReviewedMonetaryTruth(input: {
  items: readonly DiscountableItem[];
  discounts: readonly DiscountLine[];
}): ReviewedMonetaryTruth {
  const items = (Array.isArray(input.items) ? input.items : []).map((item) => item);
  const sourceDiscounts = Array.isArray(input.discounts) ? input.discounts : [];
  const planned: PlannedDiscount[] = [];
  const candidatesByHost = new Map<number, PlannedDiscount[]>();

  for (const raw of sourceDiscounts) {
    if (!raw || typeof raw !== 'object') continue;
    const amount = nonPositiveAmount(raw.amount);
    if (amount == null) continue;
    const rawAmount = raw.amount;
    const strictNegative =
      typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount < 0;
    const sourceBound = originalBoundIndex(raw);
    const sourceAdjacent = originalAdjacentIndex(raw);
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label : '値引';
    const hostIndex = currentIndexForOriginal(items, sourceBound);
    const host = hostIndex == null ? null : items[hostIndex];
    const adjacentNow =
      sourceAdjacent == null ? null : currentIndexForOriginal(items, sourceAdjacent);
    const role = reviewedRole(raw);
    const base: PlannedDiscount = {
      raw,
      amount,
      label,
      sourceBound,
      sourceAdjacent,
      adjacentNow,
      hostIndex,
      kind: 'unapplied',
      reason: null,
    };

    // A reviewed role with a raw non-negative amount is not authoritative applied
    // or absorbed metadata. Keep the normalized amount once at receipt level.
    if (role && !strictNegative) {
      planned.push({
        ...base,
        kind: 'unapplied',
        reason: 'invalid_reviewed_discount_sign',
      });
      continue;
    }

    // An explicit unapplied role is receipt-level even if a stale index remains.
    if (role === 'unapplied' || hostIndex == null || !host) {
      planned.push({
        ...base,
        kind: 'unapplied',
        reason: !host
          ? 'unbound_after_reviewed_item_removed'
          : 'unapplied_stale_binding_normalized',
      });
      continue;
    }

    if (host.amountUserEdited === true) {
      if (activeAllocated(host) !== 0) {
        items[hostIndex] = { ...host, discountAllocated: 0 };
      }
      planned.push({ ...base, kind: 'absorbed' });
      continue;
    }

    if (isAbsorbedReviewedDiscount(raw) && !hostAllocationEquationHolds(host)) {
      const gross = itemGross(host);
      const effective = Number(host.effectiveLineTotal);
      const alreadyInsideEffective =
        gross != null && Number.isFinite(effective) && effective === gross + amount;
      if (!alreadyInsideEffective) {
        planned.push({
          ...base,
          kind: 'unapplied',
          reason: 'unbound_after_absorbed_host_lost_allocation',
        });
        continue;
      }
    }

    const candidate: PlannedDiscount = { ...base, kind: 'applied' };
    planned.push(candidate);
    const group = candidatesByHost.get(hostIndex) ?? [];
    group.push(candidate);
    candidatesByHost.set(hostIndex, group);
  }

  for (const [hostIndex, group] of candidatesByHost) {
    const host = items[hostIndex];
    const amounts = group.map((row) => row.amount);
    const sum = amounts.reduce((total, value) => total + value, 0);
    const allocated = Number(host?.discountAllocated);
    const allocation = Number.isFinite(allocated)
      ? allocated < 0
        ? allocated
        : allocated === 0
          ? 0
          : -Math.abs(allocated)
      : null;
    if (
      host &&
      hostAllocationEquationHolds(host) &&
      allocation != null &&
      sum === allocation
    ) {
      continue;
    }
    const subset =
      host && hostAllocationEquationHolds(host) && allocation != null && allocation < 0
        ? uniqueSubsetIndexes(amounts, allocation)
        : null;
    if (subset) {
      const keep = new Set(subset);
      group.forEach((row, index) => {
        if (keep.has(index)) return;
        row.kind = 'unapplied';
        row.reason = 'unapplied_unproven_reviewed_role';
      });
      continue;
    }
    const gross = host ? itemGross(host) : null;
    const effective = host ? Number(host.effectiveLineTotal) : Number.NaN;
    if (
      host &&
      gross != null &&
      Number.isFinite(effective) &&
      effective === gross + sum
    ) {
      items[hostIndex] = { ...host, discountAllocated: sum, effectiveLineTotal: effective };
      continue;
    }
    group.forEach((row) => {
      row.kind = 'unapplied';
      row.reason = 'unapplied_unproven_reviewed_role';
    });
    if (host && gross != null) {
      items[hostIndex] = {
        ...host,
        discountAllocated: 0,
        effectiveLineTotal: gross,
      };
    }
  }

  for (const row of planned) {
    if (row.kind !== 'unapplied' || row.hostIndex == null) continue;
    const host = items[row.hostIndex];
    if (!host || host.amountUserEdited === true) continue;
    const appliedHere = planned.some(
      (other) => other.kind === 'applied' && other.hostIndex === row.hostIndex
    );
    if (appliedHere || !hostAllocationEquationHolds(host)) continue;
    const gross = itemGross(host);
    if (gross == null) continue;
    items[row.hostIndex] = {
      ...host,
      discountAllocated: 0,
      effectiveLineTotal: gross,
    };
  }

  const discounts = planned.map(emitDiscount);
  let receiptLevelDiscount = 0;
  for (const row of planned) {
    if (row.kind === 'unapplied') receiptLevelDiscount += row.amount;
  }
  const effectiveItemAmounts = items.map((item) => itemAmountForAnalytics(item));
  const itemMerchandise = Math.round(
    effectiveItemAmounts.reduce((sum, amount) => sum + amount, 0)
  );
  const receiptLevel = Math.round(receiptLevelDiscount);
  return {
    // Reviewed reconciliation basis is item effective merchandise, not gross.
    // Bound/absorbed discounts are already inside that merchandise.
    itemsPositiveSum: itemMerchandise,
    discountsSum: receiptLevel,
    netMerchandise: itemMerchandise + receiptLevel,
    effectiveItemAmounts,
    unappliedDiscountsSum: receiptLevel,
    discounts,
    items,
  };
}

function activeAllocated(item: DiscountableItem): number {
  const allocated = Number(item.discountAllocated);
  if (!Number.isFinite(allocated) || allocated === 0) return 0;
  return allocated < 0 ? allocated : -Math.abs(allocated);
}

export function reconcileReviewedReceipt(input: {
  items: readonly DiscountableItem[];
  discounts: readonly DiscountLine[];
  tax: number;
  total: number;
}): ReceiptReconciliation {
  const truth = projectReviewedMonetaryTruth(input);
  return reconcileReceiptTotals(
    truth.itemsPositiveSum,
    truth.discountsSum,
    input.tax,
    input.total
  );
}

/** Save gate and live warning share this entry so they cannot sum a second basis. */
export function evaluateReviewedReceiptSaveEligibility(input: {
  items: readonly DiscountableItem[];
  discounts: readonly DiscountLine[];
  tax: number;
  total: number;
}): ScanReviewSaveEligibility {
  const truth = projectReviewedMonetaryTruth(input);
  return evaluateScanReviewSaveEligibility({
    itemsPositiveSum: truth.itemsPositiveSum,
    discountsSum: truth.discountsSum,
    tax: input.tax,
    total: input.total,
  });
}

/**
 * Replace current-state derived fields on a reviewed analysis object.
 * Does not mutate the input. Does not touch recognition snapshots.
 */
export function refreshReviewedDerivedAnalysis<T extends Record<string, unknown>>(
  analysis: T
): T {
  const sourceItems = Array.isArray(analysis.items)
    ? (analysis.items as DiscountableItem[])
    : [];
  const discounts = Array.isArray(analysis.discounts)
    ? (analysis.discounts as DiscountLine[])
    : [];
  const taxN = Number(analysis.tax);
  const tax = Number.isFinite(taxN) ? taxN : 0;
  const total = Number(analysis.total) || 0;
  const truth = projectReviewedMonetaryTruth({ items: sourceItems, discounts });
  const items = truth.items;
  const reconciliation = reconcileReceiptTotals(
    truth.itemsPositiveSum,
    truth.discountsSum,
    tax,
    total
  );
  // merchandise_amount stays the item subtotal from the builders.
  // receipt_level_discount stays the unapplied discount only.
  // Net is merchandise_amount + receipt_level_discount, and root reconciliation.
  const receiptLevel = buildReceiptAnalysisV1({
    items,
    total,
    discounts: truth.discounts,
  });
  const previousOutputs =
    analysis.analysis_outputs_v1 &&
    typeof analysis.analysis_outputs_v1 === 'object'
      ? (analysis.analysis_outputs_v1 as Record<string, unknown>)
      : {};
  const previousTemplates =
    previousOutputs.templates_v1 &&
    typeof previousOutputs.templates_v1 === 'object'
      ? (previousOutputs.templates_v1 as Record<string, unknown>)
      : {};
  const currency =
    typeof analysis.currency === 'string' && analysis.currency.trim()
      ? analysis.currency
      : 'JPY';
  const engine = buildReceiptStructuredAnalysis({
    merchant: typeof analysis.merchant === 'string' ? analysis.merchant : undefined,
    items,
    total,
    tax: analysis.tax == null ? null : tax,
    currency,
  });

  return {
    ...analysis,
    items,
    discounts: truth.discounts,
    reconciliation,
    amount_mismatch: !reconciliation.ok,
    analysis_engine_v1: engine,
    analysis_outputs_v1: {
      ...previousOutputs,
      receipt_level: receiptLevel,
      templates_v1: {
        ...previousTemplates,
        receipt_template: buildReceiptTemplateL1(receiptLevel),
      },
    },
  };
}
