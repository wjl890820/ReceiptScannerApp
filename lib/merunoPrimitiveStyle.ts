import {
  TEXT_ROLES,
  TEXT_TONES,
  UI_OPACITY,
  type TextRoleName,
  type TextToneName,
} from './uiTokens';

export function buildMerunoTextStyle(
  role: TextRoleName = 'body',
  tone: TextToneName = 'primary',
  style?: Record<string, unknown>
) {
  return [TEXT_ROLES[role], { color: TEXT_TONES[tone] }, style];
}

export function resolveMerunoPressableOpacity(
  disabled: boolean | null | undefined,
  pressed: boolean
): number {
  if (disabled) return UI_OPACITY.disabled;
  if (pressed) return UI_OPACITY.pressed;
  return 1;
}
