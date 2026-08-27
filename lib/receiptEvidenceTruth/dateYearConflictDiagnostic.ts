/**
 * A1.4A — Diagnostic-only date/year conflict similarity (NOT duplicate authorization).
 */

import type { ReceiptRow } from '../db';
import type { ProductionShadowCandidateNode } from './shadowCandidateNode';
import { stableSortedStrings } from './shadowPairGates';
import {
  buildReceiptTransactionEvidence,
  calendarYearFromTransactionEvidence,
  diagnosticClockSimilarity,
} from './transactionEvidence';
import type { DateYearConflictDiagnostic } from './types';
import { rawBasketVectorsEqual, validateRawOcrItemBasket } from './rawItemValidation';

function assessBasketSimilarity(
  candidates: readonly ProductionShadowCandidateNode[]
): DateYearConflictDiagnostic['basketSimilarity'] {
  if (candidates.length < 2) return 'unknown';
  const first = validateRawOcrItemBasket(candidates[0]!.representativeReceipt);
  if (!first.ok) return 'weak';
  for (let i = 1; i < candidates.length; i += 1) {
    const next = validateRawOcrItemBasket(candidates[i]!.representativeReceipt);
    if (!next.ok) return 'partial';
    if (!rawBasketVectorsEqual(first.rows, next.rows)) return 'partial';
  }
  return 'strong_vector_match';
}

function assessRetailerSimilarity(
  candidates: readonly ProductionShadowCandidateNode[]
): DateYearConflictDiagnostic['retailerSimilarity'] {
  const keys = new Set(
    candidates.map((c) => c.merchant.retailerKey).filter(Boolean) as string[]
  );
  if (keys.size === 0) return 'unresolved';
  if (keys.size === 1) return 'same_retailer_key';
  return 'mixed';
}

function assessTransactionTimeSimilarity(
  candidates: readonly ProductionShadowCandidateNode[],
  receiptById: ReadonlyMap<string, ReceiptRow>
): DateYearConflictDiagnostic['transactionTimeSimilarity'] {
  if (candidates.length < 2) return 'unknown';
  let score: DateYearConflictDiagnostic['transactionTimeSimilarity'] =
    'compatible_minute_or_second';

  const sourceIds = new Set<string>();
  for (const candidate of candidates) {
    for (const id of candidate.sourceReceiptIds) sourceIds.add(id);
  }

  const evidenceList = [...sourceIds]
    .map((id) => {
      const receipt = receiptById.get(id);
      return receipt ? buildReceiptTransactionEvidence(receipt) : null;
    })
    .filter((tx): tx is NonNullable<typeof tx> => tx != null);

  for (let i = 0; i < evidenceList.length; i += 1) {
    for (let j = i + 1; j < evidenceList.length; j += 1) {
      const sim = diagnosticClockSimilarity(evidenceList[i]!, evidenceList[j]!);
      if (sim === 'unknown') return 'unknown';
      if (sim === 'partial') score = 'partial';
    }
  }
  return score;
}

function observedYearProvenanceLabel(
  receipt: ReceiptRow | undefined
): DateYearConflictDiagnostic['observedYearProvenanceByReceiptId'][string] {
  if (!receipt) return 'unknown';
  const tx = buildReceiptTransactionEvidence(receipt);
  if (tx.parsedFromStructuredDerived?.year != null) {
    return tx.textProvenance;
  }
  if (tx.parsedFromDiagnosticOcr?.year != null) {
    return tx.textProvenance;
  }
  return 'unknown';
}

export function buildDateYearConflictDiagnostic(
  caseSourceReceiptIds: readonly string[],
  caseCandidates: readonly ProductionShadowCandidateNode[],
  receiptById: ReadonlyMap<string, ReceiptRow>
): DateYearConflictDiagnostic {
  const observedYearsByReceiptId: Record<string, number | null> = {};
  const observedYearProvenanceByReceiptId: DateYearConflictDiagnostic['observedYearProvenanceByReceiptId'] =
    {};

  for (const id of caseSourceReceiptIds) {
    const receipt = receiptById.get(id);
    if (!receipt) {
      observedYearsByReceiptId[id] = null;
      observedYearProvenanceByReceiptId[id] = 'unknown';
      continue;
    }
    const tx = buildReceiptTransactionEvidence(receipt);
    observedYearsByReceiptId[id] = calendarYearFromTransactionEvidence(tx);
    observedYearProvenanceByReceiptId[id] = observedYearProvenanceLabel(receipt);
  }

  const conflictingYears = [
    ...new Set(
      Object.values(observedYearsByReceiptId).filter(
        (y): y is number => y != null && Number.isFinite(y)
      )
    ),
  ].sort((a, b) => a - b);

  const candidateSourceReceiptIds: Record<string, string[]> = {};
  for (const c of caseCandidates) {
    candidateSourceReceiptIds[c.candidateId] = stableSortedStrings(c.sourceReceiptIds);
  }

  const reasonCodes: string[] = [];
  if (conflictingYears.length > 1) {
    reasonCodes.push('conflicting_observed_years');
  }
  reasonCodes.push('diagnostic_only_not_duplicate_authorization');
  reasonCodes.push('no_year_correction_applied');
  reasonCodes.push('per_source_receipt_year_attribution');

  return {
    caseSourceReceiptIds: stableSortedStrings(caseSourceReceiptIds),
    productionCandidateIds: stableSortedStrings(
      caseCandidates.map((c) => c.candidateId)
    ),
    candidateSourceReceiptIds,
    observedYearsByReceiptId,
    observedYearProvenanceByReceiptId,
    conflictingYears,
    retailerSimilarity: assessRetailerSimilarity(caseCandidates),
    basketSimilarity: assessBasketSimilarity(caseCandidates),
    transactionTimeSimilarity: assessTransactionTimeSimilarity(
      caseCandidates,
      receiptById
    ),
    shadowDuplicateAuthorized: false,
    reasonCodes: stableSortedStrings(reasonCodes),
    evidence: stableSortedStrings([
      `production_candidate_count=${caseCandidates.length}`,
      `source_receipt_count=${caseSourceReceiptIds.length}`,
      `conflicting_years=${conflictingYears.join(',') || 'none'}`,
      'strong_rescan_similarity_diagnostic_only',
      'source_qualified_year_evidence_no_representative_substitution',
    ]),
  };
}
