/**
 * AP-3 frozen period semantics:
 * The selected Analysis period filters the CURRENT price-change event only.
 * The PREVIOUS baseline may predate the selected period.
 *
 * Global canonical history used for baseline lookup is never truncated here.
 */

import type { AnalysisPeriodRange } from './analysisPeriod';
import type { AnalysisTrustedPriceChangeCandidate } from './analysisTrustedPriceChanges';
import {
  MS_PER_DAY,
  rollingDaysForAnalysisRange,
} from './rollingTimeWindow';

/**
 * True when the CURRENT purchase event timestamp falls inside the selected
 * Analysis rolling window (or range === 'all').
 */
export function isCurrentPriceChangeEventInAnalysisPeriod(
  currentOccurredAtMs: number,
  range: AnalysisPeriodRange,
  nowMs: number
): boolean {
  if (
    !Number.isFinite(currentOccurredAtMs) ||
    currentOccurredAtMs <= 0 ||
    !Number.isFinite(nowMs)
  ) {
    return false;
  }
  if (range === 'all') return true;
  const days = rollingDaysForAnalysisRange(range);
  if (days == null) return true;
  const startMs = nowMs - days * MS_PER_DAY;
  return currentOccurredAtMs >= startMs && currentOccurredAtMs <= nowMs;
}

/**
 * Keep candidates whose CURRENT event is in-period.
 * Does not inspect previous baseline timestamps.
 */
export function filterAnalysisTrustedPriceChangeCandidatesByCurrentEventPeriod(
  candidates: readonly AnalysisTrustedPriceChangeCandidate[],
  range: AnalysisPeriodRange,
  nowMs: number
): AnalysisTrustedPriceChangeCandidate[] {
  return candidates.filter((candidate) =>
    isCurrentPriceChangeEventInAnalysisPeriod(
      candidate.latestOccurredAt,
      range,
      nowMs
    )
  );
}
