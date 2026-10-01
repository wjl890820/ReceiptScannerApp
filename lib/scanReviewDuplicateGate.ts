import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
  type HighConfidenceDuplicateReceiptGroupMembership,
} from './analyticsReceiptSelection';
import { getReceipt, listReceiptsForAnalysis, type ReceiptRow } from './db';
import { evaluateExactTransactionReceiptCollision } from './receiptExactTransactionCollision';
import {
  evaluateMinuteMultiNameDriftRescanAdvisory,
  evaluateMinuteSingleNameDriftRescanAdvisory,
  evaluateMinuteStrictRescanAdvisory,
  MINUTE_MULTI_NAME_DRIFT_ADVISORY_MATCH_KIND,
  MINUTE_SINGLE_NAME_DRIFT_ADVISORY_MATCH_KIND,
  MINUTE_STRICT_ADVISORY_MATCH_KIND,
} from './scanReviewMinuteStrictAdvisory';
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

export type ScanReviewDuplicateMatchKind =
  | 'SECOND_EXACT'
  | typeof MINUTE_STRICT_ADVISORY_MATCH_KIND
  | typeof MINUTE_SINGLE_NAME_DRIFT_ADVISORY_MATCH_KIND
  | typeof MINUTE_MULTI_NAME_DRIFT_ADVISORY_MATCH_KIND;

export type ScanReviewDuplicateGateMatch = {
  existingReceiptId: string;
  evidenceKey: string;
  merchantDisplay: string;
  transactionAt: number;
  total: number;
  currency: string;
  itemCount: number;
  /**
   * SECOND_EXACT is the second-precision collision.
   * The minute kinds are Scan Review warnings only.
   */
  matchKind: ScanReviewDuplicateMatchKind;
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
  storeHintLeft: string | null;
  storeHintRight: string | null;
  evidenceKey: string;
  transactionAt: number;
  itemCount: number;
  matchKind: ScanReviewDuplicateMatchKind;
};

function resolveStoredDestination(
  receipt: ReceiptRow,
  context: ScanReviewDuplicateGateContext
): ReceiptRow | null {
  const membership = context.highConfidenceGroupByReceiptId.get(receipt.id);
  if (!membership) return receipt;
  return context.receiptById.get(membership.representativeReceiptId) ?? null;
}

function duplicateEvidenceRank(kind: ScanReviewDuplicateMatchKind): number {
  switch (kind) {
    case 'SECOND_EXACT':
      return 0;
    case 'MINUTE_STRICT_ADVISORY':
      return 1;
    case 'MINUTE_SINGLE_NAME_DRIFT_ADVISORY':
      return 2;
    case 'MINUTE_MULTI_NAME_DRIFT_ADVISORY':
      return 3;
  }
}

function compareCollisionDestinations(
  left: CollisionDestination,
  right: CollisionDestination
): number {
  const rankDelta =
    duplicateEvidenceRank(left.matchKind) - duplicateEvidenceRank(right.matchKind);
  if (rankDelta !== 0) return rankDelta;
  const createdDelta = left.destination.created_at - right.destination.created_at;
  if (createdDelta !== 0) return createdDelta;
  if (left.destination.id < right.destination.id) return -1;
  if (left.destination.id > right.destination.id) return 1;
  return 0;
}

/**
 * O(n) comparison of one transient review against an already-loaded context.
 *
 * Branch-hint ambiguity fail-closed when multiple non-null stored storeHints
 * collide — EXCEPT when the draft itself has no storeHint and at least one
 * colliding stored observation is also generic (storeHint=null). That generic
 * match already aligns at the draft's merchant-identity granularity, so more
 * specific historical branch rescans must not veto it (Receipt078).
 */
