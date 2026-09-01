import {
  bindPriceChangesToCycle,
  createInitialPriceChangesBinding,
  nextAnalysisLoadCycleId,
  resolveBoundPriceChangesSurface,
} from './analysisPriceLoadCycle';

describe('analysisPriceLoadCycle', () => {
  it('hides optional price results from a stale truth cycle', () => {
    const binding = bindPriceChangesToCycle(1, {
      status: 'available',
      items: [
        {
          displayName: 'Milk',
          direction: 'up',
          deltaAmount: 20,
          currency: 'JPY',
          targetType: 'sku',
          targetKey: 'sku-a',
          promoBodyKey: null,
        },
      ],
    });
    expect(resolveBoundPriceChangesSurface(2, binding)).toEqual({
      status: 'unavailable',
    });
  });

  it('surfaces optional price results only for the matching truth cycle', () => {
    const surface = {
      status: 'available' as const,
      items: [],
    };
    const binding = bindPriceChangesToCycle(3, surface);
    expect(resolveBoundPriceChangesSurface(3, binding)).toBe(surface);
  });

  it('rejects out-of-order async completion against a newer cycle', () => {
    let cycleId = 0;
    cycleId = nextAnalysisLoadCycleId(cycleId);
    const olderBinding = bindPriceChangesToCycle(cycleId, {
      status: 'available',
      items: [],
    });
    const newerCycleId = nextAnalysisLoadCycleId(cycleId);
    expect(resolveBoundPriceChangesSurface(newerCycleId, olderBinding)).toEqual({
      status: 'unavailable',
    });
  });

  it('starts each load with unavailable optional price surface', () => {
    const cycleId = nextAnalysisLoadCycleId(
      createInitialPriceChangesBinding().cycleId
    );
    const binding = bindPriceChangesToCycle(cycleId);
    expect(binding.surface).toEqual({ status: 'unavailable' });
  });
});
