/**
 * G3-1 — Item-level price observation truth (pure projection).
 * Preserves gross / effective / discount / promo facts before index collapse.
 */

import {
  isStaleEffectiveAfterUserLineEdit,
  type DiscountableItem,
} from './receiptDiscountAllocation';
import {
  sanitizeEvidenceCaptureVersion,
  sanitizePromoMarkers,
} from './receiptPrintedEvidence';

export const PRICE_OBSERVATION_VERSION = 1 as const;

const AMOUNT_TOLERANCE = 0.01;

export type PriceAmountProvenance =
  | 'ocr_observed'
  | 'user_corrected'
  | 'user_entered'
  | 'legacy_user_override'
  | 'unknown';

export type PriceItemAmountState =
  | 'coherent'
  | 'selected_only'
  | 'conflict'
  | 'missing';

export type PricePromoContext =
  | 'explicit_discount'
  | 'qualitative_marker'
  | 'explicit_discount_and_marker'
  | 'none_observed'
  | 'unknown';

export type PriceObservationTruth = {
  version: typeof PRICE_OBSERVATION_VERSION;
  selectedLineAmount: number | null;
  /** Observed amount before explicitly item-bound discount. NOT a regular/list-price claim. */
  grossLineAmount: number | null;
  effectiveLineAmount: number | null;
  discountAllocated: number | null;
  purchaseQuantity: number | null;
  grossUnitPrice: number | null;
  effectiveUnitPrice: number | null;
  amountProvenance: PriceAmountProvenance;
  amountState: PriceItemAmountState;
  promoMarkers: string[];
  promoContext: PricePromoContext;
  evidenceCaptureVersion: 1 | null;
};

export type BuildPriceObservationTruthInput = {
  item: Record<string, unknown>;
  evidenceCaptureVersion?: 1 | null;
};

type NumericFieldRead =
  | { present: false; valid: false; value: null }
  | { present: true; valid: true; value: number }
  | { present: true; valid: false; value: null };

type GrossAliasRead = {
  gross: number | null;
  aliasConflict: boolean;
};

type DiscountFieldRead = {
  present: boolean;
  conflict: boolean;
  value: number | null;
};

type EffectiveFieldRead = {
  present: boolean;
  conflict: boolean;
  value: number | null;
};

type ResolvedOcrTuple = {
  grossLineAmount: number | null;
  effectiveLineAmount: number | null;
  discountAllocated: number | null;
  selectedLineAmount: number | null;
  amountState: PriceItemAmountState;
};

function resolvePurchaseQuantityForTruth(value: unknown): number | null {
  if (value == null) return 1;
  if (typeof value === 'string' && value.trim() === '') return 1;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function hasOwn(item: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(item, key);
}

function amountsEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= AMOUNT_TOLERANCE;
}

function readStrictNonNegativeAmountField(
  item: Record<string, unknown>,
  key: string
): NumericFieldRead {
  if (!hasOwn(item, key)) {
    return { present: false, valid: false, value: null };
  }
  const value = item[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { present: true, valid: false, value: null };
  }
  return { present: true, valid: true, value };
}

function readGrossAliases(item: Record<string, unknown>): GrossAliasRead {
  const camel = readStrictNonNegativeAmountField(item, 'lineTotal');
  const snake = readStrictNonNegativeAmountField(item, 'line_total');

  if (!camel.present && !snake.present) {
    return { gross: null, aliasConflict: false };
  }
  if (camel.present && !camel.valid) {
    return { gross: null, aliasConflict: true };
  }
  if (snake.present && !snake.valid) {
    return { gross: null, aliasConflict: true };
  }
  if (camel.valid && snake.valid) {
    if (!amountsEqual(camel.value, snake.value)) {
      return { gross: null, aliasConflict: true };
    }
    return { gross: camel.value, aliasConflict: false };
  }
  if (camel.valid) return { gross: camel.value, aliasConflict: false };
  if (snake.valid) return { gross: snake.value, aliasConflict: false };
  return { gross: null, aliasConflict: true };
}

