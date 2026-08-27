export {
  RECEIPT_EVIDENCE_TRUTH_VERSION,
  type ReceiptTransactionEvidence,
  type ReceiptTransactionPrecision,
  type ReceiptTransactionTextProvenance,
  type ReceiptMerchantEvidence,
  type MerchantEvidenceCompatibility,
  type MerchantStoreHintEvidenceStatus,
  type MonetaryCoherenceState,
  type ReceiptMonetaryCoherenceEvidence,
  type ShadowDuplicateCandidatePath,
  type ShadowDuplicateCandidateGroup,
  type ShadowDuplicateRelationEvidence,
  type ShadowMerchantMetadataVariantEvaluation,
  type DateYearConflictDiagnostic,
  type ShadowRepresentativeRecommendation,
  type GroundTruthShadowAuditReport,
  type GroundTruthCaseShadowResult,
  type ProductionShadowCandidateSummary,
} from './types';

export {
  buildReceiptTransactionEvidence,
  calendarYearFromTransactionEvidence,
  diagnosticClockSimilarity,
  precisionCompatibleClockMatch,
  isValidLocalDateTimeComponents,
} from './transactionEvidence';

export {
  buildReceiptMerchantEvidence,
  evaluateMerchantEvidenceCompatibility,
  isMerchantEvidenceShadowCompatible,
  merchantMetadataVariantRequiresDifferentKeys,
} from './merchantEvidence';

export {
  buildReceiptMonetaryCoherenceEvidence,
  monetaryCoherenceRank,
} from './monetaryCoherenceEvidence';

export {
  buildProductionShadowCandidateNodes,
  buildSubstantiatedCandidateView,
  findProductionShadowCandidateForReceiptIds,
  findProductionCanonicalGroupForReceiptIds,
  countProductionCandidatesForReceiptIds,
  indexShadowCandidateNodesByReceiptId,
  type ProductionShadowCandidateNode,
} from './shadowCandidateNode';

export {
  evaluateShadowMerchantMetadataVariantPair,
  evaluateShadowMerchantMetadataVariantDetailed,
  buildShadowDuplicateCandidateGroups,
} from './shadowDuplicateCandidates';

export { buildDateYearConflictDiagnostic } from './dateYearConflictDiagnostic';

export { buildShadowRepresentativeRecommendation } from './shadowRepresentativeRecommendation';

export {
  buildGroundTruthShadowAudit,
  GROUND_TRUTH_CASE_RECEIPT_IDS,
} from './groundTruthShadowAudit';

export {
  evaluateShadowBasketGate,
  orientCandidatePair,
  stableSortedStrings,
} from './shadowPairGates';

export {
  validateRawOcrItemBasket,
  validateRawUserItemBasket,
  isShadowAuthorizingCurrency,
  normalizeShadowCurrency,
  rawBasketVectorsEqual,
} from './rawItemValidation';
