import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { getCategoryColor, getCategoryLabel } from '@/lib/categoryPalette';
import { UI_COLORS } from '@/lib/uiTokens';

const SIZE = 116;
const STROKE = 11;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export type CategoryDonutEntry = {
  category: string;
  share: number;
};

export function CategoryDonut({ entries }: { entries: CategoryDonutEntry[] }) {
  const normalized = useMemo(() => {
    const visible = entries.filter((entry) => entry.share > 0);
    const total = visible.reduce((sum, entry) => sum + entry.share, 0);
    return visible.map((entry) => ({
      ...entry,
      share: total > 0 ? entry.share / total : 0,
    }));
  }, [entries]);
  const dominant = normalized.reduce<(typeof normalized)[number] | null>(
    (current, entry) =>
      current == null || entry.share > current.share ? entry : current,
    null
  );
  let consumed = 0;

  return (
    <View style={styles.composition}>
      <View style={styles.ringWrap}>
        <Svg width={SIZE} height={SIZE} accessibilityElementsHidden>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={UI_COLORS.surfaceMuted}
            strokeWidth={STROKE}
          />
          {normalized.map((entry) => {
            const segment = CIRCUMFERENCE * entry.share;
            const gap = Math.min(4, segment * 0.16);
            const offset = CIRCUMFERENCE * consumed;
            consumed += entry.share;
            return (
              <Circle
                key={entry.category}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={getCategoryColor(entry.category)}
                strokeWidth={STROKE}
                strokeDasharray={`${Math.max(0, segment - gap)} ${CIRCUMFERENCE}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
                rotation={-90}
                origin={`${SIZE / 2}, ${SIZE / 2}`}
              />
            );
          })}
        </Svg>
        <View style={styles.center} pointerEvents="none">
          <Text style={styles.centerValue}>
            {dominant ? `${Math.round(dominant.share * 100)}%` : '—'}
          </Text>
          <Text style={styles.centerLabel} numberOfLines={1}>
            {dominant ? getCategoryLabel(dominant.category) : ''}
          </Text>
        </View>
      </View>
      <View style={styles.legend}>
        {normalized.map((entry) => (
          <View key={entry.category} style={styles.legendRow}>
            <View
              style={[
                styles.legendMark,
                { backgroundColor: getCategoryColor(entry.category) },
              ]}
            />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {getCategoryLabel(entry.category)}
            </Text>
            <Text style={styles.legendValue}>
              {Math.round(entry.share * 100)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  composition: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  ringWrap: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  centerValue: {
    color: UI_COLORS.textPrimary,
    fontSize: 21,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  centerLabel: {
    marginTop: 2,
    color: UI_COLORS.textSecondary,
    fontSize: 10,
    fontWeight: '700',
  },
  legend: {
    flex: 1,
    minWidth: 0,
    gap: 10,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legendMark: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  legendLabel: {
    flex: 1,
    minWidth: 0,
    color: UI_COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  legendValue: {
    color: UI_COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
});
