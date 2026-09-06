/**
 * AP-3 candidate rejection funnel — count-only, privacy-safe diagnostics.
 * Does not change candidate selection semantics.
 */

import type { ProductPriceChangeUnavailableReason } from './productPriceChangeInterpretation';
import type {
  ProductPriceHistoryResult,
  ProductPriceHistoryRow,
  ProductPriceHistoryStatus,
  ReceiptEvidenceCache,
} from './productPriceHistory';
import type { ReceiptAmountBasisAssessment } from './analysisFoundation/types';
import type { ReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/types';
import { recordDiagnosticEvent } from './internalDiagnostics';
import { isInternalDiagnosticsEnabled } from './internalDiagnosticsGate';
import { resolveReceiptTax } from './receiptOcrNormalize';
import type { ReceiptAnalysis } from './receiptAnalyzer';

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

  /**
   * Cohort: membershipRows >= 2 AND history.status === not_enough_points.
   * Summary + observation-reason companions (see emitAp3CandidateFunnel).
   */
  mpHistoryTargetCount: number;
  mpHistoryMembershipRowsTotal: number;
  mpHistoryIdentityRowsTotal: number;
  mpHistoryTotalObservations: number;
  mpHistoryLevel2EligibleObservations: number;
  mpHistoryRejectedObservations: number;
  mpHistoryComparablePoints: number;
  mpHistoryTargetsIdentityRows0: number;
  mpHistoryTargetsIdentityRows1: number;
  mpHistoryTargetsIdentityRows2Plus: number;
  mpHistoryTargetsWith0ComparablePoints: number;
  mpHistoryTargetsWith1ComparablePoints: number;
  mpHistoryTargetsWith2PlusComparablePoints: number;

  /**
   * Multi-label observation-hit counts for level2RejectReasons.
   * SUM(reason counters) is NOT required to equal mpHistoryRejectedObservations.
   */
  mpObsLegacyUnbackfilled: number;
  mpObsPriceObservationVersion: number;
  mpObsItemAmountEvidenceState: number;
  mpObsInvalidGrossAmount: number;
  mpObsInvalidQuantity: number;
  mpObsCurrencyNotJpy: number;
  mpObsAmountBasisUntrusted: number;
  mpObsMonetaryIncoherent: number;
  mpObsMonetaryProvenanceInsufficient: number;
  mpObsDiscountOwnershipUnresolved: number;
  mpObsPriceQualityInvalid: number;
  mpObsPriceQualitySuspectedAnomaly: number;
  mpObsAmountBasisMismatch: number;
  mpObsMissingObservation: number;
  /** Count of unrecognized reason entries only — never emits the raw string. */
  mpObsUnknownRejectReason: number;

  /**
   * Amount-basis breakdown for observations in the not_enough_points cohort
   * that carry level2RejectReasons amount_basis_untrusted.
   * Reads prepared receiptEvidenceCache assessments only — no re-assess.
   */
  mpBasisCohortTargetCount: number;
  mpBasisTargetsWithUntrustedObservation: number;
  mpBasisUntrustedObservationCount: number;
  mpBasisAssessmentMissing: number;
  mpBasisTaxIncluded: number;
  mpBasisTaxExcluded: number;
  mpBasisUnknown: number;
  mpBasisConfidenceHigh: number;
  mpBasisConfidenceMedium: number;
  mpBasisConfidenceLow: number;
  mpBasisConfidenceUnknown: number;
  mpBasisTaxProvenanceTrusted: number;
  mpBasisTaxProvenanceUntrusted: number;
  mpBasisExactTrustedTrue: number;
  mpBasisExactTrustedFalse: number;
  mpBasisKnownButUntrusted: number;
  mpBasisKnownConfidenceMedium: number;
  mpBasisKnownConfidenceLow: number;
  mpBasisKnownConfidenceUnknown: number;

  /**
   * Multi-label reasonCodes hits from amountBasisAssessment.
   * SUM(reason counters) is NOT required to equal observation count.
   */
  mpBasisReasonObservationCount: number;
  mpBasisReasonTaxUntrusted: number;
  mpBasisReasonTaxNonPositive: number;
  mpBasisReasonMonetarySourceIncoherent: number;
  mpBasisReasonAggregateDiscountAmbiguous: number;
  mpBasisReasonInvalidAuthoritativeTotal: number;
  mpBasisReasonMissingItemMonetaryEvidence: number;
  mpBasisReasonInvalidMonetaryEvidence: number;
  mpBasisReasonAmbiguousBothHypotheses: number;
  mpBasisReasonNeitherHypothesisCloses: number;
  mpBasisReasonMalformedUserItems: number;
  mpBasisReasonUserItemsWithoutTotal: number;
  mpBasisReasonFinalTotalWithoutItems: number;
  mpBasisReasonLegacyEditMetadata: number;
  mpBasisReasonDiscountOwnershipUnresolved: number;
  mpBasisReasonInsufficientReallocationEvidence: number;
  mpBasisReasonPersistedDiscountInconsistent: number;
  mpBasisReasonNoReasonCodes: number;
  mpBasisReasonUnknown: number;

  /**
   * Monetary layer shape for amount_basis_untrusted observations.
   * Reads membership-row receiptUserEdited / userItems / finalTotal only.
   */
  mpLayerObservationCount: number;
  mpLayerUserEdited1: number;
  mpLayerUserEdited0: number;
  mpLayerHasUserItems: number;
  mpLayerNoUserItems: number;
  mpLayerHasFinalTotal: number;
  mpLayerNoFinalTotal: number;
  mpLayerEditedNoItemsNoTotal: number;
  mpLayerEditedItemsNoTotal: number;
  mpLayerEditedNoItemsHasTotal: number;
  mpLayerEditedItemsAndTotal: number;
  mpLayerNotEditedNoItemsNoTotal: number;
  mpLayerNotEditedItemsOrTotal: number;
  mpLayerMalformedUserItems: number;

  /**
   * Tax provenance shape for tax_untrusted observations inside the
   * not_enough_points + amount_basis_untrusted cohort.
   * Diagnostics-only; reuses production resolveReceiptTax without mutation.
   */
  mpTaxCohortTargetCount: number;
  mpTaxObservationCount: number;
  mpTaxPersistedKnown1: number;
  mpTaxPersistedKnown0: number;
  mpTaxStoredPositive: number;
  mpTaxStoredZero: number;
  mpTaxStoredOther: number;
  mpTaxAnalysisMarkerTrue: number;
  mpTaxAnalysisMarkerFalse: number;
  mpTaxAnalysisMarkerMissing: number;
  mpTaxAnalysisResolvedKnown: number;
  mpTaxAnalysisResolvedUnknown: number;
  mpTaxAnalysisUnavailable: number;
  mpTaxAnalysisResolvedKnownPositive: number;
  mpTaxAnalysisResolvedKnownNonPositive: number;
  mpTaxSnapshotResolvedKnown: number;
  mpTaxSnapshotResolvedUnknown: number;
  mpTaxSnapshotUnavailable: number;
  mpTaxPersisted0AnalysisKnown: number;
  mpTaxPersisted0AnalysisUnknown: number;
  mpTaxAnalysisUnknownSnapshotKnown: number;
  mpTaxAnalysisUnknownSnapshotUnknown: number;
  mpTaxAnalysisUnknownSnapshotUnavailable: number;

  /**
   * Neither-hypothesis-closes shape (NEP + amount_basis_untrusted cohort).
   * Diagnostics-only; reads cached AmountBasisAssessment numeric fields.
   */
  mpNeitherTargetCount: number;
  mpNeitherObservationCount: number;
  mpNeitherClosestResidualLe3: number;
  mpNeitherClosestResidual4To5: number;
  mpNeitherClosestResidual6To10: number;
  mpNeitherClosestResidual11To50: number;
  mpNeitherClosestResidualGt50: number;
  mpNeitherClosestResidualUnavailable: number;
  mpNeitherIncludedCloser: number;
  mpNeitherExcludedCloser: number;
  mpNeitherEqualResidual: number;
  mpNeitherResidualComparisonUnavailable: number;
  /** Orthogonal: MonetaryCoherenceEvidence.state */
  mpNeitherMonetaryStateCoherent: number;
  mpNeitherMonetaryStateIncoherent: number;
  mpNeitherMonetaryStateUnknown: number;
  /** Orthogonal: MonetaryCoherenceEvidence.monetaryProvenanceSufficient */
  mpNeitherMonetaryProvenanceSufficient: number;
  mpNeitherMonetaryProvenanceInsufficient: number;
  mpNeitherRemainderZero: number;
  mpNeitherRemainderNonZero: number;
  mpNeitherRemainderUnavailable: number;
  /** From cached monetaryCoherenceEvidence.authoritativeLayer only. */
  mpNeitherLayerOcr: number;
  mpNeitherLayerUser: number;
  mpNeitherLayerUnknown: number;
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
    mpHistoryTargetCount: 0,
    mpHistoryMembershipRowsTotal: 0,
    mpHistoryIdentityRowsTotal: 0,
    mpHistoryTotalObservations: 0,
    mpHistoryLevel2EligibleObservations: 0,
    mpHistoryRejectedObservations: 0,
    mpHistoryComparablePoints: 0,
    mpHistoryTargetsIdentityRows0: 0,
    mpHistoryTargetsIdentityRows1: 0,
    mpHistoryTargetsIdentityRows2Plus: 0,
    mpHistoryTargetsWith0ComparablePoints: 0,
    mpHistoryTargetsWith1ComparablePoints: 0,
    mpHistoryTargetsWith2PlusComparablePoints: 0,
    mpObsLegacyUnbackfilled: 0,
    mpObsPriceObservationVersion: 0,
    mpObsItemAmountEvidenceState: 0,
    mpObsInvalidGrossAmount: 0,
    mpObsInvalidQuantity: 0,
    mpObsCurrencyNotJpy: 0,
    mpObsAmountBasisUntrusted: 0,
    mpObsMonetaryIncoherent: 0,
    mpObsMonetaryProvenanceInsufficient: 0,
    mpObsDiscountOwnershipUnresolved: 0,
    mpObsPriceQualityInvalid: 0,
    mpObsPriceQualitySuspectedAnomaly: 0,
    mpObsAmountBasisMismatch: 0,
    mpObsMissingObservation: 0,
    mpObsUnknownRejectReason: 0,
    mpBasisCohortTargetCount: 0,
    mpBasisTargetsWithUntrustedObservation: 0,
    mpBasisUntrustedObservationCount: 0,
    mpBasisAssessmentMissing: 0,
    mpBasisTaxIncluded: 0,
    mpBasisTaxExcluded: 0,
    mpBasisUnknown: 0,
    mpBasisConfidenceHigh: 0,
    mpBasisConfidenceMedium: 0,
    mpBasisConfidenceLow: 0,
    mpBasisConfidenceUnknown: 0,
    mpBasisTaxProvenanceTrusted: 0,
    mpBasisTaxProvenanceUntrusted: 0,
    mpBasisExactTrustedTrue: 0,
    mpBasisExactTrustedFalse: 0,
    mpBasisKnownButUntrusted: 0,
    mpBasisKnownConfidenceMedium: 0,
    mpBasisKnownConfidenceLow: 0,
    mpBasisKnownConfidenceUnknown: 0,
    mpBasisReasonObservationCount: 0,
    mpBasisReasonTaxUntrusted: 0,
    mpBasisReasonTaxNonPositive: 0,
    mpBasisReasonMonetarySourceIncoherent: 0,
    mpBasisReasonAggregateDiscountAmbiguous: 0,
    mpBasisReasonInvalidAuthoritativeTotal: 0,
    mpBasisReasonMissingItemMonetaryEvidence: 0,
    mpBasisReasonInvalidMonetaryEvidence: 0,
    mpBasisReasonAmbiguousBothHypotheses: 0,
    mpBasisReasonNeitherHypothesisCloses: 0,
    mpBasisReasonMalformedUserItems: 0,
    mpBasisReasonUserItemsWithoutTotal: 0,
    mpBasisReasonFinalTotalWithoutItems: 0,
    mpBasisReasonLegacyEditMetadata: 0,
    mpBasisReasonDiscountOwnershipUnresolved: 0,
    mpBasisReasonInsufficientReallocationEvidence: 0,
    mpBasisReasonPersistedDiscountInconsistent: 0,
    mpBasisReasonNoReasonCodes: 0,
    mpBasisReasonUnknown: 0,
    mpLayerObservationCount: 0,
    mpLayerUserEdited1: 0,
    mpLayerUserEdited0: 0,
    mpLayerHasUserItems: 0,
    mpLayerNoUserItems: 0,
    mpLayerHasFinalTotal: 0,
    mpLayerNoFinalTotal: 0,
    mpLayerEditedNoItemsNoTotal: 0,
    mpLayerEditedItemsNoTotal: 0,
    mpLayerEditedNoItemsHasTotal: 0,
    mpLayerEditedItemsAndTotal: 0,
    mpLayerNotEditedNoItemsNoTotal: 0,
    mpLayerNotEditedItemsOrTotal: 0,
    mpLayerMalformedUserItems: 0,
    mpTaxCohortTargetCount: 0,
    mpTaxObservationCount: 0,
    mpTaxPersistedKnown1: 0,
    mpTaxPersistedKnown0: 0,
    mpTaxStoredPositive: 0,
    mpTaxStoredZero: 0,
    mpTaxStoredOther: 0,
    mpTaxAnalysisMarkerTrue: 0,
    mpTaxAnalysisMarkerFalse: 0,
    mpTaxAnalysisMarkerMissing: 0,
    mpTaxAnalysisResolvedKnown: 0,
    mpTaxAnalysisResolvedUnknown: 0,
    mpTaxAnalysisUnavailable: 0,
    mpTaxAnalysisResolvedKnownPositive: 0,
    mpTaxAnalysisResolvedKnownNonPositive: 0,
    mpTaxSnapshotResolvedKnown: 0,
    mpTaxSnapshotResolvedUnknown: 0,
    mpTaxSnapshotUnavailable: 0,
    mpTaxPersisted0AnalysisKnown: 0,
    mpTaxPersisted0AnalysisUnknown: 0,
    mpTaxAnalysisUnknownSnapshotKnown: 0,
    mpTaxAnalysisUnknownSnapshotUnknown: 0,
    mpTaxAnalysisUnknownSnapshotUnavailable: 0,
    mpNeitherTargetCount: 0,
    mpNeitherObservationCount: 0,
    mpNeitherClosestResidualLe3: 0,
    mpNeitherClosestResidual4To5: 0,
    mpNeitherClosestResidual6To10: 0,
    mpNeitherClosestResidual11To50: 0,
    mpNeitherClosestResidualGt50: 0,
    mpNeitherClosestResidualUnavailable: 0,
    mpNeitherIncludedCloser: 0,
    mpNeitherExcludedCloser: 0,
    mpNeitherEqualResidual: 0,
    mpNeitherResidualComparisonUnavailable: 0,
    mpNeitherMonetaryStateCoherent: 0,
    mpNeitherMonetaryStateIncoherent: 0,
    mpNeitherMonetaryStateUnknown: 0,
    mpNeitherMonetaryProvenanceSufficient: 0,
    mpNeitherMonetaryProvenanceInsufficient: 0,
    mpNeitherRemainderZero: 0,
    mpNeitherRemainderNonZero: 0,
    mpNeitherRemainderUnavailable: 0,
    mpNeitherLayerOcr: 0,
    mpNeitherLayerUser: 0,
    mpNeitherLayerUnknown: 0,
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

  return (
    assertAp3MpHistoryComparabilityInvariants(funnel) &&
    assertAp3MpAmountBasisInvariants(funnel) &&
    assertAp3MpNeitherCloseInvariants(funnel)
  );
}

