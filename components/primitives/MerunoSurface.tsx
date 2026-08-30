import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { EDITORIAL_UI, UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

export type MerunoSurfaceVariant = 'default' | 'muted' | 'anchor';

export type MerunoSurfaceProps = ViewProps & {
  variant?: MerunoSurfaceVariant;
  style?: StyleProp<ViewStyle>;
};

const VARIANT_STYLES: Record<MerunoSurfaceVariant, ViewStyle> = {
  default: {
    backgroundColor: EDITORIAL_UI.panelBackground,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: EDITORIAL_UI.panelBorder,
    borderRadius: UI_RADIUS.panel,
  },
  muted: {
    backgroundColor: EDITORIAL_UI.metricWash,
    borderRadius: UI_RADIUS.panel,
  },
  anchor: {
    backgroundColor: UI_COLORS.charcoal,
    borderRadius: UI_RADIUS.hero,
  },
};

export function MerunoSurface({
  variant = 'default',
  style,
  ...rest
}: MerunoSurfaceProps) {
  return <View style={[VARIANT_STYLES[variant], style]} {...rest} />;
}