function readEffectiveField(item: Record<string, unknown>): EffectiveFieldRead {
  if (!hasOwn(item, 'effectiveLineTotal')) {
    return { present: false, conflict: false, value: null };
  }
  const value = item.effectiveLineTotal;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { present: true, conflict: true, value: null };
  }
  return { present: true, conflict: false, value };
}

function readDiscountField(item: Record<string, unknown>): DiscountFieldRead {
  if (!hasOwn(item, 'discountAllocated')) {
    return { present: false, conflict: false, value: null };
  }
  const value = item.discountAllocated;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { present: true, conflict: true, value: null };
  }
  if (value > 0) {
    return { present: true, conflict: true, value: null };
  }
  return { present: true, conflict: false, value };
}

function legacyStaleAliasDetectorPreconditionsMet(
  lineTotal: NumericFieldRead,
  lineTotalSnake: NumericFieldRead,
  effective: EffectiveFieldRead,
  discount: DiscountFieldRead
): boolean {
  if (lineTotal.present && !lineTotal.valid) return false;
  if (lineTotalSnake.present && !lineTotalSnake.valid) return false;
  if (effective.present && effective.conflict) return false;
  if (discount.present && discount.conflict) return false;
  return true;
}

function hasExplicitProductDiscountFromRead(
  discountRead: DiscountFieldRead
): boolean {
  return (
    discountRead.present &&
    !discountRead.conflict &&
    discountRead.value != null &&
    discountRead.value < 0
  );
}

function unitPriceFromAmount(
  amount: number | null,
  quantity: number | null
): number | null {
  if (amount == null || quantity == null || quantity <= 0) return null;
  return amount / quantity;
}

function resolvePromoContext(args: {
  discountRead: DiscountFieldRead;
  hasMarkers: boolean;
  evidenceCaptureVersion: 1 | null;
  absenceEvidenceApplicable: boolean;
}): PricePromoContext {
  const hasExplicitDiscount = hasExplicitProductDiscountFromRead(args.discountRead);
  if (hasExplicitDiscount && args.hasMarkers) {
    return 'explicit_discount_and_marker';
  }
  if (hasExplicitDiscount) return 'explicit_discount';
  if (args.hasMarkers) return 'qualitative_marker';
  if (args.discountRead.conflict) return 'unknown';
  if (!args.absenceEvidenceApplicable) return 'unknown';
  if (args.evidenceCaptureVersion === 1) {
    const discountAbsent = !args.discountRead.present;
    const discountValidZero =
      args.discountRead.present &&
      !args.discountRead.conflict &&
      args.discountRead.value === 0;
    if (discountAbsent || discountValidZero) {
      return 'none_observed';
    }
  }
  return 'unknown';
}

function defensibleConflictSelectedAmount(
  item: Record<string, unknown>
): number | null {
  const effective = readStrictNonNegativeAmountField(item, 'effectiveLineTotal');
  if (effective.valid) return effective.value;
  const gross = readGrossAliases(item);
  if (gross.aliasConflict) return null;
  return gross.gross;
}

function readStrictUserAuthoritativeAmount(
  item: Record<string, unknown>
): number | null {
  const camel = readStrictNonNegativeAmountField(item, 'lineTotal');
  if (camel.valid) return camel.value;
  return null;
}

function readUserEnteredAmount(item: Record<string, unknown>): number | null {
  const effective = readStrictNonNegativeAmountField(item, 'effectiveLineTotal');
  if (effective.valid) return effective.value;
  const gross = readGrossAliases(item);
  if (gross.aliasConflict) return null;
  return gross.gross;
}

function hasAnyAmountField(item: Record<string, unknown>): boolean {
  return (
    hasOwn(item, 'lineTotal') ||
    hasOwn(item, 'line_total') ||
    hasOwn(item, 'effectiveLineTotal') ||
    hasOwn(item, 'discountAllocated')
  );
}