/**
 * Cohort accounting for membership>=2 && not_enough_points breakdown.
 * Rejection-reason counters are multi-label and are intentionally excluded
 * from sum-equality checks against rejectedObservations.
 */
export function assertAp3MpHistoryComparabilityInvariants(
  funnel: Ap3CandidateFunnelCounts
): boolean {
  const identityBucketSum =
    funnel.mpHistoryTargetsIdentityRows0 +
    funnel.mpHistoryTargetsIdentityRows1 +
    funnel.mpHistoryTargetsIdentityRows2Plus;
  if (funnel.mpHistoryTargetCount !== identityBucketSum) return false;

  const comparableBucketSum =
    funnel.mpHistoryTargetsWith0ComparablePoints +
    funnel.mpHistoryTargetsWith1ComparablePoints +
    funnel.mpHistoryTargetsWith2PlusComparablePoints;
  if (funnel.mpHistoryTargetCount !== comparableBucketSum) return false;

  if (
    funnel.mpHistoryTotalObservations !==
    funnel.mpHistoryLevel2EligibleObservations +
      funnel.mpHistoryRejectedObservations
  ) {
    return false;
  }

  // Cohort is not_enough_points only — 2+ points flags instrumentation drift.
  if (funnel.mpHistoryTargetsWith2PlusComparablePoints !== 0) return false;

  return true;
}

