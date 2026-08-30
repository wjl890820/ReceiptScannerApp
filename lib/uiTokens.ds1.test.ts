import * as fs from 'fs';
import * as path from 'path';

import {
  buildMerunoTextStyle,
  resolveMerunoPressableOpacity,
} from './merunoPrimitiveStyle';
import {
  TEXT_ROLES,
  TEXT_TONES,
  UI_COLORS,
  UI_OPACITY,
  UI_SHADOW,
  UI_SPACING,
} from './uiTokens';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('DS-1 uiTokens contracts', () => {
  it('extends UI_SPACING with xxl and xxxl', () => {
    expect(UI_SPACING).toMatchObject({
      xs: 4,
      sm: 8,
      md: 12,
      lg: 16,
      xl: 20,
      xxl: 24,
      xxxl: 32,
    });
  });

  it('defines compact UI_OPACITY semantics', () => {
    expect(UI_OPACITY).toEqual({
      pressed: 0.85,
      disabled: 0.5,
      subdued: 0.6,
    });
  });

  it('defines sticky shadow from Home pending-review bar', () => {
    expect(UI_SHADOW.sticky).toEqual({
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: 0.04,
      shadowRadius: 6,
      elevation: 2,
    });
  });

  it('maps TEXT_TONES to UI_COLORS without category colors', () => {
    expect(TEXT_TONES).toEqual({
      primary: UI_COLORS.textPrimary,
      secondary: UI_COLORS.textSecondary,
      muted: UI_COLORS.textMuted,
      accent: UI_COLORS.accent,
      inverse: UI_COLORS.surface,
      destructive: UI_COLORS.destructive,
    });
  });

  it('codifies SectionTitle typography via sectionTitle and meta roles', () => {
    expect(TEXT_ROLES.sectionTitle).toEqual({
      fontSize: 18,
      fontWeight: '800',
      lineHeight: 24,
    });
    expect(TEXT_ROLES.meta).toEqual({
      fontSize: 13,
      fontWeight: '400',
      lineHeight: 19,
    });
  });

  it('uses tabular nums only on amount and metric roles', () => {
    expect(TEXT_ROLES.amount.fontVariant).toEqual(['tabular-nums']);
    expect(TEXT_ROLES.metric.fontVariant).toEqual(['tabular-nums']);
    expect('fontVariant' in TEXT_ROLES.display).toBe(false);
    expect('fontVariant' in TEXT_ROLES.body).toBe(false);
    expect('fontVariant' in TEXT_ROLES.meta).toBe(false);
  });
});

describe('DS-1 primitive helpers', () => {
  it('merges MerunoText role, tone, and caller style in order', () => {
    const [roleStyle, toneStyle, callerStyle] = buildMerunoTextStyle(
      'sectionTitle',
      'secondary',
      { marginTop: 4 }
    );

    expect(roleStyle).toEqual(TEXT_ROLES.sectionTitle);
    expect(toneStyle).toEqual({ color: TEXT_TONES.secondary });
    expect(callerStyle).toEqual({ marginTop: 4 });
  });

  it('resolves MerunoPressable opacity for normal, pressed, and disabled', () => {
    expect(resolveMerunoPressableOpacity(false, false)).toBe(1);
    expect(resolveMerunoPressableOpacity(false, true)).toBe(UI_OPACITY.pressed);
    expect(resolveMerunoPressableOpacity(true, false)).toBe(UI_OPACITY.disabled);
    expect(resolveMerunoPressableOpacity(true, true)).toBe(UI_OPACITY.disabled);
  });
});

describe('DS-1 SectionTitle migration', () => {
  it('renders through MerunoText roles while preserving layout contract', () => {
    const sectionTitle = source('components/SectionTitle.tsx');

    expect(sectionTitle).toContain('MerunoText role="sectionTitle"');
    expect(sectionTitle).toContain('MerunoText role="meta" tone="secondary"');
    expect(sectionTitle).toContain('marginTop: 26');
    expect(sectionTitle).toContain('marginBottom: UI_SPACING.md');
    expect(sectionTitle).not.toContain('<Text style={styles.title}');
  });

  it('keeps primitives limited to DS-approved shared components', () => {
    const primitiveConsumers = [
      'components/SectionTitle.tsx',
      'components/MilestoneProgressCard.tsx',
      'components/MilestoneProgress.tsx',
      'components/MilestoneUnlockCard.tsx',
      'components/ProgressiveHomeInsights.tsx',
      'components/home/HomeScanAction.tsx',
      'components/home/HomeFrequentProductList.tsx',
    ];
    const notYetMigrated = [
      'components/MerunoGroupedList.tsx',
    ];

    for (const file of primitiveConsumers) {
      expect(source(file)).toContain('@/components/primitives/MerunoText');
    }
    for (const file of notYetMigrated) {
      expect(source(file)).not.toContain('@/components/primitives/');
    }
  });
});
