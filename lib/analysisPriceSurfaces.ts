/**
 * AP-3 — Analysis trusted price change release surfaces.
 *
 * Presentation-only adapter over interpretProductPriceChange results.
 */

import type { AnalysisTrustedPriceChangeCandidate } from './analysisTrustedPriceChanges';
import {
  collectAnalysisTrustedPriceChangeCandidates,
  selectAnalysisTrustedPriceChangeCandidates,
} from './analysisTrustedPriceChanges';
import type { ProductPriceHistoryRow } from './productPriceHistory';
import { resolveProductPriceChangePresentation } from './productPricePresentation';

export type AnalysisPriceChangeRow = {
  displayName: string;
  direction: 'up' | 'down';
  deltaAmount: number;
  currency: string;
  targetType: 'sku' | 'merchant_product';
  targetKey: string;
  promoBodyKey: 'priceHistory.promo.started' | 'priceHistory.promo.ended' | null;
};

export type AnalysisPriceChangesSurface =
  | { status: 'unavailable' }
  | { status: 'available'; items: AnalysisPriceChangeRow[] };

export function buildAnalysisPriceChangeRow(
  candidate: AnalysisTrustedPriceChangeCandidate
): AnalysisPriceChangeRow {
  const { interpretation } = candidate;
  const presentation = resolveProductPriceChangePresentation(interpretation);
  return {
    displayName: candidate.displayName,
    direction:
      interpretation.grossDirection === 'decreased' ? 'down' : 'up',
    deltaAmount: Math.abs(Math.round(interpretation.grossDelta)),
    currency: interpretation.current.currency,
    targetType: candidate.target.type,
    targetKey: candidate.target.key,
    promoBodyKey: presentation.promo?.key ?? null,
  };
}

export function buildAnalysisPriceChangesSurface(
  candidates: readonly AnalysisTrustedPriceChangeCandidate[],
  limit = 3
): AnalysisPriceChangesSurface {
  const selected = selectAnalysisTrustedPriceChangeCandidates(candidates, limit);
  if (selected.length === 0) {
    return { status: 'unavailable' };
  }
  return {
    status: 'available',
    items: selected.map(buildAnalysisPriceChangeRow),
  };
}

export function buildAnalysisPriceChangesSurfaceFromRows(input: {
  rows: readonly ProductPriceHistoryRow[];
  seedReceiptIds: ReadonlySet<string>;
  canonicalDuplicateSelectionApplied?: boolean;
  limit?: number;
}): AnalysisPriceChangesSurface {
  const candidates = collectAnalysisTrustedPriceChangeCandidates({
    rows: input.rows,
    seedReceiptIds: input.seedReceiptIds,
    canonicalDuplicateSelectionApplied: input.canonicalDuplicateSelectionApplied,
  });
  return buildAnalysisPriceChangesSurface(candidates, input.limit ?? 3);
}
