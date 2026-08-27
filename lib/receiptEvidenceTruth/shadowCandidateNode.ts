/**
 * A1.4A — Production canonical shadow candidate nodes (read-only).
 *
 * Shadow duplicate evaluation operates on indivisible production canonical
 * purchase candidates — never on raw receipt rows in isolation.
 */

import type { ReceiptRow } from '../db';
import {
  buildCanonicalReceiptGroups,
  indexCanonicalReceiptGroupsByReceiptId,
} from '../analysisFoundation/canonicalReceipt';
import type { CanonicalReceiptGroup, CanonicalReceiptConfidence } from '../analysisFoundation/types';
import {
  summarizeReceiptForDuplicateAudit,
  type AnalysisDDuplicateReceiptSummary,
} from '../analysisDDuplicateAudit';
import { buildReceiptMerchantEvidence } from './merchantEvidence';
import { buildReceiptMonetaryCoherenceEvidence } from './monetaryCoherenceEvidence';
import { buildReceiptTransactionEvidence } from './transactionEvidence';
import type {
  ReceiptMerchantEvidence,
  ReceiptMonetaryCoherenceEvidence,
  ReceiptTransactionEvidence,
} from './types';

export type ProductionShadowCandidateNode = {
  candidateId: string;
  representativeReceiptId: string;
  sourceReceiptIds: readonly string[];
  productionDuplicateConfidence: CanonicalReceiptConfidence;
  representativeReceipt: ReceiptRow;
  summary: AnalysisDDuplicateReceiptSummary;
  merchant: ReceiptMerchantEvidence;
  transaction: ReceiptTransactionEvidence;
  monetary: ReceiptMonetaryCoherenceEvidence;
  currency: string;
};

function stableSortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function buildProductionShadowCandidateNode(
  group: CanonicalReceiptGroup,
  receiptById: ReadonlyMap<string, ReceiptRow>
): ProductionShadowCandidateNode | null {
  const rep = group.representativeReceipt;
  if (!rep) return null;
  const summary = summarizeReceiptForDuplicateAudit(rep);
  const currency = String(rep.currency ?? '').trim().toUpperCase();
  return {
    candidateId: group.ephemeralSnapshotGroupId,
    representativeReceiptId: rep.id,
    sourceReceiptIds: stableSortedIds(group.sourceReceiptIds),
    productionDuplicateConfidence: group.confidence,
    representativeReceipt: rep,
    summary,
    merchant: buildReceiptMerchantEvidence(rep),
    transaction: buildReceiptTransactionEvidence(rep),
    monetary: buildReceiptMonetaryCoherenceEvidence(rep),
    currency,
  };
}

/**
 * Build one shadow candidate node per production canonical purchase candidate.
 */
export function buildProductionShadowCandidateNodes(
  receipts: readonly ReceiptRow[]
): ProductionShadowCandidateNode[] {
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const groups = buildCanonicalReceiptGroups([...receipts]);
  const nodes = groups
    .map((g) => buildProductionShadowCandidateNode(g, receiptById))
    .filter((n): n is ProductionShadowCandidateNode => n != null);
  nodes.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return nodes;
}

export function indexShadowCandidateNodesByReceiptId(
  nodes: readonly ProductionShadowCandidateNode[]
): Map<string, ProductionShadowCandidateNode> {
  const map = new Map<string, ProductionShadowCandidateNode>();
  for (const node of nodes) {
    for (const id of node.sourceReceiptIds) {
      map.set(id, node);
    }
  }
  return map;
}

export function findProductionShadowCandidateForReceiptIds(
  receiptIds: readonly string[],
  nodes: readonly ProductionShadowCandidateNode[]
): ProductionShadowCandidateNode[] {
  const index = indexShadowCandidateNodesByReceiptId(nodes);
  const seen = new Set<string>();
  const out: ProductionShadowCandidateNode[] = [];
  for (const id of stableSortedIds(receiptIds)) {
    const node = index.get(id);
    if (!node || seen.has(node.candidateId)) continue;
    seen.add(node.candidateId);
    out.push(node);
  }
  out.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return out;
}

export function findProductionCanonicalGroupForReceiptIds(
  receiptIds: readonly string[],
  receipts: readonly ReceiptRow[]
): CanonicalReceiptGroup | null {
  const groups = buildCanonicalReceiptGroups([...receipts]);
  const index = indexCanonicalReceiptGroupsByReceiptId(groups);
  const idSet = new Set(receiptIds);
  for (const group of groups) {
    if (group.sourceReceiptIds.every((id) => idSet.has(id)) && group.sourceReceiptIds.length === receiptIds.length) {
      return group;
    }
  }
  const first = receiptIds[0];
  if (first) return index.get(first) ?? null;
  return null;
}

export function buildSubstantiatedCandidateView(
  node: ProductionShadowCandidateNode,
  sourceReceiptId: string,
  receiptById: ReadonlyMap<string, ReceiptRow>
): ProductionShadowCandidateNode | null {
  if (!node.sourceReceiptIds.includes(sourceReceiptId)) return null;
  const receipt = receiptById.get(sourceReceiptId);
  if (!receipt) return null;
  return {
    ...node,
    representativeReceiptId: sourceReceiptId,
    representativeReceipt: receipt,
    summary: summarizeReceiptForDuplicateAudit(receipt),
    merchant: buildReceiptMerchantEvidence(receipt),
    transaction: buildReceiptTransactionEvidence(receipt),
    monetary: buildReceiptMonetaryCoherenceEvidence(receipt),
    currency: String(receipt.currency ?? '').trim().toUpperCase(),
  };
}

export function countProductionCandidatesForReceiptIds(
  receiptIds: readonly string[],
  nodes: readonly ProductionShadowCandidateNode[]
): number {
  return findProductionShadowCandidateForReceiptIds(receiptIds, nodes).length;
}
