/**
 * Bottom tab presentation tokens — contrast-safe on a white tab bar.
 * Keep independent of system dark/light so active never becomes white-on-white.
 *
 * Accent is sourced from `UI_COLORS.accent` (R2-B5). Inactive / border stay
 * tab-specific for contrast and are not remapped onto generic text tokens.
 */

import { UI_COLORS } from '@/lib/uiTokens';

export const TAB_BAR_PRESENTATION = {
  background: UI_COLORS.background,
  active: UI_COLORS.accent,
  inactive: '#687076',
  border: UI_COLORS.borderSubtle,
} as const;

/** Structural guard: active color must stay visible on the tab bar background. */
export function isTabBarActiveContrastSafe(options: {
  activeColor: string;
  backgroundColor: string;
}): boolean {
  const active = options.activeColor.trim().toLowerCase();
  const background = options.backgroundColor.trim().toLowerCase();
  if (!active || !background) return false;
  if (active === background) return false;
  if (active === '#fff' || active === '#ffffff' || active === 'white') {
    if (
      background === '#fff' ||
      background === '#ffffff' ||
      background === 'white'
    ) {
      return false;
    }
  }
  return true;
}
