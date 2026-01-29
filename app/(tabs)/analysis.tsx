// app/(tabs)/analysis.tsx
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { listReceipts, type ReceiptRow } from '@/lib/db';
import { t } from '@/lib/i18n';
import { getCategoryLabel } from '@/lib/categoryPalette';
import { calculateStats, type TimeRange } from '@/lib/statsCalculator';
import { buildInsights } from '@/lib/insights/buildInsights';
import {
  extractProductPrices,
  computeCheapestMerchants,
  getTopCheapestProducts,
  computeCategoryPriceIndex,
  isOverpriced,
  compareWithMinPrice,
} from '@/lib/priceRadar';
import { normalizeProductName } from '@/lib/productNormalizer';
import { isGroceryMerchant } from '@/lib/groceryDetector';

export default function AnalysisScreen() {
  const router = useRouter();
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>('month');

  const loadReceipts = useCallback(async () => {
    try {
      setLoading(true);
      const allReceipts = await listReceipts();
      setReceipts(allReceipts);
    } catch (e: any) {
      console.error('加载收据失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadReceipts();
    }, [loadReceipts])
  );

  // 计算统计数据
  // 全链路容错：任何异常都降级为默认值，不崩溃
  const stats = useMemo(() => {
    try {
      if (!Array.isArray(receipts)) {
        return {
          totalSpend: 0,
          grocerySpend: 0,
          topCategories: [],
          topMerchants: [],
          highestSingleReceipt: null,
          mostFrequentMerchant: null,
          uncategorizedCount: 0,
          uncategorizedTotal: 0,
        };
      }
      return calculateStats(receipts, timeRange);
    } catch (e) {
      console.error('[Analysis] stats computation failed:', e);
      return {
        totalSpend: 0,
        grocerySpend: 0,
        topCategories: [],
        topMerchants: [],
        highestSingleReceipt: null,
        mostFrequentMerchant: null,
        uncategorizedCount: 0,
        uncategorizedTotal: 0,
      };
    }
  }, [receipts, timeRange]);

  const insights = useMemo(() => {
    try {
      if (!Array.isArray(receipts)) return null;
      return buildInsights(receipts, timeRange);
    } catch (e) {
      console.error('[Analysis] buildInsights failed:', e);
      return null;
    }
  }, [receipts, timeRange]);

  // 价格雷达数据（仅grocery收据，需要至少5张grocery收据）
  // 全链路容错：任何异常都降级为null，显示"无数据"而不是崩溃
  const priceRadarData = useMemo(() => {
    try {
      if (!Array.isArray(receipts) || receipts.length === 0) {
        return null;
      }

      // Filter to grocery receipts only
      const groceryReceipts = receipts.filter((r) => {
        try {
          if (!r) return false;
          if (isGroceryMerchant(r.merchant_raw || null, r.merchant_normalized || null)) {
            return true;
          }
          try {
            const analysis = JSON.parse(r.analysis_json || '{}');
            return analysis.is_grocery === true;
          } catch {
            return false;
          }
        } catch {
          return false;
        }
      });

      if (groceryReceipts.length < 5) return null;

      const records = extractProductPrices(groceryReceipts);
      if (!Array.isArray(records) || records.length === 0) return null;

      const cheapestMap = computeCheapestMerchants(records);
      if (!cheapestMap || cheapestMap.size === 0) return null;

      const topProducts = getTopCheapestProducts(cheapestMap, 10);
      if (!Array.isArray(topProducts) || topProducts.length === 0) return null;

      return {
        records,
        cheapestMap,
        topProducts,
      };
    } catch (e) {
      console.error('[Analysis] priceRadarData computation failed:', e);
      return null; // 降级为无数据，不崩溃
    }
  }, [receipts]);

  // 分类价格指数（仅grocery收据）
  // 全链路容错：任何异常都降级为null，显示"无数据"而不是崩溃
  const categoryIndex = useMemo(() => {
    try {
      if (!Array.isArray(receipts) || receipts.length === 0) {
        return null;
      }

      // Filter to grocery receipts only
      const groceryReceipts = receipts.filter((r) => {
        try {
          if (!r) return false;
          if (isGroceryMerchant(r.merchant_raw || null, r.merchant_normalized || null)) {
            return true;
          }
          try {
            const analysis = JSON.parse(r.analysis_json || '{}');
            return analysis.is_grocery === true;
          } catch {
            return false;
          }
        } catch {
          return false;
        }
      });

      if (groceryReceipts.length < 10) return null;

      const result = computeCategoryPriceIndex(groceryReceipts, 'produce', 5);
      return result; // 可能为null，由UI处理
    } catch (e) {
      console.error('[Analysis] categoryIndex computation failed:', e);
      return null; // 降级为无数据，不崩溃
    }
  }, [receipts]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10 }}>{t('analysis.loading')}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{t('analysis.title')}</Text>

      {/* 时间范围选择 */}
      <View style={styles.timeRangeContainer}>
        <Pressable
          style={[styles.timeRangeBtn, timeRange === 'week' && styles.timeRangeBtnActive]}
          onPress={() => setTimeRange('week')}
        >
          <Text
            style={[
              styles.timeRangeBtnText,
              timeRange === 'week' && styles.timeRangeBtnTextActive,
            ]}
          >
            {t('analysis.timeRange.week')}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.timeRangeBtn, timeRange === 'month' && styles.timeRangeBtnActive]}
          onPress={() => setTimeRange('month')}
        >
          <Text
            style={[
              styles.timeRangeBtnText,
              timeRange === 'month' && styles.timeRangeBtnTextActive,
            ]}
          >
            {t('analysis.timeRange.month')}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.timeRangeBtn, timeRange === 'all' && styles.timeRangeBtnActive]}
          onPress={() => setTimeRange('all')}
        >
          <Text
            style={[
              styles.timeRangeBtnText,
              timeRange === 'all' && styles.timeRangeBtnTextActive,
            ]}
          >
            {t('analysis.timeRange.all')}
          </Text>
        </Pressable>
      </View>

      {/* V2: One-liner story */}
      {insights && (
        <>
          <View style={styles.card}>
            <Text style={styles.storyCardTitle}>{t('analysisV2.sections.story')}</Text>
            {insights.story.type === 'full' ? (
              <>
                <Text style={styles.storyConclusion}>
                  {t(insights.story.conclusionKey, (() => {
                    const p = { ...insights.story.conclusionParams } as Record<string, string | number>;
                    const cat = String(p.cat ?? '');
                    const label = getCategoryLabel(cat);
                    p.catLabel = label && label !== cat ? label : t('analysisV2.labels.other');
                    return p;
                  })())}
                </Text>
                <Text style={styles.storyExplanation}>
                  {t(insights.story.explanationKey)}
                </Text>
              </>
            ) : (
              <Text style={styles.storyFallback}>
                {t(insights.story.fallbackKey)}
              </Text>
            )}
          </View>

          {/* Changes vs previous period */}
          {insights.changes.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t('analysisV2.sections.changes')}</Text>
              {insights.changes.map((c, i) => {
                const params = { ...(c.changeParams ?? {}) } as Record<string, string | number>;
                if (params.cat != null) {
                  const lab = getCategoryLabel(String(params.cat));
                  params.catLabel = lab && lab !== String(params.cat) ? lab : t('analysisV2.labels.other');
                }
                return (
                  <Text key={i} style={styles.changeItem}>
                    {t(c.changeKey, params)}
                  </Text>
                );
              })}
            </View>
          )}

          {/* Actionable tips */}
          {insights.tips.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t('analysisV2.sections.tips')}</Text>
              {insights.tips.map((tip, i) => (
                <Text key={i} style={styles.tipItem}>
                  {t(tip.tipKey, (tip.tipParams ?? {}) as Record<string, string | number>)}
                </Text>
              ))}
            </View>
          )}

          {/* Confidence */}
          <Text style={styles.confidence}>{t(insights.confidenceKey)}</Text>

          {/* Pro teaser card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('analysisV2.pro.title')}</Text>
            {insights.proTeaser.map((item, i) => (
              <Pressable
                key={i}
                style={styles.proTeaserRow}
                onPress={() => Alert.alert(t('analysisV2.pro.title'), t('analysisV2.pro.alert'))}
              >
                <Text style={styles.proTeaserText}>{t(item.proTeaserKey)}</Text>
                <Text style={styles.proTeaserLock}>🔒</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {/* 统计卡片 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('analysis.stats.totalSpend')}</Text>
        <Text style={styles.cardValue}>
          ¥{Math.round(stats.totalSpend).toLocaleString()}
        </Text>
        {stats.grocerySpend > 0 && (
          <Text style={styles.cardSubtitle}>
            {t('analysis.stats.grocerySpend')}: ¥{Math.round(stats.grocerySpend).toLocaleString()}
          </Text>
        )}
        {timeRange !== 'all' && (
          <Text style={[styles.cardSubtitle, { marginTop: 4, fontSize: 12 }]}>
            {t('grocery.onlyNote')}
          </Text>
        )}
      </View>

      {/* Top Categories：仅 ok + 有效 grocery，不出现非超市/未分类扇区 */}
      {(stats.topCategories.length > 0 || stats.uncategorizedCount > 0) && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('analysis.stats.topCategories')}</Text>
          <Text style={styles.cardSubtitle}>{t('grocery.onlyNote')}</Text>
          {stats.topCategories.map((item, idx) => (
            <View key={idx} style={styles.statRow}>
              <Text style={styles.statLabel}>{getCategoryLabel(item.category)}</Text>
              <Text style={styles.statValue}>¥{Math.round(item.amount).toLocaleString()}</Text>
            </View>
          ))}
          {stats.uncategorizedCount > 0 && (
            <Text style={styles.uncategorizedHint}>
              {t('home.kpi.uncategorizedHint', { count: String(stats.uncategorizedCount) })}
            </Text>
          )}
        </View>
      )}

      {/* Top Merchants */}
      {stats.topMerchants.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('analysis.stats.topMerchants')}</Text>
          {stats.topMerchants.map((item, idx) => (
            <View key={idx} style={styles.statRow}>
              <Text style={styles.statLabel}>{item.merchant}</Text>
              <Text style={styles.statValue}>
                {item.count} {t('analysis.stats.times')} · ¥{Math.round(item.total).toLocaleString()}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Highest Single Receipt */}
      {stats.highestSingleReceipt && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('analysis.stats.highestReceipt')}</Text>
          <Text style={styles.statValue}>
            ¥{Math.round(stats.highestSingleReceipt.amount).toLocaleString()}
          </Text>
          <Text style={styles.statLabel}>{stats.highestSingleReceipt.merchant}</Text>
        </View>
      )}

      {/* Price Radar (需要至少5张收据) */}
      {receipts.length >= 5 && priceRadarData ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('analysis.priceRadar.title')}</Text>
          <Text style={styles.cardSubtitle}>{t('analysis.priceRadar.subtitle')}</Text>

          {priceRadarData.topProducts.length > 0 ? (
            priceRadarData.topProducts.slice(0, 5).map((product, idx) => (
              <View key={idx} style={styles.priceRadarItem}>
                <Text style={styles.priceRadarProductName} numberOfLines={1}>
                  {product.normalizedName}
                </Text>
                <View style={styles.priceRadarDetails}>
                  <Text style={styles.priceRadarMerchant}>{product.merchantKey}</Text>
                  <Text style={styles.priceRadarPrice}>
                    ¥{Math.round(product.minUnitPrice).toLocaleString()}
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.emptyText}>{t('analysis.priceRadar.noData')}</Text>
          )}
        </View>
      ) : (
        receipts.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('analysis.priceRadar.title')}</Text>
            <Text style={styles.emptyText}>
              {(() => {
                const remaining = Math.max(0, 5 - receipts.length);
                return remaining <= 0
                  ? t('analysis.priceRadar.unlockedHint')
                  : t('analysis.priceRadar.lockedHint', { count: remaining });
              })()}
            </Text>
          </View>
        )
      )}

      {/* Category Price Index */}
      {categoryIndex && categoryIndex.merchantAverages.length >= 2 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('analysis.categoryIndex.title')}</Text>
          <Text style={styles.cardSubtitle}>
            {t('analysis.categoryIndex.category')}: {getCategoryLabel(categoryIndex.category)}
          </Text>

          {categoryIndex.merchantAverages.map((merchant, idx) => (
            <View key={idx} style={styles.statRow}>
              <Text style={styles.statLabel}>{merchant.merchantKey}</Text>
              <Text style={styles.statValue}>
                ¥{Math.round(merchant.averagePrice).toLocaleString()} ({merchant.itemCount}{' '}
                {t('analysis.categoryIndex.items')})
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 24,
  },
  timeRangeContainer: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 24,
  },
  timeRangeBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  timeRangeBtnActive: {
    backgroundColor: '#111',
  },
  timeRangeBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  timeRangeBtnTextActive: {
    color: '#fff',
  },
  card: {
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 12,
  },
  cardSubtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 12,
  },
  cardValue: {
    fontSize: 28,
    fontWeight: '900',
    color: '#111',
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  statLabel: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  statValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
  },
  uncategorizedHint: {
    fontSize: 12,
    color: '#666',
    marginTop: 12,
  },
  priceRadarItem: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  priceRadarProductName: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  priceRadarDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  priceRadarMerchant: {
    fontSize: 14,
    color: '#666',
  },
  priceRadarPrice: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
  },
  emptyText: {
    fontSize: 14,
    color: '#888',
    fontStyle: 'italic',
  },
  storyCardTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
    marginBottom: 12,
  },
  storyConclusion: {
    fontSize: 19,
    fontWeight: '800',
    color: '#111',
    marginBottom: 8,
    lineHeight: 26,
  },
  storyExplanation: {
    fontSize: 15,
    color: '#555',
    lineHeight: 22,
  },
  storyFallback: {
    fontSize: 15,
    color: '#666',
    fontStyle: 'italic',
  },
  changeItem: {
    fontSize: 15,
    color: '#333',
    lineHeight: 22,
    marginBottom: 8,
  },
  tipItem: {
    fontSize: 15,
    color: '#333',
    lineHeight: 22,
    marginBottom: 8,
  },
  confidence: {
    fontSize: 13,
    color: '#888',
    marginBottom: 16,
    fontStyle: 'italic',
  },
  proTeaserRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  proTeaserText: {
    fontSize: 15,
    color: '#999',
    flex: 1,
  },
  proTeaserLock: {
    fontSize: 14,
    marginLeft: 8,
  },
});
