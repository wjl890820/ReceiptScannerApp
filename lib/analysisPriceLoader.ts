/**
 * AP-3 — Production loader for Analysis trusted price changes.
 *
 * Reuses engagement product insight rows (owner-scoped, analytics-deduped).
 * Uses session domain cache + cooperative derivation when invoked.
 */

import type { ReceiptRow } from './db';
import { loadEngagementProductInsightContext } from './engagementMilestones';
import {
  buildDefaultAnalysisPriceReceiptFingerprints,
  scheduleDeriveAnalysisPriceDomain,
} from './analysisPriceDerivation';
import type { AnalysisPriceChangesSurface } from './analysisPriceSurfaces';
import { resolveCurrentLocalReceiptOwnerScope } from './receiptOwnershipScope';
import {
  createAnalysisPriceGeneration,
  type AnalysisPriceFocusToken,
  type AnalysisPriceGeneration,
} from './analysisPriceScheduler';

const UNAVAILABLE_PRICE_CHANGES_SURFACE: AnalysisPriceChangesSurface = {
  status: 'unavailable',
};

export async function loadAnalysisTrustedPriceChangesSurface(
  analyticsReceipts: readonly ReceiptRow[],
  options?: {
    generation?: AnalysisPriceGeneration;
    focusToken?: AnalysisPriceFocusToken;
    shouldCancel?: () => boolean;
    deferUntilPaint?: boolean;
  }
): Promise<AnalysisPriceChangesSurface> {
  try {
    if (options?.shouldCancel?.()) {
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }
    const ownerScope = await resolveCurrentLocalReceiptOwnerScope();
    if (ownerScope.status !== 'ready') {
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }
    if (options?.shouldCancel?.()) {
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }
    const context = await loadEngagementProductInsightContext();
    if (context.queryFailed || context.rows.length === 0) {
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }
    if (options?.shouldCancel?.()) {
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }

    const generation =
      options?.generation ?? createAnalysisPriceGeneration();
    const scheduled = scheduleDeriveAnalysisPriceDomain({
      ownerKey: ownerScope.ownerKey,
      analyticsReceipts,
      rows: context.rows,
      receiptFingerprints:
        buildDefaultAnalysisPriceReceiptFingerprints(analyticsReceipts),
      generation,
      focusToken: options?.focusToken,
      shouldCancel: options?.shouldCancel,
      deferUntilPaint: options?.deferUntilPaint ?? false,
      limit: 3,
    });
    const result = await scheduled.promise;
    if (result.status === 'canceled' || options?.shouldCancel?.()) {
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }
    return result.surface;
  } catch {
    return UNAVAILABLE_PRICE_CHANGES_SURFACE;
  }
}
