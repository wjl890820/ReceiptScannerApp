/**
 * History purchase-truth consumer (Build 52).
 *
 * User-facing History shows ONE row per verified purchase candidate.
 * Raw stored scans remain in SQLite; this module only projects UI rows and
 * expands delete targets across already-confirmed high-confidence groups.
 *
 * Reuses selectAnalyticsReceipts — does not redesign duplicate detection.
 */

import type { AnalysisDDuplicateGroup } from './analysisDDuplicateAudit';
import {
  selectAnalyticsReceipts,
  type AnalyticsReceiptSelection,
} from './analyticsReceiptSelection';
import { selectAnalyticsReceiptsCached } from './analyticsReceiptSelectionCache';
import type { ReceiptListRow, ReceiptRow } from './db';
import { classifyVerifiedPurchaseOccurrenceBundle } from './verifiedPurchaseOccurrenceProvenance';
import {
  buildEffectivePurchaseTruth,
  buildPurchaseTruthPartition,
  type EffectivePurchaseTruth,
} from './purchaseTruthPartition';

/**
 * Former raw-receipt cap. History purchase truth must not be built from a
 * newest-N slice; pagination applies only after purchase reduction.
 */
export const HISTORY_PURCHASE_TRUTH_LOAD_LIMIT = 2000;

export type HistoryPurchaseTruthView = {
  /** Visible History rows (representative / singleton purchases). */
  visibleRows: ReceiptListRow[];
  /** Raw stored count before purchase projection. */
  storedCount: number;
  selection: AnalyticsReceiptSelection;
  /** Built from the exhaustive stored universe passed to this view. */
  effective: EffectivePurchaseTruth;
  universeReceipts: readonly ReceiptRow[];
};

export function receiptRowToListRow(row: ReceiptRow): ReceiptListRow {
  const { image_uri: _imageUri, ...rest } = row;
  return rest;
}

/**
 * Project stored receipts → user-visible purchase History rows.
 * Does not mutate or delete stored rows.
 */
export function buildHistoryPurchaseTruthView(
  storedReceipts: readonly ReceiptRow[]
): HistoryPurchaseTruthView;
export function buildHistoryPurchaseTruthView(
  storedReceipts: readonly ReceiptRow[],
  options: {
    ownerKey?: string;
    shouldSkipExpensiveBuild?: () => boolean;
  }
): HistoryPurchaseTruthView | null;
export function buildHistoryPurchaseTruthView(
  storedReceipts: readonly ReceiptRow[],
  options?: {
    ownerKey?: string;
    shouldSkipExpensiveBuild?: () => boolean;
  }
): HistoryPurchaseTruthView | null {
  const ownerKey = options?.ownerKey?.trim() || '';
  let selection: AnalyticsReceiptSelection;
  if (ownerKey) {
    const cached = selectAnalyticsReceiptsCached({
      ownerKey,
      receipts: [...storedReceipts],
      shouldSkipExpensiveBuild: options?.shouldSkipExpensiveBuild,
    });
    if (!cached) return null;
    selection = cached;
  } else {
    selection = selectAnalyticsReceipts([...storedReceipts]);
  }
  const effective = buildEffectivePurchaseTruth(storedReceipts, { selection });
  const byId = new Map(storedReceipts.map((row) => [row.id, row]));
  const seenRepresentatives = new Set<string>();
  const visibleRows: ReceiptListRow[] = [];
  for (const row of selection.analyticsReceipts) {
    const purchase = effective.purchaseByReceiptId.get(row.id);
    const representativeId = purchase?.representativeReceiptId ?? row.id;
    if (seenRepresentatives.has(representativeId)) continue;
    seenRepresentatives.add(representativeId);
    const representative = byId.get(representativeId) ?? row;
    visibleRows.push(receiptRowToListRow(representative));
  }
  return {
    visibleRows,
    storedCount: storedReceipts.length,
    selection,
    effective,
    universeReceipts: storedReceipts,
  };
}

/**
 * Resolve confirmed high-confidence group membership for a receipt id.
 * Returns null when the id is a singleton purchase (not in a HC group).
 */
