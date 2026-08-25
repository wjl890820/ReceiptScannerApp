/**
 * Meruno Analysis Foundation A1 — canonical read layer (read-only).
 *
 * Composes duplicate audit, retailer identity, product normalization, and
 * eligibility gates for downstream experiments. Does not wire into production stats/UI.
 */

export {
  ANALYSIS_FOUNDATION_VERSION,
  DEFAULT_SHOPPING_SESSION_CANDIDATE_CONFIG,
  type BasketMergeConfidence,
  type CanonicalMerchant,
  type CanonicalReceiptConfidence,
  type CanonicalReceiptDuplicateConfidence,
  type CanonicalReceiptGroup,
  type ConsolidatedBasket,
  type ConsolidatedBasketLine,
  type MerchantPatternEligibility,
  type MerchantPatternRejectReason,
  type PriceComparisonEligibility,
  type PriceComparisonRejectReason,
  type PurchaseCycleEligibility,
  type PurchaseCycleRejectReason,
  type ShoppingSessionCandidate,
  type ShoppingSessionCandidateConfidence,
  type ShoppingSessionCandidateConfig,
  type TransactionTemporalPrecision,
} from './types';

export {
  buildCanonicalReceiptGroups,
  buildEphemeralSnapshotGroupId,
  indexCanonicalReceiptGroupsByReceiptId,
  isDuplicateReceiptExtra,
  pickCanonicalRepresentativeReceipt,
  scoreReceiptRepresentativeQuality,
} from './canonicalReceipt';

export { deriveCanonicalMerchant } from './canonicalMerchant';

export { consolidateReceiptBasket } from './basketConsolidation';

export {
  evaluateMerchantPatternEligibility,
  evaluatePriceComparisonEligibility,
  evaluatePurchaseCycleEligibility,
  evaluateReceiptItemPriceComparisonEligibility,
  resolveTransactionTemporalPrecision,
  type PriceComparisonEligibilityInput,
  type PurchaseCycleEligibilityInput,
  type PriceObservationQualityLevel,
} from './eligibility';

export {
  buildShoppingSessionCandidates,
  receiptIdsInShoppingSessionCandidates,
} from './shoppingSessionCandidate';

import type { ReceiptRow } from '../db';
import { buildCanonicalReceiptGroups } from './canonicalReceipt';
import { consolidateReceiptBasket } from './basketConsolidation';
import { deriveCanonicalMerchant } from './canonicalMerchant';
import { buildShoppingSessionCandidates } from './shoppingSessionCandidate';
import type { ShoppingSessionCandidateConfig } from './types';
import type {
  CanonicalReceiptGroup,
  ConsolidatedBasket,
  ShoppingSessionCandidate,
} from './types';
import { ANALYSIS_FOUNDATION_VERSION } from './types';

export type AnalysisFoundationSnapshot = {
  version: typeof ANALYSIS_FOUNDATION_VERSION;
  canonicalReceiptGroups: CanonicalReceiptGroup[];
  shoppingSessionCandidates: ShoppingSessionCandidate[];
};

/** Build the full A1 read snapshot for a receipt corpus (pure, deterministic). */
export function buildAnalysisFoundationSnapshot(
  receipts: ReceiptRow[],
  shoppingConfig?: ShoppingSessionCandidateConfig
): AnalysisFoundationSnapshot {
  const canonicalReceiptGroups = buildCanonicalReceiptGroups(receipts);
  const shoppingSessionCandidates = buildShoppingSessionCandidates(
    receipts,
    shoppingConfig
  );
  return {
    version: ANALYSIS_FOUNDATION_VERSION,
    canonicalReceiptGroups,
    shoppingSessionCandidates,
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
