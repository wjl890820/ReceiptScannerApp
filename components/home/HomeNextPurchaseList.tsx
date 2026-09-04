import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

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
import {
  SHOPPING_LIST_QUANTITY_MAX,
  shoppingListIdentityKey,
} from '@/lib/shoppingList';
import { UI_COLORS, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

type HomeNextPurchaseListProps = {
  candidates: readonly NextPurchaseCandidate[];
  activeShoppingListIdentities?: ReadonlySet<string>;
  activeShoppingListQuantities?: ReadonlyMap<string, number>;
  onPress?: (candidate: NextPurchaseCandidate) => void;
  onAddToShoppingList?: (candidate: NextPurchaseCandidate) => void;
};

export function HomeNextPurchaseList({
  candidates,
  activeShoppingListIdentities,
  activeShoppingListQuantities,
  onPress,
  onAddToShoppingList,
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
        const identity =
          candidate.identityKind === 'merchant_product' ||
          candidate.identityKind === 'personal_product'
            ? shoppingListIdentityKey(
                candidate.identityKind,
                candidate.identityKey
              )
            : null;
        const alreadyAdded =
          identity != null &&
          activeShoppingListIdentities != null &&
          activeShoppingListIdentities.has(identity);
        const quantity =
          identity != null && activeShoppingListQuantities
            ? activeShoppingListQuantities.get(identity) ?? 1
            : 1;
        const atMax = alreadyAdded && quantity >= SHOPPING_LIST_QUANTITY_MAX;
        const canTapPlus =
          typeof onAddToShoppingList === 'function' && !atMax;

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
                {typeof onAddToShoppingList === 'function' ? (
                  <View style={styles.qtyCluster}>
                    {alreadyAdded ? (
                      <MerunoText
                        role="caption"
                        tone="secondary"
                        style={styles.qtyLabel}
                        importantForAccessibility="no"
                      >
                        {`×${quantity}`}
                      </MerunoText>
                    ) : null}
                    <Pressable
                      onPress={() => {
                        if (canTapPlus) onAddToShoppingList(candidate);
                      }}
                      disabled={!canTapPlus}
                      accessibilityRole="button"
                      accessibilityLabel={
                        alreadyAdded
                          ? t('shoppingList.increaseQuantityA11y', {
                              quantity,
                            })
                          : t('home.progressive.nextPurchase.addA11y', {
                              name: candidate.displayName,
                            })
                      }
                      hitSlop={8}
                      style={({ pressed: addPressed }) => [
                        styles.addButton,
                        addPressed && styles.addPressed,
                        !canTapPlus && styles.addDisabled,
                      ]}
                    >
                      <MerunoText
                        role="bodySmall"
                        tone="primary"
                        style={styles.addLabel}
                      >
                        +
                      </MerunoText>
                    </Pressable>
                  </View>
                ) : null}
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
  qtyCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  qtyLabel: {
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'right',
  },
  addButton: {
    minWidth: 36,
    minHeight: 36,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPressed: {
    opacity: 0.55,
  },
  addDisabled: {
    opacity: 0.4,
  },
  addLabel: {
    fontSize: 22,
    lineHeight: 24,
    fontWeight: '600',
    color: UI_COLORS.accent,
  },
});
