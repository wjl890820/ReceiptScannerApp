import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { MerunoDisclosureIndicator } from '@/components/MerunoDisclosureIndicator';
import {
  MerunoGroupedList,
  MerunoGroupedRow,
} from '@/components/MerunoGroupedList';
import { MerunoText } from '@/components/primitives/MerunoText';
import type { MilestoneFrequentProduct } from '@/lib/engagementMilestones';
import { t } from '@/lib/i18n';
import { formatFrequentProductLabel } from '@/lib/milestonePresentation';
import { UI_COLORS, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

type HomeFrequentProductListProps = {
  products: MilestoneFrequentProduct[];
  onPress: (product: MilestoneFrequentProduct) => void;
};

export function HomeFrequentProductList({
  products,
  onPress,
}: HomeFrequentProductListProps) {
  return (
    <MerunoGroupedList>
      {products.map((product, index) => {
        const label = formatFrequentProductLabel(product, t);
        return (
          <MerunoGroupedRow
            key={`${product.groupingType}:${product.key}`}
            onPress={() => onPress(product)}
            accessibilityRole="button"
            accessibilityLabel={t('home.progressive.frequent.openHistoryA11y', {
              name: label,
            })}
            showDivider={index < products.length - 1}
            dividerInset={58}
            minHeight={78}
            style={styles.productRow}
          >
            {({ pressed }) => (
              <View style={styles.rowInner}>
                <View style={styles.productIconTile} importantForAccessibility="no">
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
                  <MerunoText role="meta" tone="secondary" style={styles.productMeta}>
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
                <MerunoDisclosureIndicator kind="crossEntity" pressed={pressed} />
              </View>
            )}
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
});
