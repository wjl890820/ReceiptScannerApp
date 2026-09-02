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
import type { ReceiptListRow, ReceiptRow } from './db';

/** Load enough stored rows so same-purchase duplicate groups stay intact. */
export const HISTORY_PURCHASE_TRUTH_LOAD_LIMIT = 2000;

export type HistoryPurchaseTruthView = {
  /** Visible History rows (representative / singleton purchases). */
  visibleRows: ReceiptListRow[];
  /** Raw stored count before purchase projection. */
  storedCount: number;
  selection: AnalyticsReceiptSelection;
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
): HistoryPurchaseTruthView {
  const selection = selectAnalyticsReceipts([...storedReceipts]);
  return {
    visibleRows: selection.analyticsReceipts.map(receiptRowToListRow),
    storedCount: storedReceipts.length,
    selection,
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

  return expandHistoryPurchaseDeleteIds(selectedPurchaseReceiptIds, groups);
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
  const selection = selectAnalyticsReceipts([...storedReceipts]);
  return resolvePurchaseRepresentativeReceiptId(
    capturedReceiptId,
    selection.highConfidenceDuplicateGroups
  );
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
  const selection = selectAnalyticsReceipts([...storedReceipts]);
  return expandHistoryPurchaseEditIds(
    targetReceiptId,
    selection.highConfidenceDuplicateGroups
  );
}

export type HistorySearchProjectionInput = {
  itemResults: ReadonlyArray<{ receiptId: string } & Record<string, unknown>>;
  receiptResults: readonly ReceiptListRow[];
};

/**
 * Search operates on purchase truth: excluded extras map to their
 * representative; duplicate receipt hits appear once.
 */
export function projectHistorySearchToPurchaseTruth<
  TItem extends { receiptId: string },
>(
  input: {
    itemResults: readonly TItem[];
    receiptResults: readonly ReceiptListRow[];
  },
  selection: AnalyticsReceiptSelection
): { itemResults: TItem[]; receiptResults: ReceiptListRow[] } {
  const groups = selection.highConfidenceDuplicateGroups;
  const byId = new Map(
    selection.analyticsReceipts.map((row) => [row.id, receiptRowToListRow(row)])
  );

  const seenReceipts = new Set<string>();
  const receiptResults: ReceiptListRow[] = [];
  for (const row of input.receiptResults) {
    const repId = resolvePurchaseRepresentativeReceiptId(row.id, groups);
    if (seenReceipts.has(repId)) continue;
    seenReceipts.add(repId);
    const projected = byId.get(repId) ?? { ...row, id: repId };
    receiptResults.push(projected);
  }

  const seenItems = new Set<string>();
  const itemResults: TItem[] = [];
  for (const item of input.itemResults) {
    const repId = resolvePurchaseRepresentativeReceiptId(item.receiptId, groups);
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
