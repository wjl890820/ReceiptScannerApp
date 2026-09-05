/**
 * AP-3 candidate rejection funnel — count-only, privacy-safe diagnostics.
 * Does not change candidate selection semantics.
 */

import type { ProductPriceChangeUnavailableReason } from './productPriceChangeInterpretation';
import type { ProductPriceHistoryStatus } from './productPriceHistory';
import { recordDiagnosticEvent } from './internalDiagnostics';

export type Ap3SkuTerminal =
  | 'bucket_lt_2'
  | 'interpret_unavailable'
  | 'unchanged'
  | 'changed'
  | 'exception';

export type Ap3MpTerminal =
  | 'bucket_lt_2'
  | 'missing_identity_view'
  | 'interpret_unavailable'
  | 'unchanged'
  | 'approval_rejected'
  | 'changed'
  | 'exception';

/** mpChanged = successfully constructed BEFORE duplicate-of-SKU suppression. */
export type Ap3CandidateFunnelCounts = {
  seededSkuCount: number;
  seededMpCount: number;

  skuAttempted: number;
  skuBucketLt2: number;
  skuInterpretUnavailable: number;
  skuUnchanged: number;
  skuChanged: number;
  skuException: number;

  mpAttempted: number;
  mpBucketLt2: number;
  mpMissingIdentityView: number;
  mpInterpretUnavailable: number;
  mpUnchanged: number;
  mpApprovalRejected: number;
  /** Constructed OK before duplicate suppression. */
  mpChanged: number;
  mpException: number;
  /** Subset of mpChanged suppressed by SKU duplication. */
  mpDuplicateOfSku: number;

  finalCandidateCount: number;

  skuReasonHistoryNotReady: number;
  skuReasonSeriesNotGross: number;
  skuReasonDuplicateSelectionUnconfirmed: number;
  skuReasonIdentityNotExact: number;
  skuReasonQualityNotTrusted: number;
  skuReasonNotEnoughDistinctPurchaseEvents: number;
  skuReasonAmbiguousSameTimestamp: number;
  skuReasonPriceKindMismatch: number;
  skuReasonAmountBasisMismatch: number;
  skuReasonInvalidPrice: number;
  skuReasonUnsafeSameReceiptAggregation: number;
  skuReasonInvalidTimestamp: number;
  skuReasonLatestPurchaseNotComparable: number;
  skuReasonPurchaseObservationHistoryIncomplete: number;

  mpReasonHistoryNotReady: number;
  mpReasonSeriesNotGross: number;
  mpReasonDuplicateSelectionUnconfirmed: number;
  mpReasonIdentityNotExact: number;
  mpReasonQualityNotTrusted: number;
  mpReasonNotEnoughDistinctPurchaseEvents: number;
  mpReasonAmbiguousSameTimestamp: number;
  mpReasonPriceKindMismatch: number;
  mpReasonAmountBasisMismatch: number;
  mpReasonInvalidPrice: number;
  mpReasonUnsafeSameReceiptAggregation: number;
  mpReasonInvalidTimestamp: number;
  mpReasonLatestPurchaseNotComparable: number;
  mpReasonPurchaseObservationHistoryIncomplete: number;

  /** When interpret primary reason is history_not_ready — history.status allowlist. */
  skuHistNotEnoughPoints: number;
  skuHistUnsupportedFamily: number;
  skuHistNoComparableSpec: number;
  skuHistAmbiguousDimension: number;
  skuHistMixedCurrency: number;
  skuHistUnknownCurrency: number;

  mpHistNotEnoughPoints: number;
  mpHistUnsupportedFamily: number;
  mpHistNoComparableSpec: number;
  mpHistAmbiguousDimension: number;
  mpHistMixedCurrency: number;
  mpHistUnknownCurrency: number;
};

const INTERPRET_REASON_TO_SKU_FIELD: Record<
  ProductPriceChangeUnavailableReason,
  keyof Ap3CandidateFunnelCounts
