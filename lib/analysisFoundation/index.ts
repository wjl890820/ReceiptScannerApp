/**
 * Meruno Analysis Foundation A1 / A1.1 / A1.2 / A1.2.x / B1 — canonical read layer (read-only).
 *
 * Does not wire into production stats/UI.
 */

export {
  ANALYSIS_FOUNDATION_VERSION,
  DEFAULT_SHOPPING_SESSION_CANDIDATE_CONFIG,
  type AmountBasisConfidence,
  type AmountTaxBasis,
  type BasketMergeConfidence,
  type CanonicalMerchant,
  type CanonicalReceiptConfidence,
  type CanonicalReceiptDuplicateConfidence,
  type CanonicalReceiptGroup,
  type ConsolidatedBasket,
  type ConsolidatedBasketLine,
  type ExactPriceAmountEvidence,
  type MerchantPatternEligibility,
  type MerchantPatternRejectReason,
  type MonetaryObservation,
  type PriceComparisonEligibility,
  type PriceComparisonRejectReason,
  type PurchaseCycleEligibility,
  type PurchaseCycleRejectReason,
  type ReceiptAmountBasisAssessment,
  type ShoppingSessionCandidate,
  type ShoppingSessionCandidateConfidence,
  type ShoppingSessionCandidateConfig,
  type TaxProvenanceTrust,
  type TransactionTemporalPrecision,
} from './types';

export {
  buildCanonicalReceiptGroups,
  buildEphemeralSnapshotGroupId,
  indexCanonicalReceiptGroupsByReceiptId,
  isDuplicateReceiptExtra,
  pickCanonicalRepresentativeReceipt,
  scoreReceiptRepresentativeQuality,
  applyEvidenceAwareRepresentativeOverride,
  isTrustedMonetaryRepresentative,
} from './canonicalReceipt';

export { deriveCanonicalMerchant } from './canonicalMerchant';

export { consolidateReceiptBasket } from './basketConsolidation';

export {
  AMOUNT_BASIS_TOLERANCE_JPY,
  assessReceiptAmountBasis,
  assessReceiptAmountBasisForAll,
  buildMonetaryObservation,
  exactPriceAmountEvidenceFromAssessment,
  evaluateExactPriceAmountBasisGate,
  isExactPriceAmountEvidenceTrusted,
} from './amountBasis';

export {
  resolveReceiptMonetarySourceBundle,
  sumBundleAnalyticsItemAmounts,
} from './monetarySourceBundle';

export {
  isPersistedDiscountAllocationConsistent,
  resolveDiscountOwnership,
} from './discountOwnership';

export {
  evaluateMerchantPatternEligibility,
  evaluatePairwisePriceObservationCompatibility,
  evaluatePriceComparisonEligibility,
  evaluatePurchaseCycleEligibility,
  evaluateReceiptItemPriceComparisonEligibility,
  evaluateSinglePriceObservationEligibility,
  resolveTransactionTemporalPrecision,
  type PriceComparisonEligibilityInput,
  type PriceObservationSideInput,
  type PurchaseCycleEligibilityInput,
  type PriceObservationQualityLevel,
} from './eligibility';

export {
  buildShoppingSessionCandidates,
  receiptIdsInShoppingSessionCandidates,
} from './shoppingSessionCandidate';

