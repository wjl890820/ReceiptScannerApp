/**
 * A1.4A — Receipt Evidence Truth Layer (read-only / shadow only).
 */

import type {
  DerivedRetailerIdentityConfidence,
  DerivedRetailerIdentitySource,
} from '../retailerIdentity';
import type { CanonicalReceiptConfidence } from '../analysisFoundation/types';

export const RECEIPT_EVIDENCE_TRUTH_VERSION =
  'meruno-receipt-evidence-truth-a1.4a-v3' as const;

export type ReceiptTransactionPrecision =
  | 'second'
  | 'minute'
  | 'date'
  | 'unknown';

/** Structured analysis field — may share OCR parser lineage with transaction_at. */
export type ReceiptTransactionTextProvenance =
  | 'structured_derived_analysis_field'
  | 'diagnostic_ocr_blob_candidate'
  | 'unavailable';

export type ReceiptTransactionConsistencyState =
  | 'consistent'
  | 'conflict'
  | 'derived_lineage'
  | 'unknown';

export type ParsedLocalDateTimeComponents = {
  year: number | null;
  month: number | null;
  day: number | null;
  hour: number | null;
  minute: number | null;
  second: number | null;
};

export type ReceiptTransactionEvidence = {
  receiptId: string;
  persistedTimestampMs: number | null;
  /** Structured derived field text when present — NOT independently printed evidence. */
  structuredDerivedDateText: string | null;
  /** Non-authorizing OCR blob candidate retained for diagnostics only. */
  diagnosticOcrDateCandidate: string | null;
  parsedFromStructuredDerived: ParsedLocalDateTimeComponents | null;
  parsedFromDiagnosticOcr: ParsedLocalDateTimeComponents | null;
  precision: ReceiptTransactionPrecision;
  textProvenance: ReceiptTransactionTextProvenance;
  consistencyState: ReceiptTransactionConsistencyState;
  /** True only when provenance specifically establishes receipt transaction timestamp. */
  shadowAuthorizable: boolean;
  evidence: string[];
  reasonCodes: string[];
};

export type MerchantStoreHintEvidenceStatus =
  | 'observed_store_hint'
  | 'missing_store_hint'
  | 'unresolved';

export type ReceiptMerchantEvidence = {
  receiptId: string;
  retailerKey: string | null;
  retailerDisplayName: string | null;
  storeHint: string | null;
  storeHintEvidenceStatus: MerchantStoreHintEvidenceStatus;
  confidence: DerivedRetailerIdentityConfidence;
  source: DerivedRetailerIdentitySource;
  analyticsMerchantKey: string;
  evidence: string[];
  reasonCodes: string[];
};

export type MerchantEvidenceCompatibility =
  | 'compatible_same_observed_store_hint'
  | 'compatible_missing_store_hint'
  | 'incompatible'
  | 'fail_closed';

export type MerchantEvidenceCompatibilityResult = {
  compatibility: MerchantEvidenceCompatibility;
  evidence: string[];
  reasonCodes: string[];
};

export type RawItemQuantityEvidence =
  | 'explicit_positive'
  | 'missing_default_one';

export type ValidatedRawItemRow = {
  index: number;
  name: string;
  quantityEvidence: RawItemQuantityEvidence;
  quantity: number;
  lineAmount: number;
};

export type RawItemBasketValidationResult =
  | {
      ok: true;
      rows: ValidatedRawItemRow[];
      evidence: string[];
    }
  | {
      ok: false;
      reason: string;
      reasonCodes: string[];
    };

export type MonetaryCoherenceState =
  | 'known_coherent'
  | 'unknown'
  | 'known_incoherent';

export type ReceiptMonetaryCoherenceEvidence = {
  receiptId: string;
  state: MonetaryCoherenceState;
  authoritativeLayer: 'ocr' | 'user' | null;
  discountOwnershipStatus: string | null;
  monetaryProvenanceSufficient: boolean;
  closureHypothesis: string | null;
  evidence: string[];
  reasonCodes: string[];
};