function resolveOcrMonetaryTuple(item: Record<string, unknown>): ResolvedOcrTuple {
  const grossRead = readGrossAliases(item);
  const effectiveRead = readEffectiveField(item);
  const discountRead = readDiscountField(item);

  if (grossRead.aliasConflict || effectiveRead.conflict || discountRead.conflict) {
    return {
      grossLineAmount: grossRead.gross,
      effectiveLineAmount: effectiveRead.value,
      discountAllocated: discountRead.present ? discountRead.value : null,
      selectedLineAmount: defensibleConflictSelectedAmount(item),
      amountState: 'conflict',
    };
  }

  const gross = grossRead.gross;
  let effective = effectiveRead.value;
  const discountAllocated = discountRead.present ? discountRead.value : null;
  const hasNegativeDiscount = hasExplicitProductDiscountFromRead(discountRead);

  if (gross == null && effective == null) {
    return {
      grossLineAmount: null,
      effectiveLineAmount: null,
      discountAllocated,
      selectedLineAmount: null,
      amountState: 'missing',
    };
  }

  if (gross == null && effective != null) {
    return {
      grossLineAmount: null,
      effectiveLineAmount: effective,
      discountAllocated: null,
      selectedLineAmount: effective,
      amountState: 'selected_only',
    };
  }

  if (gross != null && effective != null && !hasNegativeDiscount) {
    if (!amountsEqual(gross, effective)) {
      return {
        grossLineAmount: gross,
        effectiveLineAmount: effective,
        discountAllocated,
        selectedLineAmount: defensibleConflictSelectedAmount(item),
        amountState: 'conflict',
      };
    }
  }

  if (gross != null && effective == null && !hasNegativeDiscount) {
    effective = gross;
  }

  if (gross != null && effective == null && hasNegativeDiscount && discountAllocated != null) {
    const derived = gross + discountAllocated;
    if (derived < 0) {
      return {
        grossLineAmount: gross,
        effectiveLineAmount: null,
        discountAllocated,
        selectedLineAmount: defensibleConflictSelectedAmount(item),
        amountState: 'conflict',
      };
    }
    effective = derived;
  }

  if (
    gross != null &&
    effective != null &&
    hasNegativeDiscount &&
    discountAllocated != null &&
    !amountsEqual(gross + discountAllocated, effective)
  ) {
    return {
      grossLineAmount: gross,
      effectiveLineAmount: effective,
      discountAllocated,
      selectedLineAmount: defensibleConflictSelectedAmount(item),
      amountState: 'conflict',
    };
  }

  const selected = effective ?? gross;
  if (selected == null) {
    return {
      grossLineAmount: gross,
      effectiveLineAmount: effective,
      discountAllocated,
      selectedLineAmount: null,
      amountState: 'missing',
    };
  }

  return {
    grossLineAmount: gross,
    effectiveLineAmount: effective,
    discountAllocated,
    selectedLineAmount: selected,
    amountState: 'coherent',
  };
}

function finalizeTruth(
  partial: Omit<
    PriceObservationTruth,
    'version' | 'grossUnitPrice' | 'effectiveUnitPrice' | 'promoContext'
  > & { evidenceCaptureVersion: 1 | null },
  options?: {
    promoContextOverride?: PricePromoContext;
    absenceEvidenceApplicable?: boolean;
    discountRead?: DiscountFieldRead;
  }
): PriceObservationTruth {
  const discountRead =
    options?.discountRead ?? ({ present: false, conflict: false, value: null } as const);
  const promoContext =
    options?.promoContextOverride ??
    resolvePromoContext({
      discountRead,
      hasMarkers: partial.promoMarkers.length > 0,
      evidenceCaptureVersion: partial.evidenceCaptureVersion,
      absenceEvidenceApplicable: options?.absenceEvidenceApplicable ?? true,
    });
  return {
    version: PRICE_OBSERVATION_VERSION,
    ...partial,
    grossUnitPrice: unitPriceFromAmount(
      partial.grossLineAmount,
      partial.purchaseQuantity
    ),
    effectiveUnitPrice: unitPriceFromAmount(
      partial.effectiveLineAmount,
      partial.purchaseQuantity
    ),
    promoContext,
  };
}