export {
  KNOWLEDGE_MEMORY_CONTRACT_VERSION,
  GLOBAL_SHAREABLE_KNOWLEDGE_KINDS,
  PERSONAL_BEHAVIORAL_KNOWLEDGE_KINDS,
  aggregatePurchaseMemoryFacts,
  canonicalSerialize,
  claimEligibility,
  compareKnowledgeSources,
  createEmptyProductKnowledgeProvider,
  deterministicSum,
  evaluateKnowledgeScopeEligibility,
  evaluatePurchaseMemory,
  insightEvidenceLevelOrdinalCompatible,
  insightEvidenceLevelRank,
  insightEvidenceSatisfies,
  isGlobalShareableKnowledgeKind,
  isGloballyVerifiedSelection,
  isKnowledgeKind,
  isKnowledgeScope,
  isKnowledgeSourceTier,
  isPersonalBehavioralKnowledgeKind,
  isPersonalManualSelection,
  isUsableKnowledgeSelection,
  knowledgeSourcePriority,
  memoryClaimAuthorizesExactPriceComparison,
  normalizeProductKnowledgeLookupResult,
  scopeForPersonalManualCorrection,
  selectBestKnowledgeCandidate,
  semanticValuesEqual,
  validateInsightEvidenceClaim,
  validateKnowledgeRecord,
  validateMemoryIdentityEvidence,
  validatePatternEvidenceSignal,
  validateProductKnowledgeQuery,
  validatePurchaseMemoryFacts,
  type ClaimEligibility,
  type ClaimEligibilityStatus,
  type GlobalShareableKnowledgeKind,
  type InsightClaimValidation,
  type InsightEvidenceLevel,
  type KnowledgeAuthorityKind,
  type KnowledgeCandidate,
  type KnowledgeConflict,
  type KnowledgeKind,
  type KnowledgeRecordValidation,
  type KnowledgeScope,
  type KnowledgeSelectionResult,
  type KnowledgeSelectionStatus,
  type KnowledgeSourceTier,
  type MemoryIdentityEvidence,
  type MemoryIdentityStatus,
  type MemoryIdentityValidation,
  type PatternEvidenceSignal,
  type PatternEvidenceValidation,
  type PersonalBehavioralKnowledgeKind,
  type ProductKnowledgeLookupResult,
  type ProductKnowledgeLookupStatus,
  type ProductKnowledgeProvider,
  type ProductKnowledgeQuery,
  type ProductKnowledgeQueryFields,
  type ProductKnowledgeRecord,
  type PurchaseMemoryAggregationResult,
  type PurchaseMemoryEvaluation,
  type PurchaseMemoryEvidenceSignals,
  type PurchaseMemoryFacts,
  type PurchaseMemoryFactsValidation,
  type PurchaseMemoryObservation,
  type PurchaseMemoryStage,
  type ValidateProductKnowledgeQueryResult,
  type ValidatedProductKnowledgeQuery,
} from './knowledgeMemoryContract';

import type { ReceiptRow } from '../db';
import { buildCanonicalReceiptGroups } from './canonicalReceipt';
import { consolidateReceiptBasket } from './basketConsolidation';
import { deriveCanonicalMerchant } from './canonicalMerchant';
import { assessReceiptAmountBasisForAll } from './amountBasis';
import { buildShoppingSessionCandidates } from './shoppingSessionCandidate';
import type { ShoppingSessionCandidateConfig } from './types';
import type {
  CanonicalReceiptGroup,
  ConsolidatedBasket,
  ReceiptAmountBasisAssessment,
  ShoppingSessionCandidate,
} from './types';
import { ANALYSIS_FOUNDATION_VERSION } from './types';

export type AnalysisFoundationSnapshot = {
  version: typeof ANALYSIS_FOUNDATION_VERSION;
  canonicalReceiptGroups: CanonicalReceiptGroup[];
  shoppingSessionCandidates: ShoppingSessionCandidate[];
  /** A1.2 — read-only receipt amount tax-basis assessments (stable-sorted by receiptId). */
  receiptAmountBasisAssessments: ReceiptAmountBasisAssessment[];
};

/** Build the full A1+ read snapshot for a receipt corpus (pure, deterministic). */
export function buildAnalysisFoundationSnapshot(
  receipts: ReceiptRow[],
  shoppingConfig?: ShoppingSessionCandidateConfig
): AnalysisFoundationSnapshot {
  const canonicalReceiptGroups = buildCanonicalReceiptGroups(receipts);
  const shoppingSessionCandidates = buildShoppingSessionCandidates(
    receipts,
    shoppingConfig
  );
  const receiptAmountBasisAssessments = assessReceiptAmountBasisForAll(receipts);
  return {
    version: ANALYSIS_FOUNDATION_VERSION,
    canonicalReceiptGroups,
    shoppingSessionCandidates,
    receiptAmountBasisAssessments,
  };
}

/** Consolidate baskets for representative receipts only (deduped physical view). */
export function buildConsolidatedBasketsForCanonicalGroups(
  groups: CanonicalReceiptGroup[]
): ConsolidatedBasket[] {
  return groups.map((g) => consolidateReceiptBasket(g.representativeReceipt));
}

/** Canonical merchants for representative receipts. */
export function buildCanonicalMerchantsForGroups(
  groups: CanonicalReceiptGroup[]
) {
  return groups.map((g) => ({
    ephemeralSnapshotGroupId: g.ephemeralSnapshotGroupId,
    merchant: deriveCanonicalMerchant(g.representativeReceipt),
  }));
}
