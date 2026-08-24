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
  background: '#f6f7f9',
  /** Primary information surface */
  surface: '#ffffff',
  /** Secondary controls / quiet information wash */
  surfaceMuted: '#f0f2f5',
  textPrimary: '#111111',
  textSecondary: '#666666',
  textMuted: '#888888',
  border: '#dce1e7',
  borderSubtle: '#e8ebef',
  /** Dominant action / link accent across production screens */
  accent: '#1677ff',
  destructive: '#dd3333',
} as const;

export const UI_SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
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
  structureLine: '#DCE1E7',
  accentRule: '#1677ff',
  accentRuleWidth: 3,
  merchantBarWidth: 4,
  panelBorder: '#DCE1E7',
  panelBackground: '#FFFFFF',
  metricWash: '#F0F2F5',
} as const;

/** Font sizes only — weights stay local to screens. */
export const UI_TYPOGRAPHY = {
  pageTitle: 28,
  sectionTitle: 22,
  cardTitle: 16,
  body: 16,
  meta: 13,
  caption: 12,
  amount: 16,
} as const;

/**
 * Page layout contract. Safe-area insets stay screen-owned;
 * use these as additives (e.g. `insets.top + UI_LAYOUT.safeAreaTopGap`).
 */
export const UI_LAYOUT = {
  pageHorizontalPadding: 18,
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
