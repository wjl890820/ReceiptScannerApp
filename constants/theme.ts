/**
 * Expo template theme (light/dark Colors + Fonts).
 *
 * Production screen visual SSOT is `@/lib/uiTokens` (R2-B5).
 * Do not add new production layout/typography/surface tokens here —
 * that would create a competing system.
 *
 * `Colors` remains for template hooks (`hooks/use-theme-color.ts`) and
 * any Expo scaffold components; it is not the app design-system layer.
 */

import { Platform } from 'react-native';

import { UI_COLORS } from '@/lib/uiTokens';

const tintColorLight = UI_COLORS.accent;
const tintColorDark = '#fff';

export const Colors = {
  light: {
    text: UI_COLORS.textPrimary,
    background: UI_COLORS.background,
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