/**
 * Amount-basis untrusted-observation partitions.
 * Multi-label reason counters are intentionally excluded from sum checks.
 * exactTrustedTrue > 0 is contract drift (should be 0 for amount_basis_untrusted).
 */
export function assertAp3MpAmountBasisInvariants(
  funnel: Ap3CandidateFunnelCounts
): boolean {
  const n = funnel.mpBasisUntrustedObservationCount;
  if (
    n !==
    funnel.mpBasisAssessmentMissing +
      funnel.mpBasisTaxIncluded +
      funnel.mpBasisTaxExcluded +
      funnel.mpBasisUnknown
  ) {
    return false;
  }
  if (
    n !==
    funnel.mpBasisAssessmentMissing +
      funnel.mpBasisConfidenceHigh +
      funnel.mpBasisConfidenceMedium +
      funnel.mpBasisConfidenceLow +
      funnel.mpBasisConfidenceUnknown
  ) {
    return false;
  }
  if (
    n !==
    funnel.mpBasisAssessmentMissing +
      funnel.mpBasisTaxProvenanceTrusted +
      funnel.mpBasisTaxProvenanceUntrusted
  ) {
    return false;
  }
  if (
    n !==
    funnel.mpBasisAssessmentMissing +
      funnel.mpBasisExactTrustedTrue +
      funnel.mpBasisExactTrustedFalse
  ) {
    return false;
  }
  // Drift signal only — callers must void-assert, never throw into product.
  if (funnel.mpBasisExactTrustedTrue !== 0) return false;
  return (
    assertAp3MpMonetaryLayerInvariants(funnel) &&
    assertAp3MpTaxProvenanceInvariants(funnel)
  );
}

/**
 * Neither-close companion partitions — all families exclusive and cover
 * mpNeitherObservationCount when any neither observation was recorded.
 */
export function assertAp3MpNeitherCloseInvariants(
  funnel: Ap3CandidateFunnelCounts
): boolean {
  const n = funnel.mpNeitherObservationCount;
  if (funnel.mpNeitherTargetCount > n) return false;

  const residualSum =
    funnel.mpNeitherClosestResidualLe3 +
    funnel.mpNeitherClosestResidual4To5 +
    funnel.mpNeitherClosestResidual6To10 +
    funnel.mpNeitherClosestResidual11To50 +
    funnel.mpNeitherClosestResidualGt50 +
    funnel.mpNeitherClosestResidualUnavailable;
  if (residualSum !== n) return false;

  const closerSum =
    funnel.mpNeitherIncludedCloser +
    funnel.mpNeitherExcludedCloser +
    funnel.mpNeitherEqualResidual +
    funnel.mpNeitherResidualComparisonUnavailable;
  if (closerSum !== n) return false;

  // Two orthogonal monetary families — do not conflate into one partition.
  const monetaryStateSum =
    funnel.mpNeitherMonetaryStateCoherent +
    funnel.mpNeitherMonetaryStateIncoherent +
    funnel.mpNeitherMonetaryStateUnknown;
  if (monetaryStateSum !== n) return false;

  const monetaryProvenanceSum =
    funnel.mpNeitherMonetaryProvenanceSufficient +
    funnel.mpNeitherMonetaryProvenanceInsufficient;
  if (monetaryProvenanceSum !== n) return false;

  const remainderSum =
    funnel.mpNeitherRemainderZero +
    funnel.mpNeitherRemainderNonZero +
    funnel.mpNeitherRemainderUnavailable;
  if (remainderSum !== n) return false;

  const layerSum =
    funnel.mpNeitherLayerOcr +
    funnel.mpNeitherLayerUser +
    funnel.mpNeitherLayerUnknown;
  if (layerSum !== n) return false;

  return true;
}

/**
 * Monetary-layer shape partitions for amount_basis_untrusted observations.
 */
export function assertAp3MpMonetaryLayerInvariants(
  funnel: Ap3CandidateFunnelCounts
): boolean {
  const n = funnel.mpLayerObservationCount;
  if (n !== funnel.mpLayerUserEdited1 + funnel.mpLayerUserEdited0) return false;
  if (n !== funnel.mpLayerHasUserItems + funnel.mpLayerNoUserItems) return false;
  if (n !== funnel.mpLayerHasFinalTotal + funnel.mpLayerNoFinalTotal) {
    return false;
  }
  if (
    funnel.mpLayerUserEdited1 !==
    funnel.mpLayerEditedNoItemsNoTotal +
      funnel.mpLayerEditedItemsNoTotal +
      funnel.mpLayerEditedNoItemsHasTotal +
      funnel.mpLayerEditedItemsAndTotal
  ) {
    return false;
  }
  if (
    funnel.mpLayerUserEdited0 !==
    funnel.mpLayerNotEditedNoItemsNoTotal + funnel.mpLayerNotEditedItemsOrTotal
  ) {
    return false;
  }
  return true;
}

/**
 * Tax-provenance shape partitions for tax_untrusted observations.
 * mpTaxPersistedKnown1 !== 0 is diagnostic drift only (never product-affecting).
 */
export function assertAp3MpTaxProvenanceInvariants(
  funnel: Ap3CandidateFunnelCounts
): boolean {
  const n = funnel.mpTaxObservationCount;
  if (n !== funnel.mpTaxPersistedKnown1 + funnel.mpTaxPersistedKnown0) {
    return false;
  }
  if (
    n !==
    funnel.mpTaxStoredPositive +
      funnel.mpTaxStoredZero +
      funnel.mpTaxStoredOther
  ) {
    return false;
  }
  if (
    n !==
    funnel.mpTaxAnalysisMarkerTrue +
      funnel.mpTaxAnalysisMarkerFalse +
      funnel.mpTaxAnalysisMarkerMissing
  ) {
    return false;
  }
  if (
    n !==
    funnel.mpTaxAnalysisResolvedKnown +
      funnel.mpTaxAnalysisResolvedUnknown +
      funnel.mpTaxAnalysisUnavailable
  ) {
    return false;
  }
  if (
    funnel.mpTaxAnalysisResolvedKnown !==
    funnel.mpTaxAnalysisResolvedKnownPositive +
      funnel.mpTaxAnalysisResolvedKnownNonPositive
  ) {
    return false;
  }
  if (
    n !==
    funnel.mpTaxSnapshotResolvedKnown +
      funnel.mpTaxSnapshotResolvedUnknown +
      funnel.mpTaxSnapshotUnavailable
  ) {
    return false;
  }
  if (
    funnel.mpTaxAnalysisResolvedUnknown !==
    funnel.mpTaxAnalysisUnknownSnapshotKnown +
      funnel.mpTaxAnalysisUnknownSnapshotUnknown +
      funnel.mpTaxAnalysisUnknownSnapshotUnavailable
  ) {
    return false;
  }
  return true;
}

