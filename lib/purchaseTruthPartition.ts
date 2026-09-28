/**
 * Shared purchase-truth projection.
 *
 * Canonical clustering and legacy high-confidence grouping stay as they are.
 * This layer only chooses which existing partition is authoritative for each
 * local purchase:
 * - a canonical occurrence with at least one valid assigned provenance member
 *   is verified-active, and canonical membership is authoritative there
 * - every other receipt keeps legacy high-confidence membership
 * Invalid or partial provenance has no verified authority.
 */

import {
  selectAnalyticsReceipts,
  type AnalyticsReceiptSelection,
} from './analyticsReceiptSelection';
import {
  buildCanonicalPurchaseOccurrenceIndex,
  type CanonicalPurchaseOccurrenceIndex,
} from './canonicalPurchaseOccurrence';
import type { ReceiptRow } from './db';
import { classifyVerifiedPurchaseOccurrenceBundle } from './verifiedPurchaseOccurrenceProvenance';

export type PurchaseTruthPartition = {
  index: CanonicalPurchaseOccurrenceIndex;
  representativeReceiptIds: readonly string[];
  memberReceiptIdsByOccurrenceKey: ReadonlyMap<string, readonly string[]>;
  occurrenceKeyByReceiptId: ReadonlyMap<string, string>;
};

export type EffectivePurchase = {
  representativeReceiptId: string;
  memberReceiptIds: readonly string[];
  verifiedActive: boolean;
  /** Collision-safe internal key when canonical membership is authoritative. */
  occurrenceKey: string | null;
};

export type EffectivePurchaseTruth = {
  selection: AnalyticsReceiptSelection;
  purchases: readonly EffectivePurchase[];
  purchaseByReceiptId: ReadonlyMap<string, EffectivePurchase>;
};

function assignedVerifiedOccurrenceId(row: ReceiptRow | undefined): string | null {
  if (!row) return null;
  const state = classifyVerifiedPurchaseOccurrenceBundle({
    occurrenceId: row.verified_purchase_occurrence_id,
    source: row.verified_purchase_occurrence_source,
    verifiedAt: row.verified_purchase_occurrence_verified_at,
  });
  return state.state === 'assigned' ? state.value.occurrenceId : null;
}

function legacyMembersForReceipt(
  receiptId: string,
  selection: AnalyticsReceiptSelection
): { representativeReceiptId: string; memberReceiptIds: string[] } {
  for (const group of selection.highConfidenceDuplicateGroups) {
    if (
      group.representativeReceiptId === receiptId ||
      group.receiptIds.includes(receiptId)
    ) {
      return {
        representativeReceiptId: group.representativeReceiptId,
        memberReceiptIds: [...group.receiptIds],
      };
    }
  }
  return { representativeReceiptId: receiptId, memberReceiptIds: [receiptId] };
}

export function buildPurchaseTruthPartition(
  receipts: readonly ReceiptRow[]
): PurchaseTruthPartition {
  const index = buildCanonicalPurchaseOccurrenceIndex(receipts);
  const memberReceiptIdsByOccurrenceKey = new Map<string, readonly string[]>();
  for (const group of index.groups) {
    memberReceiptIdsByOccurrenceKey.set(group.occurrenceKey, group.receiptIds);
  }
  return {
    index,
    representativeReceiptIds: index.groups.map(
      (group) => group.representativeReceiptId
    ),
    memberReceiptIdsByOccurrenceKey,
    occurrenceKeyByReceiptId: index.occurrenceKeyByReceiptId,
  };
}

/**
 * Occurrence-local purchase truth.
 * Canonical index is built only when some receipt has valid assigned provenance.
 * Each call computes from the receipts it is given. There is no cross-call cache.
 */
export function buildEffectivePurchaseTruth(
  receipts: readonly ReceiptRow[],
  precomputed?: { selection?: AnalyticsReceiptSelection }
): EffectivePurchaseTruth {
  const selection =
    precomputed?.selection ?? selectAnalyticsReceipts([...receipts]);
  const purchaseByReceiptId = new Map<string, EffectivePurchase>();
  const purchases: EffectivePurchase[] = [];
  const claimed = new Set<string>();
  const byId = new Map(receipts.map((row) => [row.id, row]));
  const anyAssigned = receipts.some(
    (row) => assignedVerifiedOccurrenceId(row) != null
  );

  if (anyAssigned) {
    const partition = buildPurchaseTruthPartition(receipts);
    for (const group of partition.index.groups) {
      const verifiedActive = group.receiptIds.some(
        (id) => assignedVerifiedOccurrenceId(byId.get(id)) != null
      );
      if (!verifiedActive) continue;
      const purchase: EffectivePurchase = {
        representativeReceiptId: group.representativeReceiptId,
        memberReceiptIds: [...group.receiptIds],
        verifiedActive: true,
        occurrenceKey: group.occurrenceKey,
      };
      purchases.push(purchase);
      for (const id of group.receiptIds) {
        claimed.add(id);
        purchaseByReceiptId.set(id, purchase);
      }
    }
  }

  for (const row of receipts) {
    if (purchaseByReceiptId.has(row.id)) continue;
    const legacy = legacyMembersForReceipt(row.id, selection);
    const memberReceiptIds = legacy.memberReceiptIds.filter((id) => !claimed.has(id));
    if (memberReceiptIds.length === 0) continue;
    const representativeReceiptId = memberReceiptIds.includes(
      legacy.representativeReceiptId
    )
      ? legacy.representativeReceiptId
      : memberReceiptIds[0]!;
    const purchase: EffectivePurchase = {
      representativeReceiptId,
      memberReceiptIds,
      verifiedActive: false,
      occurrenceKey: null,
    };
    purchases.push(purchase);
    for (const id of memberReceiptIds) purchaseByReceiptId.set(id, purchase);
  }

  return { selection, purchases, purchaseByReceiptId };
}

/** All stored members of the canonical occurrences touched by selected ids. */
export function canonicalMemberIdsForReceipts(
  selectedIds: readonly string[],
  storedReceipts: readonly ReceiptRow[]
): string[] {
  if (selectedIds.length === 0) return [];
  const partition = buildPurchaseTruthPartition(storedReceipts);
  const out = new Set<string>();
  for (const id of selectedIds) {
    const key = partition.occurrenceKeyByReceiptId.get(id);
    const members = key
      ? partition.memberReceiptIdsByOccurrenceKey.get(key)
      : undefined;
    if (members) {
      for (const memberId of members) out.add(memberId);
    } else {
      out.add(id);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
