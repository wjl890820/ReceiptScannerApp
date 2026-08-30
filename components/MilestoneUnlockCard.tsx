import React from 'react';
import { StyleSheet, View } from 'react-native';

import { MerunoText } from '@/components/primitives/MerunoText';
import { getCategoryLabel } from '@/lib/categoryPalette';
import type {
  EngagementMilestoneResult,
  MilestoneCategoryStructure,
  MilestoneFrequentProduct,
} from '@/lib/engagementMilestones';
import { formatDate } from '@/lib/formatDate';
import { formatJPY } from '@/lib/formatJPY';
import { t } from '@/lib/i18n';
import {
  formatFrequentProductLabel,
  formatMilestoneRecentChange,
  formatMilestoneSummary,
} from '@/lib/milestonePresentation';
import type { ProductCategory } from '@/lib/productCategory';
import { UI_COLORS, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

function formatAmount(amount: number, currency: string): string {
  return currency === 'JPY'
    ? formatJPY(amount)
    : `${currency} ${amount.toLocaleString()}`;
}

function categoryLabel(category: string): string {
  return getCategoryLabel(category as ProductCategory);
}

function CategoryStructure({
  structure,
}: {
  structure: MilestoneCategoryStructure;
}) {
  const visible = structure.categories.filter(
    (entry) => entry.itemCount > 0 || entry.spend > 0
  );
  if (visible.length === 0) return null;
  return (
    <View style={styles.chips}>
      {visible.map((entry) => (
        <View key={entry.category} style={styles.chip}>
          <MerunoText role="chip" tone="secondary">
            {categoryLabel(entry.category)}{' '}
            {Math.round(
              entry.spend > 0 ? entry.spendShare * 100 : entry.itemShare * 100
            )}
            %
          </MerunoText>
        </View>
      ))}
    </View>
  );
}

function FrequentProducts({
  products,
}: {
  products: MilestoneFrequentProduct[];
}) {
  return (
    <View style={styles.list}>
      {products.map((product, index) => (
        <View
          key={`${product.groupingType}:${product.key}`}
          style={[styles.productRow, index > 0 && styles.borderTop]}
        >
          <MerunoText role="chip" tone="primary" style={styles.productName}>
            {formatFrequentProductLabel(product, t)}
          </MerunoText>
          <MerunoText role="caption" tone="muted" style={styles.productMeta}>
            {t('postSaveSummary.frequent.occurrences', {
              count: product.purchaseOccurrenceCount,
            })}
            {' · '}
            {t('postSaveSummary.frequent.quantity', {
              count: product.totalPurchaseQuantity,
            })}
          </MerunoText>
          <MerunoText role="caption" tone="muted" style={styles.productMeta}>
            {t('postSaveSummary.frequent.lastPurchased', {
              date: formatDate(product.lastPurchasedAt),
            })}
          </MerunoText>
          {product.priceSummary && (
            <MerunoText role="caption" tone="primary" style={styles.productPrice}>
              {t('postSaveSummary.frequent.latestPrice', {
                amount: formatAmount(
                  product.priceSummary.latestPrice,
                  product.priceSummary.currency
                ),
              })}
            </MerunoText>
          )}
        </View>
      ))}
    </View>
  );
}

export function MilestoneUnlockCard({
  result,
}: {
  result: EngagementMilestoneResult;
}) {
  const titleKey =
    result.milestone === 1
      ? 'postSaveSummary.unlock.first'
      : result.milestone === 3
        ? 'postSaveSummary.unlock.third'
        : result.milestone === 5
          ? 'postSaveSummary.unlock.fifth'
          : 'postSaveSummary.unlock.tenth';

  return (
    <View style={styles.card}>
      <MerunoText role="navLabel" tone="inverse" style={styles.badge}>
        {t('postSaveSummary.unlock.badge')}
      </MerunoText>
      <MerunoText role="heroTitle" tone="primary" style={styles.title}>
        {t(titleKey)}
      </MerunoText>

      {result.milestone === 1 && (
        <>
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <MerunoText role="caption" tone="muted">
                {t('postSaveSummary.current.total')}
              </MerunoText>
              <MerunoText role="amount" tone="primary" style={styles.metricValue}>
                {formatAmount(result.total, result.currency)}
              </MerunoText>
            </View>
            <View style={styles.metric}>
              <MerunoText role="caption" tone="muted">
                {t('postSaveSummary.current.itemCount')}
              </MerunoText>
              <MerunoText role="amount" tone="primary" style={styles.metricValue}>
                {result.itemCount}
              </MerunoText>
            </View>
          </View>
          {result.highestItem && (
            <MerunoText role="meta" tone="secondary" style={styles.body}>
              {t('postSaveSummary.current.highestItemValue', {
                name: result.highestItem.displayName,
                amount: formatAmount(
                  result.highestItem.lineTotal,
                  result.currency
                ),
              })}
            </MerunoText>
          )}
          <CategoryStructure structure={result.categoryStructure} />
          <MerunoText role="bodySmall" tone="primary" style={styles.summary}>
            {formatMilestoneSummary(result.summary, t, categoryLabel)}
          </MerunoText>
        </>
      )}

      {result.milestone === 3 && (
        <>
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <MerunoText role="caption" tone="muted">
                {t('postSaveSummary.third.totalSpend')}
              </MerunoText>
              <MerunoText role="amount" tone="primary" style={styles.metricValue}>
                {formatJPY(result.totalSpend)}
              </MerunoText>
            </View>
            <View style={styles.metric}>
              <MerunoText role="caption" tone="muted">
                {t('postSaveSummary.third.averageSpend')}
              </MerunoText>
              <MerunoText role="amount" tone="primary" style={styles.metricValue}>
                {formatJPY(result.averageSpendPerReceipt)}
              </MerunoText>
            </View>
          </View>
          <CategoryStructure structure={result.categoryStructure} />
          <MerunoText role="bodySmall" tone="primary" style={styles.summary}>
            {formatMilestoneSummary(result.summary, t, categoryLabel)}
          </MerunoText>
        </>
      )}

      {result.milestone === 5 && (
        <>
          {result.frequentProducts.length > 0 ? (
            <FrequentProducts products={result.frequentProducts} />
          ) : (
            <MerunoText role="meta" tone="secondary" style={styles.body}>
              {t('postSaveSummary.frequent.dataPreparing')}
            </MerunoText>
          )}
        </>
      )}

      {result.milestone === 10 && (
        <>
          <CategoryStructure structure={result.categoryStructure} />
          {result.frequentProducts.length > 0 && (
            <FrequentProducts products={result.frequentProducts} />
          )}
          {result.dataCoverageIncomplete &&
            result.frequentProducts.length === 0 && (
              <MerunoText role="meta" tone="secondary" style={styles.body}>
                {t('postSaveSummary.frequent.dataPreparing')}
              </MerunoText>
            )}
          {result.shoppingFrequency && (
            <MerunoText role="bodySmall" tone="primary" style={styles.summary}>
              {t('postSaveSummary.tenth.frequency', {
                days: Number(
                  result.shoppingFrequency.averageIntervalDays.toFixed(1)
                ),
              })}
            </MerunoText>
          )}
          <MerunoText role="meta" tone="secondary" style={styles.body}>
            {t('postSaveSummary.tenth.windowCompared')}
          </MerunoText>
          {result.recentChange && (
            <MerunoText role="bodySmall" tone="primary" style={styles.summary}>
              {formatMilestoneRecentChange(
                result.recentChange,
                t,
                categoryLabel
              )}
            </MerunoText>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 20,
    padding: 18,
    borderRadius: UI_RADIUS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: UI_SPACING.xs,
    borderRadius: UI_RADIUS.pill,
    overflow: 'hidden',
    backgroundColor: UI_COLORS.charcoal,
    fontWeight: '800',
  },
  title: {
    marginTop: UI_SPACING.md,
    fontSize: 21,
    lineHeight: 27,
  },
  metrics: {
    marginTop: 15,
    flexDirection: 'row',
    gap: 10,
  },
  metric: {
    flex: 1,
    padding: UI_SPACING.md,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.borderSubtle,
  },
  metricValue: {
    marginTop: 5,
    fontSize: 17,
    lineHeight: 22,
  },
  body: {
    marginTop: 13,
  },
  summary: {
    marginTop: 14,
    fontWeight: '600',
  },
  chips: {
    marginTop: UI_SPACING.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: UI_RADIUS.pill,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.borderSubtle,
  },
  list: {
    marginTop: UI_SPACING.md,
    paddingHorizontal: 13,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.borderSubtle,
  },
  productRow: {
    paddingVertical: UI_SPACING.md,
  },
  borderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
  },
  productName: {
    fontWeight: '700',
  },
  productMeta: {
    marginTop: UI_SPACING.xs,
  },
  productPrice: {
    marginTop: 5,
    fontWeight: '700',
  },
});
