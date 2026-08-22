// app/(tabs)/analysis.tsx
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AnalysisEmptyState } from '@/components/analysis/AnalysisEmptyState';
import { getCategoryLabel } from '@/lib/categoryPalette';
import { selectAnalyticsReceipts } from '@/lib/analyticsReceiptSelection';
import { listReceipts, type ReceiptRow } from '@/lib/db';
import { buildInsights } from '@/lib/buildInsights';
import {
  buildAnalysisReleaseViewModel,
  countSupportedItemsInRange,
} from '@/lib/analysisPresentation';
import { buildStatsSafe } from '@/lib/analysisHelpers';
import { formatJPY } from '@/lib/formatJPY';
import { t } from '@/lib/i18n';
import { type TimeRange } from '@/lib/statsCalculator';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
  UI_TYPOGRAPHY,
} from '@/lib/uiTokens';

/**
 * Legacy Price Radar / Category Index helpers remain available in
 * lib/analysisHelpers.ts + lib/priceRadar.ts for future migration.
 * Release UI intentionally does not mount them until Safe Price History adopts them.
 */
export default function AnalysisScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>('month');

  const loadReceipts = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const allReceipts = await listReceipts();
      setReceipts(selectAnalyticsReceipts(allReceipts).analyticsReceipts);
    } catch (e) {
      console.error('加载收据失败:', e);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadReceipts();
    }, [loadReceipts])
  );

  const periodStats = useMemo(
    () => buildStatsSafe(receipts, timeRange),
    [receipts, timeRange]
  );
  const allStats = useMemo(() => buildStatsSafe(receipts, 'all'), [receipts]);
  const itemCount = useMemo(
    () => countSupportedItemsInRange(receipts, timeRange),
    [receipts, timeRange]
  );
  const insights = useMemo(() => {
    try {
      if (!Array.isArray(receipts)) return null;
      return buildInsights(receipts, timeRange);
    } catch (e) {
      console.error('[Analysis] buildInsights failed:', e);
      return null;
    }
  }, [receipts, timeRange]);

  const viewModel = useMemo(
    () =>
      buildAnalysisReleaseViewModel({
        periodStats,
        allSupportedCount: allStats.supportedReceiptCount,
        itemCount,
        insights,
        proComingSoon: true,
        priceRadarMigrated: false,
      }),
    [periodStats, allStats.supportedReceiptCount, itemCount, insights]
  );

  const renderInsightBody = () => {
    if (!viewModel.insight) return null;
    const params = { ...(viewModel.insight.bodyParams ?? {}) };
    if (typeof params.category === 'string') {
      params.catLabel = getCategoryLabel(params.category);
    }
    if (typeof params.cat === 'string') {
      params.catLabel = getCategoryLabel(String(params.cat));
    }
    if (params.amt != null) {
      params.amt = formatJPY(Number(params.amt)).replace(/^¥/, '');
    }
    return t(viewModel.insight.bodyKey, params);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.container,
        {
          paddingTop: insets.top + UI_LAYOUT.safeAreaTopGap,
          paddingBottom:
            UI_LAYOUT.tabContentClearance + Math.max(insets.bottom, 0),
        },
      ]}
    >
      <Text style={styles.title}>{t('analysis.title')}</Text>

      <View style={styles.timeRangeContainer}>
        {(['week', 'month', 'all'] as const).map((range) => (
          <Pressable
            key={range}
            style={[
              styles.timeRangeBtn,
              timeRange === range && styles.timeRangeBtnActive,
            ]}
            onPress={() => setTimeRange(range)}
            accessibilityRole="button"
            accessibilityState={{ selected: timeRange === range }}
            accessibilityLabel={t(`analysis.timeRange.${range}`)}
          >
            <Text
              style={[
                styles.timeRangeBtnText,
                timeRange === range && styles.timeRangeBtnTextActive,
              ]}
            >
              {t(`analysis.timeRange.${range}`)}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.inlineLoading}>
          <ActivityIndicator color={UI_COLORS.accent} />
        </View>
      ) : null}

      {loadError ? (
        <View style={styles.messageCard}>
          <Text style={styles.messageText}>
            {t('analysis.release.loadFailed')}
          </Text>
        </View>
      ) : null}

      {!loading && !loadError && viewModel.stage === 'empty' ? (
        <AnalysisEmptyState
          variant="empty"
          onGoHome={() => router.push('/(tabs)/' as any)}
        />
      ) : null}

      {!loading && !loadError && viewModel.stage === 'period_empty' ? (
        <AnalysisEmptyState
          variant="period_empty"
          onGoHome={() => router.push('/(tabs)/' as any)}
          onSwitchToAll={() => setTimeRange('all')}
        />
      ) : null}

      {!loading &&
      !loadError &&
      (viewModel.stage === 'low' || viewModel.stage === 'ready') &&
      viewModel.overview ? (
        <>
          <Text style={styles.sectionTitle}>
            {t('analysis.release.overviewTitle')}
          </Text>
          <View style={styles.overviewGrid}>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>
                {t('analysis.release.totalSpend')}
              </Text>
              <Text style={styles.metricValue}>
                {formatJPY(viewModel.overview.supportedSpend)}
              </Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>
                {t('analysis.release.receiptCount')}
              </Text>
              <Text style={styles.metricValue}>
                {viewModel.overview.supportedReceiptCount}
              </Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>
                {t('analysis.release.averageSpend')}
              </Text>
              <Text style={styles.metricValue}>
                {formatJPY(viewModel.overview.averageSpendPerReceipt)}
              </Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>
                {t('analysis.release.itemCount')}
              </Text>
              <Text style={styles.metricValue}>
                {viewModel.overview.itemCount}
              </Text>
            </View>
          </View>

          {viewModel.categories.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>
                {t('analysis.release.categoryTitle')}
              </Text>
              <View style={styles.card}>
                {viewModel.categories.map((row) => (
                  <View key={row.category} style={styles.categoryRow}>
                    <Text style={styles.categoryName}>
                      {getCategoryLabel(row.category)}
                    </Text>
                    <Text style={styles.categoryAmount}>
                      {formatJPY(row.amount)}
                    </Text>
                    <Text style={styles.categoryShare}>
                      {Math.round(row.share * 100)}%
                    </Text>
                  </View>
                ))}
                {viewModel.uncategorized ? (
                  <Text style={styles.uncategorizedHint}>
                    {t('analysis.stats.pendingHint', {
                      count: viewModel.uncategorized.count,
                      amount: formatJPY(viewModel.uncategorized.total),
                    })}
                  </Text>
                ) : null}
              </View>
            </>
          ) : null}

          {viewModel.merchants.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>
                {t('analysis.release.merchantsTitle')}
              </Text>
              <View style={styles.card}>
                {viewModel.merchants.map((row) => (
                  <View key={row.merchantKey} style={styles.merchantRow}>
                    <View style={styles.merchantTextCol}>
                      <Text style={styles.merchantName} numberOfLines={1}>
                        {row.displayName}
                      </Text>
                      <Text style={styles.merchantMeta}>
                        {t('analysis.release.merchantVisits', {
                          count: row.visitCount,
                        })}
                      </Text>
                    </View>
                    <Text style={styles.merchantSpend}>
                      {formatJPY(row.spend)}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}

          <Text style={styles.sectionTitle}>
            {t('analysis.release.spendChangeTitle')}
          </Text>
          <View style={styles.card}>
            {viewModel.spendChange.status === 'available' ? (
              <>
                <Text style={styles.changeCompared}>
                  {t('analysis.release.spendChangeCompared', {
                    days: viewModel.spendChange.periodDays,
                  })}
                </Text>
                <Text style={styles.changeAmount}>
                  {formatJPY(viewModel.spendChange.currentSpend)}
                </Text>
                <Text style={styles.changeDelta}>
                  {viewModel.spendChange.direction === 'up'
                    ? t('analysis.release.spendChangeUp', {
                        amount: formatJPY(viewModel.spendChange.absoluteDelta),
                        percent:
                          viewModel.spendChange.percentDelta == null
                            ? ''
                            : t('analysis.release.spendChangePercent', {
                                percent: Math.abs(
                                  viewModel.spendChange.percentDelta
                                ),
                              }),
                      })
                    : viewModel.spendChange.direction === 'down'
                      ? t('analysis.release.spendChangeDown', {
                          amount: formatJPY(
                            viewModel.spendChange.absoluteDelta
                          ),
                          percent:
                            viewModel.spendChange.percentDelta == null
                              ? ''
                              : t('analysis.release.spendChangePercent', {
                                  percent: Math.abs(
                                    viewModel.spendChange.percentDelta
                                  ),
                                }),
                        })
                      : t('analysis.release.spendChangeFlat')}
                </Text>
              </>
            ) : (
              <Text style={styles.changeUnavailable}>
                {t('analysis.release.spendChangeUnavailable')}
              </Text>
            )}
          </View>

          {viewModel.insight ? (
            <>
              <Text style={styles.sectionTitle}>
                {t(viewModel.insight.titleKey)}
              </Text>
              <View style={styles.insightCard}>
                <Text style={styles.insightText}>{renderInsightBody()}</Text>
              </View>
            </>
          ) : null}

          {viewModel.showLowDataHint ? (
            <Text style={styles.lowDataNote}>
              {t('analysis.release.lowDataHint')}
            </Text>
          ) : null}
        </>
      ) : null}

      {/*
        Intentionally not rendered in V1 release:
        - Pro locked teaser (coming soon / no entitlement)
        - Legacy Price Radar (supermarket/grocery + normalizeProductName)
        - Legacy Category Price Index
        Helper modules remain in lib/analysisHelpers.ts and lib/priceRadar.ts.
      */}
      {viewModel.showProSection ||
      viewModel.showLegacyPriceRadar ||
      viewModel.showLegacyCategoryIndex
        ? null
        : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  container: {
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingBottom: UI_LAYOUT.tabContentClearance,
  },
  title: {
    fontSize: UI_TYPOGRAPHY.pageTitle,
    fontWeight: '800',
    color: '#15181c',
    marginBottom: 16,
  },
  timeRangeContainer: {
    flexDirection: 'row',
    backgroundColor: '#eceff3',
    borderRadius: UI_RADIUS.card,
    padding: 4,
  },
  timeRangeBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: 'center',
  },
  timeRangeBtnActive: {
    backgroundColor: UI_COLORS.background,
  },
  timeRangeBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#68707a',
  },
  timeRangeBtnTextActive: {
    color: '#15181c',
  },
  inlineLoading: {
    marginTop: 24,
    alignItems: 'center',
  },
  messageCard: {
    marginTop: 18,
    padding: 16,
    borderRadius: 16,
    backgroundColor: UI_COLORS.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e1e4e8',
  },
  messageText: {
    color: '#68707a',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  sectionTitle: {
    marginTop: 24,
    marginBottom: 10,
    fontSize: 17,
    fontWeight: '800',
    color: '#171a1f',
  },
  overviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metricCard: {
    width: '48%',
    flexGrow: 1,
    minWidth: '46%',
    padding: 14,
    borderRadius: 16,
    backgroundColor: UI_COLORS.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e1e4e8',
  },
  metricLabel: {
    color: '#747d88',
    fontSize: 12,
    fontWeight: '700',
  },
  metricValue: {
    marginTop: 8,
    color: '#15181c',
    fontSize: 20,
    fontWeight: '800',
  },
  card: {
    borderRadius: 16,
    backgroundColor: UI_COLORS.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e1e4e8',
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eef1f4',
  },
  categoryName: {
    flex: 1,
    color: '#15181c',
    fontSize: 15,
    fontWeight: '700',
  },
  categoryAmount: {
    minWidth: 72,
    textAlign: 'right',
    color: '#15181c',
    fontSize: 14,
    fontWeight: '800',
    marginRight: 10,
  },
  categoryShare: {
    minWidth: 40,
    textAlign: 'right',
    color: '#68707a',
    fontSize: 13,
    fontWeight: '700',
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eef1f4',
  },
  merchantTextCol: {
    flex: 1,
    minWidth: 0,
    marginRight: 12,
  },
  merchantName: {
    color: '#15181c',
    fontSize: 15,
    fontWeight: '700',
  },
  merchantMeta: {
    marginTop: 4,
    color: '#68707a',
    fontSize: 12,
    fontWeight: '600',
  },
  merchantSpend: {
    color: '#15181c',
    fontSize: 14,
    fontWeight: '800',
  },
  changeCompared: {
    paddingTop: 12,
    color: '#68707a',
    fontSize: 12,
    fontWeight: '600',
  },
  changeAmount: {
    marginTop: 8,
    color: '#15181c',
    fontSize: 22,
    fontWeight: '800',
  },
  changeDelta: {
    marginTop: 6,
    marginBottom: 12,
    color: '#3c4654',
    fontSize: 14,
    fontWeight: '600',
  },
  changeUnavailable: {
    paddingVertical: 14,
    color: '#8a929c',
    fontSize: 13,
    lineHeight: 19,
  },
  uncategorizedHint: {
    paddingVertical: 12,
    color: '#8a929c',
    fontSize: 12,
    lineHeight: 18,
  },
  insightCard: {
    borderRadius: 16,
    backgroundColor: '#eef5ff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#cfe1fb',
    padding: 16,
  },
  insightText: {
    color: '#1f3655',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
  },
  lowDataNote: {
    marginTop: 14,
    color: '#8a929c',
    fontSize: 13,
    lineHeight: 19,
  },
});
