/**
 * AP-3 — Production loader for Analysis trusted price changes.
 *
 * Reuses engagement product insight rows (owner-scoped, analytics-deduped).
 * Uses session domain cache + cooperative derivation when invoked.
 */

import type { ReceiptRow } from './db';
import type { AnalysisPeriodRange } from './analysisPeriod';
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
import { recordDiagnosticEvent } from './internalDiagnostics';

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
    period?: { range: AnalysisPeriodRange; nowMs: number };
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
    recordDiagnosticEvent({
      category: 'timing',
      name: 'ap3_prepared_context',
      screen: 'analysis',
      meta: { rowCount: context.rows.length },
    });
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
      period: options?.period,
    });
    const result = await scheduled.promise;
    if (result.status === 'canceled' || options?.shouldCancel?.()) {
      recordDiagnosticEvent({
        category: 'timing',
        name: 'ap3_stale_discarded',
        screen: 'analysis',
        meta: { cacheHit: result.cacheHit ? 1 : 0 },
      });
      return UNAVAILABLE_PRICE_CHANGES_SURFACE;
    }
    recordDiagnosticEvent({
      category: 'timing',
      name: 'ap3_applied',
      screen: 'analysis',
      meta: {
        cacheHit: result.cacheHit ? 1 : 0,
        surfaceAvailable: result.surface.status === 'available' ? 1 : 0,
      },
    });
    return result.surface;
  } catch {
    return UNAVAILABLE_PRICE_CHANGES_SURFACE;
  }
}