export function evaluateScanReviewDuplicateGate(
  transientReceipt: ReceiptRow,
  context: ScanReviewDuplicateGateContext
): ScanReviewDuplicateGateMatch | null {
  if (context.receiptById.has(transientReceipt.id)) return null;

  const matches: CollisionDestination[] = [];
  const observedStoreHints = new Set<string>();
  let draftStoreHint: string | null | undefined;
  for (const stored of context.storedReceipts) {
    const collision = evaluateExactTransactionReceiptCollision(
      transientReceipt,
      stored
    );
    const advisory = collision.collided
      ? null
      : evaluateMinuteStrictRescanAdvisory(transientReceipt, stored);
    const nameDrift =
      advisory && !advisory.matched
        ? evaluateMinuteSingleNameDriftRescanAdvisory(transientReceipt, stored)
        : null;
    const multiName =
      nameDrift && !nameDrift.matched && nameDrift.reason === 'name_drift_count'
        ? evaluateMinuteMultiNameDriftRescanAdvisory(transientReceipt, stored)
        : null;
    const hit: Omit<CollisionDestination, 'destination'> | null = collision.collided
      ? {
          storeHintLeft: collision.storeHintLeft,
          storeHintRight: collision.storeHintRight,
          evidenceKey: collision.evidenceKey,
          transactionAt: collision.transactionAt,
          itemCount: collision.itemCount,
          matchKind: 'SECOND_EXACT',
        }
      : advisory?.matched
        ? {
            storeHintLeft: advisory.storeHintLeft,
            storeHintRight: advisory.storeHintRight,
            evidenceKey: advisory.evidenceKey,
            transactionAt: advisory.transactionAt,
            itemCount: advisory.itemCount,
            matchKind: MINUTE_STRICT_ADVISORY_MATCH_KIND,
          }
        : nameDrift?.matched
          ? {
              storeHintLeft: nameDrift.storeHintLeft,
              storeHintRight: nameDrift.storeHintRight,
              evidenceKey: nameDrift.evidenceKey,
              transactionAt: nameDrift.transactionAt,
              itemCount: nameDrift.itemCount,
              matchKind: MINUTE_SINGLE_NAME_DRIFT_ADVISORY_MATCH_KIND,
            }
          : multiName?.matched
            ? {
                storeHintLeft: multiName.storeHintLeft,
                storeHintRight: multiName.storeHintRight,
                evidenceKey: multiName.evidenceKey,
                transactionAt: multiName.transactionAt,
                itemCount: multiName.itemCount,
                matchKind: MINUTE_MULTI_NAME_DRIFT_ADVISORY_MATCH_KIND,
              }
            : null;
    if (!hit) continue;
    if (draftStoreHint === undefined) {
      draftStoreHint = hit.storeHintLeft;
    }
    if (hit.storeHintRight) {
      observedStoreHints.add(hit.storeHintRight);
    }
    const destination = resolveStoredDestination(stored, context);
    if (!destination || destination.id === transientReceipt.id) continue;
    matches.push({ destination, ...hit });
  }

  if (matches.length === 0) return null;

  const branchAmbiguous = observedStoreHints.size > 1;
  const draftHasNoStoreHint = !draftStoreHint;
  const genericMatches = matches.filter((match) => match.storeHintRight == null);

  let candidates = matches;
  if (branchAmbiguous) {
    // Receipt078: generic draft + generic stored collision survives conflicting
    // branch rescans. Without a generic stored match, keep fail-closed.
    if (draftHasNoStoreHint && genericMatches.length > 0) {
      candidates = genericMatches;
    } else {
      return null;
    }
  }

  candidates.sort(compareCollisionDestinations);
  const selected = candidates[0]!;
  const merchantDisplay =
    selected.destination.merchant_raw?.trim() ||
    selected.destination.merchant_normalized?.trim() ||
    '';
  if (!merchantDisplay) return null;

  return {
    existingReceiptId: selected.destination.id,
    evidenceKey: selected.evidenceKey,
    merchantDisplay,
    transactionAt: selected.transactionAt,
    total: selected.destination.total,
    currency: selected.destination.currency,
    itemCount: selected.itemCount,
    matchKind: selected.matchKind,
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
