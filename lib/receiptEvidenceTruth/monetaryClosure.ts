/**
 * A1.4A — Same-layer monetary closure assessment (read-only / shadow).
 *
 * Arithmetic first: metadata never overrides a contradictory same-layer equation.
 * Incomplete authoritative item monetary evidence is unknown — never treated as zero.
 */

import type { ReceiptRow } from '../db';
import { AMOUNT_BASIS_TOLERANCE_JPY } from '../analysisFoundation/amountBasis';
import { resolveDiscountOwnership } from '../analysisFoundation/discountOwnership';
import type { DiscountableItem, DiscountLine } from '../receiptDiscountAllocation';
import {
  hasFinitePositive,
  type ReceiptMonetarySourceBundle,
} from '../analysisFoundation/monetarySourceBundle';
import type { MonetaryCoherenceState } from './types';

function parseAnalysisJson(receipt: ReceiptRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(receipt.analysis_json || '{}');
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readAnalysisItems(analysis: Record<string, unknown> | null): DiscountableItem[] {
  if (!analysis) return [];
  const items = analysis.items;
  if (!Array.isArray(items)) return [];
  return items.map((row) =>
    row && typeof row === 'object'
      ? (row as DiscountableItem)
      : ({} as DiscountableItem)
  );
}

function readAnalysisDiscounts(analysis: Record<string, unknown> | null): DiscountLine[] {
  if (!analysis) return [];
  const discounts = analysis.discounts;
  if (!Array.isArray(discounts)) return [];
  const out: DiscountLine[] = [];
  for (const d of discounts) {
    if (!d || typeof d !== 'object') continue;
    const row = d as Record<string, unknown>;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const label = typeof row.label === 'string' ? row.label : '';
    out.push({
      label,
      amount: amount < 0 ? amount : -Math.abs(amount),
      adjacentPrecedingItemIndex:
        typeof row.adjacentPrecedingItemIndex === 'number'
          ? row.adjacentPrecedingItemIndex
          : null,
    });
  }
  return out;
}

function rebuildLegacyUserEditOcrBundle(
  receipt: ReceiptRow
): ReceiptMonetarySourceBundle {
  const analysis = parseAnalysisJson(receipt);
  const ocrItems = readAnalysisItems(analysis);
  const ocrDiscounts = readAnalysisDiscounts(analysis);
  const ownership = resolveDiscountOwnership({
    ocrItems,
    ocrDiscounts,
    analysis,
  });
  const ocrTotal = Number(receipt.total);
  return {
    coherent: true,
    layer: 'ocr',
    items: ownership.items,
    ocrDiscounts,
    receiptLevelUnallocatedDiscountTotal: ownership.genuineReceiptLevelRemainder,
    analyticsItemSumOverride: ownership.analyticsItemSum,
    paidTotal: Number.isFinite(ocrTotal) ? ocrTotal : null,
    discountReconciliationAmbiguous: false,
    discountOwnershipStatus: ownership.status,
    reasonCodes: [],
    evidence: [
      'monetary_layer=ocr',
      'legacy_user_edit_ocr_layer_reconstructed',
    ],
  };
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function moneyClose(a: number, b: number, tol = AMOUNT_BASIS_TOLERANCE_JPY): boolean {
  return Math.abs(a - b) <= tol;
}

function trustedPositiveTax(receipt: ReceiptRow): number | null {
  if (receipt.tax_is_known !== 1) return null;
  const tax = Number(receipt.tax);
  if (!Number.isFinite(tax) || tax <= 0) return null;
  return tax;
}

/**
 * Presence-aware classification of a single monetary field value.
 * ABSENT key is distinct from PRESENT null / malformed.
 */
type FieldAmountRead =
  | { status: 'absent' }
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'explicit_zero' }
  | { status: 'valid_positive'; amount: number };

function readPresentMonetaryField(
  row: Record<string, unknown>,
  key: string
): FieldAmountRead {
  if (!Object.prototype.hasOwnProperty.call(row, key)) {
    return { status: 'absent' };
  }
  const raw = row[key];
  if (raw === null || raw === undefined) return { status: 'missing' };
  if (typeof raw !== 'number') return { status: 'malformed' };
  if (!Number.isFinite(raw)) return { status: 'malformed' };
  if (raw < 0) return { status: 'malformed' };
  if (raw === 0) return { status: 'explicit_zero' };
  return { status: 'valid_positive', amount: raw };
}

function fieldToSelected(
  field: FieldAmountRead
): SelectedItemMonetaryAmount | null {
  if (field.status === 'absent') return null;
  if (field.status === 'missing') return { kind: 'missing' };
  if (field.status === 'malformed') return { kind: 'malformed' };
  if (field.status === 'explicit_zero') {
    return { kind: 'explicit_zero', amount: 0 };
  }
  return { kind: 'valid_positive', amount: field.amount };
}

export type SelectedItemMonetaryAmount =
  | { kind: 'valid_positive'; amount: number }
  | { kind: 'explicit_zero'; amount: 0 }
  | { kind: 'missing' }
  | { kind: 'malformed' };

type AuthoritativeItemSideResult =
  | {
      complete: true;
      itemSide: number;
      hasPositive: boolean;
      evidence: string[];
    }
  | {
      complete: false;
      reasonCodes: string[];
      evidence: string[];
    };

/**
 * Original OCR monetary evidence — presence-aware, no Number() coercion wash.
 *
 * - lineTotal / line_total are SAME-semantic gross aliases (must agree).
 * - effectiveLineTotal is NOT a gross alias; it may diverge from gross when a
 *   valid persisted discountAllocated explains: effective ≈ gross + allocated.
 * - PRESENT malformed/missing selected alias does NOT fall through to fabricate
 *   evidence from a lower alias.
 */
function readPresentDiscountAllocated(
  row: Record<string, unknown>
):
  | { status: 'absent' }
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'ok'; amount: number } {
  if (!Object.prototype.hasOwnProperty.call(row, 'discountAllocated')) {
    return { status: 'absent' };
  }
  const raw = row.discountAllocated;
  if (raw === null || raw === undefined) return { status: 'missing' };
  if (typeof raw !== 'number') return { status: 'malformed' };
  if (!Number.isFinite(raw)) return { status: 'malformed' };
  return { status: 'ok', amount: raw };
}

