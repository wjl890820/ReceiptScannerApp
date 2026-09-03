import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { MerunoDisclosureIndicator } from '@/components/MerunoDisclosureIndicator';
import {
  MerunoGroupedList,
  MerunoGroupedRow,
} from '@/components/MerunoGroupedList';
import { MerunoText } from '@/components/primitives/MerunoText';
import { t } from '@/lib/i18n';
import {
  formatNextPurchaseDaysSinceForDisplay,
  formatNextPurchaseMedianDaysForDisplay,
  type NextPurchaseCandidate,
} from '@/lib/nextPurchaseCandidates';
import { UI_COLORS, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

type HomeNextPurchaseListProps = {
  candidates: readonly NextPurchaseCandidate[];
  onPress?: (candidate: NextPurchaseCandidate) => void;
};

export function HomeNextPurchaseList({
  candidates,
  onPress,
}: HomeNextPurchaseListProps) {
  return (
    <MerunoGroupedList>
      {candidates.map((candidate, index) => {
        const medianDays = formatNextPurchaseMedianDaysForDisplay(
          candidate.cadence.medianIntervalDays
        );
        const daysSince = formatNextPurchaseDaysSinceForDisplay(
          candidate.cadence.daysSinceLastPurchase
        );
        const explanation = t('home.progressive.nextPurchase.explanation', {
          medianDays,
          daysSince,
        });
        const pressable = typeof onPress === 'function';
        return (
          <MerunoGroupedRow
            key={`${candidate.identityKind}:${candidate.identityKey}`}
            onPress={pressable ? () => onPress(candidate) : undefined}
            accessibilityRole={pressable ? 'button' : undefined}
            accessibilityLabel={
              pressable
                ? t('home.progressive.nextPurchase.openHistoryA11y', {
                    name: candidate.displayName,
                  })
                : undefined
            }
            showDivider={index < candidates.length - 1}
            dividerInset={58}
            minHeight={78}
            style={styles.row}
          >
            {({ pressed }) => (
              <View style={styles.rowInner}>
                <View style={styles.iconTile} importantForAccessibility="no">
                  <MaterialIcons
                    name="shopping-bag"
                    size={16}
                    color={UI_COLORS.textSecondary}
                  />
                </View>
                <View style={styles.text}>
                  <MerunoText
                    role="bodySmall"
                    tone="primary"
                    style={styles.name}
                    numberOfLines={2}
                  >
                    {candidate.displayName}
                  </MerunoText>
                  <MerunoText role="meta" tone="secondary" style={styles.meta}>
                    {explanation}
                  </MerunoText>
                </View>
                {pressable ? (
                  <MerunoDisclosureIndicator
                    kind="crossEntity"
                    pressed={pressed}
                  />
                ) : null}
              </View>
            )}
          </MerunoGroupedRow>
        );
      })}
    </MerunoGroupedList>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: 15,
    gap: UI_SPACING.md,
  },
  iconTile: {
    width: 34,
    height: 34,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontWeight: '700',
  },
  meta: {
    marginTop: 4,
  },
});
