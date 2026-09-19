/**
 * Phase 2 — physical-manifest post-hoc diagnostics for analytics collapse.
 * Human truth / Phase1 representative is NEVER used to choose survivors.
 */

import { matchManifestToRows } from './matchManifest';
import type { LoadedHistoricalRow, RegressionManifest } from './types';
import type { PhysicalDuplicateGroupReport } from './deepTypes';

const KNOWN_PHYSICAL_DUP_RECEIPT_NOS = [78, 80, 81] as const;

export function reportPhysicalDuplicateGroups(input: {
  manifests: readonly RegressionManifest[];
  loadedRows: readonly LoadedHistoricalRow[];
  includedReceiptIds: ReadonlySet<string>;
  excludedDuplicateReceiptIds: ReadonlySet<string>;
}): PhysicalDuplicateGroupReport[] {
  const out: PhysicalDuplicateGroupReport[] = [];
  for (const receiptNo of KNOWN_PHYSICAL_DUP_RECEIPT_NOS) {
    const manifest = input.manifests.find((m) => m.receiptNo === receiptNo);
    if (!manifest) continue;
    const matchedRows = matchManifestToRows(manifest, [...input.loadedRows]);
    const memberIds = matchedRows.map((r) => r.receiptId);
    const survivingReceiptIds = memberIds
      .filter((id) => input.includedReceiptIds.has(id))
      .sort((a, b) => a.localeCompare(b));
    const excludedReceiptIds = memberIds
      .filter((id) => input.excludedDuplicateReceiptIds.has(id))
      .sort((a, b) => a.localeCompare(b));
    const storedRows = memberIds.length;
    const analyticsIncludedRows = survivingReceiptIds.length;
    const analyticsExcludedRows = excludedReceiptIds.length;
    const collapsedToOneLogicalPurchase =
      storedRows <= 1 ? true : analyticsIncludedRows === 1;

    let collapseDiagnostic: PhysicalDuplicateGroupReport['collapseDiagnostic'];
    if (storedRows === 0) collapseDiagnostic = 'unmatched';
    else if (storedRows === 1) collapseDiagnostic = 'single_stored_row';
    else if (collapsedToOneLogicalPurchase) collapseDiagnostic = 'collapsed_to_one';
    else collapseDiagnostic = 'partial_hc_collapse_expected';

    out.push({
      receiptNo,
      storedRows,
      analyticsIncludedRows,
      analyticsExcludedRows,
      survivingReceiptIds,
      excludedReceiptIds,
      collapsedToOneLogicalPurchase,
      matchedHistoricalRows: [...memberIds],
      collapseDiagnostic,
    });
  }
  return out;
}