function monetaryAmountOf(
  selected: SelectedItemMonetaryAmount & {
    kind: 'valid_positive' | 'explicit_zero';
  }
): number {
  return selected.kind === 'explicit_zero' ? 0 : selected.amount;
}

/**
 * Mirror production persisted-allocation equation without modifying production:
 * effective ≈ gross + discountAllocated, allocated <= 0, effective >= 0.
 *
 * Structural: gross !== effective requires a non-zero discount explanation.
 * Arithmetic: moneyClose applies ONLY to effective ≈ gross + allocated.
 */
function isValidPersistedDiscountExplanation(
  item: Record<string, unknown>,
  gross: number,
  effective: number
): boolean {
  const allocated = readPresentDiscountAllocated(item);
  if (allocated.status !== 'ok') return false;
  if (allocated.amount > 0) return false;
  // alloc=0 cannot explain gross !== effective (structural, not tolerance).
  if (allocated.amount === 0 && gross !== effective) return false;
  if (effective < 0) return false;
  if (Math.abs(allocated.amount) > gross) return false;
  return moneyClose(effective, gross + allocated.amount);
}

function resolveOriginalOcrItemMonetaryEvidence(
  item: Record<string, unknown>
): SelectedItemMonetaryAmount {
  const effective = readPresentMonetaryField(item, 'effectiveLineTotal');
  const camel = readPresentMonetaryField(item, 'lineTotal');
  const snake = readPresentMonetaryField(item, 'line_total');

  // A. Same-semantic gross aliases: lineTotal / line_total — EXACT identity.
  let gross: SelectedItemMonetaryAmount | null = null;
  if (camel.status !== 'absent' && snake.status !== 'absent') {
    const camelSelected = fieldToSelected(camel)!;
    const snakeSelected = fieldToSelected(snake)!;
    if (
      camelSelected.kind === 'missing' ||
      camelSelected.kind === 'malformed'
    ) {
      return camelSelected;
    }
    if (
      snakeSelected.kind === 'missing' ||
      snakeSelected.kind === 'malformed'
    ) {
      return snakeSelected;
    }
    if (
      monetaryAmountOf(camelSelected) !== monetaryAmountOf(snakeSelected)
    ) {
      return { kind: 'malformed' };
    }
    gross = camelSelected;
  } else if (camel.status !== 'absent') {
    const selected = fieldToSelected(camel)!;
    if (selected.kind === 'missing' || selected.kind === 'malformed') {
      return selected;
    }
    gross = selected;
  } else if (snake.status !== 'absent') {
    const selected = fieldToSelected(snake)!;
    if (selected.kind === 'missing' || selected.kind === 'malformed') {
      return selected;
    }
    gross = selected;
  }

  // B. effectiveLineTotal is net/paid — EXACT inequality triggers allocation proof.
  if (effective.status !== 'absent') {
    const effSelected = fieldToSelected(effective)!;
    if (effSelected.kind === 'missing' || effSelected.kind === 'malformed') {
      return effSelected;
    }

    if (gross != null) {
      const grossAmt = monetaryAmountOf(gross);
      const effAmt = monetaryAmountOf(effSelected);
      if (grossAmt !== effAmt) {
        if (!isValidPersistedDiscountExplanation(item, grossAmt, effAmt)) {
          return { kind: 'malformed' };
        }
      }
    }

    return effSelected;
  }

  if (gross != null) return gross;
  return { kind: 'missing' };
}

