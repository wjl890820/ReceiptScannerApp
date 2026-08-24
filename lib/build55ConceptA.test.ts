import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('Build 55 Concept A production contracts', () => {
  it('uses the approved blue primary modules on Home and Analysis', () => {
    const home = source('components/ProgressiveHomeInsights.tsx');
    const analysis = source('app/(tabs)/analysis.tsx');
    expect(home).toContain('styles.scanHero');
    expect(home).toContain('backgroundColor: UI_COLORS.accent');
    expect(analysis).toContain('styles.overviewBlueHero');
    expect(analysis).not.toContain('styles.overviewDarkAnchor');
  });

  it('does not call the deprecated price unit translation path', () => {
    const chart = source('components/ProductPriceHistoryChart.tsx');
    expect(chart).not.toContain('priceHistory.unit.');
    expect(chart).toContain('resolveProductPriceKindLabel');
    expect(chart).toContain("visualMode === 'flat_pair'");
  });

  it('keeps History and Review as light grouped lists', () => {
    const history = source('app/(tabs)/history/index.tsx');
    const review = source('app/scan-review/[draftId].tsx');
    expect(history).toContain('buildHistoryMonthSections');
    expect(review).toContain('styles.itemList');
    expect(review).not.toMatch(/backgroundColor:\s*['"]#181[bB]20['"]/);
  });
});
