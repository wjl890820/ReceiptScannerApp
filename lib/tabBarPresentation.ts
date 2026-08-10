/**
 * Bottom tab presentation tokens — contrast-safe on a white tab bar.
 * Keep independent of system dark/light so active never becomes white-on-white.
 */

export const TAB_BAR_PRESENTATION = {
  background: '#ffffff',
  active: '#1677ff',
  inactive: '#687076',
  border: '#e8eaed',
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