> = {
  history_not_ready: 'skuReasonHistoryNotReady',
  series_not_gross: 'skuReasonSeriesNotGross',
  duplicate_selection_unconfirmed: 'skuReasonDuplicateSelectionUnconfirmed',
  identity_not_exact: 'skuReasonIdentityNotExact',
  quality_not_trusted: 'skuReasonQualityNotTrusted',
  not_enough_distinct_purchase_events:
    'skuReasonNotEnoughDistinctPurchaseEvents',
  ambiguous_same_timestamp: 'skuReasonAmbiguousSameTimestamp',
  price_kind_mismatch: 'skuReasonPriceKindMismatch',
  amount_basis_mismatch: 'skuReasonAmountBasisMismatch',
  invalid_price: 'skuReasonInvalidPrice',
  unsafe_same_receipt_aggregation: 'skuReasonUnsafeSameReceiptAggregation',
  invalid_timestamp: 'skuReasonInvalidTimestamp',
  latest_purchase_not_comparable: 'skuReasonLatestPurchaseNotComparable',
  purchase_observation_history_incomplete:
    'skuReasonPurchaseObservationHistoryIncomplete',
};

const INTERPRET_REASON_TO_MP_FIELD: Record<
  ProductPriceChangeUnavailableReason,
  keyof Ap3CandidateFunnelCounts
> = {
  history_not_ready: 'mpReasonHistoryNotReady',
  series_not_gross: 'mpReasonSeriesNotGross',
  duplicate_selection_unconfirmed: 'mpReasonDuplicateSelectionUnconfirmed',
  identity_not_exact: 'mpReasonIdentityNotExact',
  quality_not_trusted: 'mpReasonQualityNotTrusted',
  not_enough_distinct_purchase_events:
    'mpReasonNotEnoughDistinctPurchaseEvents',
  ambiguous_same_timestamp: 'mpReasonAmbiguousSameTimestamp',
  price_kind_mismatch: 'mpReasonPriceKindMismatch',
  amount_basis_mismatch: 'mpReasonAmountBasisMismatch',
  invalid_price: 'mpReasonInvalidPrice',
  unsafe_same_receipt_aggregation: 'mpReasonUnsafeSameReceiptAggregation',
  invalid_timestamp: 'mpReasonInvalidTimestamp',
  latest_purchase_not_comparable: 'mpReasonLatestPurchaseNotComparable',
  purchase_observation_history_incomplete:
    'mpReasonPurchaseObservationHistoryIncomplete',
};

const HISTORY_STATUS_TO_SKU_FIELD: Partial<
  Record<ProductPriceHistoryStatus, keyof Ap3CandidateFunnelCounts>
> = {
  not_enough_points: 'skuHistNotEnoughPoints',
  unsupported_family: 'skuHistUnsupportedFamily',
  no_comparable_spec: 'skuHistNoComparableSpec',
  ambiguous_dimension: 'skuHistAmbiguousDimension',
  mixed_currency: 'skuHistMixedCurrency',
  unknown_currency: 'skuHistUnknownCurrency',
};

const HISTORY_STATUS_TO_MP_FIELD: Partial<
  Record<ProductPriceHistoryStatus, keyof Ap3CandidateFunnelCounts>
> = {
  not_enough_points: 'mpHistNotEnoughPoints',
  unsupported_family: 'mpHistUnsupportedFamily',
  no_comparable_spec: 'mpHistNoComparableSpec',
  ambiguous_dimension: 'mpHistAmbiguousDimension',
  mixed_currency: 'mpHistMixedCurrency',
  unknown_currency: 'mpHistUnknownCurrency',
};

