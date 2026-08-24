import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { getCategoryPresentation } from '@/lib/categoryPalette';
import { UI_RADIUS } from '@/lib/uiTokens';

export function CategoryIdentityIcon({
  category,
  size = 34,
}: {
  category: string;
  size?: number;
}) {
  const presentation = getCategoryPresentation(category);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.iconTile,
        {
          width: size,
          height: size,
          borderColor: `${presentation.color}38`,
          backgroundColor: `${presentation.color}14`,
        },
      ]}
    >
      <MaterialIcons
        name={presentation.icon}
        size={Math.max(15, Math.round(size * 0.52))}
        color={presentation.color}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  iconTile: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: UI_RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
