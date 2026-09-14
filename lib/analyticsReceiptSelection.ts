/**
 * Central analytics receipt selection boundary (D2-A3).
 *
 * Stored receipts remain untouched. Analytics consumers that count real-world
 * purchases should use analyticsReceipts / excludedDuplicateReceiptIds from
 * this module rather than reimplementing duplicate detection.
 *
 * V1 excludes CONTENT_EXACT + STRUCTURAL_EXACT + RECONCILED_STRUCTURAL_EXACT extras.
 * Optional keepSeparateReceiptIds is a future KEEP_SEPARATE override.
 */

import {
  buildHighConfidenceDuplicateGroups,
  summarizeReceiptForDuplicateAudit,
  type AnalysisDDuplicateGroup,
} from './analysisDDuplicateAudit';
import type { ReceiptRow } from './db';

export type AnalyticsReceiptSelectionOpts = {
  /** Future KEEP_SEPARATE — never drop these receipt ids from analytics. */
  keepSeparateReceiptIds?: ReadonlySet<string>;
};

/**
 * Caller-independent duplicate / selection decision.
 * Does NOT retain caller receipt arrays or object references.
 */
export type AnalyticsReceiptSelectionDecision = {
  excludedDuplicateReceiptIds: ReadonlySet<string>;
  contentExactDuplicateExtras: number;
  structuralExactDuplicateExtras: number;
  reconciledStructuralExactDuplicateExtras: number;
  probableDuplicateExtras: number;
  /**
   * Authoritative high-confidence excluded count = excludedDuplicateReceiptIds.size.
   * Includes CONTENT + STRUCTURAL + RECONCILED extras actually dropped from analytics.
   * Do not re-sum confidence buckets independently for this field.
   */
  highConfidenceDuplicateExtras: number;
  highConfidenceDuplicateGroups: AnalysisDDuplicateGroup[];
  keepSeparateReceiptIds: ReadonlySet<string>;
};

export type AnalyticsReceiptSelection = AnalyticsReceiptSelectionDecision & {
  storedReceipts: ReceiptRow[];
  analyticsReceipts: ReceiptRow[];
  analyticsPurchaseCandidateCount: number;
};

export type HighConfidenceDuplicateReceiptGroupMembership = {
  representativeReceiptId: string;
  receiptIds: readonly string[];
  confidence: AnalysisDDuplicateGroup['confidence'];
};

/**
 * Index every member of existing canonical duplicate groups, including the
 * representative. This is interpretation infrastructure only: it never
 * changes grouping, representative selection, or analytics exclusions.
 */
export function indexHighConfidenceDuplicateGroupsByReceiptId(
  groups: readonly AnalysisDDuplicateGroup[]
): ReadonlyMap<string, HighConfidenceDuplicateReceiptGroupMembership> {
  const byReceiptId = new Map<
    string,
    HighConfidenceDuplicateReceiptGroupMembership
  >();

  for (const group of groups) {
    const receiptIds = [...new Set(group.receiptIds)].sort((a, b) =>
      a.localeCompare(b)
    );
    if (
      !group.representativeReceiptId ||
      receiptIds.length < 2 ||
      !receiptIds.includes(group.representativeReceiptId)
    ) {
      throw new Error('invalid_high_confidence_duplicate_group');
    }
    const membership: HighConfidenceDuplicateReceiptGroupMembership = {
      representativeReceiptId: group.representativeReceiptId,
      receiptIds,
      confidence: group.confidence,
    };
    const signature = JSON.stringify(membership);
    for (const receiptId of receiptIds) {
      const existing = byReceiptId.get(receiptId);
      if (existing && JSON.stringify(existing) !== signature) {
        throw new Error('conflicting_high_confidence_duplicate_membership');
      }
      byReceiptId.set(receiptId, membership);
    }
  }

  return byReceiptId;
}

/**
 * Build caller-independent analytics selection decision (expensive O(n²) work).
 */
export function buildAnalyticsReceiptSelectionDecision(
  receipts: ReceiptRow[],
  opts?: AnalyticsReceiptSelectionOpts
): AnalyticsReceiptSelectionDecision {
  const keepSeparateReceiptIds = opts?.keepSeparateReceiptIds ?? new Set<string>();
  const summaries = receipts.map(summarizeReceiptForDuplicateAudit);
  const highConfidenceDuplicateGroups =
    buildHighConfidenceDuplicateGroups(summaries, receipts);

  let contentExactDuplicateExtras = 0;
  let structuralExactDuplicateExtras = 0;
  let reconciledStructuralExactDuplicateExtras = 0;
  const excluded = new Set<string>();

  for (const g of highConfidenceDuplicateGroups) {
    const extras = Math.max(0, g.receiptIds.length - 1);
    if (g.confidence === 'CONTENT_EXACT_DUPLICATE') {
      contentExactDuplicateExtras += extras;
    } else if (
      g.confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE' ||
      g.confidence === 'RECONCILED_DISCOUNT_SHAPE_EQUIVALENT_DUPLICATE' ||
      g.confidence === 'RECONCILED_STRUCTURAL_QUANTITY_NOISE_DUPLICATE'
    ) {
      reconciledStructuralExactDuplicateExtras += extras;
    } else {
      structuralExactDuplicateExtras += extras;
    }
    for (const id of g.receiptIds) {
      if (id === g.representativeReceiptId) continue;
      if (keepSeparateReceiptIds.has(id)) continue;
      excluded.add(id);
    }
  }

  return {
    excludedDuplicateReceiptIds: excluded,
    contentExactDuplicateExtras,
    structuralExactDuplicateExtras,
    reconciledStructuralExactDuplicateExtras,
    probableDuplicateExtras: 0,
    highConfidenceDuplicateExtras: excluded.size,
    highConfidenceDuplicateGroups,
    keepSeparateReceiptIds,
  };
}

/**
 * Reconstruct a caller-specific AnalyticsReceiptSelection from a shared decision.
 * Preserves caller input order and object references.
 */
export function materializeAnalyticsReceiptSelection(
  receipts: ReceiptRow[],
  decision: AnalyticsReceiptSelectionDecision
): AnalyticsReceiptSelection {
  const analyticsReceipts = receipts.filter(
    (r) => !decision.excludedDuplicateReceiptIds.has(r.id)
  );
  return {
    ...decision,
    storedReceipts: receipts,
    analyticsReceipts,
    analyticsPurchaseCandidateCount: analyticsReceipts.length,
  };
}

/**
 * Select receipts for purchase-occurrence analytics.
 * High-confidence duplicate extras are excluded; PROBABLE is not.
 */
export function selectAnalyticsReceipts(
  receipts: ReceiptRow[],
  opts?: AnalyticsReceiptSelectionOpts
): AnalyticsReceiptSelection {
  return materializeAnalyticsReceiptSelection(
    receipts,
    buildAnalyticsReceiptSelectionDecision(receipts, opts)
  );
}

/** Filter productRows (or any { receiptId }) by excluded duplicate receipt ids. */
export function filterProductRowsByExcludedReceiptIds<
  T extends { receiptId: string },
>(rows: readonly T[], excludedIds: ReadonlySet<string>): T[] {
  if (excludedIds.size === 0) return [...rows];
  return rows.filter((row) => !excludedIds.has(row.receiptId));
}
