/**
 * AP-3 optional price surface binding to Analysis truth cycles + period.
 * Prevents stale or out-of-order async price results from rendering.
 */

import type { AnalysisPeriodRange } from './analysisPeriod';
import type { AnalysisPriceChangesSurface } from './analysisPriceSurfaces';

export type AnalysisPriceChangesBinding = {
  cycleId: number;
  /** Selected Analysis range this surface was built for. */
  timeRange: AnalysisPeriodRange | null;
  surface: AnalysisPriceChangesSurface;
};

const UNAVAILABLE_SURFACE: AnalysisPriceChangesSurface = {
  status: 'unavailable',
};

export function createInitialPriceChangesBinding(): AnalysisPriceChangesBinding {
  return { cycleId: 0, timeRange: null, surface: UNAVAILABLE_SURFACE };
}

export function nextAnalysisLoadCycleId(current: number): number {
  return current + 1;
}

export function bindPriceChangesToCycle(
  cycleId: number,
  surface: AnalysisPriceChangesSurface = UNAVAILABLE_SURFACE,
  timeRange: AnalysisPeriodRange | null = null
): AnalysisPriceChangesBinding {
  return { cycleId, timeRange, surface };
}

/**
 * Fail-closed: only surface AP-3 results bound to the active truth cycle
 * AND the currently selected Analysis period.
 */
export function resolveBoundPriceChangesSurface(
  truthCycleId: number | null | undefined,
  binding: AnalysisPriceChangesBinding,
  timeRange?: AnalysisPeriodRange | null
): AnalysisPriceChangesSurface {
  if (truthCycleId == null || binding.cycleId !== truthCycleId) {
    return UNAVAILABLE_SURFACE;
  }
  if (
    timeRange != null &&
    binding.timeRange != null &&
    binding.timeRange !== timeRange
  ) {
    return UNAVAILABLE_SURFACE;
  }
  return binding.surface;
}
