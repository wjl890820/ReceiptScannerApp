import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('Build 56 Concept A composition contracts', () => {
  it('uses a bold Home action hero and profile memory summary on Home', () => {
    const home = source('components/ProgressiveHomeInsights.tsx');
    const scan = source('components/home/HomeScanAction.tsx');
    expect(scan).toContain('styles.scanCornerDetail');
    expect(scan).toContain('UI_COLORS.accent');
    expect(home).not.toContain('CategoryDonut');
    expect(home).toContain('home.progressive.profile.frequencyLabel');
    expect(home).toContain('formatMilestoneRecentChange');
  });

  it('keeps Analysis dense and grouped instead of restoring metric cards', () => {
    const analysis = source('app/(tabs)/analysis.tsx');
    expect(analysis).toContain('styles.overviewBlueHero');
    expect(analysis).toContain('styles.metricStrip');
    expect(analysis).toContain('styles.categoryRowDivider');
    expect(analysis).not.toContain('overviewGrid');
  });

  it('uses grouped transaction and receipt-detail structures', () => {
    const history = source('app/(tabs)/history/index.tsx');
    const receipt = source('app/(tabs)/history/[id].tsx');
    expect(history).toContain('MerchantIdentityTile');
    expect(receipt).toContain('<MerunoGroupedRow');
    expect(receipt).toContain('showDivider={index < categorySummary.length - 1}');
    expect(receipt).toContain('backgroundColor: UI_COLORS.surfaceMuted');
  });

  it('keeps price data and framing on the primary data color', () => {
    const price = source('components/ProductPriceHistoryChart.tsx');
    expect(price).toContain('stroke={UI_COLORS.accent}');
    expect(price).toContain('fill={');
    expect(price).toContain('? UI_COLORS.accent');
  });
});
