import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function locale(name: 'en' | 'ja' | 'zh'): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'locales', `${name}.json`), 'utf8')
  );
}

describe('DS-3 Home presentation contracts', () => {
  const homeInsights = source('components/ProgressiveHomeInsights.tsx');
  const homeIndex = source('app/(tabs)/index.tsx');
  const homeExperience = source('lib/homeProgressiveExperience.ts');
  const scanAction = source('components/home/HomeScanAction.tsx');
  const frequentList = source('components/home/HomeFrequentProductList.tsx');
  const groupedList = source('components/MerunoGroupedList.tsx');

  it('leaves progressive home stage domain semantics frozen', () => {
    expect(homeExperience).toContain("if (supportedReceiptCount <= 0) return 'empty'");
    expect(homeExperience).toContain("if (supportedReceiptCount === 1) return 'first'");
    expect(homeExperience).toContain("if (supportedReceiptCount === 2) return 'building'");
    expect(homeExperience).toContain("if (supportedReceiptCount < 5) return 'recent'");
    expect(homeExperience).toContain("if (supportedReceiptCount < 10) return 'frequent'");
    expect(homeExperience).toContain("return 'profile'");
  });

  it('renders scan before accumulated memory sections', () => {
    const scanIndex = homeInsights.indexOf('<HomeScanAction');
    const recentIndex = homeInsights.indexOf('home.progressive.recent.title');
    const insightIndex = homeInsights.indexOf('home.progressive.insight.title');
    const frequentIndex = homeInsights.indexOf('home.progressive.frequent.title');
    const profileIndex = homeInsights.indexOf('home.progressive.profile.title');

    expect(scanIndex).toBeGreaterThan(-1);
    expect(recentIndex).toBeGreaterThan(scanIndex);
    expect(insightIndex).toBeGreaterThan(scanIndex);
    expect(frequentIndex).toBeGreaterThan(scanIndex);
    expect(profileIndex).toBeGreaterThan(scanIndex);
  });

  it('places stage insight before frequent products for the 5–9 frequent stage', () => {
    const insightIndex = homeInsights.indexOf('home.progressive.insight.title');
    const frequentListIndex = homeInsights.indexOf('<HomeFrequentProductList');
    const frequentTitleIndex = homeInsights.indexOf(
      'home.progressive.frequent.title'
    );

    expect(insightIndex).toBeGreaterThan(-1);
    expect(frequentListIndex).toBeGreaterThan(-1);
    expect(insightIndex).toBeLessThan(frequentListIndex);
    expect(insightIndex).toBeLessThan(frequentTitleIndex);
  });

  it('keeps 10+ profile before frequent products', () => {
    const profileIndex = homeInsights.indexOf('home.progressive.profile.title');
    const frequentIndex = homeInsights.indexOf('home.progressive.frequent.title');

    expect(profileIndex).toBeGreaterThan(-1);
    expect(frequentIndex).toBeGreaterThan(profileIndex);
  });

  it('keeps scan hero on DS accent action language', () => {
    expect(scanAction).toContain('backgroundColor: UI_COLORS.accent');
    expect(scanAction).toContain('UI_RADIUS.hero');
    expect(scanAction).not.toContain('UI_COLORS.charcoal');
    expect(scanAction).not.toMatch(/['"]#1677ff['"]/);
  });

  it('removes CategoryDonut from Home and uses disclosure instead of text chevrons', () => {
    expect(homeInsights).not.toContain('CategoryDonut');
    expect(homeInsights).not.toContain('ProfileComposition');
    expect(homeInsights).not.toContain('insightCategoryTitle');
    expect(homeInsights).not.toMatch(/›/);
    expect(homeInsights).toContain('MerunoDisclosureIndicator');
    expect(homeInsights).toContain('kind="crossEntity"');
  });

  it('preserves frequent and profile stage product memory paths', () => {
    expect(homeInsights).toContain('HomeFrequentProductList');
    expect(homeInsights).toContain("experience.stage === 'frequent'");
    expect(homeInsights).toContain("experience.stage === 'profile'");
    expect(frequentList).toContain('formatFrequentProductLabel');
    expect(frequentList).toContain('purchaseOccurrenceCount');
    expect(homeInsights).toContain('onProductPress');
  });

  it('DS-3.1: profile summary separates metric label/value from recent-change narrative', () => {
    expect(homeInsights).toContain('home.progressive.profile.frequencyLabel');
    expect(homeInsights).toContain('home.progressive.profile.frequencyValue');
    expect(homeInsights).toContain('home.progressive.profile.recentChangeLabel');
    expect(homeInsights).toContain('averageIntervalDays.toFixed');
    expect(homeInsights).toContain('formatMilestoneRecentChange');
    expect(homeInsights).toContain('role="metric"');
    expect(homeInsights).toContain('role="bodySmall"');
    expect(homeInsights).not.toMatch(/home\.progressive\.profile\.frequency['"]/);
    expect(homeInsights).not.toMatch(/profileSummary|profileFact/);
  });

  it('DS-3.1: profile label keys exist in all locales', () => {
    for (const file of ['en', 'ja', 'zh'] as const) {
      const profile = (
        (locale(file).home as Record<string, unknown>).progressive as Record<
          string,
          unknown
        >
      ).profile as Record<string, string>;
      expect(profile.frequencyLabel).toBeTruthy();
      expect(profile.frequencyValue).toContain('{days}');
      expect(profile.recentChangeLabel).toBeTruthy();
    }
  });

  it('DS-3.1: Home frequent rows use compact minHeight without changing global default', () => {
    expect(frequentList).toContain('minHeight={78}');
    expect(groupedList).toContain('minHeight = 92');
    expect(frequentList).not.toContain('minHeight={92}');
  });

  it('preserves P0 unknown-date semantics on latest purchase', () => {
    expect(homeInsights).toContain("t('history.detail.dateUnknown')");
    expect(homeInsights).toContain('transactionAt != null');
  });

  it('does not add new Home sections or touch Receipt Detail / Analysis production files', () => {
    const sectionTitles = [
      'home.progressive.recent.title',
      'home.progressive.profile.title',
      'home.progressive.frequent.title',
      'home.progressive.insight.title',
    ];
    for (const key of sectionTitles) {
      const first = homeInsights.indexOf(key);
      const last = homeInsights.lastIndexOf(key);
      expect(first).toBeGreaterThan(-1);
      expect(first).toBe(last);
    }
    expect(source('app/(tabs)/history/[id].tsx')).not.toContain(
      'frequencyLabel'
    );
    expect(source('app/(tabs)/analysis.tsx')).not.toContain('frequencyLabel');
  });

  it('keeps milestone progress supporting-only without a Home section title', () => {
    expect(homeInsights).toContain('MilestoneProgressCard');
    expect(homeInsights).toContain('experience.status.nextMilestone != null');
    expect(homeInsights).not.toContain('home.progressive.progress.section');
    expect(homeInsights).toContain('milestoneProgressWrap');
  });

  it('preserves Home navigation targets', () => {
    expect(homeIndex).toContain('buildHomeFrequentProductDetailHref');
    expect(homeIndex).toContain('router.push(`/history/${encodeURIComponent(receiptId)}`');
    expect(homeInsights).toContain('onRecentPurchasePress');
  });

  it('tokenizes sticky pending-review elevation', () => {
    expect(homeIndex).toContain('UI_SHADOW.sticky');
    expect(homeIndex).not.toContain('shadowColor:');
  });

  it('avoids banned legacy Home raw colors in touched Home files', () => {
    const touched = [
      'components/ProgressiveHomeInsights.tsx',
      'components/home/HomeScanAction.tsx',
      'components/home/HomeFrequentProductList.tsx',
    ];

    for (const file of touched) {
      const contents = source(file);
      expect(contents).not.toMatch(/['"]#15181c['"]/);
      expect(contents).not.toMatch(/['"]#747d88['"]/);
      expect(contents).not.toMatch(/['"]#1677ff['"]/);
      expect(contents).not.toMatch(/['"]#262b31['"]/);
      expect(contents).not.toMatch(/['"]#727b86['"]/);
    }
  });
});