/** Parse receipt-level G1-1 capture version from analysis_json root (fail-closed). */
export function parseReceiptEvidenceCaptureVersion(
  analysisJson: string | null | undefined
): 1 | null {
  if (!analysisJson?.trim()) return null;
  try {
    const parsed = JSON.parse(analysisJson) as Record<string, unknown>;
    return sanitizeEvidenceCaptureVersion(parsed.evidenceCaptureVersion) ?? null;
  } catch {
    return null;
  }
}

/**
 * Deterministic item-level price observation truth.
 * Does not mutate input; does not apply analytics zero fallback.
 */
export function buildPriceObservationTruth(
  input: BuildPriceObservationTruthInput
): PriceObservationTruth {
  const item = input.item;
  const evidenceCaptureVersion = input.evidenceCaptureVersion ?? null;
  const promoMarkers = sanitizePromoMarkers(item.promoMarkers) ?? [];
  const purchaseQuantity = resolvePurchaseQuantityForTruth(item.quantity);
  const userAbsenceEvidence = false;
  const camelLineTotal = readStrictNonNegativeAmountField(item, 'lineTotal');
  const snakeLineTotal = readStrictNonNegativeAmountField(item, 'line_total');
  const effectiveRead = readEffectiveField(item);
  const discountRead = readDiscountField(item);
  const finalizeOptions = { discountRead };

  if (item.amountUserEdited === true) {
    const selected = readStrictUserAuthoritativeAmount(item);
    return finalizeTruth(
      {
        selectedLineAmount: selected,
        grossLineAmount: null,
        effectiveLineAmount: selected,
        discountAllocated: null,
        purchaseQuantity,
        amountProvenance: 'user_corrected',
        amountState: selected != null ? 'selected_only' : 'missing',
        promoMarkers,
        evidenceCaptureVersion,
      },
      { ...finalizeOptions, absenceEvidenceApplicable: userAbsenceEvidence }
    );
  }

  if (item.user_added === true) {
    const selected = readUserEnteredAmount(item);
    return finalizeTruth(
      {
        selectedLineAmount: selected,
        grossLineAmount: null,
        effectiveLineAmount: selected,
        discountAllocated: null,
        purchaseQuantity,
        amountProvenance: 'user_entered',
        amountState: selected != null ? 'selected_only' : 'missing',
        promoMarkers,
        evidenceCaptureVersion,
      },
      { ...finalizeOptions, absenceEvidenceApplicable: userAbsenceEvidence }
    );
  }

  if (
    legacyStaleAliasDetectorPreconditionsMet(
      camelLineTotal,
      snakeLineTotal,
      effectiveRead,
      discountRead
    ) &&
    isStaleEffectiveAfterUserLineEdit(item as DiscountableItem)
  ) {
    const selected = readStrictUserAuthoritativeAmount(item);
    return finalizeTruth(
      {
        selectedLineAmount: selected,
        grossLineAmount: null,
        effectiveLineAmount: selected,
        discountAllocated: null,
        purchaseQuantity,
        amountProvenance: 'legacy_user_override',
        amountState: selected != null ? 'selected_only' : 'missing',
        promoMarkers,
        evidenceCaptureVersion,
      },
      { ...finalizeOptions, absenceEvidenceApplicable: userAbsenceEvidence }
    );
  }

  if (!hasAnyAmountField(item)) {
    return finalizeTruth(
      {
        selectedLineAmount: null,
        grossLineAmount: null,
        effectiveLineAmount: null,
        discountAllocated: null,
        purchaseQuantity,
        amountProvenance: 'unknown',
        amountState: 'missing',
        promoMarkers,
        evidenceCaptureVersion,
      },
      finalizeOptions
    );
  }

  const tuple = resolveOcrMonetaryTuple(item);
  return finalizeTruth(
    {
      selectedLineAmount: tuple.selectedLineAmount,
      grossLineAmount: tuple.grossLineAmount,
      effectiveLineAmount: tuple.effectiveLineAmount,
      discountAllocated: tuple.discountAllocated,
      purchaseQuantity,
      amountProvenance: 'ocr_observed',
      amountState: tuple.amountState,
      promoMarkers,
      evidenceCaptureVersion,
    },
    finalizeOptions
  );
}