export function findHighConfidenceDuplicateGroupForReceipt(
  receiptId: string,
  groups: readonly AnalysisDDuplicateGroup[]
): AnalysisDDuplicateGroup | null {
  for (const group of groups) {
    if (
      group.representativeReceiptId === receiptId ||
      group.receiptIds.includes(receiptId)
    ) {
      return group;
    }
  }
  return null;
}

export function resolvePurchaseRepresentativeReceiptId(
  receiptId: string,
  groups: readonly AnalysisDDuplicateGroup[]
): string {
  const group = findHighConfidenceDuplicateGroupForReceipt(receiptId, groups);
  return group?.representativeReceiptId ?? receiptId;
}

/**
 * When the user deletes visible purchase(s), expand to all confirmed
 * high-confidence duplicate members so the purchase cannot resurrect.
 */
function assignedVerifiedPurchaseOccurrenceId(
  row: ReceiptRow | undefined
): string | null {
  if (!row) return null;
  const state = classifyVerifiedPurchaseOccurrenceBundle({
    occurrenceId: row.verified_purchase_occurrence_id,
    source: row.verified_purchase_occurrence_source,
    verifiedAt: row.verified_purchase_occurrence_verified_at,
  });
  return state.state === 'assigned' ? state.value.occurrenceId : null;
}

/**
 * Same valid verified occurrence id is one logical purchase.
 * Derived HC ids are kept only when they do not carry a different verified id.
 * No verified provenance → return the HC expansion unchanged.
 */
export function expandLogicalPurchaseIdsWithVerifiedOccurrence(
  selectedIds: readonly string[],
  hcExpandedIds: readonly string[],
  storedReceipts: readonly ReceiptRow[]
): string[] {
  const byId = new Map(storedReceipts.map((row) => [row.id, row]));
  const verifiedIds = new Set<string>();
  for (const id of selectedIds) {
    const verifiedId = assignedVerifiedPurchaseOccurrenceId(byId.get(id));
    if (verifiedId) verifiedIds.add(verifiedId);
  }
  if (verifiedIds.size === 0) {
    const filtered = hcExpandedIds.filter((id) => {
      const verifiedId = assignedVerifiedPurchaseOccurrenceId(byId.get(id));
      return !verifiedId;
    });
    if (filtered.length === hcExpandedIds.length) return [...hcExpandedIds];
    return filtered;
  }
  const out = new Set<string>();
  for (const row of storedReceipts) {
    const verifiedId = assignedVerifiedPurchaseOccurrenceId(row);
    if (verifiedId && verifiedIds.has(verifiedId)) out.add(row.id);
  }
  for (const id of hcExpandedIds) {
    const verifiedId = assignedVerifiedPurchaseOccurrenceId(byId.get(id));
    if (verifiedId) continue;
    out.add(id);
  }
  for (const id of selectedIds) out.add(id);
  return [...out].sort((a, b) => a.localeCompare(b));
}

export function expandHistoryPurchaseDeleteIds(
  selectedPurchaseReceiptIds: readonly string[],
  groups: readonly AnalysisDDuplicateGroup[]
): string[] {
  const out = new Set<string>();
  for (const id of selectedPurchaseReceiptIds) {
    const group = findHighConfidenceDuplicateGroupForReceipt(id, groups);
    if (group) {
      for (const memberId of group.receiptIds) out.add(memberId);
    } else {
      out.add(id);
    }
  }
  return [...out];
}

export class HistoryPurchaseDeleteResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryPurchaseDeleteResolutionError';
  }
}

/**
 * Fresh purchase-truth expansion for delete: recompute HC groups from stored rows
 * and fail closed when any selected purchase cannot be resolved safely.
 */