const LEVEL2_REJECT_REASON_TO_FIELD: Record<
  string,
  keyof Ap3CandidateFunnelCounts
> = {
  legacy_unbackfilled: 'mpObsLegacyUnbackfilled',
  price_observation_version: 'mpObsPriceObservationVersion',
  item_amount_evidence_state: 'mpObsItemAmountEvidenceState',
  invalid_gross_amount: 'mpObsInvalidGrossAmount',
  invalid_quantity: 'mpObsInvalidQuantity',
  currency_not_jpy: 'mpObsCurrencyNotJpy',
  amount_basis_untrusted: 'mpObsAmountBasisUntrusted',
  monetary_incoherent: 'mpObsMonetaryIncoherent',
  monetary_provenance_insufficient: 'mpObsMonetaryProvenanceInsufficient',
  discount_ownership_unresolved: 'mpObsDiscountOwnershipUnresolved',
  price_quality_invalid: 'mpObsPriceQualityInvalid',
  price_quality_suspected_anomaly: 'mpObsPriceQualitySuspectedAnomaly',
  amount_basis_mismatch: 'mpObsAmountBasisMismatch',
  missing_observation: 'mpObsMissingObservation',
};

const AMOUNT_BASIS_REASON_TO_FIELD: Record<
  string,
  keyof Ap3CandidateFunnelCounts
> = {
  tax_untrusted: 'mpBasisReasonTaxUntrusted',
  tax_non_positive_cannot_discriminate: 'mpBasisReasonTaxNonPositive',
  monetary_source_incoherent: 'mpBasisReasonMonetarySourceIncoherent',
  aggregate_discount_summary_ambiguous:
    'mpBasisReasonAggregateDiscountAmbiguous',
  invalid_authoritative_total: 'mpBasisReasonInvalidAuthoritativeTotal',
  missing_item_monetary_evidence: 'mpBasisReasonMissingItemMonetaryEvidence',
  invalid_monetary_evidence: 'mpBasisReasonInvalidMonetaryEvidence',
  ambiguous_both_hypotheses_close: 'mpBasisReasonAmbiguousBothHypotheses',
  neither_hypothesis_closes: 'mpBasisReasonNeitherHypothesisCloses',
  malformed_user_items_json: 'mpBasisReasonMalformedUserItems',
  user_items_without_authoritative_total: 'mpBasisReasonUserItemsWithoutTotal',
  final_total_without_matching_item_layer:
    'mpBasisReasonFinalTotalWithoutItems',
  inconsistent_legacy_user_edit_metadata: 'mpBasisReasonLegacyEditMetadata',
  discount_ownership_unresolved: 'mpBasisReasonDiscountOwnershipUnresolved',
  insufficient_evidence_for_reallocation:
    'mpBasisReasonInsufficientReallocationEvidence',
  persisted_discount_allocation_inconsistent:
    'mpBasisReasonPersistedDiscountInconsistent',
};

/** Diagnostics-only shape helpers — mirror monetarySourceBundle field rules. */
function rowHasUserItemsField(
  row: Pick<ProductPriceHistoryRow, 'receiptUserItemsJson'> | null | undefined
): boolean {
  const raw = row?.receiptUserItemsJson;
  return raw != null && typeof raw === 'string' && raw.trim().length > 0;
}

function rowHasFinalTotal(
  row: Pick<ProductPriceHistoryRow, 'receiptFinalTotal'> | null | undefined
): boolean {
  const value = row?.receiptFinalTotal;
  return value != null && Number.isFinite(Number(value));
}

function rowUserEdited(
  row: Pick<ProductPriceHistoryRow, 'receiptUserEdited'> | null | undefined
): boolean {
  return row?.receiptUserEdited === 1;
}

function rowUserItemsMalformed(
  row: Pick<ProductPriceHistoryRow, 'receiptUserItemsJson'> | null | undefined
): boolean {
  const raw = row?.receiptUserItemsJson;
  if (raw == null || typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw);
    return !Array.isArray(parsed);
  } catch {
    return true;
  }
}

let forceTaxProvenanceDiagnosticsForTests: boolean | null = null;

/** Test seam: null restores production gate (internal + Analysis D). */
export function setAp3TaxProvenanceDiagnosticsEnabledForTests(
  enabled: boolean | null
): void {
  forceTaxProvenanceDiagnosticsForTests = enabled;
}

/** Shared gate for tax-provenance recording + AP-3 snapshot projection. */
export function shouldRecordAp3TaxProvenanceDiagnostics(): boolean {
  if (forceTaxProvenanceDiagnosticsForTests != null) {
    return forceTaxProvenanceDiagnosticsForTests;
  }
  try {
    if (!isInternalDiagnosticsEnabled()) return false;
    // Lazy require: keep expo-constants out of Jest suites that import this module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isAnalysisDDiagnosticsEnabled } = require('./env') as {
      isAnalysisDDiagnosticsEnabled: () => boolean;
    };
    return isAnalysisDDiagnosticsEnabled();
  } catch {
    return false;
  }
}

let forceNeitherCloseDiagnosticsForTests: boolean | null = null;

/** Test seam: null restores production gate (internal + Analysis D). */
export function setAp3NeitherCloseDiagnosticsEnabledForTests(
  enabled: boolean | null
): void {
  forceNeitherCloseDiagnosticsForTests = enabled;
}

/**
 * Gate for neither-hypothesis-closes residual companion.
 * Internal Diagnostics AND Analysis-D Diagnostics — never emit when Analysis-D OFF.
 */
export function shouldRecordAp3NeitherCloseDiagnostics(): boolean {
  if (forceNeitherCloseDiagnosticsForTests != null) {
    return forceNeitherCloseDiagnosticsForTests;
  }
  try {
    if (!isInternalDiagnosticsEnabled()) return false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isAnalysisDDiagnosticsEnabled } = require('./env') as {
      isAnalysisDDiagnosticsEnabled: () => boolean;
    };
    return isAnalysisDDiagnosticsEnabled();
  } catch {
    return false;
  }
}

export type NeitherCloseResidualBucket =
  | 'le3'
  | '4to5'
  | '6to10'
  | '11to50'
  | 'gt50'
  | 'unavailable';

export type NeitherCloseCloserSide =
  | 'included'
  | 'excluded'
  | 'equal'
  | 'unavailable';

export type NeitherCloseResidualClassification = {
  includedResidual: number | null;
  excludedResidual: number | null;
  closestResidual: number | null;
  bucket: NeitherCloseResidualBucket;
  closer: NeitherCloseCloserSide;
};

/**
 * Pure classifier — uses AmountBasisAssessment structured totals only.
 * Does not parse evidence strings or re-run amountBasis equations.
 */
