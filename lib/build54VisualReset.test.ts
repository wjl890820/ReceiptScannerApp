import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('Build 54 visual reset contracts', () => {
  it('removes the Build 53 numbered micro-label system', () => {
    const productionSources = [
      'app/(tabs)/analysis.tsx',
      'app/(tabs)/settings/index.tsx',
      'app/product/[targetType].tsx',
      'components/ProgressiveHomeInsights.tsx',
    ].map(source).join('\n');

    expect(productionSources).not.toContain('IndustrialSectionHeader');
    expect(productionSources).not.toContain('SECTION_MICRO');
    expect(productionSources).not.toMatch(/01\s*\/|QUICK SCAN|OVERVIEW|ACCOUNT/);
  });

  it('uses one Analysis overview region instead of a four-card grid', () => {
    const analysis = source('app/(tabs)/analysis.tsx');
    expect(analysis).toContain('styles.overviewPanel');
    expect(analysis).toContain('styles.metricStrip');
    expect(analysis).not.toContain('styles.overviewGrid');
    expect(analysis).not.toContain('styles.metricCard');
  });

  it('keeps frequent products and History purchases as divided rows', () => {
    const home = source('components/ProgressiveHomeInsights.tsx');
    const history = source('app/(tabs)/history/index.tsx');
    expect(home).toContain('index > 0 && styles.borderTop');
    expect(history).toContain('ItemSeparatorComponent');
    expect(history).toContain('MerchantIdentityTile');
  });

  it('uses grouped Product metrics and localized Settings sections', () => {
    const product = source('app/product/[targetType].tsx');
    const settings = source('app/(tabs)/settings/index.tsx');
    expect(product).toContain('styles.summaryPanel');
    expect(product).toContain('styles.summaryCell');
    expect(settings).toContain("t('settings.sections.preferences')");
    expect(settings).toContain("t('settings.sections.support')");
  });
});
