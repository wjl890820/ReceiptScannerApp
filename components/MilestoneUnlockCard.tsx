import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

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
          <Text style={styles.chipText}>
            {categoryLabel(entry.category)}{' '}
            {Math.round(
              entry.spend > 0 ? entry.spendShare * 100 : entry.itemShare * 100
            )}
            %
          </Text>
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
          <Text style={styles.productName}>
            {formatFrequentProductLabel(product, t)}
          </Text>
          <Text style={styles.productMeta}>
            {t('postSaveSummary.frequent.occurrences', {
              count: product.purchaseOccurrenceCount,
            })}
            {' · '}
            {t('postSaveSummary.frequent.quantity', {
              count: product.totalPurchaseQuantity,
            })}
          </Text>
          <Text style={styles.productMeta}>
            {t('postSaveSummary.frequent.lastPurchased', {
              date: formatDate(product.lastPurchasedAt),
            })}
          </Text>
          {product.priceSummary && (
            <Text style={styles.productPrice}>
              {t('postSaveSummary.frequent.latestPrice', {
                amount: formatAmount(
                  product.priceSummary.latestPrice,
                  product.priceSummary.currency
                ),
              })}
            </Text>
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
      <Text style={styles.badge}>{t('postSaveSummary.unlock.badge')}</Text>
      <Text style={styles.title}>{t(titleKey)}</Text>

      {result.milestone === 1 && (
        <>
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>
                {t('postSaveSummary.current.total')}
              </Text>
              <Text style={styles.metricValue}>
                {formatAmount(result.total, result.currency)}
              </Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>
                {t('postSaveSummary.current.itemCount')}
              </Text>
              <Text style={styles.metricValue}>{result.itemCount}</Text>
            </View>
          </View>
          {result.highestItem && (
            <Text style={styles.body}>
              {t('postSaveSummary.current.highestItemValue', {
                name: result.highestItem.displayName,
                amount: formatAmount(
                  result.highestItem.lineTotal,
                  result.currency
                ),
              })}
            </Text>
          )}
          <CategoryStructure structure={result.categoryStructure} />
          <Text style={styles.summary}>
            {formatMilestoneSummary(result.summary, t, categoryLabel)}
          </Text>
        </>
      )}

      {result.milestone === 3 && (
        <>
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>
                {t('postSaveSummary.third.totalSpend')}
              </Text>
              <Text style={styles.metricValue}>
                {formatJPY(result.totalSpend)}
              </Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>
                {t('postSaveSummary.third.averageSpend')}
              </Text>
              <Text style={styles.metricValue}>
                {formatJPY(result.averageSpendPerReceipt)}
              </Text>
            </View>
          </View>
          <CategoryStructure structure={result.categoryStructure} />
          <Text style={styles.summary}>
            {formatMilestoneSummary(result.summary, t, categoryLabel)}
          </Text>
        </>
      )}

      {result.milestone === 5 && (
        <>
          {result.frequentProducts.length > 0 ? (
            <FrequentProducts products={result.frequentProducts} />
          ) : (
            <Text style={styles.body}>
              {t('postSaveSummary.frequent.dataPreparing')}
            </Text>
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
              <Text style={styles.body}>
                {t('postSaveSummary.frequent.dataPreparing')}
              </Text>
            )}
          {result.shoppingFrequency && (
            <Text style={styles.summary}>
              {t('postSaveSummary.tenth.frequency', {
                days: Number(
                  result.shoppingFrequency.averageIntervalDays.toFixed(1)
                ),
              })}
            </Text>
          )}
          <Text style={styles.body}>
            {t('postSaveSummary.tenth.windowCompared')}
          </Text>
          {result.recentChange && (
            <Text style={styles.summary}>
              {formatMilestoneRecentChange(
                result.recentChange,
                t,
                categoryLabel
              )}
            </Text>
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
    borderRadius: 16,
    backgroundColor: '#ececec',
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#222',
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },
  title: {
    marginTop: 12,
    color: '#111',
    fontSize: 21,
    lineHeight: 27,
    fontWeight: '800',
  },
  metrics: {
    marginTop: 15,
    flexDirection: 'row',
    gap: 10,
  },
  metric: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  metricLabel: {
    color: '#777',
    fontSize: 11,
  },
  metricValue: {
    marginTop: 5,
    color: '#111',
    fontSize: 17,
    fontWeight: '800',
  },
  body: {
    marginTop: 13,
    color: '#555',
    fontSize: 13,
    lineHeight: 19,
  },
  summary: {
    marginTop: 14,
    color: '#222',
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '600',
  },
  chips: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  chipText: {
    color: '#444',
    fontSize: 12,
    fontWeight: '600',
  },
  list: {
    marginTop: 12,
    paddingHorizontal: 13,
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  productRow: {
    paddingVertical: 12,
  },
  borderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ddd',
  },
  productName: {
    color: '#222',
    fontSize: 14,
    fontWeight: '700',
  },
  productMeta: {
    marginTop: 4,
    color: '#777',
    fontSize: 12,
  },
  productPrice: {
    marginTop: 5,
    color: '#333',
    fontSize: 12,
    fontWeight: '700',
  },
});
