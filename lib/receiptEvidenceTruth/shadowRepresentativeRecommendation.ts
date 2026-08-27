/**
 * A1.4A — Shadow evidence-aware representative recommendation (read-only).
 *
 * Public API requires an existing production CanonicalReceiptGroup.
 */

import type { ReceiptRow } from '../db';
import type { CanonicalReceiptGroup } from '../analysisFoundation/types';
import {
  summarizeReceiptForDuplicateAudit,
  type AnalysisDDuplicateReceiptSummary,
} from '../analysisDDuplicateAudit';
import {
  pickBestRepresentativeReceiptId,
  type RepresentativeQualitySummary,
} from '../receiptRepresentativeQuality';
import {
  buildReceiptMonetaryCoherenceEvidence,
  monetaryCoherenceRank,
} from './monetaryCoherenceEvidence';
import { stableSortedStrings } from './shadowPairGates';
import type {
  MonetaryCoherenceState,
  ShadowRepresentativeRecommendation,
} from './types';

function toQualitySummary(
  summary: AnalysisDDuplicateReceiptSummary
): RepresentativeQualitySummary {
  return {
    receiptId: summary.receiptId,
    merchandiseSum: summary.merchandiseSum,
    total: summary.total,
    itemCount: summary.itemCount,
    hasExactTransactionTime: summary.hasExactTransactionTime,
    hasValidTransactionAt: summary.hasValidTransactionAt,
    taxKnown: summary.taxKnown,
    structuralFingerprint: summary.structuralFingerprint,
    createdAt: summary.createdAt,
  };
}

function selectMonetaryPool(
  memberIds: readonly string[],
  receiptById: ReadonlyMap<string, ReceiptRow>
): {
  poolIds: string[];
  poolLabel: MonetaryCoherenceState;
  noCoherentRepresentativeExists: boolean;
} {
  const states = memberIds.map((id) =>
    buildReceiptMonetaryCoherenceEvidence(receiptById.get(id)!)
  );
  const coherentIds = memberIds.filter(
    (_, i) => states[i]!.state === 'known_coherent'
  );
  if (coherentIds.length > 0) {
    return {
      poolIds: stableSortedStrings(coherentIds),
      poolLabel: 'known_coherent',
      noCoherentRepresentativeExists: false,
    };
  }
  const unknownIds = memberIds.filter((_, i) => states[i]!.state === 'unknown');
  if (unknownIds.length > 0) {
    return {
      poolIds: stableSortedStrings(unknownIds),
      poolLabel: 'unknown',
      noCoherentRepresentativeExists: true,
    };
  }
  return {
    poolIds: stableSortedStrings(memberIds),
    poolLabel: 'known_incoherent',
    noCoherentRepresentativeExists: true,
  };
}

function pickShadowRepresentativeWithinGroup(
  memberSummaries: readonly AnalysisDDuplicateReceiptSummary[],
  receiptById: ReadonlyMap<string, ReceiptRow>
): string {
  const memberIds = memberSummaries.map((s) => s.receiptId);
  const { poolIds } = selectMonetaryPool(memberIds, receiptById);
  const poolSummaries = poolIds
    .map((id) => memberSummaries.find((s) => s.receiptId === id))
    .filter((s): s is AnalysisDDuplicateReceiptSummary => s != null)
    .map(toQualitySummary);
  return pickBestRepresentativeReceiptId(poolSummaries, receiptById);
}

export function buildShadowRepresentativeRecommendation(
  canonicalGroup: CanonicalReceiptGroup,
  receipts: readonly ReceiptRow[]
): ShadowRepresentativeRecommendation {
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const sourceReceiptIds = stableSortedStrings(canonicalGroup.sourceReceiptIds);
  const groupReceipts = sourceReceiptIds
    .map((id) => receiptById.get(id))
    .filter((r): r is ReceiptRow => r != null);
  const summaries = groupReceipts.map(summarizeReceiptForDuplicateAudit);

  const productionRepresentativeReceiptId = canonicalGroup.representativeReceipt.id;
  const shadowRecommendedRepresentativeReceiptId =
    pickShadowRepresentativeWithinGroup(summaries, receiptById);

  const monetaryPool = selectMonetaryPool(sourceReceiptIds, receiptById);
  const reasonCodes: string[] = [];
  if (monetaryPool.noCoherentRepresentativeExists) {
    reasonCodes.push('no_known_coherent_representative_in_group');
  }
  if (productionRepresentativeReceiptId !== shadowRecommendedRepresentativeReceiptId) {
    reasonCodes.push('shadow_monetary_tri_state_pool_override');
  }

  const evidence = stableSortedStrings(
    sourceReceiptIds.map((id) => {
      const mon = buildReceiptMonetaryCoherenceEvidence(receiptById.get(id)!);
      return `receipt=${id};monetary_state=${mon.state};rank=${monetaryCoherenceRank(mon.state)};closure=${mon.closureHypothesis ?? 'none'}`;
    })
  );

  return {
    candidateId: canonicalGroup.ephemeralSnapshotGroupId,
    sourceReceiptIds,
    productionRepresentativeReceiptId,
    shadowRecommendedRepresentativeReceiptId,
    changed:
      productionRepresentativeReceiptId !== shadowRecommendedRepresentativeReceiptId,
    monetarySelectionPool: monetaryPool.poolLabel,
    noCoherentRepresentativeExists: monetaryPool.noCoherentRepresentativeExists,
    evidence,
    reasonCodes: stableSortedStrings(reasonCodes),
  };
}
