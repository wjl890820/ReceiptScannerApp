import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
  type HighConfidenceDuplicateReceiptGroupMembership,
} from './analyticsReceiptSelection';
import { getReceipt, listReceiptsForAnalysis, type ReceiptRow } from './db';
import {
  evaluateExactTransactionReceiptCollision,
  type ExactTransactionReceiptCollision,
} from './receiptExactTransactionCollision';
import { projectReceiptSaveMaterialEvidence } from './receiptSaveProjection';
import type { ReceiptAnalysis } from './receiptAnalyzer';

export type ScanReviewDuplicateGateContext = {
  storedReceipts: readonly ReceiptRow[];
  receiptById: ReadonlyMap<string, ReceiptRow>;
  highConfidenceGroupByReceiptId: ReadonlyMap<
    string,
    HighConfidenceDuplicateReceiptGroupMembership
  >;
};

export type ScanReviewDuplicateGateMatch = {
  existingReceiptId: string;
  evidenceKey: string;
  merchantDisplay: string;
  transactionAt: number;
  total: number;
  currency: string;
  itemCount: number;
};

export type ScanReviewDuplicateGateLifecycle = {
  mounted: boolean;
  capturedGeneration: number;
  currentGeneration: number;
  capturedDraftId: string;
  currentDraftId: string;
};

export function shouldApplyScanReviewDuplicateGateUpdate(
  lifecycle: ScanReviewDuplicateGateLifecycle
): boolean {
  return (
    lifecycle.mounted &&
    lifecycle.capturedGeneration === lifecycle.currentGeneration &&
    lifecycle.capturedDraftId === lifecycle.currentDraftId
  );
}

export function dismissScanReviewDuplicateEvidence(
  match: ScanReviewDuplicateGateMatch
): string {
  return match.evidenceKey;
}

export function shouldShowScanReviewDuplicateGateMatch(
  match: ScanReviewDuplicateGateMatch | null,
  dismissedEvidenceKey: string | null
): boolean {
  return Boolean(match && match.evidenceKey !== dismissedEvidenceKey);
}

export async function loadScanReviewDuplicateGateContext(
  deps: {
    listOwnerReceipts?: () => Promise<ReceiptRow[]>;
  } = {}
): Promise<ScanReviewDuplicateGateContext | null> {
  try {
    const storedReceipts = await (
      deps.listOwnerReceipts ?? listReceiptsForAnalysis
    )();
    const selection = selectAnalyticsReceipts(storedReceipts);
    const receiptById = new Map(
      selection.storedReceipts.map((receipt) => [receipt.id, receipt])
    );
    return {
      storedReceipts: selection.storedReceipts,
      receiptById,
      highConfidenceGroupByReceiptId:
        indexHighConfidenceDuplicateGroupsByReceiptId(
          selection.highConfidenceDuplicateGroups
        ),
    };
  } catch {
    return null;
  }
}

export function buildTransientScanReviewReceipt(input: {
  transientReceiptId: string;
  imageUri: string;
  analysis: ReceiptAnalysis & Record<string, unknown>;
}): ReceiptRow | null {
  if (!input.transientReceiptId || !input.transientReceiptId.trim()) return null;
  const projection = projectReceiptSaveMaterialEvidence({
    analysis: input.analysis,
    reviewedSave: true,
  });
  return {
    id: input.transientReceiptId,
    created_at: 0,
    transaction_at: projection.transactionAt,
    image_uri: input.imageUri,
    merchant_raw: projection.merchantRaw,
    merchant_normalized: projection.merchantNormalized,
    merchant_type: projection.merchantType,
    total: projection.total,
    tax: projection.tax,
    tax_is_known: projection.taxIsKnown,
    currency: projection.currency,
    analysis_json: JSON.stringify(projection.persistedAnalysis),
    user_edited: 1,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    transaction_source: projection.transactionSource,
  };
}

type CollisionDestination = {
  destination: ReceiptRow;
  collision: ExactTransactionReceiptCollision;
};

function resolveStoredDestination(
  receipt: ReceiptRow,
  context: ScanReviewDuplicateGateContext
): ReceiptRow | null {
  const membership = context.highConfidenceGroupByReceiptId.get(receipt.id);
  if (!membership) return receipt;
  return context.receiptById.get(membership.representativeReceiptId) ?? null;
}

function compareCollisionDestinations(
  left: CollisionDestination,
  right: CollisionDestination
): number {
  const createdDelta = left.destination.created_at - right.destination.created_at;
  if (createdDelta !== 0) return createdDelta;
  return left.destination.id.localeCompare(right.destination.id);
}

/** O(n) comparison of one transient review against an already-loaded context. */
export function evaluateScanReviewDuplicateGate(
  transientReceipt: ReceiptRow,
  context: ScanReviewDuplicateGateContext
): ScanReviewDuplicateGateMatch | null {
  if (context.receiptById.has(transientReceipt.id)) return null;

  const matches: CollisionDestination[] = [];
  const observedStoreHints = new Set<string>();
  for (const stored of context.storedReceipts) {
    const collision = evaluateExactTransactionReceiptCollision(
      transientReceipt,
      stored
    );
    if (!collision.collided) continue;
    if (collision.storeHintRight) observedStoreHints.add(collision.storeHintRight);
    const destination = resolveStoredDestination(stored, context);
    if (!destination || destination.id === transientReceipt.id) continue;
    matches.push({ destination, collision });
  }

  // Multiple positive stored branch observations that conflict make even this
  // advisory result ambiguous. Missing branch evidence does not conflict.
  if (matches.length === 0 || observedStoreHints.size > 1) return null;

  matches.sort(compareCollisionDestinations);
  const selected = matches[0]!;
  const merchantDisplay =
    selected.destination.merchant_raw?.trim() ||
    selected.destination.merchant_normalized?.trim() ||
    '';
  if (!merchantDisplay) return null;

  return {
    existingReceiptId: selected.destination.id,
    evidenceKey: selected.collision.evidenceKey,
    merchantDisplay,
    transactionAt: selected.collision.transactionAt,
    total: selected.destination.total,
    currency: selected.destination.currency,
    itemCount: selected.collision.itemCount,
  };
}

/** Revalidate the current-owner SQL boundary immediately before navigation. */
export async function revalidateScanReviewDuplicateDestination(
  existingReceiptId: string,
  deps: { getOwnerReceipt?: (id: string) => Promise<ReceiptRow | null> } = {}
): Promise<boolean> {
  if (!existingReceiptId) return false;
  try {
    return Boolean(
      await (deps.getOwnerReceipt ?? getReceipt)(existingReceiptId)
    );
  } catch {
    return false;
  }
}
