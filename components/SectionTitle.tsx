import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { UI_COLORS, UI_SPACING } from '@/lib/uiTokens';

export function SectionTitle({
  title,
  subtitle,
  style,
}: {
  title: string;
  subtitle?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.wrap, style]} accessibilityRole="header">
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 26,
    marginBottom: UI_SPACING.md,
  },
  title: {
    color: UI_COLORS.textPrimary,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '800',
  },
  subtitle: {
    marginTop: 4,
    color: UI_COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
});