export function createEmptyAp3CandidateFunnel(): Ap3CandidateFunnelCounts {
  return {
    seededSkuCount: 0,
    seededMpCount: 0,
    skuAttempted: 0,
    skuBucketLt2: 0,
    skuInterpretUnavailable: 0,
    skuUnchanged: 0,
    skuChanged: 0,
    skuException: 0,
    mpAttempted: 0,
    mpBucketLt2: 0,
    mpMissingIdentityView: 0,
    mpInterpretUnavailable: 0,
    mpUnchanged: 0,
    mpApprovalRejected: 0,
    mpChanged: 0,
    mpException: 0,
    mpDuplicateOfSku: 0,
    finalCandidateCount: 0,
    skuReasonHistoryNotReady: 0,
    skuReasonSeriesNotGross: 0,
    skuReasonDuplicateSelectionUnconfirmed: 0,
    skuReasonIdentityNotExact: 0,
    skuReasonQualityNotTrusted: 0,
    skuReasonNotEnoughDistinctPurchaseEvents: 0,
    skuReasonAmbiguousSameTimestamp: 0,
    skuReasonPriceKindMismatch: 0,
    skuReasonAmountBasisMismatch: 0,
    skuReasonInvalidPrice: 0,
    skuReasonUnsafeSameReceiptAggregation: 0,
    skuReasonInvalidTimestamp: 0,
    skuReasonLatestPurchaseNotComparable: 0,
    skuReasonPurchaseObservationHistoryIncomplete: 0,
    mpReasonHistoryNotReady: 0,
    mpReasonSeriesNotGross: 0,
    mpReasonDuplicateSelectionUnconfirmed: 0,
    mpReasonIdentityNotExact: 0,
    mpReasonQualityNotTrusted: 0,
    mpReasonNotEnoughDistinctPurchaseEvents: 0,
    mpReasonAmbiguousSameTimestamp: 0,
    mpReasonPriceKindMismatch: 0,
    mpReasonAmountBasisMismatch: 0,
    mpReasonInvalidPrice: 0,
    mpReasonUnsafeSameReceiptAggregation: 0,
    mpReasonInvalidTimestamp: 0,
    mpReasonLatestPurchaseNotComparable: 0,
    mpReasonPurchaseObservationHistoryIncomplete: 0,
    skuHistNotEnoughPoints: 0,
    skuHistUnsupportedFamily: 0,
    skuHistNoComparableSpec: 0,
    skuHistAmbiguousDimension: 0,
    skuHistMixedCurrency: 0,
    skuHistUnknownCurrency: 0,
    mpHistNotEnoughPoints: 0,
    mpHistUnsupportedFamily: 0,
    mpHistNoComparableSpec: 0,
    mpHistAmbiguousDimension: 0,
    mpHistMixedCurrency: 0,
    mpHistUnknownCurrency: 0,
  };
}

export function recordAp3SkuTerminal(
  funnel: Ap3CandidateFunnelCounts,
  terminal: Ap3SkuTerminal
): void {
  funnel.skuAttempted += 1;
  switch (terminal) {
    case 'bucket_lt_2':
      funnel.skuBucketLt2 += 1;
      break;
    case 'interpret_unavailable':
      funnel.skuInterpretUnavailable += 1;
      break;
    case 'unchanged':
      funnel.skuUnchanged += 1;
      break;
    case 'changed':
      funnel.skuChanged += 1;
      break;
    case 'exception':
      funnel.skuException += 1;
      break;
  }
}

export function recordAp3MpTerminal(
  funnel: Ap3CandidateFunnelCounts,
  terminal: Ap3MpTerminal
): void {
  funnel.mpAttempted += 1;
  switch (terminal) {
    case 'bucket_lt_2':
      funnel.mpBucketLt2 += 1;
      break;
    case 'missing_identity_view':
      funnel.mpMissingIdentityView += 1;
      break;
    case 'interpret_unavailable':
      funnel.mpInterpretUnavailable += 1;
      break;
    case 'unchanged':
      funnel.mpUnchanged += 1;
      break;
    case 'approval_rejected':
      funnel.mpApprovalRejected += 1;
      break;
    case 'changed':
      funnel.mpChanged += 1;
      break;
    case 'exception':
      funnel.mpException += 1;
      break;
  }
}

/**
 * Count primary (first) unavailable reason only — deterministic.
 */
export function recordAp3InterpretUnavailableReasons(
  funnel: Ap3CandidateFunnelCounts,
  kind: 'sku' | 'mp',
  reasonCodes: readonly ProductPriceChangeUnavailableReason[],
  historyStatus: ProductPriceHistoryStatus | null
): void {
  const primary = reasonCodes[0];
  if (!primary) return;
  const map =
    kind === 'sku' ? INTERPRET_REASON_TO_SKU_FIELD : INTERPRET_REASON_TO_MP_FIELD;
  const field = map[primary];
  if (field) funnel[field] += 1;

  if (primary === 'history_not_ready' && historyStatus) {
    const histMap =
      kind === 'sku' ? HISTORY_STATUS_TO_SKU_FIELD : HISTORY_STATUS_TO_MP_FIELD;
    const histField = histMap[historyStatus];
    if (histField) funnel[histField] += 1;
  }
}

