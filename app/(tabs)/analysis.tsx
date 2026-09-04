// app/(tabs)/analysis.tsx
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
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
import { CategoryRatioRow } from '@/components/CategoryRatioRow';
import { MerchantIdentityTile } from '@/components/MerchantIdentityTile';
import { SectionTitle } from '@/components/SectionTitle';
import { getCategoryLabel } from '@/lib/categoryPalette';
import { selectAnalyticsReceipts } from '@/lib/analyticsReceiptSelection';
import { listReceiptsForAnalysis } from '@/lib/db';
import {
  buildAnalysisReleaseViewModel,
} from '@/lib/analysisPresentation';
import type { AnalysisPriceChangesSurface } from '@/lib/analysisPriceSurfaces';
import {
  buildAnalysisAllTimeStats,
  buildAnalysisTruthSnapshot,
  type AnalysisLoadedTruth,
} from '@/lib/analysisTruthCycle';
import {
  beginAnalysisRefresh,
  completeAnalysisRefresh,
  createInitialAnalysisRefreshUiState,
  failAnalysisRefresh,
  shouldShowAnalysisBlockingLoader,
  shouldShowAnalysisContent,
  shouldShowAnalysisLoadFailed,
  type AnalysisRefreshUiState,
} from '@/lib/analysisRefreshState';
import {
  bindPriceChangesToCycle,
  createInitialPriceChangesBinding,
  resolveBoundPriceChangesSurface,
  type AnalysisPriceChangesBinding,
} from '@/lib/analysisPriceLoadCycle';
import {
  measureAnalysisRefreshStage,
  measureAnalysisRefreshStageSync,
  recordAnalysisRefreshTiming,
} from '@/lib/analysisRefreshTimings';
import { createEmptyStats } from '@/lib/analysisHelpers';
import { formatJPY } from '@/lib/formatJPY';
import { t } from '@/lib/i18n';
import { logger } from '@/lib/logger';
import { type TimeRange } from '@/lib/statsCalculator';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
  UI_TYPOGRAPHY,
} from '@/lib/uiTokens';

/** Build 80 release gate: AP-3 disabled at Analysis entry (fail-closed). */
export const ANALYSIS_PRICE_CHANGES_ENABLED = false;

const ANALYSIS_PRICE_CHANGES_UNAVAILABLE: AnalysisPriceChangesSurface = {
  status: 'unavailable',
};

/**
 * Legacy Price Radar / Category Index helpers remain available in
 * lib/analysisHelpers.ts + lib/priceRadar.ts for future migration.
 * Release UI intentionally does not mount them until Safe Price History adopts them.
 *
 * C2C: when ANALYSIS_PRICE_CHANGES_ENABLED flips true, AP-3 must:
 * - render Analysis core first
 * - schedule derivation after first paint (runAfterAnalysisFirstPaint)
 * - use session domain cache + generation cancellation
 * - cancel on Analysis blur/unfocus (focus lifetime token)
 * Wiring remains dormant while the flag is false.
 */
