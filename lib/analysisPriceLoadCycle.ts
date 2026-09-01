/**
 * AP-3 optional price surface binding to Analysis truth cycles.
 * Prevents stale or out-of-order async price results from rendering.
 */

import type { AnalysisPriceChangesSurface } from './analysisPriceSurfaces';

export type AnalysisPriceChangesBinding = {
  cycleId: number;
  surface: AnalysisPriceChangesSurface;
};

const UNAVAILABLE_SURFACE: AnalysisPriceChangesSurface = {
  status: 'unavailable',
};

export function createInitialPriceChangesBinding(): AnalysisPriceChangesBinding {
  return { cycleId: 0, surface: UNAVAILABLE_SURFACE };
}

export function nextAnalysisLoadCycleId(current: number): number {
  return current + 1;
}

export function bindPriceChangesToCycle(
  cycleId: number,
  surface: AnalysisPriceChangesSurface = UNAVAILABLE_SURFACE
): AnalysisPriceChangesBinding {
  return { cycleId, surface };
}

/**
 * Fail-closed: only surface AP-3 results bound to the active truth cycle.
 */
export function resolveBoundPriceChangesSurface(
  truthCycleId: number | null | undefined,
  binding: AnalysisPriceChangesBinding
): AnalysisPriceChangesSurface {
  if (truthCycleId == null || binding.cycleId !== truthCycleId) {
    return UNAVAILABLE_SURFACE;
  }
  return binding.surface;
}