/**
 * PRE-NORMALIZATION source completeness against receipt.analysis_json.items.
 * Must run before discount allocation / bundle.items can rewrite null→0.
 */
function assessOriginalOcrItemMonetaryCompleteness(
  receipt: ReceiptRow
): AuthoritativeItemSideResult {
  const analysis = parseAnalysisJson(receipt);
  const rawItems = analysis?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return {
      complete: false,
      reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
      evidence: ['original_ocr_item_basket_empty'],
    };
  }

  let hasPositive = false;
  const evidence: string[] = [
    'original_ocr_pre_normalization_completeness_check',
  ];

  for (let i = 0; i < rawItems.length; i += 1) {
    const raw = rawItems[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        complete: false,
        reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
        evidence: [
          ...evidence,
          `original_ocr_item_index_${i}_malformed_row`,
        ],
      };
    }
    const selected = resolveOriginalOcrItemMonetaryEvidence(
      raw as Record<string, unknown>
    );
    if (selected.kind === 'missing' || selected.kind === 'malformed') {
      return {
        complete: false,
        reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
        evidence: [
          ...evidence,
          `original_ocr_item_index_${i}_selected_amount=${selected.kind}`,
        ],
      };
    }
    if (selected.kind === 'valid_positive') {
      hasPositive = true;
      evidence.push(
        `original_ocr_item_index_${i}_selected_amount=valid_positive`
      );
    } else {
      evidence.push(
        `original_ocr_item_index_${i}_selected_amount=explicit_zero`
      );
    }
  }

  if (!hasPositive) {
    return {
      complete: false,
      reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
      evidence: [
        ...evidence,
        'original_ocr_no_strictly_positive_selected_item_amount',
      ],
    };
  }

  return {
    complete: true,
    itemSide: 0,
    hasPositive: true,
    evidence,
  };
}

function hasActiveDiscountAllocation(item: DiscountableItem): boolean {
  const allocated = Number(item.discountAllocated);
  return Number.isFinite(allocated) && allocated !== 0;
}

/**
 * Local mirror of production stale-effective detection — read-only, no production mutation.
 */
