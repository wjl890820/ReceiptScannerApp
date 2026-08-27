/**
 * A1.4A — Ground Truth shadow audit (read-only).
 */

import { selectAnalyticsReceipts } from '../analyticsReceiptSelection';
import {
  buildHighConfidenceDuplicateGroups,
  summarizeReceiptForDuplicateAudit,
} from '../analysisDDuplicateAudit';
import type { ReceiptRow } from '../db';
import { buildDateYearConflictDiagnostic } from './dateYearConflictDiagnostic';
import {
  buildProductionShadowCandidateNodes,
  countProductionCandidatesForReceiptIds,
  findProductionCanonicalGroupForReceiptIds,
  findProductionShadowCandidateForReceiptIds,
} from './shadowCandidateNode';
import { buildReceiptMonetaryCoherenceEvidence } from './monetaryCoherenceEvidence';
import { buildReceiptMerchantEvidence } from './merchantEvidence';
import {
  buildShadowDuplicateCandidateGroups,
  evaluateShadowMerchantMetadataVariantDetailed,
} from './shadowDuplicateCandidates';
import { buildShadowRepresentativeRecommendation } from './shadowRepresentativeRecommendation';
import { stableSortedStrings } from './shadowPairGates';
import {
  buildReceiptTransactionEvidence,
  calendarYearFromTransactionEvidence,
} from './transactionEvidence';
import type {
  GroundTruthCaseId,
  GroundTruthCaseShadowResult,
  GroundTruthShadowAuditReport,
  ShadowDuplicateCandidateGroup,
} from './types';
import { RECEIPT_EVIDENCE_TRUTH_VERSION } from './types';

export const GROUND_TRUTH_CASE_RECEIPT_IDS: Record<
  GroundTruthCaseId,
  readonly string[]
> = {
  'GT-002': [
    'C_aMA69ijcqNLhGI76Y5Q',
    '4a1-xfRs0jLc9QREdaKcb',
    'ElhqdUr9SU-xD-1s5JbS3',
    'NEHGZCkqd8MiBCyKO-fWd',
    '2bDvMWs3dkCKagyrYWyxA',
    'n6_vGM5c8X255Psyiup4k',
  ],
  'GT-017': ['_KWltUWmzEA2ubrHWh3zF', 'OzH_95aHPw9Claz4oXpJH'],
  'GT-019': [
    'pbU0NavDejcsAEM7fGlMB',
    '9Brk_HjDEvLeBD2i6c7Hb',
    'eXTXbcHrAJ8F1_nFYS2Zy',
    'HpHmXmADOv2E90biOTdab',
  ],
  'GT-020': ['pE9Qa_k-wlYkOLltAFbEi'],
};

function intersectsSourceIds(
  caseIds: readonly string[],
  groupSourceIds: readonly string[]
): boolean {
  const set = new Set(groupSourceIds);
  return caseIds.some((id) => set.has(id));
}

function isGroupContainedInCase(
  group: ShadowDuplicateCandidateGroup,
  caseCandidateIds: ReadonlySet<string>
): boolean {
  return group.candidateIds.every((id) => caseCandidateIds.has(id));
}

function filterCaseContainedShadowGroups(
  shadowGroups: readonly ShadowDuplicateCandidateGroup[],
  caseCandidateIds: ReadonlySet<string>
): ShadowDuplicateCandidateGroup[] {
  return shadowGroups.filter((g) => isGroupContainedInCase(g, caseCandidateIds));
}

function externalCandidateIdsForCase(
  shadowGroups: readonly ShadowDuplicateCandidateGroup[],
  caseCandidateIds: ReadonlySet<string>
): string[] {
  const external = new Set<string>();
  for (const group of shadowGroups) {
    const touchesCase = group.candidateIds.some((id) => caseCandidateIds.has(id));
    if (!touchesCase) continue;
    for (const id of group.candidateIds) {
      if (!caseCandidateIds.has(id)) external.add(id);
    }
  }
  return stableSortedStrings([...external]);
}

