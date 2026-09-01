import fs from 'fs';
import path from 'path';

import { buildAnalysisReleaseViewModel } from './analysisPresentation';
import { createEmptyStats } from './analysisHelpers';

const ANALYSIS_SCREEN = path.join(__dirname, '../app/(tabs)/analysis.tsx');

function readAnalysisScreenSource(): string {
  return fs.readFileSync(ANALYSIS_SCREEN, 'utf8');
}

describe('Analysis Build 80 — AP-3 release gate', () => {
  it('disables AP-3 at the production Analysis screen', () => {
    const source = readAnalysisScreenSource();
    expect(source).toContain('ANALYSIS_PRICE_CHANGES_ENABLED = false');
    expect(source).not.toContain('loadAnalysisTrustedPriceChangesSurface');
    expect(source).not.toContain('analysisScreenLoadLifecycle');
    expect(source).not.toContain('yieldToUiThread');
  });

  it('passes unavailable priceChanges to the release view model', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
      priceChanges: { status: 'unavailable' },
    });
    expect(vm.priceChanges).toEqual({ status: 'unavailable' });
  });

  it('cannot render purchase-price-change section when priceChanges is unavailable', () => {
    const source = readAnalysisScreenSource();
    expect(source).toContain("viewModel.priceChanges.status === 'available'");
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
      priceChanges: { status: 'unavailable' },
    });
    expect(vm.priceChanges.status).not.toBe('available');
  });

  it('preserves week/month/all and period-change finalization gates', () => {
    const source = readAnalysisScreenSource();
    expect(source).toContain("timeRange !== 'all'");
    expect(source).toContain('showPeriodChangesSection');
    expect(source).toContain("analysis.timeRange.${range}");
  });

  it('keeps Finalization overview label and insight suppression contracts', () => {
    const source = readAnalysisScreenSource();
    expect(source).toContain("t('analysis.release.totalSpend')");
    expect(source).not.toContain('buildPriceRadarData');
    expect(source).not.toContain('buildCategoryIndexData');
    expect(source).toContain('priceRadarMigrated: false');
  });
});