function isStaleEffectiveAfterUserLineEdit(item: DiscountableItem): boolean {
  if (hasActiveDiscountAllocation(item)) return false;
  const row = item as Record<string, unknown>;
  const camel = readPresentMonetaryField(row, 'lineTotal');
  const effective = readPresentMonetaryField(row, 'effectiveLineTotal');
  if (camel.status !== 'valid_positive' && camel.status !== 'explicit_zero') {
    return false;
  }
  if (
    effective.status !== 'valid_positive' &&
    effective.status !== 'explicit_zero'
  ) {
    return false;
  }
  const camelAmount = camel.status === 'explicit_zero' ? 0 : camel.amount;
  const effectiveAmount =
    effective.status === 'explicit_zero' ? 0 : effective.amount;
  if (camelAmount === effectiveAmount) return false;
  const snake = readPresentMonetaryField(row, 'line_total');
  if (snake.status !== 'valid_positive' && snake.status !== 'explicit_zero') {
    return false;
  }
  const snakeAmount = snake.status === 'explicit_zero' ? 0 : snake.amount;
  return snakeAmount === effectiveAmount && camelAmount !== snakeAmount;
}

/**
 * Resolve the monetary amount that would be selected for analytics/closure,
 * without collapsing missing/null into numeric zero.
 *
 * Precedence mirrors itemAmountForAnalytics:
 * 1) Explicit user amount override (amountUserEdited or stale-alias heal) → gross
 * 2) effectiveLineTotal when PRESENT and defensible
 * 3) gross lineTotal / line_total
 */
export function resolveSelectedItemMonetaryAmount(
  item: DiscountableItem
): SelectedItemMonetaryAmount {
  const row = item as Record<string, unknown>;

  const resolveGross = (): SelectedItemMonetaryAmount => {
    const camel = fieldToSelected(readPresentMonetaryField(row, 'lineTotal'));
    if (camel) return camel;
    const snake = fieldToSelected(readPresentMonetaryField(row, 'line_total'));
    if (snake) return snake;
    return { kind: 'missing' };
  };

  if (item.amountUserEdited === true || isStaleEffectiveAfterUserLineEdit(item)) {
    return resolveGross();
  }

  const effective = fieldToSelected(
    readPresentMonetaryField(row, 'effectiveLineTotal')
  );
  if (effective) return effective;

  return resolveGross();
}

function assessAuthoritativeItemSide(
  items: readonly DiscountableItem[]
): AuthoritativeItemSideResult {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      complete: false,
      reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
      evidence: ['authoritative_item_basket_empty'],
    };
  }

  let sum = 0;
  let hasPositive = false;
  const evidence: string[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const selected = resolveSelectedItemMonetaryAmount(items[i]!);
    if (selected.kind === 'missing' || selected.kind === 'malformed') {
      return {
        complete: false,
        reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
        evidence: [
          ...evidence,
          `item_index_${i}_selected_amount=${selected.kind}`,
        ],
      };
    }
    if (selected.kind === 'valid_positive') {
      hasPositive = true;
      sum += selected.amount;
      evidence.push(`item_index_${i}_selected_amount=valid_positive`);
    } else {
      evidence.push(`item_index_${i}_selected_amount=explicit_zero`);
    }
  }

  if (!hasPositive) {
    return {
      complete: false,
      reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
      evidence: [
        ...evidence,
        'no_strictly_positive_selected_item_amount',
      ],
    };
  }

  return {
    complete: true,
    itemSide: roundMoney(sum),
    hasPositive: true,
    evidence,
  };
}

function assessUserItemsItemSide(
  receipt: ReceiptRow
): AuthoritativeItemSideResult {
  const raw = receipt.user_items_json;
  if (raw == null || typeof raw !== 'string' || !raw.trim()) {
    return {
      complete: false,
      reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
      evidence: ['user_items_unavailable'],
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        complete: false,
        reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
        evidence: ['user_items_not_array'],
      };
    }
    return assessAuthoritativeItemSide(
      parsed.map((row) =>
        row && typeof row === 'object'
          ? (row as DiscountableItem)
          : ({} as DiscountableItem)
      )
    );
  } catch {
    return {
      complete: false,
      reasonCodes: ['incomplete_authoritative_item_monetary_evidence'],
      evidence: ['user_items_json_malformed'],
    };
  }
}

export type SameLayerClosureAssessment = {
  state: MonetaryCoherenceState;
  hypothesis: string | null;
  evidence: string[];
  reasonCodes: string[];
};

