/**
 * A1.4A — Shadow duplicate candidate evaluation at production-candidate level.
 *
 * Only SHADOW_MERCHANT_METADATA_VARIANT may authorize shadow duplicate relations.
 * Date/year conflict is diagnostic-only (see dateYearConflictDiagnostic.ts).
 */

import type { ReceiptRow } from '../db';
import {
  evaluateMerchantEvidenceCompatibility,
  isMerchantEvidenceShadowCompatible,
  merchantMetadataVariantRequiresDifferentKeys,
} from './merchantEvidence';
import {
  buildProductionShadowCandidateNodes,
  buildSubstantiatedCandidateView,
  type ProductionShadowCandidateNode,
} from './shadowCandidateNode';
import {
  evaluateShadowBasketGate,
  orientCandidatePair,
  stableSortedStrings,
} from './shadowPairGates';
import { precisionCompatibleClockMatch } from './transactionEvidence';
import type {
  ShadowDuplicateCandidateGroup,
  ShadowDuplicateRelationEvidence,
  ShadowMerchantMetadataVariantEvaluation,
} from './types';

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u001f${b}` : `${b}\u001f${a}`;
}

function buildRelationEvidence(
  left: ProductionShadowCandidateNode,
  right: ProductionShadowCandidateNode,
  extraEvidence: readonly string[]
): ShadowDuplicateRelationEvidence {
  return {
    leftCandidateId: left.candidateId,
    rightCandidateId: right.candidateId,
    leftSourceReceiptIds: stableSortedStrings(left.sourceReceiptIds),
    rightSourceReceiptIds: stableSortedStrings(right.sourceReceiptIds),
    path: 'SHADOW_MERCHANT_METADATA_VARIANT',
    evidence: stableSortedStrings(extraEvidence),
  };
}

function evaluateLeafMerchantMetadataVariantPair(
  left: ProductionShadowCandidateNode,
  right: ProductionShadowCandidateNode
): ShadowDuplicateRelationEvidence | null {
  const merchantCompat = evaluateMerchantEvidenceCompatibility(
    left.merchant,
    right.merchant
  );
  if (!isMerchantEvidenceShadowCompatible(merchantCompat)) return null;
  if (!merchantMetadataVariantRequiresDifferentKeys(left.merchant, right.merchant)) {
    return null;
  }

  const basket = evaluateShadowBasketGate(left, right);
  if (!basket.ok) return null;

  if (!precisionCompatibleClockMatch(left.transaction, right.transaction)) {
    return null;
  }

  return buildRelationEvidence(left, right, [
    ...merchantCompat.evidence,
    ...basket.evidence,
    'merchant_metadata_variant',
    'shadow_duplicate_authorized',
  ]);
}

/** Exported pair evaluator — orients candidates first for determinism. */
export function evaluateShadowMerchantMetadataVariantPair(
  a: ProductionShadowCandidateNode,
  b: ProductionShadowCandidateNode
): ShadowDuplicateRelationEvidence | null {
  const { left, right } = orientCandidatePair(a, b);
  return evaluateLeafMerchantMetadataVariantPair(left, right);
}

export function evaluateShadowMerchantMetadataVariantDetailed(
  a: ProductionShadowCandidateNode,
  b: ProductionShadowCandidateNode
): ShadowMerchantMetadataVariantEvaluation {
  const { left, right } = orientCandidatePair(a, b);
  const merchantCompat = evaluateMerchantEvidenceCompatibility(
    left.merchant,
    right.merchant
  );

  let basketCompatibility: ShadowMerchantMetadataVariantEvaluation['basketCompatibility'] =
    'not_evaluated';
  const basket = evaluateShadowBasketGate(left, right);
  if (basket.ok) {
    basketCompatibility = 'strong';
  } else if (
    basket.reason.includes('item_name_incompatible') ||
    basket.reason.includes('raw_basket') ||
    basket.reason.includes('qty_amount')
  ) {
    basketCompatibility = 'incompatible';
  } else {
    basketCompatibility = 'weak';
  }

  let transactionAuthorization: ShadowMerchantMetadataVariantEvaluation['transactionAuthorization'] =
    'not_evaluated';
  if (
    left.transaction.consistencyState === 'conflict' ||
    right.transaction.consistencyState === 'conflict'
  ) {
    transactionAuthorization = 'conflict';
  } else if (
    !left.transaction.shadowAuthorizable ||
    !right.transaction.shadowAuthorizable
  ) {
    transactionAuthorization = 'insufficient_provenance';
  } else if (precisionCompatibleClockMatch(left.transaction, right.transaction)) {
    transactionAuthorization = 'authorized';
  } else {
    transactionAuthorization = 'insufficient_provenance';
  }

  const relation = evaluateLeafMerchantMetadataVariantPair(left, right);
  const shadowDuplicateAuthorized = relation != null;

  return {
    leftCandidateId: left.candidateId,
    rightCandidateId: right.candidateId,
    leftSourceReceiptIds: stableSortedStrings(left.sourceReceiptIds),
    rightSourceReceiptIds: stableSortedStrings(right.sourceReceiptIds),
    shadowDuplicateAuthorized,
    merchantCompatibility: merchantCompat.compatibility,
    basketCompatibility,
    transactionAuthorization,
    evidence: stableSortedStrings([
      ...(relation?.evidence ?? []),
      `merchant_compatibility=${merchantCompat.compatibility}`,
      `basket_compatibility=${basketCompatibility}`,
      `transaction_authorization=${transactionAuthorization}`,
    ]),
    reasonCodes: stableSortedStrings([
      ...merchantCompat.reasonCodes,
      ...(shadowDuplicateAuthorized ? [] : ['shadow_duplicate_not_authorized']),
    ]),
  };
}

function orderedSourcePairs(
  leftIds: readonly string[],
  rightIds: readonly string[]
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const left of stableSortedStrings(leftIds)) {
    for (const right of stableSortedStrings(rightIds)) {
      if (left === right) continue;
      pairs.push([left, right]);
    }
  }
  return pairs;
}

function evaluateCandidateLevelShadowPair(
  nodeA: ProductionShadowCandidateNode,
  nodeB: ProductionShadowCandidateNode,
  receiptById: ReadonlyMap<string, ReceiptRow>
): ShadowDuplicateRelationEvidence | null {
  const { left: nodeLeft, right: nodeRight } = orientCandidatePair(nodeA, nodeB);
  const direct = evaluateLeafMerchantMetadataVariantPair(nodeLeft, nodeRight);
  if (direct) return direct;

  for (const [sourceA, sourceB] of orderedSourcePairs(
    nodeLeft.sourceReceiptIds,
    nodeRight.sourceReceiptIds
  )) {
    const viewA = buildSubstantiatedCandidateView(nodeLeft, sourceA, receiptById);
    const viewB = buildSubstantiatedCandidateView(nodeRight, sourceB, receiptById);
    if (!viewA || !viewB) continue;
    const rel = evaluateLeafMerchantMetadataVariantPair(viewA, viewB);
    if (!rel) continue;
    return buildRelationEvidence(nodeLeft, nodeRight, [
      ...rel.evidence,
      `substantiated_source_pair=${sourceA}|${sourceB}`,
    ]);
  }
  return null;
}

function clusterCompleteLink(
  sortedCandidateIds: string[],
  relationByPair: Map<string, ShadowDuplicateRelationEvidence>,
  nodeById: ReadonlyMap<string, ProductionShadowCandidateNode>
): ShadowDuplicateCandidateGroup[] {
  const assigned = new Set<string>();
  const groups: ShadowDuplicateCandidateGroup[] = [];

  for (const seed of sortedCandidateIds) {
    if (assigned.has(seed)) continue;
    const cluster = [seed];
    for (const candidate of sortedCandidateIds) {
      if (candidate === seed || assigned.has(candidate)) continue;
      const compatible = cluster.every((member) =>
        relationByPair.has(pairKey(member, candidate))
      );
      if (compatible) cluster.push(candidate);
    }
    if (cluster.length < 2) continue;
    for (const id of cluster) assigned.add(id);

    const candidateIds = stableSortedStrings(cluster);
    const relationEvidence: ShadowDuplicateRelationEvidence[] = [];
    for (let i = 0; i < candidateIds.length; i += 1) {
      for (let j = i + 1; j < candidateIds.length; j += 1) {
        const rel = relationByPair.get(
          pairKey(candidateIds[i]!, candidateIds[j]!)
        );
        if (rel) relationEvidence.push(rel);
      }
    }
    relationEvidence.sort((x, y) => {
      if (x.leftCandidateId !== y.leftCandidateId) {
        return x.leftCandidateId.localeCompare(y.leftCandidateId);
      }
      return x.rightCandidateId.localeCompare(y.rightCandidateId);
    });

    const sourceIds = new Set<string>();
    for (const id of candidateIds) {
      const node = nodeById.get(id);
      if (!node) continue;
      for (const sourceId of node.sourceReceiptIds) sourceIds.add(sourceId);
    }

    groups.push({
      path: 'SHADOW_MERCHANT_METADATA_VARIANT',
      candidateIds,
      sourceReceiptIds: stableSortedStrings([...sourceIds]),
      relationEvidence,
      evidence: [`complete_link_cluster_size=${candidateIds.length}`],
    });
  }

  return groups;
}

export function buildShadowDuplicateCandidateGroups(
  receipts: readonly ReceiptRow[]
): ShadowDuplicateCandidateGroup[] {
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const nodes = buildProductionShadowCandidateNodes(receipts);
  const nodeById = new Map(nodes.map((n) => [n.candidateId, n]));
  const sortedCandidateIds = stableSortedStrings(nodes.map((n) => n.candidateId));

  const merchantRelations = new Map<string, ShadowDuplicateRelationEvidence>();

  for (let i = 0; i < sortedCandidateIds.length; i += 1) {
    for (let j = i + 1; j < sortedCandidateIds.length; j += 1) {
      const nodeA = nodeById.get(sortedCandidateIds[i]!)!;
      const nodeB = nodeById.get(sortedCandidateIds[j]!)!;
      const merchantRel = evaluateCandidateLevelShadowPair(nodeA, nodeB, receiptById);
      if (merchantRel) {
        merchantRelations.set(
          pairKey(nodeA.candidateId, nodeB.candidateId),
          merchantRel
        );
      }
    }
  }

  return clusterCompleteLink(sortedCandidateIds, merchantRelations, nodeById).sort(
    (a, b) => {
      const a0 = a.candidateIds[0] ?? '';
      const b0 = b.candidateIds[0] ?? '';
      return a0.localeCompare(b0);
    }
  );
}
