import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { UI_COLORS } from '@/lib/uiTokens';

export function RatioBar({
  label,
  value,
  percent,
}: {
  label: string;
  value?: string;
  percent: number;
}) {
  const safePercent = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : 0;
  return (
    <View style={styles.row}>
      <View style={styles.labelRow}>
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
        {value ? <Text style={styles.value}>{value}</Text> : null}
        <Text style={styles.percent}>{safePercent}%</Text>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${safePercent === 0 ? 0 : Math.max(safePercent, 1)}%` as any },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 7,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 12,
  },
  label: {
    flex: 1,
    color: UI_COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  value: {
    minWidth: 76,
    color: UI_COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  percent: {
    width: 38,
    color: UI_COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 4,
    backgroundColor: UI_COLORS.surfaceMuted,
    overflow: 'hidden',
  },
  fill: {
    height: 4,
    backgroundColor: UI_COLORS.accent,
  },
});
