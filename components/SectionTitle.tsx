import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { MerunoText } from '@/components/primitives/MerunoText';
import { UI_SPACING } from '@/lib/uiTokens';

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
      <MerunoText role="sectionTitle" tone="primary">
        {title}
      </MerunoText>
      {subtitle ? (
        <MerunoText role="meta" tone="secondary" style={styles.subtitle}>
          {subtitle}
        </MerunoText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 26,
    marginBottom: UI_SPACING.md,
  },
  subtitle: {
    marginTop: 4,
  },
});
