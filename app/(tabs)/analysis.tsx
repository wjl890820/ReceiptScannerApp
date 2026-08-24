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
import { RatioBar } from '@/components/RatioBar';
import { SectionTitle } from '@/components/SectionTitle';
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
import { merchantAccentColor } from '@/lib/merchantAccent';
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
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGap },
      ]}
    >
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[
        styles.container,
        {
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
          <SectionTitle title={t('analysis.release.overviewTitle')} />
          <View style={styles.overviewPanel}>
            <View style={styles.overviewDarkAnchor}>
              <View style={styles.overviewLabelRow}>
                <View style={styles.overviewSignal} />
                <Text style={styles.overviewPrimaryLabel}>
                  {t('analysis.release.totalSpend')}
                </Text>
              </View>
              <Text style={styles.overviewPrimaryValue}>
                {formatJPY(viewModel.overview.supportedSpend)}
              </Text>
              <View style={styles.overviewTechnicalRule} />
            </View>
            <View style={styles.metricStrip}>
              <View style={styles.stripMetric}>
                <Text style={styles.stripValue}>{viewModel.overview.supportedReceiptCount}</Text>
                <Text style={styles.stripLabel}>{t('analysis.release.receiptCount')}</Text>
              </View>
              <View style={[styles.stripMetric, styles.stripMetricBorder]}>
                <Text style={styles.stripValue}>{formatJPY(viewModel.overview.averageSpendPerReceipt)}</Text>
                <Text style={styles.stripLabel}>{t('analysis.release.averageSpend')}</Text>
              </View>
              <View style={[styles.stripMetric, styles.stripMetricBorder]}>
                <Text style={styles.stripValue}>{viewModel.overview.itemCount}</Text>
                <Text style={styles.stripLabel}>{t('analysis.release.itemCount')}</Text>
              </View>
            </View>
          </View>

          {viewModel.categories.length > 0 ? (
            <>
              <SectionTitle title={t('analysis.release.categoryTitle')} />
              <View style={[styles.card, styles.categoryPanel]}>
                {viewModel.categories.map((row) => (
                  <RatioBar
                    key={row.category}
                    label={getCategoryLabel(row.category)}
                    value={formatJPY(row.amount)}
                    percent={row.share * 100}
                  />
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
              <SectionTitle title={t('analysis.release.merchantsTitle')} />
              <View style={styles.card}>
                {viewModel.merchants.map((row, index) => (
                  <View
                    key={row.merchantKey}
                    style={[styles.merchantRow, index > 0 && styles.rowDivider]}
                  >
                    <View
                      style={[
                        styles.merchantAccent,
                        { backgroundColor: merchantAccentColor(row.merchantKey) },
                      ]}
                    />
                    <View style={styles.merchantTextCol}>
                      <Text style={styles.merchantName} numberOfLines={2}>
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

          <SectionTitle title={t('analysis.release.spendChangeTitle')} />
          <View style={styles.changePanel}>
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
              <SectionTitle title={t(viewModel.insight.titleKey)} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: UI_COLORS.background,
  },
  scroll: {
    flex: 1,
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
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
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
    borderRadius: 8,
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
  overviewPanel: {
    overflow: 'hidden',
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
  },
  overviewDarkAnchor: {
    position: 'relative',
    minHeight: 122,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 20,
    backgroundColor: UI_COLORS.charcoal,
    overflow: 'hidden',
  },
  overviewLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  overviewSignal: {
    width: 14,
    height: 3,
    backgroundColor: UI_COLORS.accent,
  },
  overviewPrimaryLabel: {
    color: '#b7c0ca',
    fontSize: 13,
    fontWeight: '700',
  },
  overviewPrimaryValue: {
    marginTop: 8,
    color: '#ffffff',
    fontSize: 36,
    lineHeight: 43,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  overviewTechnicalRule: {
    position: 'absolute',
    right: 0,
    bottom: 14,
    width: 54,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#505760',
  },
  metricStrip: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.border,
  },
  stripMetric: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  stripMetricBorder: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: UI_COLORS.border,
  },
  stripValue: {
    color: UI_COLORS.textPrimary,
    fontSize: 17,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  stripLabel: {
    marginTop: 5,
    color: UI_COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  card: {
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    paddingHorizontal: 16,
  },
  categoryPanel: {
    paddingVertical: 16,
    gap: 16,
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  merchantAccent: {
    width: 4,
    height: 34,
    marginRight: 12,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
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
    fontVariant: ['tabular-nums'],
  },
  changePanel: {
    paddingHorizontal: 2,
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
  },
  changeCompared: {
    color: '#68707a',
    fontSize: 12,
    fontWeight: '600',
  },
  changeAmount: {
    marginTop: 8,
    color: '#15181c',
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  changeDelta: {
    marginTop: 6,
    color: '#3c4654',
    fontSize: 14,
    fontWeight: '600',
  },
  changeUnavailable: {
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
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#cbdcf7',
    borderLeftWidth: 4,
    borderLeftColor: UI_COLORS.accent,
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
