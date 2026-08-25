/**
 * Meruno Analysis Foundation A1 — shared read-only types.
 *
 * Derived layer only. Does not mutate receipts, UI, OCR, save, sync, or stats.
 */

import type { ReceiptRow } from '../db';
import type { AnalysisDDuplicateConfidence } from '../analysisDDuplicateAudit';
import type {
  DerivedRetailerIdentityConfidence,
  DerivedRetailerIdentitySource,
} from '../retailerIdentity';

export const ANALYSIS_FOUNDATION_VERSION =
  'meruno-analysis-foundation-a1-v1' as const;

/** High-confidence physical-receipt duplicate (reuses Analysis D confidence ladder). */
export type CanonicalReceiptDuplicateConfidence = Extract<
  AnalysisDDuplicateConfidence,
  | 'CONTENT_EXACT_DUPLICATE'
  | 'STRUCTURAL_EXACT_DUPLICATE'
  | 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
>;

export type CanonicalReceiptConfidence =
  | CanonicalReceiptDuplicateConfidence
  | 'SINGLETON'
  | 'NOT_ENOUGH_EVIDENCE';

/**
 * Read-only physical-receipt grouping for one analysis snapshot.
 *
 * ID contract (A1.1):
 * - `ephemeralSnapshotGroupId` is a hash of the current membership
 *   (sorted sourceReceiptIds) for this derived snapshot only.
 * - It is NOT a persistent physical-receipt identity.
 * - It MUST NOT be stored as a durable key: membership changes (new scan
 *   joined / split) may change the id even for the “same” real-world receipt.
 * - No DB persistence in A1 / A1.1.
 */
export type CanonicalReceiptGroup = {
  /**
   * Ephemeral snapshot group id = hash(sorted sourceReceiptIds).
   * Callers must not treat this as a durable physical receipt id.
   */
  ephemeralSnapshotGroupId: string;
  representativeReceipt: ReceiptRow;
  sourceReceiptIds: string[];
  duplicateCount: number;
  confidence: CanonicalReceiptConfidence;
  evidence: string[];
};

export type BasketMergeConfidence = 'high' | 'medium' | 'low' | 'none';

export type ConsolidatedBasketLine = {
  quantity: number;
  unitPrice: number | null;
  lineTotal: number;
  displayName: string;
  mergeConfidence: BasketMergeConfidence;
  mergeEvidence: string[];
  sourceItemIndexes: number[];
  /** Stable merge bucket key when identity was used; null for unmerged singleton lines. */
  identityBucketKey: string | null;
};

export type ConsolidatedBasket = {
  receiptId: string;
  lines: ConsolidatedBasketLine[];
  unmergedLineCount: number;
};

export type CanonicalMerchant = {
  retailerKey: string | null;
  displayName: string | null;
  /** Parse residue / branch hint — NOT verified store identity. */
  storeBranch: string | null;
  confidence: DerivedRetailerIdentityConfidence;
  source: DerivedRetailerIdentitySource;
  /** V1 analytics aggregation key (unchanged contract). */
  analyticsKey: string;
};

export type PriceComparisonRejectReason =
  | 'identity_unresolved'
  | 'identity_low_confidence'
  | 'variant_spec_incomparable'
  | 'currency_mismatch'
  | 'invalid_quantity_basis'
  | 'invalid_price'
  | 'duplicate_receipt_observation'
  | 'non_product_row'
  | 'price_quality_invalid'
  | 'price_quality_suspected_anomaly';

export type PriceComparisonEligibility = {
  eligible: boolean;
  reasonCodes: PriceComparisonRejectReason[];
};

export type PurchaseCycleRejectReason =
  | 'identity_unresolved'
  | 'identity_low_confidence'
  | 'duplicate_receipt_extra'
  | 'transaction_at_missing';

/**
 * Temporal precision for purchase-cycle observations.
 * - exact_time: clock time available (eligible for day-level AND session proximity)
 * - date_only: calendar date only (day-level purchase-cycle OK; NOT for shopping-session proximity)
 */
export type TransactionTemporalPrecision = 'exact_time' | 'date_only';

export type PurchaseCycleEligibility = {
  eligible: boolean;
  reasonCodes: PurchaseCycleRejectReason[];
  /**
   * Set when transaction_at is valid. Absent when rejected for missing transaction_at.
   * date_only may still be eligible for day-level purchase-cycle analysis.
   */
  temporalPrecision: TransactionTemporalPrecision | null;
};

export type MerchantPatternRejectReason =
  | 'merchant_unresolved'
  | 'analytics_key_empty';

export type MerchantPatternEligibility = {
  eligible: boolean;
  reasonCodes: MerchantPatternRejectReason[];
};

export type ShoppingSessionCandidateConfidence = 'low' | 'medium' | 'high';

/** Always a candidate — never promoted to confirmed shopping trip. */
export type ShoppingSessionCandidate = {
  status: 'candidate';
  receiptIds: string[];
  startAt: number;
  endAt: number;
  merchantKeys: string[];
  confidence: ShoppingSessionCandidateConfidence;
  evidence: string[];
};

export type ShoppingSessionCandidateConfig = {
  /** Require Asia/Tokyo calendar-day match. */
  sameCalendarDayRequired: boolean;
  /** Max gap (minutes) between adjacent receipts to stay in one candidate cluster. */
  adjacentMaxMinutes: number;
  /** Gap at or below this raises confidence (still candidate only). */
  strongGapMinutes: number;
  /**
   * Max total span (minutes) from first→last receipt in one candidate.
   * Adjacent gaps alone must not chain forever — split when span would exceed this.
   */
  maxSessionSpanMinutes: number;
};

export const DEFAULT_SHOPPING_SESSION_CANDIDATE_CONFIG: ShoppingSessionCandidateConfig =
  {
    sameCalendarDayRequired: true,
    adjacentMaxMinutes: 120,
    strongGapMinutes: 60,
    maxSessionSpanMinutes: 180,
  };