export function assertAp3CandidateFunnelInvariants(
  funnel: Ap3CandidateFunnelCounts
): boolean {
  const skuSum =
    funnel.skuBucketLt2 +
    funnel.skuInterpretUnavailable +
    funnel.skuUnchanged +
    funnel.skuChanged +
    funnel.skuException;
  if (funnel.skuAttempted !== skuSum) return false;

  const mpSum =
    funnel.mpBucketLt2 +
    funnel.mpMissingIdentityView +
    funnel.mpInterpretUnavailable +
    funnel.mpUnchanged +
    funnel.mpApprovalRejected +
    funnel.mpChanged +
    funnel.mpException;
  if (funnel.mpAttempted !== mpSum) return false;

  if (funnel.mpDuplicateOfSku > funnel.mpChanged) return false;

  const expectedFinal =
    funnel.skuChanged + (funnel.mpChanged - funnel.mpDuplicateOfSku);
  if (funnel.finalCandidateCount !== expectedFinal) return false;

  return true;
}

function pickMeta(
  funnel: Ap3CandidateFunnelCounts,
  keys: readonly (keyof Ap3CandidateFunnelCounts)[]
): Record<string, number> {
  const meta: Record<string, number> = {};
  for (const key of keys) {
    meta[key] = funnel[key];
  }
  return meta;
}

const FUNNEL_CORE_KEYS = [
  'seededSkuCount',
  'seededMpCount',
  'skuAttempted',
  'skuBucketLt2',
  'skuInterpretUnavailable',
  'skuUnchanged',
  'skuChanged',
  'skuException',
  'mpAttempted',
  'mpBucketLt2',
  'mpMissingIdentityView',
  'mpInterpretUnavailable',
  'mpUnchanged',
  'mpApprovalRejected',
  'mpChanged',
  'mpException',
  'mpDuplicateOfSku',
  'finalCandidateCount',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_SKU_REASON_KEYS = [
  'skuReasonHistoryNotReady',
  'skuReasonSeriesNotGross',
  'skuReasonDuplicateSelectionUnconfirmed',
  'skuReasonIdentityNotExact',
  'skuReasonQualityNotTrusted',
  'skuReasonNotEnoughDistinctPurchaseEvents',
  'skuReasonAmbiguousSameTimestamp',
  'skuReasonPriceKindMismatch',
  'skuReasonAmountBasisMismatch',
  'skuReasonInvalidPrice',
  'skuReasonUnsafeSameReceiptAggregation',
  'skuReasonInvalidTimestamp',
  'skuReasonLatestPurchaseNotComparable',
  'skuReasonPurchaseObservationHistoryIncomplete',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_MP_REASON_KEYS = [
  'mpReasonHistoryNotReady',
  'mpReasonSeriesNotGross',
  'mpReasonDuplicateSelectionUnconfirmed',
  'mpReasonIdentityNotExact',
  'mpReasonQualityNotTrusted',
  'mpReasonNotEnoughDistinctPurchaseEvents',
  'mpReasonAmbiguousSameTimestamp',
  'mpReasonPriceKindMismatch',
  'mpReasonAmountBasisMismatch',
  'mpReasonInvalidPrice',
  'mpReasonUnsafeSameReceiptAggregation',
  'mpReasonInvalidTimestamp',
  'mpReasonLatestPurchaseNotComparable',
  'mpReasonPurchaseObservationHistoryIncomplete',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_HISTORY_KEYS = [
  'skuHistNotEnoughPoints',
  'skuHistUnsupportedFamily',
  'skuHistNoComparableSpec',
  'skuHistAmbiguousDimension',
  'skuHistMixedCurrency',
  'skuHistUnknownCurrency',
  'mpHistNotEnoughPoints',
  'mpHistUnsupportedFamily',
  'mpHistNoComparableSpec',
  'mpHistAmbiguousDimension',
  'mpHistMixedCurrency',
  'mpHistUnknownCurrency',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

/**
 * Emit completed funnel as core + companion reason/history events
 * (Internal Diagnostics meta key budget = 24).
 */
export function emitAp3CandidateFunnel(funnel: Ap3CandidateFunnelCounts): void {
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_CORE_KEYS),
  });
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_sku_reasons',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_SKU_REASON_KEYS),
  });
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_mp_reasons',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_MP_REASON_KEYS),
  });
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_history',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_HISTORY_KEYS),
  });
}
