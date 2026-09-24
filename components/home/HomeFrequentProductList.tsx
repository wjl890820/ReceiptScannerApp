import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { MerunoDisclosureIndicator } from '@/components/MerunoDisclosureIndicator';
import {
  MerunoGroupedList,
  MerunoGroupedRow,
} from '@/components/MerunoGroupedList';
import { MerunoText } from '@/components/primitives/MerunoText';
import type { MilestoneFrequentProduct } from '@/lib/engagementMilestones';
import { t } from '@/lib/i18n';
import { formatFrequentProductLabel } from '@/lib/milestonePresentation';
import {
  isTrustedShoppingListIdentity,
  shoppingListIdentityKey,
} from '@/lib/shoppingList';
import { UI_COLORS, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

type HomeFrequentProductListProps = {
  products: MilestoneFrequentProduct[];
  onPress: (product: MilestoneFrequentProduct) => void;
  activeShoppingListIdentities?: ReadonlySet<string>;
  onAddToShoppingList?: (product: MilestoneFrequentProduct) => void;
  addBusy?: boolean;
};

export function HomeFrequentProductList({
  products,
  onPress,
  activeShoppingListIdentities,
  onAddToShoppingList,
  addBusy = false,
}: HomeFrequentProductListProps) {
  return (
    <MerunoGroupedList>
      {products.map((product, index) => {
        const label = formatFrequentProductLabel(product, t);
        let identity: string | null = null;
        if (isTrustedShoppingListIdentity(product.groupingType, product.key)) {
          identity = shoppingListIdentityKey(
            product.groupingType,
            product.key
          );
        }
        const trusted = identity != null;
        const alreadyAdded =
          identity != null &&
          activeShoppingListIdentities != null &&
          activeShoppingListIdentities.has(identity);
        const showAdd =
          trusted && typeof onAddToShoppingList === 'function';
        const canAdd = showAdd && !alreadyAdded && !addBusy;

        return (
          <MerunoGroupedRow
            key={`${product.groupingType}:${product.key}`}
            showDivider={index < products.length - 1}
            dividerInset={58}
            minHeight={78}
            style={styles.productRow}
          >
            <View style={styles.rowInner}>
              <Pressable
                onPress={() => onPress(product)}
                accessibilityRole="button"
                accessibilityLabel={t(
                  'home.progressive.frequent.openHistoryA11y',
                  { name: label }
                )}
                style={({ pressed }) => [
                  styles.contentHit,
                  pressed && styles.contentPressed,
                ]}
              >
                {({ pressed }) => (
                  <>
                    <View
                      style={styles.productIconTile}
                      importantForAccessibility="no"
                    >
                      <MaterialIcons
                        name="inventory-2"
                        size={16}
                        color={UI_COLORS.textSecondary}
                      />
                    </View>
                    <View style={styles.productText}>
                      <MerunoText
                        role="bodySmall"
                        tone="primary"
                        style={styles.productName}
                        numberOfLines={2}
                      >
                        {label}
                      </MerunoText>
                      <MerunoText
                        role="meta"
                        tone="secondary"
                        style={styles.productMeta}
                      >
                        {t('home.progressive.frequent.occurrences', {
                          count: product.purchaseOccurrenceCount,
                        })}
                        {product.totalPurchaseQuantity > 0
                          ? ` · ${t('home.progressive.frequent.quantity', {
                              count: product.totalPurchaseQuantity,
                            })}`
                          : ''}
                      </MerunoText>
                    </View>
                    <MerunoDisclosureIndicator
                      kind="crossEntity"
                      pressed={pressed}
                    />
                  </>
                )}
              </Pressable>
              {showAdd ? (
                <Pressable
                  onPress={() => {
                    if (canAdd) onAddToShoppingList?.(product);
                  }}
                  disabled={!canAdd}
                  accessibilityRole="button"
                  accessibilityLabel={
                    alreadyAdded
                      ? t('home.progressive.frequent.addedA11y', {
                          name: label,
                        })
                      : t('home.progressive.frequent.addA11y', {
                          name: label,
                        })
                  }
                  hitSlop={8}
                  style={({ pressed: addPressed }) => [
                    styles.addButton,
                    addPressed && styles.addPressed,
                    !canAdd && styles.addDisabled,
                  ]}
                >
                  <MerunoText
                    role="caption"
                    tone="primary"
                    style={styles.addLabel}
                  >
                    {alreadyAdded
                      ? t('home.progressive.frequent.added')
                      : t('home.progressive.frequent.add')}
                  </MerunoText>
                </Pressable>
              ) : null}
            </View>
          </MerunoGroupedRow>
        );
      })}
    </MerunoGroupedList>
  );
}

const styles = StyleSheet.create({
  productRow: {
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: 12,
    gap: UI_SPACING.md,
  },
  contentHit: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: UI_SPACING.md,
  },
  contentPressed: {
    opacity: 0.72,
  },
  productIconTile: {
    width: 32,
    height: 32,
    borderRadius: UI_RADIUS.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_COLORS.surfaceMuted,
    flexShrink: 0,
  },
  productText: {
    flex: 1,
    minWidth: 0,
  },
  productName: {
    fontWeight: '700',
  },
  productMeta: {
    marginTop: UI_SPACING.xs,
  },
  addButton: {
    minHeight: 36,
    minWidth: 56,
    paddingHorizontal: 10,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  addPressed: {
    opacity: 0.55,
  },
  addDisabled: {
    opacity: 0.55,
  },
  addLabel: {
    fontWeight: '700',
    color: UI_COLORS.accent,
  },
});
