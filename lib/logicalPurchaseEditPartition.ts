/**
 * Exact logical-purchase partition gate for item edits (CC-2B P0 safety).
 *
 * Ensures a proposed identical user_items_json overlay cannot split or merge
 * high-confidence duplicate groups before any DB mutation.
 */

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';
import { expandHistoryPurchaseEditIds } from './historyPurchaseTruth';

export class LogicalPurchaseEditPartitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogicalPurchaseEditPartitionError';
  }
}

export function sortedExactMemberSet(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

export function deriveExactLogicalPurchaseMemberSet(
  anchorReceiptId: string,
  storedReceipts: readonly ReceiptRow[]
): string[] {
  const selection = selectAnalyticsReceipts([...storedReceipts]);
  return sortedExactMemberSet(
    expandHistoryPurchaseEditIds(
      anchorReceiptId,
      selection.highConfidenceDuplicateGroups
    )
  );
}

export function applyLogicalPurchaseEditOverlay(
  storedReceipts: readonly ReceiptRow[],
  memberIds: readonly string[],
  userItemsJson: string
): ReceiptRow[] {
  const memberSet = new Set(memberIds);
  return storedReceipts.map((receipt) =>
    memberSet.has(receipt.id)
      ? {
          ...receipt,
          user_edited: 1,
          user_items_json: userItemsJson,
        }
      : receipt
  );
}

/**
 * Fail closed when caller membership is stale or the overlay would change the
 * exact HC logical-purchase member partition.
 */
export function assertLogicalPurchaseEditPartition(params: {
  storedReceipts: readonly ReceiptRow[];
  memberReceiptIds: readonly string[];
  user_items_json: string;
}): { preMemberSet: string[]; postMemberSet: string[] } {
  const callerSet = sortedExactMemberSet(params.memberReceiptIds);
  if (callerSet.length === 0) {
    throw new LogicalPurchaseEditPartitionError(
      'logical purchase edit requires at least one receipt id'
    );
  }

  const preSet = deriveExactLogicalPurchaseMemberSet(
    callerSet[0]!,
    params.storedReceipts
  );
  if (
    preSet.length !== callerSet.length ||
    !preSet.every((id, index) => id === callerSet[index])
  ) {
    throw new LogicalPurchaseEditPartitionError(
      'stale logical purchase membership'
    );
  }

  const proposedReceipts = applyLogicalPurchaseEditOverlay(
    params.storedReceipts,
    preSet,
    params.user_items_json
  );
  const postSet = deriveExactLogicalPurchaseMemberSet(
    callerSet[0]!,
    proposedReceipts
  );
  if (
    preSet.length !== postSet.length ||
    !preSet.every((id, index) => id === postSet[index])
  ) {
    throw new LogicalPurchaseEditPartitionError(
      'edit would change logical purchase partition'
    );
  }

  return { preMemberSet: preSet, postMemberSet: postSet };
}
