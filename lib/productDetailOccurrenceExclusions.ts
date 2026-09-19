/**
 * Product Detail occurrence exclusion set — same SSOT as Analysis / milestones.
 * Must be built from the uncapped owner-scoped receipt universe (not History 200).
 */

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { applyOccurrenceRepresentativeUniverse } from './canonicalPurchaseOccurrence';
import type { ReceiptRow } from './db';

/**
 * HC analytics exclusions ∪ non-representative occurrence members.
 * Callers must pass the full owner-scoped receipt set used for Product History
 * aggregation (e.g. listReceiptsForAnalysis), never a display-capped slice.
 */
export function buildProductDetailExcludedReceiptIds(
  ownerScopedReceipts: readonly ReceiptRow[]
): ReadonlySet<string> {
  const selection = selectAnalyticsReceipts([...ownerScopedReceipts]);
  return applyOccurrenceRepresentativeUniverse(
    selection.analyticsReceipts,
    selection.excludedDuplicateReceiptIds
  ).excludedReceiptIds;
}
