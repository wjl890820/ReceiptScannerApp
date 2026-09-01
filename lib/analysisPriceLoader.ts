/**
 * AP-3 — Production loader for Analysis trusted price changes.
 *
 * Reuses engagement product insight rows (owner-scoped, analytics-deduped).
 */

import type { ReceiptRow } from './db';
import { loadEngagementProductInsightContext } from './engagementMilestones';
import {
  buildAnalysisPriceChangesSurfaceFromRows,
  type AnalysisPriceChangesSurface,
} from './analysisPriceSurfaces';

const UNAVAILABLE_PRICE_CHANGES_SURFACE: AnalysisPriceChangesSurface = {
  status: 'unavailable',
};

export async function loadAnalysisTrustedPriceChangesSurface(
  analyticsReceipts: readonly ReceiptRow[]
): Promise<AnalysisPriceChangesSurface> {
  try {
    const context = await loadEngagementProductInsightContext();
    if (context.queryFailed || context.rows.length === 0) {
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }

    const seedReceiptIds = new Set(
      analyticsReceipts.map((receipt) => receipt.id)
    );
    try {
      return buildAnalysisPriceChangesSurfaceFromRows({
        rows: context.rows,
        seedReceiptIds,
        canonicalDuplicateSelectionApplied: true,
        limit: 3,
      });
    } catch {
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }
  } catch {
    return UNAVAILABLE_PRICE_CHANGES_SURFACE;
  }
}
