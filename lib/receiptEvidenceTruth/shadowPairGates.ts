/**
 * A1.4A — Shared conservative shadow pair gates (read-only).
 */

import {
  areSemanticRescanItemNamesCompatible,
  type AnalysisDQtyAmountRow,
} from '../analysisDDuplicateAudit';
import { canonicalizeReceiptItemName } from '../analysisDDuplicateAudit';
import type { ProductionShadowCandidateNode } from './shadowCandidateNode';
import type { RawItemBasketValidationResult } from './types';
import {
  isShadowAuthorizingCurrency,
  normalizeShadowCurrency,
  rawBasketVectorsEqual,
  validateRawOcrItemBasket,
} from './rawItemValidation';

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function moneyEquals(a: number, b: number): boolean {
  return roundMoney(a) === roundMoney(b);
}

function qtyAmountVectorEquals(
  a: readonly AnalysisDQtyAmountRow[],
  b: readonly AnalysisDQtyAmountRow[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.quantity !== right.quantity ||
      !moneyEquals(left.lineAmount, right.lineAmount)
    ) {
      return false;
    }
  }
  return true;
}

function hasFinitePositiveTotal(total: number): boolean {
  return Number.isFinite(total) && total > 0;
}

export type ShadowBasketGateResult =
  | { ok: true; evidence: string[]; rawA: RawItemBasketValidationResult & { ok: true }; rawB: RawItemBasketValidationResult & { ok: true } }
  | { ok: false; reason: string };

export function evaluateShadowBasketGate(
  left: ProductionShadowCandidateNode,
  right: ProductionShadowCandidateNode
): ShadowBasketGateResult {
  const summaryA = left.summary;
  const summaryB = right.summary;

  const currencyA = normalizeShadowCurrency(left.representativeReceipt);
  const currencyB = normalizeShadowCurrency(right.representativeReceipt);

  if (!isShadowAuthorizingCurrency(currencyA) || !isShadowAuthorizingCurrency(currencyB)) {
    return { ok: false, reason: 'currency_not_jpy' };
  }

  if (!hasFinitePositiveTotal(summaryA.total) || !hasFinitePositiveTotal(summaryB.total)) {
    return { ok: false, reason: 'non_positive_total' };
  }
  if (!moneyEquals(summaryA.total, summaryB.total)) {
    return { ok: false, reason: 'total_mismatch' };
  }
  if (summaryA.itemCount !== summaryB.itemCount || summaryA.itemCount === 0) {
    return { ok: false, reason: 'item_count_mismatch_or_empty' };
  }
  if (!qtyAmountVectorEquals(summaryA.orderedQtyAmountVector, summaryB.orderedQtyAmountVector)) {
    return { ok: false, reason: 'qty_amount_vector_mismatch' };
  }

  const rawA = validateRawOcrItemBasket(left.representativeReceipt);
  const rawB = validateRawOcrItemBasket(right.representativeReceipt);
  if (!rawA.ok) return { ok: false, reason: `raw_basket_left_${rawA.reason}` };
  if (!rawB.ok) return { ok: false, reason: `raw_basket_right_${rawB.reason}` };
  if (!rawBasketVectorsEqual(rawA.rows, rawB.rows)) {
    return { ok: false, reason: 'raw_basket_vector_mismatch' };
  }

  const evidence: string[] = [
    'same_positive_total',
    'currency=JPY',
    'same_item_count',
    'same_ordered_qty_amount_vector',
    'raw_basket_validated',
    ...rawA.evidence,
    ...rawB.evidence,
  ];

  for (let i = 0; i < rawA.rows.length; i += 1) {
    const leftName = canonicalizeReceiptItemName(rawA.rows[i]!.name);
    const rightName = canonicalizeReceiptItemName(rawB.rows[i]!.name);
    if (!leftName.trim() || !rightName.trim()) {
      return { ok: false, reason: 'empty_item_name_evidence' };
    }
    const check = areSemanticRescanItemNamesCompatible(leftName, rightName);
    if (!check.compatible) {
      return { ok: false, reason: `item_name_incompatible_index_${i}` };
    }
    evidence.push(`name_compatible_index_${i}=${check.note}`);
  }

  if (summaryA.taxKnown && summaryB.taxKnown) {
    if (summaryA.tax == null || summaryB.tax == null) {
      return { ok: false, reason: 'tax_value_missing' };
    }
    if (!moneyEquals(summaryA.tax, summaryB.tax)) {
      return { ok: false, reason: 'tax_mismatch' };
    }
    evidence.push('both_tax_known_equal');
  } else {
    return { ok: false, reason: 'tax_evidence_insufficient' };
  }

  return { ok: true, evidence, rawA, rawB };
}

export function stableSortedStrings(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function orientCandidatePair(
  a: ProductionShadowCandidateNode,
  b: ProductionShadowCandidateNode
): { left: ProductionShadowCandidateNode; right: ProductionShadowCandidateNode } {
  return a.candidateId <= b.candidateId
    ? { left: a, right: b }
    : { left: b, right: a };
}