export default function AnalysisScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const loadCycleRef = useRef(0);
  const priceGenerationRef = useRef(0);
  const focusTokenRef = useRef(0);
  const [truthCycle, setTruthCycle] = useState<
    (AnalysisLoadedTruth & { cycleId: number }) | null
  >(null);
  const [priceChangesBinding, setPriceChangesBinding] =
    useState<AnalysisPriceChangesBinding>(createInitialPriceChangesBinding);
  const [refreshUi, setRefreshUi] = useState<AnalysisRefreshUiState>(
    createInitialAnalysisRefreshUiState
  );
  const hasTruthSnapshotRef = useRef(false);
  const [timeRange, setTimeRange] = useState<TimeRange>('month');

  const loadReceipts = useCallback(async () => {
    const cycleId = loadCycleRef.current + 1;
    loadCycleRef.current = cycleId;
    priceGenerationRef.current += 1;
    const priceGenerationId = priceGenerationRef.current;
    setRefreshUi((state) => beginAnalysisRefresh(state));
    const totalStarted = Date.now();
    let analyticsReceipts: AnalysisLoadedTruth['receipts'] | null = null;
    try {
      const allReceipts = await measureAnalysisRefreshStage(
        'listReceiptsForAnalysis',
        () => listReceiptsForAnalysis()
      );
      const selectStarted = Date.now();
      analyticsReceipts =
        selectAnalyticsReceipts(allReceipts).analyticsReceipts;
      recordAnalysisRefreshTiming({
        stage: 'selectAnalyticsReceipts',
        durationMs: Date.now() - selectStarted,
        receiptCount: allReceipts.length,
        analyticsReceiptCount: analyticsReceipts.length,
      });
      if (loadCycleRef.current !== cycleId) return;
      // Commit newer truth without clearing prior AP-3 binding.
      // Cross-cycle render is fail-closed via resolveBoundPriceChangesSurface.
      setTruthCycle({
        cycleId,
        receipts: analyticsReceipts,
        nowMs: Date.now(),
      });
      hasTruthSnapshotRef.current = true;
      setRefreshUi((state) => completeAnalysisRefresh(state));
    } catch (e) {
      console.error('加载收据失败:', e);
      if (loadCycleRef.current !== cycleId) return;
      if (hasTruthSnapshotRef.current) {
        logger.warn('Analysis', 'background refresh failed', { error: e });
        setRefreshUi((state) => failAnalysisRefresh(state));
      } else {
        setRefreshUi((state) => failAnalysisRefresh(state));
      }
    } finally {
      recordAnalysisRefreshTiming({
        stage: 'total',
        durationMs: Date.now() - totalStarted,
      });
    }
    return { analyticsReceipts, cycleId, priceGenerationId };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const focusId = ++focusTokenRef.current;
      let cancelled = false;
      let cancelScheduledPrice: (() => void) | null = null;

      void (async () => {
        const loaded = await loadReceipts();
        if (
          cancelled ||
          focusTokenRef.current !== focusId ||
          !loaded ||
          !ANALYSIS_PRICE_CHANGES_ENABLED ||
          !loaded.analyticsReceipts ||
          loadCycleRef.current !== loaded.cycleId
        ) {
          return;
        }
        try {
          const { scheduleAnalysisPriceLoadAfterPaint } = await import(
            '@/lib/analysisPriceEnablement'
          );
          const { createAnalysisPriceFocusToken } = await import(
            '@/lib/analysisPriceScheduler'
          );
          const focusToken = createAnalysisPriceFocusToken();
          const scheduled = scheduleAnalysisPriceLoadAfterPaint({
            analyticsReceipts: loaded.analyticsReceipts,
            focusToken,
            isStale: () =>
              cancelled ||
              focusTokenRef.current !== focusId ||
              loadCycleRef.current !== loaded.cycleId ||
              priceGenerationRef.current !== loaded.priceGenerationId ||
              !focusToken.isActive(),
          });
          cancelScheduledPrice = scheduled.cancel;
          const surface = await scheduled.promise;
          if (
            surface == null ||
            cancelled ||
            focusTokenRef.current !== focusId ||
            loadCycleRef.current !== loaded.cycleId ||
            priceGenerationRef.current !== loaded.priceGenerationId
          ) {
            return;
          }
          setPriceChangesBinding(
            bindPriceChangesToCycle(loaded.cycleId, surface)
          );
        } catch {
          if (
            cancelled ||
            focusTokenRef.current !== focusId ||
            loadCycleRef.current !== loaded.cycleId
          ) {
            return;
          }
          setPriceChangesBinding(
            bindPriceChangesToCycle(
              loaded.cycleId,
              ANALYSIS_PRICE_CHANGES_UNAVAILABLE
            )
          );
        }
      })();

      return () => {
        cancelled = true;
        focusTokenRef.current += 1;
        priceGenerationRef.current += 1;
        cancelScheduledPrice?.();
      };
    }, [loadReceipts])
  );

  const truthSnapshot = useMemo(() => {
    if (!truthCycle) return null;
    return measureAnalysisRefreshStageSync('buildAnalysisTruthSnapshot', () =>
      buildAnalysisTruthSnapshot({
        receipts: truthCycle.receipts,
        range: timeRange,
        nowMs: truthCycle.nowMs,
      })
    );
  }, [truthCycle, timeRange]);

  const allStats = useMemo(() => {
    if (!truthCycle) return null;
    return measureAnalysisRefreshStageSync('buildAnalysisAllTimeStats', () =>
      buildAnalysisAllTimeStats({
        receipts: truthCycle.receipts,
        nowMs: truthCycle.nowMs,
      })
    );
  }, [truthCycle]);

  const boundPriceChanges = useMemo(() => {
    if (!ANALYSIS_PRICE_CHANGES_ENABLED) {
      return ANALYSIS_PRICE_CHANGES_UNAVAILABLE;
    }
    return resolveBoundPriceChangesSurface(
      truthCycle?.cycleId,
      priceChangesBinding
    );
  }, [truthCycle?.cycleId, priceChangesBinding]);

  const viewModel = useMemo(() => {
    return measureAnalysisRefreshStageSync('buildAnalysisReleaseViewModel', () =>
      buildAnalysisReleaseViewModel({
        periodStats: truthSnapshot?.periodStats ?? createEmptyStats(),
        allSupportedCount: allStats?.supportedReceiptCount ?? 0,
        itemCount: truthSnapshot?.itemCount ?? 0,
        insights: truthSnapshot?.insights ?? null,
        priceChanges: boundPriceChanges,
        proComingSoon: true,
        priceRadarMigrated: false,
      })
    );
  }, [truthSnapshot, allStats, boundPriceChanges]);

  const showBlockingLoader = shouldShowAnalysisBlockingLoader(refreshUi);
  const showLoadFailed = shouldShowAnalysisLoadFailed(refreshUi);
  const showContent = shouldShowAnalysisContent(refreshUi);

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

      {showBlockingLoader ? (
        <View style={styles.inlineLoading}>
          <ActivityIndicator color={UI_COLORS.accent} />
        </View>
      ) : null}

      {showLoadFailed ? (
        <View style={styles.messageCard}>
          <Text style={styles.messageText}>
            {t('analysis.release.loadFailed')}
          </Text>
        </View>
      ) : null}

      {showContent && viewModel.stage === 'empty' ? (
        <AnalysisEmptyState
          variant="empty"
          onGoHome={() => router.push('/(tabs)/' as any)}
        />
      ) : null}

      {showContent && viewModel.stage === 'period_empty' ? (
        <AnalysisEmptyState
          variant="period_empty"
          onGoHome={() => router.push('/(tabs)/' as any)}
          onSwitchToAll={() => setTimeRange('all')}
        />
      ) : null}

      {showContent &&
      (viewModel.stage === 'low' || viewModel.stage === 'ready') &&
      viewModel.overview ? (
        <>
          <SectionTitle title={t('analysis.release.overviewTitle')} />
          <View style={styles.overviewPanel}>
            <View style={styles.overviewBlueHero}>
              <View style={styles.overviewMotif} />
              <Text style={styles.overviewPrimaryLabel}>
                {t('analysis.release.totalSpend')}
              </Text>
              <Text style={styles.overviewPrimaryValue}>
                {formatJPY(viewModel.overview.supportedSpend)}
              </Text>
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
                {viewModel.categories.map((row, index) => (
                  <View
                    key={row.category}
                    style={[
                      styles.categoryRow,
                      index > 0 && styles.categoryRowDivider,
                    ]}
                  >
                    <CategoryRatioRow
                      category={row.category}
                      amount={formatJPY(row.amount)}
                      percent={row.share * 100}
                    />
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
              <SectionTitle title={t('analysis.release.merchantsTitle')} />
              <View style={styles.card}>
                {viewModel.merchants.map((row, index) => (
                  <View
                    key={row.merchantKey}
                    style={[styles.merchantRow, index > 0 && styles.rowDivider]}
                  >
                    <MerchantIdentityTile
                      merchant={row.displayName}
                      merchantKey={row.merchantKey}
                      size={38}
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

          {timeRange !== 'all' && viewModel.showPeriodChangesSection ? (
            <>
              <SectionTitle title={t('analysis.release.changesTitle')} />
              <View style={styles.changesPanel}>
                {viewModel.spendChange.status === 'available' ||
                viewModel.categoryChange.status === 'available' ||
                viewModel.merchantChange.status === 'available' ? (
                  <>
                    {viewModel.spendChange.status === 'available' ? (
                      <Text style={styles.changesCompared}>
                        {t('analysis.release.changesCompared', {
                          days: viewModel.spendChange.periodDays,
                        })}
                      </Text>
                    ) : null}
                    {viewModel.spendChange.status === 'available' ? (
                      <Text style={styles.changeFactPrimary}>
                        {viewModel.spendChange.direction === 'up'
                          ? t('analysis.release.spendChangeLineUp', {
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
                          : viewModel.spendChange.direction === 'down'
                            ? t('analysis.release.spendChangeLineDown', {
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
                            : t('analysis.release.spendChangeLineFlat')}
                      </Text>
                    ) : null}
                    {viewModel.categoryChange.status === 'available' ? (
                      <View style={styles.changeFactBlock}>
                        <Text style={styles.changeFactLabel}>
                          {getCategoryLabel(viewModel.categoryChange.category)}
                        </Text>
                        <Text style={styles.changeFactSecondary}>
                          {viewModel.categoryChange.direction === 'up'
                            ? t('analysis.release.categoryChangeUp', {
                                fromPercent:
                                  viewModel.categoryChange.fromPercent,
                                toPercent: viewModel.categoryChange.toPercent,
                                points:
                                  viewModel.categoryChange.percentagePointChange,
                              })
                            : t('analysis.release.categoryChangeDown', {
                                fromPercent:
                                  viewModel.categoryChange.fromPercent,
                                toPercent: viewModel.categoryChange.toPercent,
                                points:
                                  viewModel.categoryChange.percentagePointChange,
                              })}
                        </Text>
                      </View>
                    ) : null}
                    {viewModel.merchantChange.status === 'available' ? (
                      <View style={styles.changeFactBlock}>
                        <Text style={styles.changeFactLabel}>
                          {viewModel.merchantChange.displayName}
                        </Text>
                        <Text style={styles.changeFactSecondary}>
                          {viewModel.merchantChange.kind === 'share_increased'
                            ? t('analysis.release.merchantChangeShareIncreased', {
                                merchant: viewModel.merchantChange.displayName,
                                fromPercent:
                                  viewModel.merchantChange.previousShare,
                                toPercent: viewModel.merchantChange.currentShare,
                              })
                            : t('analysis.release.merchantChangeCurrentShare', {
                                share: viewModel.merchantChange.currentShare,
                              })}
                        </Text>
                      </View>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.changeUnavailable}>
                    {t('analysis.release.changesUnavailable')}
                  </Text>
                )}
              </View>
            </>
          ) : null}

          {viewModel.priceChanges.status === 'available' ? (
            <>
              <SectionTitle title={t('analysis.release.priceChangesTitle')} />
              <View style={styles.changesPanel}>
                <Text style={styles.changesCompared}>
                  {t('analysis.release.priceChangesContext')}
                </Text>
                {viewModel.priceChanges.items.map((row) => (
                  <View
                    key={`${row.targetType}-${row.targetKey}`}
                    style={styles.changeFactBlock}
                  >
                    <Text style={styles.changeFactLabel}>{row.displayName}</Text>
                    <Text style={styles.changeFactSecondary}>
                      {row.direction === 'up'
                        ? t('analysis.release.priceChangeUp', {
                            amount: formatJPY(row.deltaAmount),
                          })
                        : t('analysis.release.priceChangeDown', {
                            amount: formatJPY(row.deltaAmount),
                          })}
                    </Text>
                    {row.promoBodyKey ? (
                      <Text style={styles.changeCompared}>
                        {t(row.promoBodyKey)}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            </>
          ) : null}

          {viewModel.insight ? (
            <>
              <SectionTitle title={t(viewModel.insight.titleKey)} />
              <View style={styles.insightCard}>
                <View style={styles.insightIcon} importantForAccessibility="no">
                  <MaterialIcons
                    name="lightbulb-outline"
                    size={18}
                    color={UI_COLORS.accent}
                  />
                </View>
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
  overviewBlueHero: {
    position: 'relative',
    minHeight: 122,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 20,
    backgroundColor: UI_COLORS.accent,
    overflow: 'hidden',
  },
  overviewMotif: {
    position: 'absolute',
    right: -28,
    top: -42,
    width: 126,
    height: 126,
    borderRadius: 63,
    borderWidth: 18,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  overviewPrimaryLabel: {
    color: 'rgba(255,255,255,0.82)',
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
    paddingVertical: 2,
  },
  categoryRow: {
    paddingVertical: 14,
  },
  categoryRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
  },
  merchantTextCol: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: 12,
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
  changesPanel: {
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  changesCompared: {
    color: '#68707a',
    fontSize: 12,
    fontWeight: '600',
  },
  changeFactPrimary: {
    color: '#15181c',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  changeFactBlock: {
    gap: 4,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
  },
  changeFactLabel: {
    color: '#15181c',
    fontSize: 14,
    fontWeight: '800',
  },
  changeFactSecondary: {
    color: '#3c4654',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
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
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#cbdcf7',
    borderLeftWidth: 4,
    borderLeftColor: UI_COLORS.accent,
    padding: 16,
  },
  insightIcon: {
    width: 30,
    height: 30,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: UI_COLORS.surface,
  },
  insightText: {
    flex: 1,
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