type ArithmeticClosureAttempt = {
  closes: boolean;
  hypothesis: string | null;
  itemSide: number;
  remainder: number;
  paidTotal: number;
  trustedTax: number | null;
};

function trySameLayerArithmeticClosure(
  itemSide: number,
  remainder: number,
  paidTotal: number,
  trustedTax: number | null
): ArithmeticClosureAttempt {
  // H1 — tax included
  const taxIncluded = roundMoney(itemSide + remainder);
  if (moneyClose(taxIncluded, paidTotal)) {
    return {
      closes: true,
      hypothesis: 'tax_included_item_side_plus_remainder',
      itemSide,
      remainder,
      paidTotal,
      trustedTax,
    };
  }

  // H2 — tax excluded, only with trusted finite positive tax
  if (trustedTax != null) {
    const taxExcluded = roundMoney(itemSide + remainder + trustedTax);
    if (moneyClose(taxExcluded, paidTotal)) {
      return {
        closes: true,
        hypothesis: 'tax_excluded_item_side_plus_remainder_plus_trusted_tax',
        itemSide,
        remainder,
        paidTotal,
        trustedTax,
      };
    }
  }

  return {
    closes: false,
    hypothesis: null,
    itemSide,
    remainder,
    paidTotal,
    trustedTax,
  };
}

function appendOcrMetadataReasonCodes(
  reasonCodes: string[],
  ocrFlags: { reconciliationOk: boolean | null; amountMismatch: boolean | null },
  arithmeticCloses: boolean
): void {
  if (arithmeticCloses) return;
  if (ocrFlags.reconciliationOk === false) {
    reasonCodes.push('ocr_reconciliation_not_ok');
  }
  if (ocrFlags.amountMismatch === true) {
    reasonCodes.push('ocr_amount_mismatch');
  }
  if (
    ocrFlags.reconciliationOk === true &&
    ocrFlags.amountMismatch === false
  ) {
    reasonCodes.push('ocr_reconciliation_metadata_contradicts_arithmetic');
  }
}

function assessOcrSameLayerClosure(
  bundle: ReceiptMonetarySourceBundle,
  receipt: ReceiptRow,
  ocrFlags: { reconciliationOk: boolean | null; amountMismatch: boolean | null }
): SameLayerClosureAssessment {
  const evidence: string[] = ['authoritative_monetary_layer=ocr'];
  const reasonCodes: string[] = [];

  const paidTotal = bundle.paidTotal;
  if (!hasFinitePositive(paidTotal)) {
    return {
      state: 'unknown',
      hypothesis: null,
      evidence,
      reasonCodes: ['ocr_paid_total_not_positive_finite'],
    };
  }

  // B. PRE-NORMALIZATION: original analysis_json.items must be complete.
  // Allocation may rewrite Number(null)→0; that must never wash missing evidence.
  const originalCompleteness = assessOriginalOcrItemMonetaryCompleteness(receipt);
  evidence.push(...originalCompleteness.evidence);
  if (!originalCompleteness.complete) {
    return {
      state: 'unknown',
      hypothesis: null,
      evidence,
      reasonCodes: [
        ...reasonCodes,
        ...originalCompleteness.reasonCodes,
      ],
    };
  }

  // C. POST-NORMALIZATION: authoritative bundle item side
  const itemSideResult = assessAuthoritativeItemSide(bundle.items);
  evidence.push(...itemSideResult.evidence);

  if (!itemSideResult.complete) {
    return {
      state: 'unknown',
      hypothesis: null,
      evidence,
      reasonCodes: [
        ...reasonCodes,
        ...itemSideResult.reasonCodes,
      ],
    };
  }

  const remainder = bundle.receiptLevelUnallocatedDiscountTotal;
  const trustedTax = trustedPositiveTax(receipt);
  const attempt = trySameLayerArithmeticClosure(
    itemSideResult.itemSide,
    remainder,
    paidTotal,
    trustedTax
  );

  evidence.push(
    `item_side=${attempt.itemSide}`,
    `remainder=${attempt.remainder}`,
    `paid_total=${attempt.paidTotal}`
  );
  if (attempt.trustedTax != null) {
    evidence.push(`trusted_tax=${attempt.trustedTax}`);
  }

  if (attempt.closes) {
    return {
      state: 'known_coherent',
      hypothesis: attempt.hypothesis,
      evidence,
      reasonCodes,
    };
  }

  appendOcrMetadataReasonCodes(reasonCodes, ocrFlags, false);

  return {
    state: 'known_incoherent',
    hypothesis: null,
    evidence,
    reasonCodes: [
      ...reasonCodes,
      'ocr_same_layer_arithmetic_does_not_close',
    ],
  };
}

