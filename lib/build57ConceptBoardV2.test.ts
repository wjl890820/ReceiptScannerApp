import * as fs from 'fs';
import * as path from 'path';

jest.mock('./i18n', () => ({ t: (key: string) => key }));

import { getCategoryColor, getCategoryPresentation } from './categoryPalette';
import { buildHistoryMonthSections } from './historyMonthPresentation';
import { merchantAccentColor } from './merchantAccent';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('Build 57 Concept Board v2.0 presentation contracts', () => {
  it('keeps category identity deterministic and visibly differentiated', () => {
    expect(getCategoryColor('food_ingredients')).toBe('#1683FF');
    expect(getCategoryColor('ready_to_eat')).toBe('#31B8A6');
    expect(getCategoryColor('snacks_drinks')).toBe('#F39228');
    expect(getCategoryColor('household')).toBe('#775BC7');
    expect(getCategoryPresentation('ready_to_eat').icon).toBe('restaurant');
    expect(new Set([
      getCategoryColor('food_ingredients'),
      getCategoryColor('ready_to_eat'),
      getCategoryColor('snacks_drinks'),
      getCategoryColor('household'),
    ]).size).toBe(4);
  });

  it('keeps merchant identity deterministic and app-owned', () => {
    expect(merchantAccentColor('コストコ')).toBe(merchantAccentColor('コストコ'));
    const tile = source('components/MerchantIdentityTile.tsx');
    expect(tile).toContain('merchantAccentColor(');
    expect(tile).toContain('merchantIdentityGlyph');
  });

  it('groups visible receipt rows by localized Tokyo month without changing rows', () => {
    const augustA = {
      id: 'a',
      transaction_at: Date.parse('2026-08-20T10:00:00+09:00'),
      created_at: 1,
    };
    const augustB = {
      id: 'b',
      transaction_at: Date.parse('2026-08-01T10:00:00+09:00'),
      created_at: 2,
    };
    const july = {
      id: 'c',
      transaction_at: Date.parse('2026-07-31T10:00:00+09:00'),
      created_at: 3,
    };
    const sections = buildHistoryMonthSections([augustA, augustB, july], 'zh');
    expect(sections.map((section) => section.title)).toEqual([
      '2026年8月',
      '2026年7月',
    ]);
    expect(sections.flatMap((section) => section.data).map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('uses blue finance heroes and multi-color category presentation', () => {
    const home = source('components/ProgressiveHomeInsights.tsx');
    const analysis = source('app/(tabs)/analysis.tsx');
    expect(home).toContain('backgroundColor: UI_COLORS.accent');
    expect(home).toContain('CategoryDonut');
    expect(analysis).toContain('styles.overviewBlueHero');
    expect(analysis).toContain('CategoryRatioRow');
    expect(analysis).toContain('MerchantIdentityTile');
  });

  it('does not expose internal price keys or global audit exclusions', () => {
    const chart = source('components/ProductPriceHistoryChart.tsx');
    expect(chart).not.toContain('priceHistory.unit.');
    expect(chart).not.toContain('priceHistory.coverageExcludedCurrent');
    expect(chart).toContain("visualMode === 'flat_pair'");
    expect(chart).toContain('result.points.length === 2 ? 112');
  });

  it('preserves native navigation and the review dirty-state guard', () => {
    expect(source('app/(tabs)/history/_layout.tsx')).toContain('gestureEnabled: true');
    expect(source('app/(tabs)/settings/_layout.tsx')).toContain('gestureEnabled: true');
    expect(source('app/_layout.tsx')).toContain('gestureEnabled: true');
    expect(source('app/scan-review/[draftId].tsx')).toContain(
      "navigation.addListener('beforeRemove'"
    );
  });
});
