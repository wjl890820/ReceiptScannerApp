/**
 * Thin production UI token layer (R2-B5).
 *
 * Semantic visual constants for Home / Analysis / History /
 * Receipt Detail / Product Detail / Settings. Not a theme engine,
 * component library, or dark-mode system.
 *
 * Domain category colors: `lib/categoryPalette.ts` (SSOT) (SSOT).
 * Tab bar contrast: `lib/tabBarPresentation.ts` (accent aligned here).
 */

export const UI_COLORS = {
  background: '#F6F7F9',
  /** Primary information surface */
  surface: '#FFFFFF',
  /** Secondary controls / quiet information wash */
  surfaceMuted: '#F1F3F6',
  textPrimary: '#111318',
  textSecondary: '#6F7680',
  textMuted: '#969DA6',
  /** Restrained structural anchor; never a page background. */
  charcoal: '#17191D',
  border: '#E5E8EC',
  borderSubtle: '#E5E8EC',
  /** Dominant action / link accent across production screens */
  accent: '#1683FF',
  accentDark: '#096AE8',
  /** Quiet information emphasis; not a second page background. */
  accentSoft: '#EAF4FF',
  /** Optional micro-signal only. */
  signal: '#F39228',
  destructive: '#dd3333',
} as const;

export const UI_SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** Semantic opacity — matches common production pressed/disabled behavior. */
export const UI_OPACITY = {
  pressed: 0.85,
  disabled: 0.5,
  subdued: 0.6,
} as const;

/**
 * V1 supports a single elevation style: sticky / floating action surfaces.
 * Extracted from Home pending-review sticky bar.
 */
export const UI_SHADOW = {
  sticky: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 } as const,
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
} as const;

export const UI_RADIUS = {
  card: 10,
  panel: 9,
  hero: 11,
  control: 9,
  input: 9,
  pill: 999,
} as const;

/**
 * Build 54 — restrained industrial-editorial structure.
 * Identity comes from flat surfaces, rules, and hierarchy—not ornament.
 */
export const EDITORIAL_UI = {
  structureLine: '#E5E8EC',
  accentRule: '#1683FF',
  accentRuleWidth: 3,
  merchantBarWidth: 4,
  panelBorder: '#E5E8EC',
  panelBackground: '#FFFFFF',
  metricWash: '#F1F3F6',
  darkAnchor: '#17191D',
  darkAnchorMuted: '#AEB7C3',
} as const;

/** Font sizes only — weights stay local to screens. */
export const UI_TYPOGRAPHY = {
  pageTitle: 32,
  sectionTitle: 22,
  cardTitle: 16,
  body: 16,
  meta: 13,
  caption: 12,
  amount: 16,
} as const;

/** Typography structure only — no colors. Derived from current production hierarchy. */
export type TextRoleStyle = {
  fontSize: number;
  fontWeight: '400' | '500' | '600' | '700' | '800' | '900';
  lineHeight: number;
  letterSpacing?: number;
  fontVariant?: 'tabular-nums'[];
};

export const TEXT_ROLES = {
  display: {
    fontSize: 36,
    fontWeight: '900',
    lineHeight: 43,
  },
  pageTitle: {
    fontSize: 32,
    fontWeight: '900',
    lineHeight: 38,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 24,
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 28,
  },
  metric: {
    fontSize: 26,
    fontWeight: '900',
    lineHeight: 32,
    fontVariant: ['tabular-nums'],
  },
  amount: {
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 22,
    fontVariant: ['tabular-nums'],
  },
  body: {
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 22,
  },
  bodySmall: {
    fontSize: 15,
    fontWeight: '400',
    lineHeight: 21,
  },
  meta: {
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 19,
  },
  caption: {
    fontSize: 12,
    fontWeight: '400',
    lineHeight: 17,
  },
  button: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 20,
  },
  navLabel: {
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 14,
  },
  chip: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 18,
  },
} as const satisfies Record<string, TextRoleStyle>;

/** Semantic text color tones — map to UI_COLORS, not categoryPalette. */
export const TEXT_TONES = {
  primary: UI_COLORS.textPrimary,
  secondary: UI_COLORS.textSecondary,
  muted: UI_COLORS.textMuted,
  accent: UI_COLORS.accent,
  inverse: UI_COLORS.surface,
  destructive: UI_COLORS.destructive,
} as const;

/**
 * Page layout contract. Safe-area insets stay screen-owned;
 * use these as additives (e.g. `insets.top + UI_LAYOUT.safeAreaTopGap`).
 */
export const UI_LAYOUT = {
  pageHorizontalPadding: 16,
  sectionGap: 26,
  /** Common gap after safe-area on tab roots (Home / Analysis / History). */
  safeAreaTopGap: 16,
  /** Compact gap after safe-area (Detail / Product Detail). */
  safeAreaTopGapCompact: 8,
  /** Extra scroll clearance above the bottom tab bar. */
  tabContentClearance: 72,
  controlMinHeight: 44,
} as const;

export type UiColorName = keyof typeof UI_COLORS;
export type UiSpacingName = keyof typeof UI_SPACING;
export type UiRadiusName = keyof typeof UI_RADIUS;
export type UiTypographyName = keyof typeof UI_TYPOGRAPHY;
export type UiLayoutName = keyof typeof UI_LAYOUT;
export type TextRoleName = keyof typeof TEXT_ROLES;
export type TextToneName = keyof typeof TEXT_TONES;
export type UiOpacityName = keyof typeof UI_OPACITY;
export type UiShadowName = keyof typeof UI_SHADOW;
