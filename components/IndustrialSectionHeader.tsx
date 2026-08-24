import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { INDUSTRIAL_UI, UI_COLORS, UI_SPACING } from '@/lib/uiTokens';

type IndustrialSectionHeaderProps = {
  /** Visual micro token, e.g. "01 / QUICK SCAN" — secondary only */
  microLabel: string;
  /** Localized primary section title */
  title: string;
  /** Optional short structural rule under the title */
  showRule?: boolean;
};

/**
 * Build 53 — reusable section header.
 * English micro label is secondary; localized title remains primary comprehension.
 */
export function IndustrialSectionHeader({
  microLabel,
  title,
  showRule = true,
}: IndustrialSectionHeaderProps) {
  return (
    <View style={styles.wrap} accessibilityRole="header">
      <Text style={styles.micro} importantForAccessibility="no">
        {microLabel}
      </Text>
      <Text style={styles.title}>{title}</Text>
      {showRule ? <View style={styles.rule} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: UI_SPACING.sm,
  },
  micro: {
    color: INDUSTRIAL_UI.microLabel,
    fontSize: INDUSTRIAL_UI.microLabelSize,
    fontWeight: '700',
    letterSpacing: INDUSTRIAL_UI.microLabelTracking,
    textTransform: 'uppercase',
  },
  title: {
    marginTop: 4,
    color: UI_COLORS.textPrimary,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  rule: {
    marginTop: 8,
    width: 28,
    height: 2,
    backgroundColor: INDUSTRIAL_UI.accentRule,
  },
});
