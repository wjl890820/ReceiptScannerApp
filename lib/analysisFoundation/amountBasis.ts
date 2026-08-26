/**
 * A1.2 / A1.2.1 — Receipt amount tax-basis assessment (read-only).
 *
 * Uses a coherent monetary source bundle (items + discounts + total).
 * Does NOT invent per-item tax normalization from receipt.tax ratios.
 */

import type { ReceiptRow } from '../db';
import type {
  AmountBasisConfidence,
  AmountTaxBasis,
  ExactPriceAmountEvidence,
  MonetaryObservation,
  ReceiptAmountBasisAssessment,
  TaxProvenanceTrust,
} from './types';
import {
  bundleHasMeaningfulItemMonetaryEvidence,
  hasFinitePositive,
  resolveReceiptMonetarySourceBundle,
  sumBundleAnalyticsItemAmounts,
} from './monetarySourceBundle';

/**
 * Reuse receiptTotalResolve's yen tolerance default (2 JPY).
 * Fixed absolute yen — do not scale with item count.
 */
export const AMOUNT_BASIS_TOLERANCE_JPY = 2;

/** Exact price comparison requires high confidence + trusted tax provenance. */
export const EXACT_PRICE_AMOUNT_BASIS_MIN_CONFIDENCE: AmountBasisConfidence =
  'high';

