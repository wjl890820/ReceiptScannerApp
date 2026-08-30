import React from 'react';
import {
  Text,
  type StyleProp,
  type TextProps,
  type TextStyle,
} from 'react-native';

import { buildMerunoTextStyle as buildMerunoTextStyleBase } from '@/lib/merunoPrimitiveStyle';
import { type TextRoleName, type TextToneName } from '@/lib/uiTokens';

export type MerunoTextProps = Omit<TextProps, 'role'> & {
  role?: TextRoleName;
  tone?: TextToneName;
  style?: StyleProp<TextStyle>;
};

export function buildMerunoTextStyle(
  role: TextRoleName = 'body',
  tone: TextToneName = 'primary',
  style?: StyleProp<TextStyle>
): StyleProp<TextStyle> {
  return buildMerunoTextStyleBase(role, tone, style as Record<string, unknown>);
}

export function MerunoText({
  role = 'body',
  tone = 'primary',
  style,
  ...rest
}: MerunoTextProps) {
  return <Text style={buildMerunoTextStyle(role, tone, style)} {...rest} />;
}