export function classifyNeitherCloseResiduals(
  assessment: Pick<
    ReceiptAmountBasisAssessment,
    | 'receiptTotal'
    | 'expectedTotalIfTaxIncluded'
    | 'expectedTotalIfTaxExcluded'
  >
): NeitherCloseResidualClassification {
  const paid = assessment.receiptTotal;
  const expectedIncluded = assessment.expectedTotalIfTaxIncluded;
  const expectedExcluded = assessment.expectedTotalIfTaxExcluded;

  const includedResidual =
    Number.isFinite(paid) &&
    expectedIncluded != null &&
    Number.isFinite(expectedIncluded)
      ? Math.abs(expectedIncluded - paid)
      : null;
  const excludedResidual =
    Number.isFinite(paid) &&
    expectedExcluded != null &&
    Number.isFinite(expectedExcluded)
      ? Math.abs(expectedExcluded - paid)
      : null;

  let closer: NeitherCloseCloserSide = 'unavailable';
  let closestResidual: number | null = null;
  if (includedResidual != null && excludedResidual != null) {
    if (includedResidual < excludedResidual) {
      closer = 'included';
      closestResidual = includedResidual;
    } else if (excludedResidual < includedResidual) {
      closer = 'excluded';
      closestResidual = excludedResidual;
    } else {
      closer = 'equal';
      closestResidual = includedResidual;
    }
  } else if (includedResidual != null) {
    closer = 'included';
    closestResidual = includedResidual;
  } else if (excludedResidual != null) {
    closer = 'excluded';
    closestResidual = excludedResidual;
  }

  let bucket: NeitherCloseResidualBucket = 'unavailable';
  if (closestResidual != null && Number.isFinite(closestResidual)) {
    if (closestResidual <= 3) bucket = 'le3';
    else if (closestResidual <= 5) bucket = '4to5';
    else if (closestResidual <= 10) bucket = '6to10';
    else if (closestResidual <= 50) bucket = '11to50';
    else bucket = 'gt50';
  }

  return {
    includedResidual,
    excludedResidual,
    closestResidual,
    bucket,
    closer,
  };
}

function classifyNeitherMonetaryStateBucket(
  monetary: ReceiptMonetaryCoherenceEvidence | null | undefined
): 'coherent' | 'incoherent' | 'unknown' {
  if (!monetary) return 'unknown';
  if (monetary.state === 'known_coherent') return 'coherent';
  if (monetary.state === 'known_incoherent') return 'incoherent';
  return 'unknown';
}

function classifyNeitherMonetaryProvenanceBucket(
  monetary: ReceiptMonetaryCoherenceEvidence | null | undefined
): 'sufficient' | 'insufficient' {
  // Production field is boolean; only strict true counts as sufficient.
  if (monetary?.monetaryProvenanceSufficient === true) return 'sufficient';
  return 'insufficient';
}

/**
 * Observe-only neither_hypothesis_closes residual shape for NEP observations.
 * Gated by shouldRecordAp3NeitherCloseDiagnostics — caller must check gate.
 */
export function recordAp3MpNeitherCloseShape(
  funnel: Ap3CandidateFunnelCounts,
  input: {
    history: ProductPriceHistoryResult;
    receiptEvidenceCache?: ReceiptEvidenceCache | null;
  }
): void {
  const cache = input.receiptEvidenceCache ?? null;
  let targetHasNeither = false;

  for (const observation of input.history.observations) {
    if (!observation.level2RejectReasons.includes('amount_basis_untrusted')) {
      continue;
    }
    const entry = cache?.get(observation.receiptId) ?? null;
    const assessment = entry?.amountBasisAssessment ?? null;
    if (!assessment) continue;
    if (!assessment.reasonCodes.includes('neither_hypothesis_closes')) {
      continue;
    }

    targetHasNeither = true;
    funnel.mpNeitherObservationCount += 1;

    const classified = classifyNeitherCloseResiduals(assessment);
    switch (classified.bucket) {
      case 'le3':
        funnel.mpNeitherClosestResidualLe3 += 1;
        break;
      case '4to5':
        funnel.mpNeitherClosestResidual4To5 += 1;
        break;
      case '6to10':
        funnel.mpNeitherClosestResidual6To10 += 1;
        break;
      case '11to50':
        funnel.mpNeitherClosestResidual11To50 += 1;
        break;
      case 'gt50':
        funnel.mpNeitherClosestResidualGt50 += 1;
        break;
      default:
        funnel.mpNeitherClosestResidualUnavailable += 1;
        break;
    }
    switch (classified.closer) {
      case 'included':
        funnel.mpNeitherIncludedCloser += 1;
        break;
      case 'excluded':
        funnel.mpNeitherExcludedCloser += 1;
        break;
      case 'equal':
        funnel.mpNeitherEqualResidual += 1;
        break;
      default:
        funnel.mpNeitherResidualComparisonUnavailable += 1;
        break;
    }

    const monetary = entry?.monetaryCoherenceEvidence;
    const stateBucket = classifyNeitherMonetaryStateBucket(monetary);
    if (stateBucket === 'coherent') {
      funnel.mpNeitherMonetaryStateCoherent += 1;
    } else if (stateBucket === 'incoherent') {
      funnel.mpNeitherMonetaryStateIncoherent += 1;
    } else {
      funnel.mpNeitherMonetaryStateUnknown += 1;
    }
    if (classifyNeitherMonetaryProvenanceBucket(monetary) === 'sufficient') {
      funnel.mpNeitherMonetaryProvenanceSufficient += 1;
    } else {
      funnel.mpNeitherMonetaryProvenanceInsufficient += 1;
    }

    const remainder = assessment.unallocatedDiscountTotal;
    if (typeof remainder === 'number' && Number.isFinite(remainder)) {
      if (remainder === 0) funnel.mpNeitherRemainderZero += 1;
      else funnel.mpNeitherRemainderNonZero += 1;
    } else {
      funnel.mpNeitherRemainderUnavailable += 1;
    }

    const layer = monetary?.authoritativeLayer ?? null;
    if (layer === 'ocr') funnel.mpNeitherLayerOcr += 1;
    else if (layer === 'user') funnel.mpNeitherLayerUser += 1;
    else funnel.mpNeitherLayerUnknown += 1;
  }

  if (targetHasNeither) {
    funnel.mpNeitherTargetCount += 1;
  }
}

type TaxDiagResolvedLayer = 'known' | 'unknown' | 'unavailable';
type TaxDiagMarker = 'true' | 'false' | 'missing';

type TaxProvenanceDiagMemo = {
  analysisMarker: TaxDiagMarker;
  analysisResolved: TaxDiagResolvedLayer;
  analysisResolvedPositive: boolean;
  snapshotResolved: TaxDiagResolvedLayer;
};

/**
 * Per-receipt tax diagnostic cache for ONE AP-3 funnel/derivation.
 * Not module-global — create once per collect and discard after emit.
 */
export type Ap3TaxProvenanceReceiptMemo = {
  byReceiptId: Map<string, TaxProvenanceDiagMemo>;
  analysisParseCalls: number;
  analysisResolveCalls: number;
  snapshotParseCalls: number;
  snapshotResolveCalls: number;
};

export function createAp3TaxProvenanceReceiptMemo(): Ap3TaxProvenanceReceiptMemo {
  return {
    byReceiptId: new Map(),
    analysisParseCalls: 0,
    analysisResolveCalls: 0,
    snapshotParseCalls: 0,
    snapshotResolveCalls: 0,
  };
}

function readAnalysisTaxMarker(obj: Record<string, unknown>): TaxDiagMarker {
  const marker = obj.tax_is_known ?? obj.taxIsKnown;
  if (marker === true || marker === 1) return 'true';
  if (marker === false || marker === 0) return 'false';
  return 'missing';
}

