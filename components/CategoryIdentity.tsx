import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CategoryIdentityIcon } from '@/components/CategoryIdentityIcon';
import { getCategoryPresentation } from '@/lib/categoryPalette';
import { UI_COLORS } from '@/lib/uiTokens';

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
      <CategoryIdentityIcon category={category} size={size} />
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
