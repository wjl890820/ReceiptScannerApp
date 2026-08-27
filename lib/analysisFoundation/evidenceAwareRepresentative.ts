/**
 * A1.4B-1 — Strict evidence-aware representative override for production
 * CanonicalReceiptGroup construction.
 *
 * Membership is immutable. Only the representative may change, and only when:
 * - baseline is NOT trusted, AND
 * - at least one trusted alternative exists
 *   (known_coherent && monetaryProvenanceSufficient).
 *
 * Does NOT promote shadow tri-state ranking (unknown over known_incoherent).
 * Reuses A1.4A buildReceiptMonetaryCoherenceEvidence — no second monetary truth.
 */

import type { ReceiptRow } from '../db';
import { buildReceiptMonetaryCoherenceEvidence } from '../receiptEvidenceTruth/monetaryCoherenceEvidence';
import {
  pickBestRepresentativeReceiptId,
  type RepresentativeQualitySummary,
} from '../receiptRepresentativeQuality';

export type EvidenceAwareRepresentativeResult = {
  representativeId: string;
  baselineRepresentativeId: string;
  changed: boolean;
  reason:
    | 'baseline_already_trusted'
    | 'no_trusted_alternative'
    | 'trusted_monetary_override';
};

export function isTrustedMonetaryRepresentative(receipt: ReceiptRow): boolean {
  const evidence = buildReceiptMonetaryCoherenceEvidence(receipt);
  return (
    evidence.state === 'known_coherent' &&
    evidence.monetaryProvenanceSufficient === true
  );
}

/**
 * Strict override: keep baseline when trusted or when no trusted alternative
 * exists. Otherwise pick among trusted candidates only via existing quality SSOT.
 */
export function applyEvidenceAwareRepresentativeOverride(args: {
  baselineRepresentativeId: string;
  sourceReceiptIds: readonly string[];
  receiptById: ReadonlyMap<string, ReceiptRow>;
  memberSummaries: readonly RepresentativeQualitySummary[];
}): EvidenceAwareRepresentativeResult {
  const sourceIds = [...args.sourceReceiptIds];
  const baselineRepresentativeId = sourceIds.includes(args.baselineRepresentativeId)
    ? args.baselineRepresentativeId
    : sourceIds.slice().sort((a, b) => a.localeCompare(b))[0]!;

  const baselineReceipt = args.receiptById.get(baselineRepresentativeId);
  if (baselineReceipt && isTrustedMonetaryRepresentative(baselineReceipt)) {
    return {
      representativeId: baselineRepresentativeId,
      baselineRepresentativeId,
      changed: false,
      reason: 'baseline_already_trusted',
    };
  }

  const trustedIds = sourceIds.filter((id) => {
    const receipt = args.receiptById.get(id);
    return receipt != null && isTrustedMonetaryRepresentative(receipt);
  });

  if (trustedIds.length === 0) {
    return {
      representativeId: baselineRepresentativeId,
      baselineRepresentativeId,
      changed: false,
      reason: 'no_trusted_alternative',
    };
  }

  const trustedIdSet = new Set(trustedIds);
  const trustedSummaries = args.memberSummaries.filter((s) =>
    trustedIdSet.has(s.receiptId)
  );
  const winner = pickBestRepresentativeReceiptId(
    trustedSummaries.length > 0
      ? trustedSummaries
      : trustedIds.map((id) => {
          const fromMembers = args.memberSummaries.find((s) => s.receiptId === id);
          if (fromMembers) return fromMembers;
          // Defensive: should not happen when callers pass group member summaries.
          const receipt = args.receiptById.get(id)!;
          return {
            receiptId: id,
            merchandiseSum: Number(receipt.total) || 0,
            total: Number(receipt.total) || 0,
            itemCount: 0,
            hasExactTransactionTime: false,
            hasValidTransactionAt: receipt.transaction_at != null,
            taxKnown: receipt.tax_is_known === 1,
            structuralFingerprint: null,
            createdAt: receipt.created_at,
          };
        }),
    args.receiptById
  );

  return {
    representativeId: winner,
    baselineRepresentativeId,
    changed: winner !== baselineRepresentativeId,
    reason: 'trusted_monetary_override',
  };
}
