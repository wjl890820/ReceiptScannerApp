import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

export type MerunoDisclosureKind = 'none' | 'crossEntity' | 'settings';

export function MerunoDisclosureIndicator({
  kind = 'none',
  pressed = false,
}: {
  kind?: MerunoDisclosureKind;
  pressed?: boolean;
}) {
  if (kind === 'none') return null;

  if (kind === 'settings') {
    return (
      <MaterialIcons
        name="chevron-right"
        size={14}
        color={UI_COLORS.textMuted}
        importantForAccessibility="no"
      />
    );
  }

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.crossEntity, pressed && styles.crossEntityPressed]}
    >
      <MaterialIcons
        name="arrow-forward"
        size={14}
        color={pressed ? UI_COLORS.accent : UI_COLORS.textSecondary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  crossEntity: {
    width: 28,
    height: 28,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  crossEntityPressed: {
    backgroundColor: UI_COLORS.accentSoft,
  },
});