function parseJsonObjectForTaxDiag(
  raw: string | null | undefined,
  memo: Ap3TaxProvenanceReceiptMemo,
  kind: 'analysis' | 'snapshot'
): Record<string, unknown> | null {
  if (raw == null || typeof raw !== 'string' || !raw.trim()) return null;
  if (kind === 'analysis') memo.analysisParseCalls += 1;
  else memo.snapshotParseCalls += 1;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveTaxDiagFromObject(
  obj: Record<string, unknown> | null,
  memo: Ap3TaxProvenanceReceiptMemo,
  kind: 'analysis' | 'snapshot'
): { layer: TaxDiagResolvedLayer; positive: boolean } {
  if (!obj) return { layer: 'unavailable', positive: false };
  if (kind === 'analysis') memo.analysisResolveCalls += 1;
  else memo.snapshotResolveCalls += 1;
  try {
    const resolved = resolveReceiptTax(
      obj as ReceiptAnalysis & Record<string, unknown>
    );
    if (resolved.taxIsKnown) {
      return {
        layer: 'known',
        positive: Number.isFinite(resolved.tax) && resolved.tax > 0,
      };
    }
    return { layer: 'unknown', positive: false };
  } catch {
    return { layer: 'unavailable', positive: false };
  }
}

function getOrBuildTaxProvenanceDiagMemo(
  memo: Ap3TaxProvenanceReceiptMemo,
  receiptId: string,
  row: ProductPriceHistoryRow | null | undefined
): TaxProvenanceDiagMemo {
  const existing = memo.byReceiptId.get(receiptId);
  if (existing) return existing;

  let built: TaxProvenanceDiagMemo;
  try {
    const analysisObj = parseJsonObjectForTaxDiag(
      row?.receiptAnalysisJson,
      memo,
      'analysis'
    );
    const analysisMarker = analysisObj
      ? readAnalysisTaxMarker(analysisObj)
      : ('missing' as TaxDiagMarker);
    const analysisResolved = resolveTaxDiagFromObject(
      analysisObj,
      memo,
      'analysis'
    );
    const marker: TaxDiagMarker = analysisObj ? analysisMarker : 'missing';

    const snapshotObj = parseJsonObjectForTaxDiag(
      row?.receiptRecognitionSnapshotJson,
      memo,
      'snapshot'
    );
    const snapshotResolved = resolveTaxDiagFromObject(
      snapshotObj,
      memo,
      'snapshot'
    );

    built = {
      analysisMarker: marker,
      analysisResolved: analysisResolved.layer,
      analysisResolvedPositive: analysisResolved.positive,
      snapshotResolved: snapshotResolved.layer,
    };
  } catch {
    built = {
      analysisMarker: 'missing',
      analysisResolved: 'unavailable',
      analysisResolvedPositive: false,
      snapshotResolved: 'unavailable',
    };
  }
  memo.byReceiptId.set(receiptId, built);
  return built;
}

function recordTaxProvenanceShapeForObservation(
  funnel: Ap3CandidateFunnelCounts,
  row: ProductPriceHistoryRow | null | undefined,
  memo: Ap3TaxProvenanceReceiptMemo,
  receiptId: string
): void {
  funnel.mpTaxObservationCount += 1;

  if (row?.receiptTaxIsKnown === 1) {
    funnel.mpTaxPersistedKnown1 += 1;
  } else {
    funnel.mpTaxPersistedKnown0 += 1;
  }

  const tax = Number(row?.receiptTax);
  if (Number.isFinite(tax) && tax > 0) {
    funnel.mpTaxStoredPositive += 1;
  } else if (Number.isFinite(tax) && tax === 0) {
    funnel.mpTaxStoredZero += 1;
  } else {
    funnel.mpTaxStoredOther += 1;
  }

  const diag = getOrBuildTaxProvenanceDiagMemo(memo, receiptId, row);

  if (diag.analysisMarker === 'true') funnel.mpTaxAnalysisMarkerTrue += 1;
  else if (diag.analysisMarker === 'false') {
    funnel.mpTaxAnalysisMarkerFalse += 1;
  } else {
    funnel.mpTaxAnalysisMarkerMissing += 1;
  }

  if (diag.analysisResolved === 'known') {
    funnel.mpTaxAnalysisResolvedKnown += 1;
    if (diag.analysisResolvedPositive) {
      funnel.mpTaxAnalysisResolvedKnownPositive += 1;
    } else {
      funnel.mpTaxAnalysisResolvedKnownNonPositive += 1;
    }
  } else if (diag.analysisResolved === 'unknown') {
    funnel.mpTaxAnalysisResolvedUnknown += 1;
  } else {
    funnel.mpTaxAnalysisUnavailable += 1;
  }

  if (diag.snapshotResolved === 'known') {
    funnel.mpTaxSnapshotResolvedKnown += 1;
  } else if (diag.snapshotResolved === 'unknown') {
    funnel.mpTaxSnapshotResolvedUnknown += 1;
  } else {
    funnel.mpTaxSnapshotUnavailable += 1;
  }

  const persistedKnown = row?.receiptTaxIsKnown === 1;
  if (!persistedKnown && diag.analysisResolved === 'known') {
    funnel.mpTaxPersisted0AnalysisKnown += 1;
  }
  if (!persistedKnown && diag.analysisResolved === 'unknown') {
    funnel.mpTaxPersisted0AnalysisUnknown += 1;
  }

  if (diag.analysisResolved === 'unknown') {
    if (diag.snapshotResolved === 'known') {
      funnel.mpTaxAnalysisUnknownSnapshotKnown += 1;
    } else if (diag.snapshotResolved === 'unknown') {
      funnel.mpTaxAnalysisUnknownSnapshotUnknown += 1;
    } else {
      funnel.mpTaxAnalysisUnknownSnapshotUnavailable += 1;
    }
  }
}

function recordMonetaryLayerShapeForObservation(
  funnel: Ap3CandidateFunnelCounts,
  row: ProductPriceHistoryRow | null | undefined
): void {
  funnel.mpLayerObservationCount += 1;
  const edited = rowUserEdited(row);
  const hasItems = rowHasUserItemsField(row);
  const hasTotal = rowHasFinalTotal(row);

  if (edited) funnel.mpLayerUserEdited1 += 1;
  else funnel.mpLayerUserEdited0 += 1;

  if (hasItems) funnel.mpLayerHasUserItems += 1;
  else funnel.mpLayerNoUserItems += 1;

  if (hasTotal) funnel.mpLayerHasFinalTotal += 1;
  else funnel.mpLayerNoFinalTotal += 1;

  if (edited) {
    if (!hasItems && !hasTotal) funnel.mpLayerEditedNoItemsNoTotal += 1;
    else if (hasItems && !hasTotal) funnel.mpLayerEditedItemsNoTotal += 1;
    else if (!hasItems && hasTotal) funnel.mpLayerEditedNoItemsHasTotal += 1;
    else funnel.mpLayerEditedItemsAndTotal += 1;
  } else if (!hasItems && !hasTotal) {
    funnel.mpLayerNotEditedNoItemsNoTotal += 1;
  } else {
    funnel.mpLayerNotEditedItemsOrTotal += 1;
  }

  if (rowUserItemsMalformed(row)) {
    funnel.mpLayerMalformedUserItems += 1;
  }
}

/**
 * Observe-only amount-basis breakdown for amount_basis_untrusted observations
 * within the not_enough_points cohort. Reads cache assessments + membership
 * row receipt layer fields only.
 */
export function recordAp3MpAmountBasisUntrustedBreakdown(
  funnel: Ap3CandidateFunnelCounts,
  input: {
    history: ProductPriceHistoryResult;
    receiptEvidenceCache?: ReceiptEvidenceCache | null;
    membershipRows?: readonly ProductPriceHistoryRow[] | null;
    /** Shared across all MP targets in one AP-3 derivation. */
    taxProvenanceReceiptMemo?: Ap3TaxProvenanceReceiptMemo | null;
  }
): void {
  funnel.mpBasisCohortTargetCount += 1;
  let targetHasUntrusted = false;
  let targetHasTaxUntrusted = false;
  const cache = input.receiptEvidenceCache ?? null;
  const rowByReceiptId = new Map<string, ProductPriceHistoryRow>();
  for (const row of input.membershipRows ?? []) {
    if (!rowByReceiptId.has(row.receiptId)) {
      rowByReceiptId.set(row.receiptId, row);
    }
  }
  const taxDiagEnabled = shouldRecordAp3TaxProvenanceDiagnostics();
  // Prefer derivation-scoped memo; allocate local only for single-target direct calls.
  const taxDiagMemo = taxDiagEnabled
    ? input.taxProvenanceReceiptMemo ?? createAp3TaxProvenanceReceiptMemo()
    : null;

  for (const observation of input.history.observations) {
    if (!observation.level2RejectReasons.includes('amount_basis_untrusted')) {
      continue;
    }
    targetHasUntrusted = true;
    funnel.mpBasisUntrustedObservationCount += 1;
    funnel.mpBasisReasonObservationCount += 1;

    recordMonetaryLayerShapeForObservation(
      funnel,
      rowByReceiptId.get(observation.receiptId)
    );

    const assessment =
      cache?.get(observation.receiptId)?.amountBasisAssessment ?? null;
    if (!assessment) {
      funnel.mpBasisAssessmentMissing += 1;
      continue;
    }

    if (assessment.basis === 'tax_included') {
      funnel.mpBasisTaxIncluded += 1;
    } else if (assessment.basis === 'tax_excluded') {
      funnel.mpBasisTaxExcluded += 1;
    } else {
      funnel.mpBasisUnknown += 1;
    }

    if (assessment.confidence === 'high') {
      funnel.mpBasisConfidenceHigh += 1;
    } else if (assessment.confidence === 'medium') {
      funnel.mpBasisConfidenceMedium += 1;
    } else if (assessment.confidence === 'low') {
      funnel.mpBasisConfidenceLow += 1;
    } else {
      funnel.mpBasisConfidenceUnknown += 1;
    }

    if (assessment.taxProvenance === 'trusted') {
      funnel.mpBasisTaxProvenanceTrusted += 1;
    } else {
      funnel.mpBasisTaxProvenanceUntrusted += 1;
    }

    if (assessment.exactComparisonTrusted) {
      funnel.mpBasisExactTrustedTrue += 1;
    } else {
      funnel.mpBasisExactTrustedFalse += 1;
    }

    const knownBasis =
      assessment.basis === 'tax_included' ||
      assessment.basis === 'tax_excluded';
    if (knownBasis && !assessment.exactComparisonTrusted) {
      funnel.mpBasisKnownButUntrusted += 1;
    }
    if (knownBasis) {
      if (assessment.confidence === 'medium') {
        funnel.mpBasisKnownConfidenceMedium += 1;
      } else if (assessment.confidence === 'low') {
        funnel.mpBasisKnownConfidenceLow += 1;
      } else if (assessment.confidence === 'unknown') {
        funnel.mpBasisKnownConfidenceUnknown += 1;
      }
    }

    // Diagnostics-only: dedupe reasonCodes so product duplicate appends
    // (e.g. monetary_source_incoherent twice) count once per observation.
    const uniqueReasons = [...new Set(assessment.reasonCodes)];
    if (uniqueReasons.length === 0) {
      funnel.mpBasisReasonNoReasonCodes += 1;
    } else {
      for (const reason of uniqueReasons) {
        const field = AMOUNT_BASIS_REASON_TO_FIELD[reason];
        if (field) {
          funnel[field] += 1;
        } else {
          funnel.mpBasisReasonUnknown += 1;
        }
      }
    }

    // Tax-provenance companion: only tax_untrusted observations, gated.
    if (
      taxDiagEnabled &&
      taxDiagMemo &&
      uniqueReasons.includes('tax_untrusted')
    ) {
      try {
        targetHasTaxUntrusted = true;
        recordTaxProvenanceShapeForObservation(
          funnel,
          rowByReceiptId.get(observation.receiptId),
          taxDiagMemo,
          observation.receiptId
        );
      } catch {
        // Diagnostics fail-open: never affect AP-3 product path.
      }
    }
  }

  if (targetHasUntrusted) {
    funnel.mpBasisTargetsWithUntrustedObservation += 1;
  }
  if (taxDiagEnabled && targetHasTaxUntrusted) {
    funnel.mpTaxCohortTargetCount += 1;
  }
}

/**
 * Observe-only: membership >= 2 AND history.status === not_enough_points.
 * Does not recompute identity/history/quality/amount-basis.
 */
export function recordAp3MpNotEnoughPointsComparability(
  funnel: Ap3CandidateFunnelCounts,
  input: {
    membershipRowCount: number;
    identityRowCount: number;
    history: ProductPriceHistoryResult;
    receiptEvidenceCache?: ReceiptEvidenceCache | null;
    membershipRows?: readonly ProductPriceHistoryRow[] | null;
    taxProvenanceReceiptMemo?: Ap3TaxProvenanceReceiptMemo | null;
  }
): void {
  if (input.membershipRowCount < 2) return;
  if (input.history.status !== 'not_enough_points') return;

  funnel.mpHistoryTargetCount += 1;
  funnel.mpHistoryMembershipRowsTotal += input.membershipRowCount;
  funnel.mpHistoryIdentityRowsTotal += input.identityRowCount;

  const observations = input.history.observations;
  funnel.mpHistoryTotalObservations += observations.length;
  let eligible = 0;
  let rejected = 0;
  for (const observation of observations) {
    if (observation.level2Eligible) {
      eligible += 1;
    } else {
      rejected += 1;
    }
    for (const reason of observation.level2RejectReasons) {
      const field = LEVEL2_REJECT_REASON_TO_FIELD[reason];
      if (field) {
        funnel[field] += 1;
      } else {
        funnel.mpObsUnknownRejectReason += 1;
      }
    }
  }
  funnel.mpHistoryLevel2EligibleObservations += eligible;
  funnel.mpHistoryRejectedObservations += rejected;

  const points = input.history.points.length;
  funnel.mpHistoryComparablePoints += points;
  if (points <= 0) {
    funnel.mpHistoryTargetsWith0ComparablePoints += 1;
  } else if (points === 1) {
    funnel.mpHistoryTargetsWith1ComparablePoints += 1;
  } else {
    funnel.mpHistoryTargetsWith2PlusComparablePoints += 1;
  }

  if (input.identityRowCount <= 0) {
    funnel.mpHistoryTargetsIdentityRows0 += 1;
  } else if (input.identityRowCount === 1) {
    funnel.mpHistoryTargetsIdentityRows1 += 1;
  } else {
    funnel.mpHistoryTargetsIdentityRows2Plus += 1;
  }

  recordAp3MpAmountBasisUntrustedBreakdown(funnel, {
    history: input.history,
    receiptEvidenceCache: input.receiptEvidenceCache,
    membershipRows: input.membershipRows,
    taxProvenanceReceiptMemo: input.taxProvenanceReceiptMemo,
  });

  if (shouldRecordAp3NeitherCloseDiagnostics()) {
    try {
      recordAp3MpNeitherCloseShape(funnel, {
        history: input.history,
        receiptEvidenceCache: input.receiptEvidenceCache,
      });
    } catch {
      // Diagnostics fail-open: never affect AP-3 product path.
    }
  }
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

const FUNNEL_MP_HISTORY_SUMMARY_KEYS = [
  'mpHistoryTargetCount',
  'mpHistoryMembershipRowsTotal',
  'mpHistoryIdentityRowsTotal',
  'mpHistoryTotalObservations',
  'mpHistoryLevel2EligibleObservations',
  'mpHistoryRejectedObservations',
  'mpHistoryComparablePoints',
  'mpHistoryTargetsIdentityRows0',
  'mpHistoryTargetsIdentityRows1',
  'mpHistoryTargetsIdentityRows2Plus',
  'mpHistoryTargetsWith0ComparablePoints',
  'mpHistoryTargetsWith1ComparablePoints',
  'mpHistoryTargetsWith2PlusComparablePoints',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_MP_OBSERVATION_REASON_KEYS = [
  'mpObsLegacyUnbackfilled',
  'mpObsPriceObservationVersion',
  'mpObsItemAmountEvidenceState',
  'mpObsInvalidGrossAmount',
  'mpObsInvalidQuantity',
  'mpObsCurrencyNotJpy',
  'mpObsAmountBasisUntrusted',
  'mpObsMonetaryIncoherent',
  'mpObsMonetaryProvenanceInsufficient',
  'mpObsDiscountOwnershipUnresolved',
  'mpObsPriceQualityInvalid',
  'mpObsPriceQualitySuspectedAnomaly',
  'mpObsAmountBasisMismatch',
  'mpObsMissingObservation',
  'mpObsUnknownRejectReason',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_MP_AMOUNT_BASIS_SUMMARY_KEYS = [
  'mpBasisCohortTargetCount',
  'mpBasisTargetsWithUntrustedObservation',
  'mpBasisUntrustedObservationCount',
  'mpBasisAssessmentMissing',
  'mpBasisTaxIncluded',
  'mpBasisTaxExcluded',
  'mpBasisUnknown',
  'mpBasisConfidenceHigh',
  'mpBasisConfidenceMedium',
  'mpBasisConfidenceLow',
  'mpBasisConfidenceUnknown',
  'mpBasisTaxProvenanceTrusted',
  'mpBasisTaxProvenanceUntrusted',
  'mpBasisExactTrustedTrue',
  'mpBasisExactTrustedFalse',
  'mpBasisKnownButUntrusted',
  'mpBasisKnownConfidenceMedium',
  'mpBasisKnownConfidenceLow',
  'mpBasisKnownConfidenceUnknown',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_MP_AMOUNT_BASIS_REASON_KEYS = [
  'mpBasisReasonObservationCount',
  'mpBasisReasonTaxUntrusted',
  'mpBasisReasonTaxNonPositive',
  'mpBasisReasonMonetarySourceIncoherent',
  'mpBasisReasonAggregateDiscountAmbiguous',
  'mpBasisReasonInvalidAuthoritativeTotal',
  'mpBasisReasonMissingItemMonetaryEvidence',
  'mpBasisReasonInvalidMonetaryEvidence',
  'mpBasisReasonAmbiguousBothHypotheses',
  'mpBasisReasonNeitherHypothesisCloses',
  'mpBasisReasonMalformedUserItems',
  'mpBasisReasonUserItemsWithoutTotal',
  'mpBasisReasonFinalTotalWithoutItems',
  'mpBasisReasonLegacyEditMetadata',
  'mpBasisReasonDiscountOwnershipUnresolved',
  'mpBasisReasonInsufficientReallocationEvidence',
  'mpBasisReasonPersistedDiscountInconsistent',
  'mpBasisReasonNoReasonCodes',
  'mpBasisReasonUnknown',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_MP_MONETARY_LAYER_KEYS = [
  'mpLayerObservationCount',
  'mpLayerUserEdited1',
  'mpLayerUserEdited0',
  'mpLayerHasUserItems',
  'mpLayerNoUserItems',
  'mpLayerHasFinalTotal',
  'mpLayerNoFinalTotal',
  'mpLayerEditedNoItemsNoTotal',
  'mpLayerEditedItemsNoTotal',
  'mpLayerEditedNoItemsHasTotal',
  'mpLayerEditedItemsAndTotal',
  'mpLayerNotEditedNoItemsNoTotal',
  'mpLayerNotEditedItemsOrTotal',
  'mpLayerMalformedUserItems',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_MP_TAX_PROVENANCE_KEYS = [
  'mpTaxCohortTargetCount',
  'mpTaxObservationCount',
  'mpTaxPersistedKnown1',
  'mpTaxPersistedKnown0',
  'mpTaxStoredPositive',
  'mpTaxStoredZero',
  'mpTaxStoredOther',
  'mpTaxAnalysisMarkerTrue',
  'mpTaxAnalysisMarkerFalse',
  'mpTaxAnalysisMarkerMissing',
  'mpTaxAnalysisResolvedKnown',
  'mpTaxAnalysisResolvedUnknown',
  'mpTaxAnalysisUnavailable',
  'mpTaxAnalysisResolvedKnownPositive',
  'mpTaxAnalysisResolvedKnownNonPositive',
  'mpTaxSnapshotResolvedKnown',
  'mpTaxSnapshotResolvedUnknown',
  'mpTaxSnapshotUnavailable',
  'mpTaxPersisted0AnalysisKnown',
  'mpTaxPersisted0AnalysisUnknown',
  'mpTaxAnalysisUnknownSnapshotKnown',
  'mpTaxAnalysisUnknownSnapshotUnknown',
  'mpTaxAnalysisUnknownSnapshotUnavailable',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

const FUNNEL_MP_NEITHER_CLOSE_KEYS = [
  'mpNeitherTargetCount',
  'mpNeitherObservationCount',
  'mpNeitherClosestResidualLe3',
  'mpNeitherClosestResidual4To5',
  'mpNeitherClosestResidual6To10',
  'mpNeitherClosestResidual11To50',
  'mpNeitherClosestResidualGt50',
  'mpNeitherClosestResidualUnavailable',
  'mpNeitherIncludedCloser',
  'mpNeitherExcludedCloser',
  'mpNeitherEqualResidual',
  'mpNeitherResidualComparisonUnavailable',
  'mpNeitherMonetaryStateCoherent',
  'mpNeitherMonetaryStateIncoherent',
  'mpNeitherMonetaryStateUnknown',
  'mpNeitherMonetaryProvenanceSufficient',
  'mpNeitherMonetaryProvenanceInsufficient',
  'mpNeitherRemainderZero',
  'mpNeitherRemainderNonZero',
  'mpNeitherRemainderUnavailable',
  'mpNeitherLayerOcr',
  'mpNeitherLayerUser',
  'mpNeitherLayerUnknown',
] as const satisfies readonly (keyof Ap3CandidateFunnelCounts)[];

/**
 * Emit completed funnel as core + companion reason/history/breakdown events
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
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_mp_history_summary',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_MP_HISTORY_SUMMARY_KEYS),
  });
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_mp_observation_reasons',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_MP_OBSERVATION_REASON_KEYS),
  });
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_mp_amount_basis_summary',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_MP_AMOUNT_BASIS_SUMMARY_KEYS),
  });
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_mp_amount_basis_reasons',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_MP_AMOUNT_BASIS_REASON_KEYS),
  });
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_mp_monetary_layer_shape',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_MP_MONETARY_LAYER_KEYS),
  });
  recordDiagnosticEvent({
    category: 'timing',
    name: 'ap3_candidate_funnel_mp_tax_provenance_shape',
    screen: 'analysis',
    meta: pickMeta(funnel, FUNNEL_MP_TAX_PROVENANCE_KEYS),
  });
  // Neither-close companion: never emit when Analysis-D OFF (avoid all-zero B2).
  if (shouldRecordAp3NeitherCloseDiagnostics()) {
    recordDiagnosticEvent({
      category: 'timing',
      name: 'ap3_candidate_funnel_mp_neither_close_shape',
      screen: 'analysis',
      meta: pickMeta(funnel, FUNNEL_MP_NEITHER_CLOSE_KEYS),
    });
  }
}