/** Only authorized shadow duplicate path in A1.4A. */
export type ShadowDuplicateCandidatePath = 'SHADOW_MERCHANT_METADATA_VARIANT';

export type ShadowDuplicateRelationEvidence = {
  leftCandidateId: string;
  rightCandidateId: string;
  leftSourceReceiptIds: string[];
  rightSourceReceiptIds: string[];
  path: ShadowDuplicateCandidatePath;
  evidence: string[];
};

export type ShadowDuplicateCandidateGroup = {
  path: ShadowDuplicateCandidatePath;
  candidateIds: string[];
  sourceReceiptIds: string[];
  relationEvidence: ShadowDuplicateRelationEvidence[];
  evidence: string[];
};

export type ShadowMerchantMetadataVariantEvaluation = {
  leftCandidateId: string;
  rightCandidateId: string;
  leftSourceReceiptIds: string[];
  rightSourceReceiptIds: string[];
  shadowDuplicateAuthorized: boolean;
  merchantCompatibility: MerchantEvidenceCompatibility | 'not_evaluated';
  basketCompatibility: 'strong' | 'weak' | 'incompatible' | 'not_evaluated';
  transactionAuthorization: 'authorized' | 'insufficient_provenance' | 'conflict' | 'not_evaluated';
  evidence: string[];
  reasonCodes: string[];
};

export type DateYearConflictDiagnostic = {
  caseSourceReceiptIds: string[];
  productionCandidateIds: string[];
  candidateSourceReceiptIds: Record<string, string[]>;
  observedYearsByReceiptId: Record<string, number | null>;
  observedYearProvenanceByReceiptId: Record<
    string,
    ReceiptTransactionTextProvenance | 'unknown'
  >;
  conflictingYears: number[];
  retailerSimilarity: 'same_retailer_key' | 'mixed' | 'unresolved';
  basketSimilarity: 'strong_vector_match' | 'partial' | 'weak' | 'unknown';
  transactionTimeSimilarity: 'compatible_minute_or_second' | 'partial' | 'unknown';
  shadowDuplicateAuthorized: false;
  reasonCodes: string[];
  evidence: string[];
};

export type ShadowRepresentativeRecommendation = {
  candidateId: string;
  sourceReceiptIds: string[];
  productionRepresentativeReceiptId: string;
  shadowRecommendedRepresentativeReceiptId: string;
  changed: boolean;
  monetarySelectionPool: MonetaryCoherenceState;
  noCoherentRepresentativeExists: boolean;
  evidence: string[];
  reasonCodes: string[];
};

export type GroundTruthCaseId = 'GT-002' | 'GT-017' | 'GT-019' | 'GT-020';

export type GroundTruthCaseShadowResult = {
  caseId: GroundTruthCaseId;
  sourceReceiptIds: string[];
  productionCandidateCount: number;
  productionCandidateIds: string[];
  externalCandidateIds: string[];
  productionHighConfidenceGroupCount: number;
  shadowDuplicateCandidateGroups: ShadowDuplicateCandidateGroup[];
  dateYearConflictDiagnostic: DateYearConflictDiagnostic | null;
  merchantMetadataVariantEvaluation: ShadowMerchantMetadataVariantEvaluation | null;
  shadowRepresentativeRecommendation: ShadowRepresentativeRecommendation | null;
  monetaryProvenanceNotes: string[];
  evidence: string[];
};

export type GroundTruthShadowAuditReport = {
  version: typeof RECEIPT_EVIDENCE_TRUTH_VERSION;
  storedReceiptCount: number;
  productionBaseline: {
    highConfidenceDuplicateExtras: number;
    analyticsPurchaseCandidateCount: number;
  };
  cases: GroundTruthCaseShadowResult[];
};

export type ProductionShadowCandidateSummary = {
  candidateId: string;
  representativeReceiptId: string;
  sourceReceiptIds: string[];
  productionDuplicateConfidence: CanonicalReceiptConfidence;
};
