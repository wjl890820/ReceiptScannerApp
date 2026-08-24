import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getCategoryColor } from '@/lib/categoryPalette';
import { UI_COLORS } from '@/lib/uiTokens';

import { CategoryIdentity } from './CategoryIdentity';

export function CategoryRatioRow({
  category,
  amount,
  percent,
}: {
  category: string;
  amount: string;
  percent: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const color = getCategoryColor(category);

  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <CategoryIdentity category={category} compact />
        <View style={styles.values}>
          <Text style={styles.amount}>{amount}</Text>
          <Text style={styles.percent}>{Math.round(clamped)}%</Text>
        </View>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            {
              backgroundColor: color,
              width: clamped === 0 ? 2 : `${clamped}%`,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  values: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'flex-end',
    gap: 12,
  },
  amount: {
    color: UI_COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  percent: {
    minWidth: 34,
    color: UI_COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 5,
    borderRadius: 3,
    backgroundColor: UI_COLORS.surfaceMuted,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
});
