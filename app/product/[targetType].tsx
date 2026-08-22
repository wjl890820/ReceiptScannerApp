import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { navigateBackOrHistory } from '@/lib/navigationBack';

import { ProductPriceHistoryChart } from '@/components/ProductPriceHistoryChart';
import { selectAnalyticsReceipts } from '@/lib/analyticsReceiptSelection';
import { listReceipts } from '@/lib/db';
import { formatDate } from '@/lib/formatDate';
import { formatJPY } from '@/lib/formatJPY';
import { getCurrentLocale, t } from '@/lib/i18n';
import {
  formatProductSpecification,
  loadProductHistory,
  type ProductHistorySummary,
} from '@/lib/productHistory';
import { parseProductDetailTarget } from '@/lib/productDetailTarget';
import { PRODUCT_FAMILY_KEYS } from '@/lib/productFamily';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
} from '@/lib/uiTokens';
import {
  loadProductPriceHistory,
  type ProductPriceHistoryResult,
} from '@/lib/productPriceHistory';

function formatCurrency(amount: number, currency: string): string {
  if (currency === 'JPY') return formatJPY(amount);
  return `${currency} ${amount.toLocaleString()}`;
}

export default function ProductDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const onBack = useCallback(() => {
    navigateBackOrHistory(router);
  }, [router]);
  const locale = getCurrentLocale();
  const params = useLocalSearchParams<{
    targetType?: string | string[];
    key?: string | string[];
  }>();
  const targetType = Array.isArray(params.targetType)
    ? params.targetType[0]
    : params.targetType;
  const targetKey = Array.isArray(params.key) ? params.key[0] : params.key;
  const target = useMemo(
    () => parseProductDetailTarget(targetType, targetKey),
    [targetKey, targetType]
  );
  const [summary, setSummary] = useState<ProductHistorySummary | null>(null);
  const [priceHistory, setPriceHistory] =
    useState<ProductPriceHistoryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [priceLoadFailed, setPriceLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    setPriceLoadFailed(false);
    setSummary(null);
    setPriceHistory(null);
    if (!target) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void (async () => {
      let excludedReceiptIds: ReadonlySet<string> | undefined;
      try {
        const allReceipts = await listReceipts();
        excludedReceiptIds =
          selectAnalyticsReceipts(allReceipts).excludedDuplicateReceiptIds;
      } catch (e) {
        console.error('[ProductDetail] analytics selection failed', e);
      }

      const [historyResult, priceResult] = await Promise.allSettled([
        loadProductHistory(target, { locale, excludedReceiptIds }),
        loadProductPriceHistory(target, { excludedReceiptIds }),
      ]);
      if (!active) return;
      if (historyResult.status === 'fulfilled') {
        setSummary(historyResult.value);
      } else {
        console.error('[ProductDetail] history load failed', historyResult.reason);
        setLoadFailed(true);
      }
      if (priceResult.status === 'fulfilled') {
        setPriceHistory(priceResult.value);
      } else {
        console.error('[ProductDetail] price history load failed', priceResult.reason);
        setPriceLoadFailed(true);
      }
      if (active) setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [locale, target]);

  const title =
    target?.type === 'family'
      ? PRODUCT_FAMILY_KEYS.includes(target.key as (typeof PRODUCT_FAMILY_KEYS)[number])
        ? t(`productDetail.family.${target.key}`)
        : t('productDetail.title')
      : summary?.title || target?.key || t('productDetail.title');
  const typeLabel = target
    ? t(`productDetail.targetType.${target.type}`)
    : '';
  const specificationLabels = summary
    ? [
        ...new Set(
          summary.specificationVariants
            .map((variant) => formatProductSpecification(variant, locale))
            .filter((value): value is string => Boolean(value))
        ),
      ]
    : [];

  return (
    <View style={[styles.container, { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGapCompact }]}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t('productDetail.back')}
          style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.55 }]}
          hitSlop={8}
        >
          <Text style={styles.backText}>{t('productDetail.back')}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{t('productDetail.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator color="#555" />
          <Text style={styles.stateText}>{t('productDetail.loading')}</Text>
        </View>
      ) : loadFailed || !target || !summary ? (
        <View style={styles.centerState}>
          <Text style={styles.stateTitle}>
            {loadFailed
              ? t('productDetail.loadFailed')
              : t('productDetail.noHistory')}
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.typeLabel}>{typeLabel}</Text>
          <Text style={styles.productTitle}>{title}</Text>
          {target.type === 'canonical' && (
            <Text style={styles.scopeNote}>
              {t('productDetail.seriesScopeNote')}
            </Text>
          )}
          {target.type === 'family' && (
            <Text style={styles.scopeNote}>
              {t('productDetail.familyScopeNote')}
            </Text>
          )}

          <View style={styles.summaryGrid}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>
                {t('productDetail.purchaseCount')}
              </Text>
              <Text style={styles.summaryValue}>
                {t('productDetail.purchaseCountValue', {
                  count: summary.purchaseOccurrenceCount,
                })}
              </Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>
                {t('productDetail.totalSpend')}
              </Text>
              {summary.totalSpend != null && summary.currency ? (
                <Text style={styles.summaryValue}>
                  {formatCurrency(summary.totalSpend, summary.currency)}
                </Text>
              ) : (
                summary.currencyTotals.map((currencyTotal) => (
                  <Text
                    key={currencyTotal.currency}
                    style={styles.multiCurrencyValue}
                  >
                    {formatCurrency(
                      currencyTotal.totalSpend,
                      currencyTotal.currency
                    )}
                  </Text>
                ))
              )}
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>
                {t('productDetail.lastPurchase')}
              </Text>
              <Text style={styles.summaryDate}>
                {summary.lastPurchasedAt
                  ? formatDate(summary.lastPurchasedAt)
                  : '—'}
              </Text>
            </View>
          </View>

          <Text style={styles.secondarySummary}>
            {t('productDetail.totalQuantity', {
              count: summary.totalPurchaseQuantity,
            })}
            {' · '}
            {t('productDetail.firstPurchaseValue', {
              date: summary.firstPurchasedAt
                ? formatDate(summary.firstPurchasedAt)
                : '—',
            })}
          </Text>

          {priceHistory ? (
            <ProductPriceHistoryChart result={priceHistory} />
          ) : priceLoadFailed ? (
            <>
              <Text style={styles.sectionTitle}>
                {t('priceHistory.title')}
              </Text>
              <View style={styles.sectionCard}>
                <Text style={styles.priceLoadError}>
                  {t('priceHistory.loadFailed')}
                </Text>
              </View>
            </>
          ) : null}

          <Text style={styles.sectionTitle}>{t('productDetail.stores')}</Text>
          <View style={styles.sectionCard}>
            {summary.merchants.map((merchant, index) => (
              <View
                key={`${merchant.merchantName ?? 'unknown'}:${index}`}
                style={[
                  styles.factRow,
                  index > 0 && styles.factRowBorder,
                ]}
              >
                <Text style={styles.factName}>
                  {merchant.merchantName || t('common.unknownMerchant')}
                </Text>
                <Text style={styles.factValue}>
                  {t('productDetail.purchaseCountValue', {
                    count: merchant.purchaseOccurrenceCount,
                  })}
                </Text>
              </View>
            ))}
          </View>

          {specificationLabels.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>
                {t('productDetail.specificationVariants')}
              </Text>
              <View style={styles.chips}>
                {specificationLabels.map((label) => (
                  <View key={label} style={styles.chip}>
                    <Text style={styles.chipText}>{label}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          <Text style={styles.sectionTitle}>
            {t('productDetail.recentPurchases')}
          </Text>
          <View style={styles.sectionCard}>
            {summary.recentPurchases.map((purchase, index) => {
              const merchant =
                purchase.merchantRaw ||
                purchase.merchantNormalized ||
                t('common.unknownMerchant');
              return (
                <Pressable
                  key={purchase.itemId}
                  onPress={() => router.push(`/history/${purchase.receiptId}`)}
                  style={({ pressed }) => [
                    styles.purchaseRow,
                    index > 0 && styles.factRowBorder,
                    pressed && { opacity: 0.55 },
                  ]}
                >
                  <View style={styles.purchaseTopRow}>
                    <Text style={styles.purchaseName} numberOfLines={2}>
                      {purchase.displayName}
                    </Text>
                    <Text style={styles.purchaseAmount}>
                      {purchase.lineTotal == null
                        ? '—'
                        : formatCurrency(purchase.lineTotal, purchase.currency)}
                    </Text>
                  </View>
                  <Text style={styles.purchaseMeta}>
                    {merchant} · {formatDate(purchase.purchasedAt)}
                  </Text>
                  <Text style={styles.purchaseQuantity}>
                    ×{purchase.purchaseQuantity}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: UI_COLORS.background,
  },
  header: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  backButton: {
    minWidth: 72,
    minHeight: UI_LAYOUT.controlMinHeight,
    justifyContent: 'center',
    paddingVertical: 10,
  },
  backText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#222',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 72,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  stateText: {
    color: UI_COLORS.textSecondary,
  },
  stateTitle: {
    color: '#555',
    fontSize: 16,
    textAlign: 'center',
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingTop: 24,
    paddingBottom: 50,
  },
  typeLabel: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#eee',
    color: '#555',
    fontSize: 12,
    fontWeight: '700',
  },
  productTitle: {
    marginTop: 12,
    fontSize: 25,
    lineHeight: 32,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
  },
  scopeNote: {
    marginTop: 8,
    color: UI_COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  summaryGrid: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 22,
  },
  summaryCard: {
    flex: 1,
    minHeight: 94,
    padding: 12,
    borderRadius: UI_RADIUS.card,
    backgroundColor: UI_COLORS.surface,
  },
  summaryLabel: {
    color: UI_COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  summaryValue: {
    marginTop: 10,
    fontSize: 18,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
  },
  summaryDate: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    color: '#222',
  },
  multiCurrencyValue: {
    marginTop: 5,
    fontSize: 13,
    fontWeight: '700',
    color: '#222',
  },
  secondarySummary: {
    marginTop: 12,
    color: UI_COLORS.textSecondary,
    fontSize: 13,
  },
  sectionTitle: {
    marginTop: 26,
    marginBottom: 10,
    fontSize: 17,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
  },
  sectionCard: {
    borderRadius: UI_RADIUS.card,
    paddingHorizontal: 14,
    backgroundColor: '#f5f5f5',
  },
  factRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  factRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d6d6d6',
  },
  factName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  factValue: {
    color: UI_COLORS.textSecondary,
    fontSize: 13,
  },
  priceLoadError: {
    paddingVertical: 14,
    color: UI_COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#eee',
  },
  chipText: {
    color: '#333',
    fontSize: 14,
    fontWeight: '600',
  },
  purchaseRow: {
    paddingVertical: 14,
  },
  purchaseTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  purchaseName: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  purchaseAmount: {
    fontSize: 15,
    fontWeight: '800',
  },
  purchaseMeta: {
    marginTop: 6,
    color: UI_COLORS.textSecondary,
    fontSize: 13,
  },
  purchaseQuantity: {
    marginTop: 5,
    color: '#444',
    fontSize: 13,
    fontWeight: '700',
  },
});
