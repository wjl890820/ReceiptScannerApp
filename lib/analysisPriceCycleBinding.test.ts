import {
  bindPriceChangesToCycle,
  createInitialPriceChangesBinding,
  resolveBoundPriceChangesSurface,
} from './analysisPriceLoadCycle';
import type { AnalysisPriceChangesSurface } from './analysisPriceSurfaces';
import * as fs from 'fs';
import * as path from 'path';

const SAMPLE_AVAILABLE: AnalysisPriceChangesSurface = {
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
};

describe('AP-3 truth-cycle binding (P1A hardening)', () => {
  it('A: Truth A + AP3(A) remains while background refresh B is pending', () => {
    const bindingA = bindPriceChangesToCycle(1, SAMPLE_AVAILABLE);
    // Truth still A while B loads — binding A still matches.
    expect(resolveBoundPriceChangesSurface(1, bindingA)).toEqual(
      SAMPLE_AVAILABLE
    );
  });

  it('B: Truth B commits before AP3(B) => B + unavailable', () => {
    const bindingA = bindPriceChangesToCycle(1, SAMPLE_AVAILABLE);
    expect(resolveBoundPriceChangesSurface(2, bindingA)).toEqual({
      status: 'unavailable',
    });
  });

  it('C: AP3(B) completes => B + AP3(B)', () => {
    const bindingB = bindPriceChangesToCycle(2, SAMPLE_AVAILABLE);
    expect(resolveBoundPriceChangesSurface(2, bindingB)).toBe(SAMPLE_AVAILABLE);
  });

  it('D: late AP3(A) after B => cannot render with Truth B', () => {
    let rendered: AnalysisPriceChangesSurface = { status: 'unavailable' };
    const truthCycleId = { current: 1 };
    const applyPrice = (
      cycleId: number,
      surface: AnalysisPriceChangesSurface
    ) => {
      const binding = bindPriceChangesToCycle(cycleId, surface);
      rendered = resolveBoundPriceChangesSurface(truthCycleId.current, binding);
    };

    applyPrice(1, SAMPLE_AVAILABLE);
    expect(rendered).toEqual(SAMPLE_AVAILABLE);

    truthCycleId.current = 2;
    // Simulate keeping old binding until new one arrives — resolve fail-closed.
    rendered = resolveBoundPriceChangesSurface(
      truthCycleId.current,
      bindPriceChangesToCycle(1, SAMPLE_AVAILABLE)
    );
    expect(rendered).toEqual({ status: 'unavailable' });

    // Late AP3(A) "completes" and tries to bind — still wrong cycle for current truth.
    applyPrice(1, SAMPLE_AVAILABLE);
    expect(rendered).toEqual({ status: 'unavailable' });
  });

  it('E: cached current-cycle AP3 => renders', () => {
    const cached = bindPriceChangesToCycle(5, SAMPLE_AVAILABLE);
    expect(resolveBoundPriceChangesSurface(5, cached)).toBe(SAMPLE_AVAILABLE);
  });

  it('F: flag=false => no AP3 dynamic loader execution path when gate off', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('isAnalysisPriceChangesEnabled');
    expect(source).toContain('resolveBoundPriceChangesSurface');
    expect(source).toContain('bindPriceChangesToCycle');
    expect(source).toContain('!priceChangesEnabled');
    // Dynamic import remains gated; gate false short-circuits before import.
    expect(source).toMatch(
      /if \(!priceChangesEnabled\)[\s\S]*createInitialPriceChangesBinding/
    );
    expect(source).toContain('scheduleAnalysisPriceLoadAfterPaint');
  });

  it('initial binding is unavailable and unmatched', () => {
    const initial = createInitialPriceChangesBinding();
    expect(resolveBoundPriceChangesSurface(1, initial)).toEqual({
      status: 'unavailable',
    });
  });
});
