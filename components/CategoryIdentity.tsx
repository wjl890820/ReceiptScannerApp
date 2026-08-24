import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getCategoryPresentation } from '@/lib/categoryPalette';
import { UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

export function CategoryIdentity({
  category,
  compact = false,
  showLabel = true,
}: {
  category: string;
  compact?: boolean;
  showLabel?: boolean;
}) {
  const presentation = getCategoryPresentation(category);
  const size = compact ? 28 : 34;

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.iconTile,
          { width: size, height: size, borderColor: presentation.color },
        ]}
      >
        <MaterialIcons
          name={presentation.icon}
          size={compact ? 15 : 18}
          color={presentation.color}
        />
      </View>
      {showLabel ? (
        <Text style={[styles.label, compact && styles.compactLabel]} numberOfLines={1}>
          {presentation.label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minWidth: 0,
  },
  iconTile: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: UI_RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: UI_COLORS.surface,
  },
  label: {
    flexShrink: 1,
    color: UI_COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  compactLabel: {
    fontSize: 13,
  },
});