export function resolveHistoryPurchaseDeleteIds(
  selectedPurchaseReceiptIds: readonly string[],
  storedReceipts: readonly ReceiptRow[]
): string[] {
  if (selectedPurchaseReceiptIds.length === 0) return [];

  const selection = selectAnalyticsReceipts([...storedReceipts]);
  const groups = selection.highConfidenceDuplicateGroups;
  const storedIds = new Set(storedReceipts.map((row) => row.id));
  const visibleIds = new Set(selection.analyticsReceipts.map((row) => row.id));
  const excludedIds = selection.excludedDuplicateReceiptIds;

  for (const id of selectedPurchaseReceiptIds) {
    if (!storedIds.has(id)) {
      throw new HistoryPurchaseDeleteResolutionError(`missing receipt: ${id}`);
    }
    const isVisible = visibleIds.has(id);
    const isHiddenMember = excludedIds.has(id);
    if (!isVisible && !isHiddenMember) {
      throw new HistoryPurchaseDeleteResolutionError(
        `unresolvable logical purchase: ${id}`
      );
    }
  }

  const truth = buildEffectivePurchaseTruth(storedReceipts, { selection });
  const anyVerifiedActive = selectedPurchaseReceiptIds.some(
    (id) => truth.purchaseByReceiptId.get(id)?.verifiedActive === true
  );
  if (!anyVerifiedActive) {
    return expandHistoryPurchaseDeleteIds(selectedPurchaseReceiptIds, groups);
  }

  const out = new Set<string>();
  for (const id of selectedPurchaseReceiptIds) {
    const purchase = truth.purchaseByReceiptId.get(id);
    if (purchase) {
      for (const memberId of purchase.memberReceiptIds) out.add(memberId);
    } else {
      out.add(id);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Canonical History detail receipt id from fresh purchase truth.
 * Returns null when the captured id is not present in stored receipts.
 */
export function resolveHistoryPurchaseDetailReceiptId(
  capturedReceiptId: string,
  storedReceipts: readonly ReceiptRow[]
): string | null {
  if (!storedReceipts.some((row) => row.id === capturedReceiptId)) {
    return null;
  }
  const truth = buildEffectivePurchaseTruth(storedReceipts);
  const purchase = truth.purchaseByReceiptId.get(capturedReceiptId);
  if (!purchase?.verifiedActive) {
    return resolvePurchaseRepresentativeReceiptId(
      capturedReceiptId,
      truth.selection.highConfidenceDuplicateGroups
    );
  }
  return purchase.representativeReceiptId;
}

/**
 * Resolve logical-purchase member IDs for item edit expansion.
 * Works for visible representative or hidden duplicate member entry points.
 */
export function expandHistoryPurchaseEditIds(
  targetReceiptId: string,
  groups: readonly AnalysisDDuplicateGroup[]
): string[] {
  const group = findHighConfidenceDuplicateGroupForReceipt(targetReceiptId, groups);
  if (group) {
    return [...group.receiptIds];
  }
  return [targetReceiptId];
}

/**
 * Fresh purchase-truth expansion for edit: recompute HC groups from stored rows.
 */
export function resolveHistoryPurchaseEditMemberIds(
  targetReceiptId: string,
  storedReceipts: readonly ReceiptRow[]
): string[] {
  const truth = buildEffectivePurchaseTruth(storedReceipts);
  const purchase = truth.purchaseByReceiptId.get(targetReceiptId);
  if (!purchase?.verifiedActive) {
    return expandHistoryPurchaseEditIds(
      targetReceiptId,
      truth.selection.highConfidenceDuplicateGroups
    );
  }
  return [...purchase.memberReceiptIds].sort((a, b) => a.localeCompare(b));
}

export type HistorySearchProjectionInput = {
  itemResults: ReadonlyArray<{ receiptId: string } & Record<string, unknown>>;
  receiptResults: readonly ReceiptListRow[];
};

function projectHistorySearchFromEffectiveTruth<
  TItem extends { receiptId: string },
>(
  input: {
    itemResults: readonly TItem[];
    receiptResults: readonly ReceiptListRow[];
  },
  projection: {
    effective: EffectivePurchaseTruth;
    universeReceipts: readonly ReceiptRow[];
  }
): { itemResults: TItem[]; receiptResults: ReceiptListRow[] } {
  const byId = new Map(
    projection.universeReceipts.map((row) => [row.id, receiptRowToListRow(row)])
  );
  const representativeIdFor = (receiptId: string): string | null =>
    projection.effective.purchaseByReceiptId.get(receiptId)
      ?.representativeReceiptId ?? null;

  const seenReceipts = new Set<string>();
  const receiptResults: ReceiptListRow[] = [];
  for (const row of input.receiptResults) {
    const repId = representativeIdFor(row.id);
    if (!repId || seenReceipts.has(repId)) continue;
    seenReceipts.add(repId);
    const projected = byId.get(repId);
    if (projected) receiptResults.push(projected);
  }

  const seenItems = new Set<string>();
  const itemResults: TItem[] = [];
  for (const item of input.itemResults) {
    const repId = representativeIdFor(item.receiptId);
    if (!repId) continue;
    const displayName = String(
      (item as { displayName?: string }).displayName ?? ''
    );
    const sourceIndex = String(
      (item as { sourceIndex?: number }).sourceIndex ?? ''
    );
    const itemId = String((item as { itemId?: string }).itemId ?? '');
    const dedupeKey =
      displayName || sourceIndex
        ? `${repId}::${displayName}::${sourceIndex}`
        : `${repId}::${itemId || JSON.stringify(item)}`;
    if (seenItems.has(dedupeKey)) continue;
    seenItems.add(dedupeKey);
    itemResults.push(
      item.receiptId === repId ? item : { ...item, receiptId: repId }
    );
  }

  return { itemResults, receiptResults };
}

/**
 * Search operates on purchase truth: excluded extras map to their
 * representative; duplicate receipt hits appear once.
 * When exhaustive effective truth is supplied, ids outside that universe are
 * omitted rather than shown as raw receipt identity.
 */
export function projectHistorySearchToPurchaseTruth<
  TItem extends { receiptId: string },
>(
  input: {
    itemResults: readonly TItem[];
    receiptResults: readonly ReceiptListRow[];
  },
  selection: AnalyticsReceiptSelection,
  projection?: {
    effective: EffectivePurchaseTruth;
    universeReceipts: readonly ReceiptRow[];
  }
): { itemResults: TItem[]; receiptResults: ReceiptListRow[] } {
  if (projection) {
    return projectHistorySearchFromEffectiveTruth(input, projection);
  }
  const groups = selection.highConfidenceDuplicateGroups;
  const partition = buildPurchaseTruthPartition(selection.analyticsReceipts);
  const repByReceipt = partition.index.representativeReceiptIdByReceiptId;
  const repRows = new Map(
    selection.analyticsReceipts
      .filter((row) => partition.representativeReceiptIds.includes(row.id))
      .map((row) => [row.id, receiptRowToListRow(row)])
  );

  const seenReceipts = new Set<string>();
  const receiptResults: ReceiptListRow[] = [];
  for (const row of input.receiptResults) {
    const hcRep = resolvePurchaseRepresentativeReceiptId(row.id, groups);
    const repId = repByReceipt.get(hcRep) ?? repByReceipt.get(row.id) ?? hcRep;
    if (seenReceipts.has(repId)) continue;
    seenReceipts.add(repId);
    const projected = repRows.get(repId) ?? { ...row, id: repId };
    receiptResults.push(projected);
  }

  const seenItems = new Set<string>();
  const itemResults: TItem[] = [];
  for (const item of input.itemResults) {
    const hcRep = resolvePurchaseRepresentativeReceiptId(item.receiptId, groups);
    const repId =
      repByReceipt.get(hcRep) ?? repByReceipt.get(item.receiptId) ?? hcRep;
    // Across duplicate scans, item row ids differ — collapse by display identity.
    const displayName = String(
      (item as { displayName?: string }).displayName ?? ''
    );
    const sourceIndex = String(
      (item as { sourceIndex?: number }).sourceIndex ?? ''
    );
    const itemId = String((item as { itemId?: string }).itemId ?? '');
    const dedupeKey =
      displayName || sourceIndex
        ? `${repId}::${displayName}::${sourceIndex}`
        : `${repId}::${itemId || JSON.stringify(item)}`;
    if (seenItems.has(dedupeKey)) continue;
    seenItems.add(dedupeKey);
    if (item.receiptId === repId) {
      itemResults.push(item);
    } else {
      itemResults.push({ ...item, receiptId: repId });
    }
  }

  return { itemResults, receiptResults };
}