function evaluateGroundTruthCase(
  caseId: GroundTruthCaseId,
  receiptIds: readonly string[],
  allReceipts: readonly ReceiptRow[],
  shadowGroups: ReturnType<typeof buildShadowDuplicateCandidateGroups>,
  productionGroups: ReturnType<typeof buildHighConfidenceDuplicateGroups>,
  candidateNodes: ReturnType<typeof buildProductionShadowCandidateNodes>
): GroundTruthCaseShadowResult {
  const presentIds = stableSortedStrings(
    receiptIds.filter((id) => allReceipts.some((r) => r.id === id))
  );

  const caseCandidates = findProductionShadowCandidateForReceiptIds(
    presentIds,
    candidateNodes
  );
  const caseCandidateIds = new Set(caseCandidates.map((c) => c.candidateId));
  const productionCandidateIds = stableSortedStrings([...caseCandidateIds]);

  const caseShadowGroups = filterCaseContainedShadowGroups(
    shadowGroups.filter((g) =>
      g.candidateIds.some((id) => caseCandidateIds.has(id))
    ),
    caseCandidateIds
  );

  const externalCandidateIds = externalCandidateIdsForCase(
    shadowGroups,
    caseCandidateIds
  );

  const productionHighConfidenceGroupCount = productionGroups.filter((g) =>
    intersectsSourceIds(presentIds, g.receiptIds)
  ).length;

  let shadowRepresentativeRecommendation = null;
  if (caseId === 'GT-019') {
    const canonicalGroup = findProductionCanonicalGroupForReceiptIds(
      presentIds,
      allReceipts
    );
    if (canonicalGroup && canonicalGroup.sourceReceiptIds.length >= 2) {
      shadowRepresentativeRecommendation = buildShadowRepresentativeRecommendation(
        canonicalGroup,
        allReceipts
      );
    }
  }

  let dateYearConflictDiagnostic = null;
  if (caseId === 'GT-002' && caseCandidates.length >= 2) {
    const receiptById = new Map(allReceipts.map((r) => [r.id, r]));
    dateYearConflictDiagnostic = buildDateYearConflictDiagnostic(
      presentIds,
      caseCandidates,
      receiptById
    );
  }

  let merchantMetadataVariantEvaluation = null;
  if (caseId === 'GT-017' && caseCandidates.length === 2) {
    merchantMetadataVariantEvaluation = evaluateShadowMerchantMetadataVariantDetailed(
      caseCandidates[0]!,
      caseCandidates[1]!
    );
  }

  const monetaryProvenanceNotes: string[] = [];
  const evidence: string[] = [];

  for (const id of presentIds) {
    const receipt = allReceipts.find((r) => r.id === id)!;
    const tx = buildReceiptTransactionEvidence(receipt);
    const merchant = buildReceiptMerchantEvidence(receipt);
    const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
    const year = calendarYearFromTransactionEvidence(tx);

    evidence.push(
      `receipt=${id};tx_precision=${tx.precision};tx_year=${year ?? 'unknown'};tx_consistency=${tx.consistencyState};tx_shadow_authorizable=${tx.shadowAuthorizable};retailerKey=${merchant.retailerKey ?? 'null'};storeHintStatus=${merchant.storeHintEvidenceStatus}`
    );

    if (caseId === 'GT-002') {
      if (tx.consistencyState === 'conflict') {
        evidence.push(`GT-002_date_conflict:${id}`);
      }
      if (year != null) evidence.push(`GT-002_analysis_year:${id}=${year}`);
    }

    if (caseId === 'GT-017') {
      evidence.push(
        `GT-017_merchant:${id};retailerKey=${merchant.retailerKey};storeHint=${merchant.storeHint ?? 'missing'};status=${merchant.storeHintEvidenceStatus}`
      );
    }

    if (caseId === 'GT-020') {
      monetaryProvenanceNotes.push(
        `receipt=${id};discountOwnership=${monetary.discountOwnershipStatus};monetaryState=${monetary.state};monetaryProvenanceSufficient=${monetary.monetaryProvenanceSufficient};reasonCodes=${monetary.reasonCodes.join(',')}`
      );
    }
  }

  for (const candidate of caseCandidates) {
    evidence.push(
      `production_candidate=${candidate.candidateId};representative=${candidate.representativeReceiptId};sourceReceiptIds=${candidate.sourceReceiptIds.join(',')};confidence=${candidate.productionDuplicateConfidence}`
    );
  }

  if (externalCandidateIds.length > 0) {
    evidence.push(`external_candidate_ids=${externalCandidateIds.join(',')}`);
  }

  return {
    caseId,
    sourceReceiptIds: presentIds,
    productionCandidateCount: countProductionCandidatesForReceiptIds(
      presentIds,
      candidateNodes
    ),
    productionCandidateIds,
    externalCandidateIds,
    productionHighConfidenceGroupCount,
    shadowDuplicateCandidateGroups: caseShadowGroups,
    dateYearConflictDiagnostic,
    merchantMetadataVariantEvaluation,
    shadowRepresentativeRecommendation,
    monetaryProvenanceNotes: stableSortedStrings(monetaryProvenanceNotes),
    evidence: stableSortedStrings(evidence),
  };
}

export function buildGroundTruthShadowAudit(
  receipts: readonly ReceiptRow[]
): GroundTruthShadowAuditReport {
  const selection = selectAnalyticsReceipts([...receipts]);
  const summaries = selection.storedReceipts.map(summarizeReceiptForDuplicateAudit);
  const productionGroups = buildHighConfidenceDuplicateGroups(
    summaries,
    selection.storedReceipts
  );
  const candidateNodes = buildProductionShadowCandidateNodes(receipts);
  const shadowGroups = buildShadowDuplicateCandidateGroups(receipts);

  const cases = (Object.keys(GROUND_TRUTH_CASE_RECEIPT_IDS) as GroundTruthCaseId[]).map(
    (caseId) =>
      evaluateGroundTruthCase(
        caseId,
        GROUND_TRUTH_CASE_RECEIPT_IDS[caseId],
        receipts,
        shadowGroups,
        productionGroups,
        candidateNodes
      )
  );

  return {
    version: RECEIPT_EVIDENCE_TRUTH_VERSION,
    storedReceiptCount: selection.storedReceipts.length,
    productionBaseline: {
      highConfidenceDuplicateExtras: selection.highConfidenceDuplicateExtras,
      analyticsPurchaseCandidateCount: selection.analyticsPurchaseCandidateCount,
    },
    cases,
  };
}