export type AssessReceiptAmountBasisOptions = {
  toleranceJpy?: number;
};

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function moneyClose(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function readReceiptTax(receipt: ReceiptRow): number | null {
  const tax = Number(receipt.tax);
  if (!Number.isFinite(tax)) return null;
  return tax;
}

function resolveTaxProvenance(receipt: ReceiptRow): TaxProvenanceTrust {
  return receipt.tax_is_known === 1 ? 'trusted' : 'untrusted';
}

/**
 * Whether amount-basis evidence is trusted enough for exact price comparison.
 * Known basis alone is insufficient — confidence + tax provenance must pass.
 */
export function isExactPriceAmountEvidenceTrusted(
  evidence: ExactPriceAmountEvidence | null | undefined
): boolean {
  if (!evidence) return false;
  if (evidence.basis !== 'tax_included' && evidence.basis !== 'tax_excluded') {
    return false;
  }
  if (evidence.confidence !== 'high') return false;
  if (evidence.taxProvenance !== 'trusted') return false;
  return true;
}

export function exactPriceAmountEvidenceFromAssessment(
  assessment: ReceiptAmountBasisAssessment
): ExactPriceAmountEvidence {
  return {
    basis: assessment.basis,
    confidence: assessment.confidence,
    taxProvenance: assessment.taxProvenance,
  };
}

/**
 * Pairwise exact-comparison amount-basis gate.
 * Missing / unknown / untrusted evidence → amount_basis_unknown.
 * Different known bases → amount_basis_mismatch.
 */
export function evaluateExactPriceAmountBasisGate(
  self: ExactPriceAmountEvidence | null | undefined,
  peer: ExactPriceAmountEvidence | null | undefined
):
  | { pass: true; reason: 'ok' }
  | {
      pass: false;
      reason: 'amount_basis_unknown' | 'amount_basis_mismatch';
    } {
  if (!isExactPriceAmountEvidenceTrusted(self)) {
    return { pass: false, reason: 'amount_basis_unknown' };
  }
  if (!isExactPriceAmountEvidenceTrusted(peer)) {
    return { pass: false, reason: 'amount_basis_unknown' };
  }
  if (self!.basis !== peer!.basis) {
    return { pass: false, reason: 'amount_basis_mismatch' };
  }
  return { pass: true, reason: 'ok' };
}

/**
 * Conservative receipt-level tax-basis inference (A1.2.1).
 */
export function assessReceiptAmountBasis(
  receipt: ReceiptRow,
  opts?: AssessReceiptAmountBasisOptions
): ReceiptAmountBasisAssessment {
  const tol = opts?.toleranceJpy ?? AMOUNT_BASIS_TOLERANCE_JPY;
  const receiptId = receipt.id;
  const receiptTax = readReceiptTax(receipt);
  const taxProvenance = resolveTaxProvenance(receipt);
  const bundle = resolveReceiptMonetarySourceBundle(receipt);

  const evidence: string[] = [
    ...bundle.evidence,
    `tolerance_jpy=${tol}`,
    `tax_provenance=${taxProvenance}`,
  ];
  const reasonCodes: string[] = [...bundle.reasonCodes];

  const unknownResult = (
    extraReasons: string[],
    fields: {
      receiptTotal: number;
      analyticsItemSum: number;
      unallocatedDiscountTotal: number;
      expectedTotalIfTaxIncluded: number | null;
      expectedTotalIfTaxExcluded: number | null;
    }
  ): ReceiptAmountBasisAssessment => ({
    receiptId,
    basis: 'unknown',
    receiptTotal: fields.receiptTotal,
    receiptTax,
    analyticsItemSum: fields.analyticsItemSum,
    unallocatedDiscountTotal: fields.unallocatedDiscountTotal,
    expectedTotalIfTaxIncluded: fields.expectedTotalIfTaxIncluded,
    expectedTotalIfTaxExcluded: fields.expectedTotalIfTaxExcluded,
    confidence: 'unknown',
    taxProvenance,
    exactComparisonTrusted: false,
    evidence: [...evidence, ...extraReasons.map((r) => `reason=${r}`)],
    reasonCodes: [...reasonCodes, ...extraReasons],
  });

  if (!bundle.coherent || bundle.paidTotal == null) {
    return unknownResult(['monetary_source_incoherent'], {
      receiptTotal: 0,
      analyticsItemSum: 0,
      unallocatedDiscountTotal: 0,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: null,
    });
  }

  if (bundle.discountReconciliationAmbiguous) {
    return unknownResult(['aggregate_discount_summary_ambiguous'], {
      receiptTotal: bundle.paidTotal,
      analyticsItemSum: sumBundleAnalyticsItemAmounts(bundle.items),
      unallocatedDiscountTotal: bundle.receiptLevelUnallocatedDiscountTotal,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: null,
    });
  }

  const receiptTotal = bundle.paidTotal;
  const analyticsItemSum =
    bundle.analyticsItemSumOverride != null
      ? bundle.analyticsItemSumOverride
      : sumBundleAnalyticsItemAmounts(bundle.items);
  const unallocatedDiscountTotal = bundle.receiptLevelUnallocatedDiscountTotal;
  const reconciledSide = roundMoney(analyticsItemSum + unallocatedDiscountTotal);

  evidence.push(
    `analytics_item_sum=${analyticsItemSum}`,
    `unallocated_discount_total=${unallocatedDiscountTotal}`,
    `reconciled_item_side=${reconciledSide}`,
    `paid_total=${receiptTotal}`
  );

  if (!hasFinitePositive(receiptTotal)) {
    return unknownResult(['invalid_authoritative_total'], {
      receiptTotal,
      analyticsItemSum,
      unallocatedDiscountTotal,
      expectedTotalIfTaxIncluded: reconciledSide,
      expectedTotalIfTaxExcluded: null,
    });
  }

  if (!bundleHasMeaningfulItemMonetaryEvidence(bundle.items)) {
    return unknownResult(['missing_item_monetary_evidence'], {
      receiptTotal,
      analyticsItemSum,
      unallocatedDiscountTotal,
      expectedTotalIfTaxIncluded: reconciledSide,
      expectedTotalIfTaxExcluded: null,
    });
  }

  if (!Number.isFinite(reconciledSide)) {
    return unknownResult(['invalid_monetary_evidence'], {
      receiptTotal,
      analyticsItemSum,
      unallocatedDiscountTotal,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: null,
    });
  }

  // Untrusted tax must not authorize a known basis for exact comparison.
  if (taxProvenance !== 'trusted') {
    return unknownResult(['tax_untrusted'], {
      receiptTotal,
      analyticsItemSum,
      unallocatedDiscountTotal,
      expectedTotalIfTaxIncluded: reconciledSide,
      expectedTotalIfTaxExcluded:
        receiptTax != null && receiptTax > 0
          ? roundMoney(reconciledSide + receiptTax)
          : null,
    });
  }

  const taxPositive =
    receiptTax != null && Number.isFinite(receiptTax) && receiptTax > 0;

  const expectedTotalIfTaxIncluded = reconciledSide;
  const expectedTotalIfTaxExcluded = taxPositive
    ? roundMoney(reconciledSide + (receiptTax as number))
    : null;

  evidence.push(
    `expected_if_tax_included=${expectedTotalIfTaxIncluded}`,
    `expected_if_tax_excluded=${
      expectedTotalIfTaxExcluded == null ? 'n/a' : expectedTotalIfTaxExcluded
    }`
  );

  if (!taxPositive) {
    return unknownResult(['tax_non_positive_cannot_discriminate'], {
      receiptTotal,
      analyticsItemSum,
      unallocatedDiscountTotal,
      expectedTotalIfTaxIncluded,
      expectedTotalIfTaxExcluded,
    });
  }

  const includedCloses = moneyClose(
    expectedTotalIfTaxIncluded,
    receiptTotal,
    tol
  );
  const excludedCloses = moneyClose(
    expectedTotalIfTaxExcluded!,
    receiptTotal,
    tol
  );

  if (includedCloses) evidence.push('tax_included_equation_closes');
  if (excludedCloses) evidence.push('tax_excluded_equation_closes');

  if (includedCloses && excludedCloses) {
    return unknownResult(['ambiguous_both_hypotheses_close'], {
      receiptTotal,
      analyticsItemSum,
      unallocatedDiscountTotal,
      expectedTotalIfTaxIncluded,
      expectedTotalIfTaxExcluded,
    });
  }

  if (!includedCloses && !excludedCloses) {
    return unknownResult(['neither_hypothesis_closes'], {
      receiptTotal,
      analyticsItemSum,
      unallocatedDiscountTotal,
      expectedTotalIfTaxIncluded,
      expectedTotalIfTaxExcluded,
    });
  }

  const basis: AmountTaxBasis = includedCloses
    ? 'tax_included'
    : 'tax_excluded';
  evidence.push(`inferred_basis=${basis}`);

  let confidence: AmountBasisConfidence = 'high';
  if (Math.abs(unallocatedDiscountTotal) > tol) {
    confidence = 'medium';
    evidence.push('unallocated_discount_present');
  }

  const exactComparisonTrusted =
    confidence === 'high' &&
    taxProvenance === 'trusted' &&
    (basis === 'tax_included' || basis === 'tax_excluded');

  return {
    receiptId,
    basis,
    receiptTotal,
    receiptTax,
    analyticsItemSum,
    unallocatedDiscountTotal,
    expectedTotalIfTaxIncluded,
    expectedTotalIfTaxExcluded,
    confidence,
    taxProvenance,
    exactComparisonTrusted,
    evidence,
    reasonCodes,
  };
}

export function assessReceiptAmountBasisForAll(
  receipts: ReceiptRow[],
  opts?: AssessReceiptAmountBasisOptions
): ReceiptAmountBasisAssessment[] {
  return receipts
    .map((r) => assessReceiptAmountBasis(r, opts))
    .sort((a, b) => a.receiptId.localeCompare(b.receiptId));
}

/**
 * Per-item monetary view. Without reliable item-level tax-rate evidence,
 * only maps known amount onto the matching side; alternate side stays null.
 */
export function buildMonetaryObservation(input: {
  rawAmount: number;
  effectiveAmount: number;
  taxBasis: AmountTaxBasis;
  itemTaxRatePercent?: number | null;
  confidence?: AmountBasisConfidence;
}): MonetaryObservation {
  const evidence: string[] = ['no_proportional_receipt_tax_split'];
  const conf = input.confidence ?? 'unknown';
  const rate =
    typeof input.itemTaxRatePercent === 'number' &&
    Number.isFinite(input.itemTaxRatePercent) &&
    input.itemTaxRatePercent > 0
      ? input.itemTaxRatePercent
      : null;

  let normalizedGrossAmount: number | null = null;
  let normalizedNetAmount: number | null = null;

  if (input.taxBasis === 'tax_included') {
    normalizedGrossAmount = input.effectiveAmount;
    evidence.push('known_amount_is_tax_included_gross');
    if (rate != null) {
      normalizedNetAmount = roundMoney(
        input.effectiveAmount / (1 + rate / 100)
      );
      evidence.push(`derived_net_from_item_tax_rate=${rate}`);
    } else {
      evidence.push('normalized_net_null_without_item_tax_rate');
    }
  } else if (input.taxBasis === 'tax_excluded') {
    normalizedNetAmount = input.effectiveAmount;
    evidence.push('known_amount_is_tax_excluded_net');
    if (rate != null) {
      normalizedGrossAmount = roundMoney(
        input.effectiveAmount * (1 + rate / 100)
      );
      evidence.push(`derived_gross_from_item_tax_rate=${rate}`);
    } else {
      evidence.push('normalized_gross_null_without_item_tax_rate');
    }
  } else {
    evidence.push('tax_basis_unknown_no_normalization');
  }

  return {
    rawAmount: input.rawAmount,
    effectiveAmount: input.effectiveAmount,
    taxBasis: input.taxBasis,
    normalizedGrossAmount,
    normalizedNetAmount,
    confidence: input.taxBasis === 'unknown' ? 'unknown' : conf,
    evidence,
  };
}
