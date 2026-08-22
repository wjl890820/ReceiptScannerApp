import * as fs from 'fs';
import * as path from 'path';

import { TAB_BAR_PRESENTATION } from './tabBarPresentation';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
  UI_SPACING,
  UI_TYPOGRAPHY,
} from './uiTokens';

function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
}

describe('uiTokens contract (R2-B5)', () => {
  it('exposes the intended thin semantic groups', () => {
    expect(Object.keys(UI_COLORS).sort()).toEqual(
      [
        'accent',
        'background',
        'border',
        'borderSubtle',
        'destructive',
        'surface',
        'surfaceMuted',
        'textMuted',
        'textPrimary',
        'textSecondary',
      ].sort()
    );
    expect(Object.keys(UI_SPACING).sort()).toEqual(
      ['lg', 'md', 'sm', 'xl', 'xs'].sort()
    );
    expect(Object.keys(UI_RADIUS).sort()).toEqual(
      ['card', 'control', 'input', 'pill'].sort()
    );
    expect(Object.keys(UI_TYPOGRAPHY).sort()).toEqual(
      [
        'amount',
        'body',
        'caption',
        'cardTitle',
        'meta',
        'pageTitle',
        'sectionTitle',
      ].sort()
    );
    expect(Object.keys(UI_LAYOUT).sort()).toEqual(
      [
        'controlMinHeight',
        'pageHorizontalPadding',
        'safeAreaTopGap',
        'safeAreaTopGapCompact',
        'sectionGap',
        'tabContentClearance',
      ].sort()
    );
  });

  it('keeps critical numeric and color values valid', () => {
    for (const value of Object.values(UI_COLORS)) {
      expect(isHexColor(value)).toBe(true);
    }
    expect(UI_COLORS.accent.toLowerCase()).toBe('#1677ff');
    expect(UI_COLORS.textPrimary.toLowerCase()).toBe('#111111');
    expect(UI_LAYOUT.pageHorizontalPadding).toBe(18);
    expect(UI_LAYOUT.tabContentClearance).toBe(72);
    expect(UI_LAYOUT.controlMinHeight).toBe(44);
    expect(UI_RADIUS.card).toBe(12);
    expect(UI_TYPOGRAPHY.pageTitle).toBeGreaterThanOrEqual(24);
    expect(UI_TYPOGRAPHY.pageTitle).toBeLessThanOrEqual(32);
    expect(UI_SPACING.md).toBe(12);
  });

  it('aligns tab accent to the shared accent token without rewriting tab contract', () => {
    expect(TAB_BAR_PRESENTATION.active.toLowerCase()).toBe(
      UI_COLORS.accent.toLowerCase()
    );
    expect(TAB_BAR_PRESENTATION.background.toLowerCase()).toBe(
      UI_COLORS.background.toLowerCase()
    );
    expect(TAB_BAR_PRESENTATION.inactive.toLowerCase()).toBe('#687076');
  });

  it('keeps categoryPalette as an independent domain SSOT', () => {
    const paletteSource = fs.readFileSync(
      path.join(__dirname, 'categoryPalette.ts'),
      'utf8'
    );
    expect(paletteSource).not.toContain('uiTokens');
    expect(paletteSource).toContain('PRODUCT_CATEGORY_COLOR');
    expect(paletteSource).toContain('getCategoryColor');
  });

  it('migrated production screens do not hardcode competing accents', () => {
    const screens = [
      '../app/(tabs)/index.tsx',
      '../app/(tabs)/analysis.tsx',
      '../app/(tabs)/history/index.tsx',
      '../app/(tabs)/history/[id].tsx',
      '../app/product/[targetType].tsx',
      '../app/(tabs)/settings.tsx',
    ];
    for (const relative of screens) {
      const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
      expect(source).toContain('UI_COLORS');
      expect(source).not.toMatch(/['"]#1677ff['"]/);
      expect(source).not.toMatch(/['"]#0a7ea4['"]/);
    }
  });
});
