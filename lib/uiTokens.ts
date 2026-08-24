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
  background: '#ffffff',
  /** List/card surfaces on white pages */
  surface: '#f3f3f3',
  /** Soft page/section wash (Analysis / Settings) */
  surfaceMuted: '#f7f8fa',
  textPrimary: '#111111',
  textSecondary: '#666666',
  textMuted: '#888888',
  border: '#e0e0e0',
  borderSubtle: '#e8eaed',
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
  card: 12,
  /** Build 53 — structured data panels (less soft than card) */
  panel: 8,
  /** Build 53 — hero / primary CTA surfaces */
  hero: 14,
  control: 10,
  input: 12,
  pill: 999,
} as const;

/**
 * Build 53 — Meruno / industrial-data visual language (Arknights-lite ~30%).
 * Additive tokens only — not a full redesign system.
 */
export const INDUSTRIAL_UI = {
  /** Cool gray for micro English section labels */
  microLabel: '#6B7A8A',
  microLabelSize: 10,
  microLabelTracking: 1.4,
  structureLine: '#D7DDE5',
  accentRule: '#1677ff',
  accentRuleWidth: 3,
  merchantBarWidth: 4,
  panelBorder: '#D9DEE6',
  panelBackground: '#FFFFFF',
  metricWash: '#F4F6F8',
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
  sectionGap: 16,
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
