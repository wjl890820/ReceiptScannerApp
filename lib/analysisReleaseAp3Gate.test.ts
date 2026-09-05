import fs from 'fs';
import path from 'path';

import { buildAnalysisReleaseViewModel } from './analysisPresentation';
import { createEmptyStats } from './analysisHelpers';
import {
  isAnalysisPriceChangesEnabled,
  setAnalysisPriceChangesEnabledForTests,
} from './analysisPriceChangesGate';

const ANALYSIS_SCREEN = path.join(__dirname, '../app/(tabs)/analysis.tsx');
const EAS_JSON = path.join(__dirname, '../eas.json');

function readAnalysisScreenSource(): string {
  return fs.readFileSync(ANALYSIS_SCREEN, 'utf8');
}

describe('Analysis C2D — AP-3 validation-only release gate', () => {
  afterEach(() => {
    setAnalysisPriceChangesEnabledForTests(null);
    delete process.env.ENABLE_ANALYSIS_PRICE_CHANGES;
  });

  it('disables AP-3 by default (fail closed / production path)', () => {
    expect(isAnalysisPriceChangesEnabled()).toBe(false);
    const eas = JSON.parse(fs.readFileSync(EAS_JSON, 'utf8'));
    expect(eas.build.production.env.ENABLE_ANALYSIS_PRICE_CHANGES).toBe('false');
  });

  it('enables AP-3 only via validation profile configuration', () => {
    const eas = JSON.parse(fs.readFileSync(EAS_JSON, 'utf8'));
    expect(eas.build.validation.env.ENABLE_ANALYSIS_PRICE_CHANGES).toBe('true');
    for (const [name, profile] of Object.entries(eas.build) as [
      string,
      { env?: Record<string, string> },
    ][]) {
      const value = profile.env?.ENABLE_ANALYSIS_PRICE_CHANGES;
      expect(value).toBeDefined();
      expect(value).toBe(name === 'validation' ? 'true' : 'false');
    }
    setAnalysisPriceChangesEnabledForTests(true);
    expect(isAnalysisPriceChangesEnabled()).toBe(true);
  });

  it('Analysis screen wires the validation gate + cooperative AP-3 path', () => {
    const source = readAnalysisScreenSource();
    expect(source).toContain('isAnalysisPriceChangesEnabled');
    expect(source).toContain('scheduleAnalysisPriceLoadAfterPaint');
    expect(source).toContain('period:');
    expect(source).not.toContain('ANALYSIS_PRICE_CHANGES_ENABLED = false');
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