function assessUserSameLayerClosure(
  bundle: ReceiptMonetarySourceBundle,
  receipt: ReceiptRow
): SameLayerClosureAssessment {
  const evidence: string[] = ['authoritative_monetary_layer=user'];
  const reasonCodes: string[] = [];

  const paidTotal =
    receipt.final_total != null && Number.isFinite(Number(receipt.final_total))
      ? Number(receipt.final_total)
      : null;

  if (paidTotal == null) {
    return {
      state: 'unknown',
      hypothesis: null,
      evidence,
      reasonCodes: ['user_same_layer_closure_inputs_incomplete'],
    };
  }

  if (!hasFinitePositive(paidTotal)) {
    return {
      state: 'unknown',
      hypothesis: null,
      evidence,
      reasonCodes: ['user_paid_total_not_positive_finite'],
    };
  }

  const itemSideResult = assessUserItemsItemSide(receipt);
  evidence.push(...itemSideResult.evidence);

  if (!itemSideResult.complete) {
    return {
      state: 'unknown',
      hypothesis: null,
      evidence,
      reasonCodes: [
        ...reasonCodes,
        ...itemSideResult.reasonCodes,
      ],
    };
  }

  const remainder = bundle.receiptLevelUnallocatedDiscountTotal;
  // USER and OCR share H1/H2 — pass trusted positive tax into shared evaluator.
  // Stale OCR reconciliation / amount_mismatch are intentionally ignored here.
  const trustedTax = trustedPositiveTax(receipt);
  const attempt = trySameLayerArithmeticClosure(
    itemSideResult.itemSide,
    remainder,
    paidTotal,
    trustedTax
  );

  evidence.push(
    `user_items_sum=${attempt.itemSide}`,
    `remainder=${attempt.remainder}`,
    `final_total=${attempt.paidTotal}`
  );
  if (attempt.trustedTax != null) {
    evidence.push(`trusted_tax=${attempt.trustedTax}`);
  }

  if (attempt.closes) {
    return {
      state: 'known_coherent',
      hypothesis: attempt.hypothesis,
      evidence,
      reasonCodes,
    };
  }

  return {
    state: 'known_incoherent',
    hypothesis: null,
    evidence,
    reasonCodes: ['user_same_layer_arithmetic_does_not_close'],
  };
}

export function assessSameLayerMonetaryClosure(
  receipt: ReceiptRow,
  bundle: ReceiptMonetarySourceBundle,
  ocrFlags: { reconciliationOk: boolean | null; amountMismatch: boolean | null }
): SameLayerClosureAssessment {
  if (!bundle.coherent || bundle.layer == null) {
    const substantiveIncoherentCodes = bundle.reasonCodes.filter(
      (code) =>
        code !== 'monetary_source_incoherent' &&
        code !== 'user_edited_flag_without_monetary_layers'
    );
    const legacyUserEditOnly =
      substantiveIncoherentCodes.length === 1 &&
      substantiveIncoherentCodes[0] === 'inconsistent_legacy_user_edit_metadata';

    if (legacyUserEditOnly) {
      return assessOcrSameLayerClosure(
        rebuildLegacyUserEditOcrBundle(receipt),
        receipt,
        ocrFlags
      );
    }

    return {
      state: 'known_incoherent',
      hypothesis: null,
      evidence: [],
      reasonCodes: ['monetary_source_bundle_incoherent'],
    };
  }

  if (bundle.layer === 'user') {
    return assessUserSameLayerClosure(bundle, receipt);
  }

  return assessOcrSameLayerClosure(bundle, receipt, ocrFlags);
}
