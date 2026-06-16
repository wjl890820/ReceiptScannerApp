// app/(tabs)/index.tsx

import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Text as SvgText, TSpan } from 'react-native-svg';

import type { ReceiptAnalysis, ReceiptItem } from '@/lib/receiptAnalyzer';
import { pingOcrEdge, probeSupabaseNetwork } from '@/lib/ocrService';
import {
  runScanPipelineToReview,
  aggregateBatchScanResults,
  type ScanOneResult,
} from '@/lib/scanPipeline';
import { setScanReviewQueue, clearScanReviewQueue } from '@/lib/scanReviewQueue';
import { getScanErrorMessage } from '@/lib/scanError';
import { logger } from '@/lib/logger';

import { listReceipts, type ReceiptRow } from '@/lib/db';
import { t } from '@/lib/i18n';
// 商品分类由 receiptEnricher.applyCategoriesWithLearning 完成（规则 + classify-item AI + 学习表），在 lib/scanPipeline 内调用
import { getCategoryColor, getCategoryLabel, getCategoryShortLabel } from '@/lib/categoryPalette';
import { formatJPY } from '@/lib/formatJPY';
import { getHomeTimeRange, setHomeTimeRange } from '@/lib/settingsStore';
import {
  aggregateCategoryData,
  computeUncategorizedSummary,
  type CategoryData,
} from '@/lib/homeMetricsHelpers';

// ====== 饼图相关 ======
// Note: Category colors and labels from lib/categoryPalette.ts；分类聚合与未分类汇总来自 lib/homeMetricsHelpers

function safeParseItems(json: string | null): ReceiptItem[] | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    return arr;
  } catch {
    return null;
  }
}

function safeParseAnalysis(json: string | null): ReceiptAnalysis | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    return obj as ReceiptAnalysis;
  } catch {
    return null;
  }
}

// ====== 洞察规则引擎 ======
import {
  computeInsightContext,
  buildHomeInsight,
  pickInsightRule,
  type InsightContext,
  type InsightLevel,
} from '@/lib/homeInsightHelpers';

type InsightRuleWithMessages = {
  priority: number;
  level: InsightLevel;
  condition: (ctx: InsightContext) => boolean;
  messages: ((ctx: InsightContext) => string)[];
};

const INSIGHT_RULES: InsightRuleWithMessages[] = [
  {
    priority: 100,
    level: 'alert',
    condition: (ctx) => ctx.top1Pct >= 60,
    messages: [
      (ctx) => {
        const label = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        return `消费高度集中在【${label}】（${Math.round(ctx.top1Pct)}%），建议分散支出。`;
      },
      (ctx) => {
        const label = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        return `【${label}】占比过高（${Math.round(ctx.top1Pct)}%），消费结构需要优化。`;
      },
      (ctx) => {
        const label = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        return `超过六成支出用于【${label}】（${Math.round(ctx.top1Pct)}%），建议平衡消费。`;
      },
    ],
  },
  {
    priority: 90,
    level: 'warn',
    condition: (ctx) => ctx.top1Pct >= 50,
    messages: [
      (ctx) => {
        const label = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        return `【${label}】占比较高（${Math.round(ctx.top1Pct)}%），注意消费平衡。`;
      },
      (ctx) => {
        const label = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        return `消费主要集中在【${label}】（${Math.round(ctx.top1Pct)}%），建议多样化。`;
      },
      (ctx) => {
        const label = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        return `【${label}】支出占比达${Math.round(ctx.top1Pct)}%，可考虑分散。`;
      },
    ],
  },
  {
    priority: 85,
    level: 'warn',
    condition: (ctx) => ctx.top1Pct + ctx.top2Pct >= 80,
    messages: [
      (ctx) => {
        const label1 = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        const label2 = ctx.top2Category ? getCategoryLabel(ctx.top2Category) : '';
        return `前两大类别【${label1}】和【${label2}】合计占比${Math.round(ctx.top1Pct + ctx.top2Pct)}%，消费较为集中。`;
      },
      (ctx) => {
        const label1 = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        const label2 = ctx.top2Category ? getCategoryLabel(ctx.top2Category) : '';
        return `【${label1}】和【${label2}】共占${Math.round(ctx.top1Pct + ctx.top2Pct)}%，建议增加其他类别支出。`;
      },
      (ctx) => {
        const label1 = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        const label2 = ctx.top2Category ? getCategoryLabel(ctx.top2Category) : '';
        return `消费集中在【${label1}】和【${label2}】（合计${Math.round(ctx.top1Pct + ctx.top2Pct)}%），可适当分散。`;
      },
    ],
  },
  {
    priority: 80,
    level: 'alert',
    condition: (ctx) => ctx.nonEssentialPct >= 45,
    messages: [
      (ctx) =>
        `非必需品（零食/饮料/外食）占比${Math.round(ctx.nonEssentialPct)}%，建议控制此类支出。`,
      (ctx) =>
        `零食、饮料、外食支出占比达${Math.round(ctx.nonEssentialPct)}%，可适当减少。`,
      (ctx) =>
        `非必需品消费占比${Math.round(ctx.nonEssentialPct)}%，建议优化消费结构。`,
    ],
  },
  {
    priority: 75,
    level: 'warn',
    condition: (ctx) => ctx.nonEssentialPct >= 35,
    messages: [
      (ctx) => `非必需品支出占比${Math.round(ctx.nonEssentialPct)}%，注意控制。`,
      (ctx) => `零食、饮料、外食共占${Math.round(ctx.nonEssentialPct)}%，可适当调整。`,
      (ctx) => `非必需品消费${Math.round(ctx.nonEssentialPct)}%，建议适度控制。`,
    ],
  },
  {
    priority: 70,
    level: 'alert',
    condition: (ctx) => ctx.uncategorizedPct >= 35,
    messages: [
      (ctx) =>
        `未分类项目占比${Math.round(ctx.uncategorizedPct)}%，建议完善分类以提高分析准确性。`,
      (ctx) =>
        `有${Math.round(ctx.uncategorizedPct)}%的支出未分类，建议补充分类信息。`,
      (ctx) =>
        `未分类支出占比${Math.round(ctx.uncategorizedPct)}%，完善分类有助于更好分析。`,
    ],
  },
  {
    priority: 65,
    level: 'warn',
    condition: (ctx) => ctx.uncategorizedPct >= 20,
    messages: [
      (ctx) => `未分类项目占比${Math.round(ctx.uncategorizedPct)}%，建议补充分类。`,
      (ctx) =>
        `有${Math.round(ctx.uncategorizedPct)}%的支出未分类，完善分类可提升分析质量。`,
      (ctx) => `未分类支出${Math.round(ctx.uncategorizedPct)}%，建议添加分类信息。`,
    ],
  },
  {
    priority: 60,
    level: 'warn',
    condition: (ctx) => {
      const dailyNecessitiesPct =
        ctx.totalSpending > 0
          ? ((ctx.totalsByCategory.get('日用品') || 0) / ctx.totalSpending) * 100
          : 0;
      return dailyNecessitiesPct >= 45;
    },
    messages: [
      (ctx) => {
        const pct =
          ctx.totalSpending > 0
            ? ((ctx.totalsByCategory.get('日用品') || 0) / ctx.totalSpending) * 100
            : 0;
        return `日用品支出占比${Math.round(pct)}%，占比偏高。`;
      },
      (ctx) => {
        const pct =
          ctx.totalSpending > 0
            ? ((ctx.totalsByCategory.get('日用品') || 0) / ctx.totalSpending) * 100
            : 0;
        return `日用品消费达${Math.round(pct)}%，可考虑优化。`;
      },
      (ctx) => {
        const pct =
          ctx.totalSpending > 0
            ? ((ctx.totalsByCategory.get('日用品') || 0) / ctx.totalSpending) * 100
            : 0;
        return `日用品支出${Math.round(pct)}%，占比较高。`;
      },
    ],
  },
  {
    priority: 55,
    level: 'info',
    condition: (ctx) => {
      const dailyNecessitiesPct =
        ctx.totalSpending > 0
          ? ((ctx.totalsByCategory.get('日用品') || 0) / ctx.totalSpending) * 100
          : 0;
      return dailyNecessitiesPct >= 30;
    },
    messages: [
      (ctx) => {
        const pct =
          ctx.totalSpending > 0
            ? ((ctx.totalsByCategory.get('日用品') || 0) / ctx.totalSpending) * 100
            : 0;
        return `日用品支出占比${Math.round(pct)}%。`;
      },
      (ctx) => {
        const pct =
          ctx.totalSpending > 0
            ? ((ctx.totalsByCategory.get('日用品') || 0) / ctx.totalSpending) * 100
            : 0;
        return `日用品消费${Math.round(pct)}%。`;
      },
      (ctx) => {
        const pct =
          ctx.totalSpending > 0
            ? ((ctx.totalsByCategory.get('日用品') || 0) / ctx.totalSpending) * 100
            : 0;
        return `日用品占比${Math.round(pct)}%。`;
      },
    ],
  },
  {
    priority: 50,
    level: 'info',
    condition: (ctx) => ctx.top1Pct <= 35 && ctx.uncategorizedPct <= 10,
    messages: [
      (ctx) =>
        `消费结构较为均衡，主要类别占比${Math.round(ctx.top1Pct)}%，未分类项目较少。`,
      (ctx) =>
        `支出分布合理，最大类别占比${Math.round(ctx.top1Pct)}%，分类完善。`,
      (ctx) => `消费结构良好，主要类别${Math.round(ctx.top1Pct)}%，分类清晰。`,
    ],
  },
  {
    priority: 45,
    level: 'warn',
    condition: (ctx) =>
      ctx.avgReceiptTotal > 0 && ctx.maxReceiptTotal >= ctx.avgReceiptTotal * 2.5,
    messages: [
      (ctx) =>
        `存在单笔大额消费（${formatJPY(ctx.maxReceiptTotal)}），是平均值的${Math.round((ctx.maxReceiptTotal / ctx.avgReceiptTotal) * 10) / 10}倍。`,
      (ctx) =>
        `最大单笔消费${formatJPY(ctx.maxReceiptTotal)}，显著高于平均值${formatJPY(ctx.avgReceiptTotal)}。`,
      (ctx) =>
        `单笔最大支出${formatJPY(ctx.maxReceiptTotal)}，远超平均${formatJPY(ctx.avgReceiptTotal)}。`,
    ],
  },
];

// Period-over-period comparison
function computePeriodComparison(
  receipts: ReceiptRow[],
  timeRange: TimeRange
): { category: string; change: number; from: number; to: number } | null {
  if (timeRange === 'ALL' || receipts.length === 0) {
    return null;
  }

  const now = Date.now();
  const days = timeRange === '7D' ? 7 : 30;
  const currentStart = now - days * 24 * 60 * 60 * 1000;
  const previousStart = currentStart - days * 24 * 60 * 60 * 1000;
  const previousEnd = currentStart;

  const currentReceipts = receipts.filter((r) => {
    const receiptTime = r.transaction_at || r.created_at;
    return receiptTime >= currentStart;
  });
  const previousReceipts = receipts.filter((r) => {
    const receiptTime = r.transaction_at || r.created_at;
    return receiptTime >= previousStart && receiptTime < previousEnd;
  });

  const currentData = aggregateCategoryData(currentReceipts);
  const previousData = aggregateCategoryData(previousReceipts);

  if (currentData.length === 0 || previousData.length === 0) {
    return null;
  }

  // Find the category with the largest absolute change
  const changes: Array<{ category: string; change: number; from: number; to: number }> = [];

  for (const current of currentData) {
    const previous = previousData.find((p) => p.category === current.category);
    const prevPct = previous?.percentage || 0;
    const currPct = current.percentage;
    const change = currPct - prevPct;

    if (Math.abs(change) > 2) {
      // Only show significant changes (>2%)
      changes.push({
        category: current.category,
        change,
        from: prevPct,
        to: currPct,
      });
    }
  }

  if (changes.length === 0) {
    return null;
  }

  // Return the category with the largest absolute change
  changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return changes[0];
}

type StructuredInsight = {
  headline: string;
  reasons: string[];
  suggestion: string;
  level: InsightLevel;
};

function generateStructuredInsight(
  context: InsightContext,
  periodComparison: { category: string; change: number; from: number; to: number } | null
): StructuredInsight | null {
  if (context.totalSpending === 0) {
    return null;
  }

  const matchedRule = pickInsightRule(context);

  if (!matchedRule) {
    return null;
  }

  const concentration = context.top1Pct + context.top2Pct;
  const reasons: string[] = [];

  // Build quantified reasons
  if (context.top1Pct >= 50) {
    reasons.push(
      t('home.insight.reason.top1', {
        category: context.top1Category || '',
        percentage: String(Math.round(context.top1Pct)),
      })
    );
  }

  if (concentration >= 80) {
    reasons.push(
      t('home.insight.reason.concentration', {
        percentage: String(Math.round(concentration)),
      })
    );
  }

  if (context.nonEssentialPct >= 35) {
    reasons.push(
      t('home.insight.reason.nonEssential', {
        percentage: String(Math.round(context.nonEssentialPct)),
      })
    );
  }

  if (context.uncategorizedPct >= 20) {
    reasons.push(
      t('home.insight.reason.uncategorized', {
        percentage: String(Math.round(context.uncategorizedPct)),
      })
    );
  }

  // Generate headline based on concentration
  let headline = '';
  if (concentration >= 80) {
    headline = t('home.insight.headline.highConcentration', {
      percentage: String(Math.round(concentration)),
    });
  } else if (concentration >= 60) {
    headline = t('home.insight.headline.moderateConcentration', {
      percentage: String(Math.round(concentration)),
    });
  } else {
    headline = t('home.insight.headline.balanced');
  }

  // Add period comparison if available
  if (periodComparison && Math.abs(periodComparison.change) > 2) {
    const changeText =
      periodComparison.change > 0
        ? t('home.insight.comparison.increased', {
            category: periodComparison.category,
            change: String(Math.round(Math.abs(periodComparison.change))),
            from: String(Math.round(periodComparison.from)),
            to: String(Math.round(periodComparison.to)),
          })
        : t('home.insight.comparison.decreased', {
            category: periodComparison.category,
            change: String(Math.round(Math.abs(periodComparison.change))),
            from: String(Math.round(periodComparison.from)),
            to: String(Math.round(periodComparison.to)),
          });
    reasons.push(changeText);
  }

  // Generate suggestion based on the matched rule
  let suggestion = '';
  if (matchedRule.level === 'alert') {
    if (context.top1Pct >= 60) {
      suggestion = t('home.insight.suggestion.diversify');
    } else if (context.nonEssentialPct >= 45) {
      suggestion = t('home.insight.suggestion.controlNonEssential');
    } else if (context.uncategorizedPct >= 35) {
      suggestion = t('home.insight.suggestion.improveCategories');
    }
  } else if (matchedRule.level === 'warn') {
    suggestion = t('home.insight.suggestion.monitor');
  } else {
    suggestion = t('home.insight.suggestion.maintain');
  }

  return {
    headline,
    reasons: reasons.length > 0 ? reasons : [t('home.insight.reason.general')],
    suggestion,
    level: matchedRule.level,
  };
}

function generateInsight(context: InsightContext): { message: string; level: InsightLevel } | null {
  if (context.totalSpending === 0) {
    return null;
  }

  const sortedRules = [...INSIGHT_RULES].sort((a, b) => b.priority - a.priority);
  const matchedRule = sortedRules.find((rule) => rule.condition(context));

  if (!matchedRule) {
    return null;
  }

  const messageIndex = Math.floor((context.totalSpending % matchedRule.messages.length) || 0);
  const message = matchedRule.messages[messageIndex](context);

  return {
    message,
    level: matchedRule.level,
  };
}
// ====== 洞察规则引擎结束 ======

function generatePiePath(
  data: CategoryData[],
  centerX: number,
  centerY: number,
  radius: number
): string[] {
  const paths: string[] = [];
  let currentAngle = -90;

  for (const item of data) {
    if (item.percentage === 0) continue;

    const angle = (item.percentage / 100) * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;

    const startAngleRad = (startAngle * Math.PI) / 180;
    const endAngleRad = (endAngle * Math.PI) / 180;

    const x1 = centerX + radius * Math.cos(startAngleRad);
    const y1 = centerY + radius * Math.sin(startAngleRad);
    const x2 = centerX + radius * Math.cos(endAngleRad);
    const y2 = centerY + radius * Math.sin(endAngleRad);

    const largeArcFlag = angle > 180 ? 1 : 0;

    const path = `M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;
    paths.push(path);

    currentAngle = endAngle;
  }

  return paths;
}

type PieChartProps = {
  data: CategoryData[];
  total: number;
  size?: number;
};

function PieChart({ data, total, size = 200 }: PieChartProps) {
  const centerX = size / 2;
  const centerY = size / 2;
  const radius = size / 2 - 20;

  const validData = data.filter((item) => item.percentage > 0);
  const paths = generatePiePath(validData, centerX, centerY, radius);

  return (
    <View style={{ alignItems: 'center', marginVertical: 20 }}>
      <Svg width={size} height={size}>
        {validData.map((item, index) => {
          const color = getCategoryColor(item.category);
          return (
            <Path
              key={item.category}
              d={paths[index] || ''}
              fill={color}
              stroke="#fff"
              strokeWidth={2}
            />
          );
        })}
        <SvgText
          x={centerX}
          y={centerY - 8}
          fontSize={20}
          fontWeight="900"
          fill="#111"
          textAnchor="middle"
        >
          <TSpan>{Math.round(total)}</TSpan>
        </SvgText>
        <SvgText
          x={centerX}
          y={centerY + 12}
          fontSize={14}
          fontWeight="700"
          fill="#666"
          textAnchor="middle"
        >
          <TSpan>{t('home.pieChart.totalLabel')}</TSpan>
        </SvgText>
      </Svg>
    </View>
  );
}

// ====== 饼图相关结束 ======

type TimeRange = '7D' | '30D' | 'ALL';

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>('7D');
  const [scanning, setScanning] = useState(false);
  const [processingProgress, setProcessingProgress] = useState<{ current: number; total: number } | null>(null);
  const [stickyHeight, setStickyHeight] = useState(0);

  // Load time range preference on mount
  useEffect(() => {
    async function loadTimeRange() {
      try {
        const savedRange = await getHomeTimeRange();
        setTimeRange(savedRange);
      } catch (e) {
        // If loading fails, keep default (7D)
        if (__DEV__) {
          console.warn('[Home] Failed to load time range preference:', e);
        }
      }
    }
    loadTimeRange();
  }, []);

  // Save time range preference when changed
  const handleTimeRangeChange = useCallback(async (newRange: TimeRange) => {
    setTimeRange(newRange);
    try {
      await setHomeTimeRange(newRange);
    } catch (e) {
      // If saving fails, log but don't block UI
      if (__DEV__) {
        console.warn('[Home] Failed to save time range preference:', e);
      }
    }
  }, []);

  // 加载所有收据用于饼图
  const loadReceipts = useCallback(async () => {
    try {
      setLoadingReceipts(true);
      const allReceipts = await listReceipts();
      setReceipts(allReceipts);
    } catch (e: any) {
      console.error('加载收据失败:', e);
    } finally {
      setLoadingReceipts(false);
    }
  }, []);

  // 当屏幕获得焦点时刷新数据
  useFocusEffect(
    useCallback(() => {
      loadReceipts();
    }, [loadReceipts])
  );

  if (__DEV__) {
    console.log('[Home][Metrics] receipts_loaded_count', receipts.length);
  }

  // 根据时间范围过滤收据（使用 transaction_at，fallback 到 created_at）
  const filteredReceipts = useMemo(() => {
    if (timeRange === 'ALL') {
      return receipts;
    }

    const now = Date.now();
    const days = timeRange === '7D' ? 7 : 30;
    const cutoffTime = now - days * 24 * 60 * 60 * 1000;

    return receipts.filter((receipt) => {
      const receiptTime = receipt.transaction_at || receipt.created_at;
      return receiptTime >= cutoffTime;
    });
  }, [receipts, timeRange]);

  if (__DEV__) {
    const missingTx = receipts.filter((r) => !r.transaction_at).length;
    console.log('[Home][Metrics] timeRange', timeRange, 'filtered_count', filteredReceipts.length, 'missing_transaction_at', missingTx);
  }

  // 聚合类别数据
  const categoryData = useMemo(() => {
    return aggregateCategoryData(filteredReceipts);
  }, [filteredReceipts]);

  if (__DEV__) {
    let missingCategoryCount = 0;
    for (const r of filteredReceipts) {
      try {
        const obj = JSON.parse(r.user_items_json || r.analysis_json || '{}');
        const items = Array.isArray(obj?.items) ? obj.items : [];
        for (const it of items) {
          const cat = (it as any)?.category;
          if (!cat || (typeof cat === 'string' && !cat.trim())) missingCategoryCount++;
        }
      } catch {
        // ignore
      }
    }
    console.log('[Home][Metrics] categoryData', categoryData, 'missing_item_category_count', missingCategoryCount);
  }

  const totalAmount = useMemo(() => {
    return categoryData.reduce((sum, item) => sum + item.amount, 0);
  }, [categoryData]);

  const uncategorizedSummary = useMemo(() => {
    return computeUncategorizedSummary(filteredReceipts);
  }, [filteredReceipts]);

  // Compute insight context
  const insightContext = useMemo(() => {
    return computeInsightContext(filteredReceipts, categoryData);
  }, [filteredReceipts, categoryData]);

  // Period-over-period comparison
  const periodComparison = useMemo(() => {
    return computePeriodComparison(receipts, timeRange);
  }, [receipts, timeRange]);

  // Build insight structure (no i18n in helper)
  const homeInsight = useMemo(() => {
    return buildHomeInsight(insightContext, periodComparison);
  }, [insightContext, periodComparison]);

  // Compose structured insight (i18n in page)
  const structuredInsight = useMemo(() => {
    if (!homeInsight) return null;

    const { level, payload } = homeInsight;

    const headline = payload.headline.params
      ? t(payload.headline.key, payload.headline.params)
      : t(payload.headline.key);

    const reasons = payload.reasons.map((r) =>
      r.params ? t(r.key, r.params) : t(r.key)
    );

    const suggestion = payload.suggestion.key ? t(payload.suggestion.key) : '';

    return {
      headline,
      reasons: reasons.length > 0 ? reasons : [t('home.insight.reason.general')],
      suggestion,
      level,
    };
  }, [homeInsight]);

  // KPI data
  const kpiData = useMemo(() => {
    if (categoryData.length === 0) {
      return null;
    }
    const topCategory = categoryData[0];
    const nonEssentialCategories = ['snacks', 'non_alcoholic_drinks', 'ready_meals'];
    const nonEssentialAmount = categoryData
      .filter((item) => nonEssentialCategories.includes(item.category))
      .reduce((sum, item) => sum + item.amount, 0);
    const nonEssentialPct = totalAmount > 0 ? (nonEssentialAmount / totalAmount) * 100 : 0;

    return {
      totalSpending: totalAmount,
      topCategory: topCategory.category,
      topCategoryPct: topCategory.percentage,
      nonEssentialPct,
    };
  }, [categoryData, totalAmount]);

  // 扫描小票
  const handleScanReceipt = async () => {
    // Once-guard: 防止重复触发
    if (scanning) return;

    try {
      setScanning(true);

      // Network connectivity check (only in development)
      // Note: probe/ping failures are logged internally (once per session) to avoid spam
      if (__DEV__) {
        try {
          await probeSupabaseNetwork();
          await pingOcrEdge();
        } catch (pingError: any) {
          // Errors are already logged internally, only log unexpected errors here
          if (__DEV__ && pingError.message && !pingError.message.includes('not configured')) {
            console.warn('[OCR] Unexpected ping error:', pingError.message);
          }
        }
      }

      // 选择图片来源：拍照或相册
      const sourceChoice = await new Promise<'camera' | 'album' | 'cancel'>((resolve) => {
        Alert.alert(
          t('home.scan.title'),
          '',
          [
            { text: t('home.scan.cancel'), style: 'cancel', onPress: () => resolve('cancel') },
            { text: t('home.scan.takePhoto'), onPress: () => resolve('camera') },
            { text: t('home.scan.chooseFromLibrary'), onPress: () => resolve('album') },
          ],
          { cancelable: true, onDismiss: () => resolve('cancel') }
        );
      });

      if (sourceChoice === 'cancel') {
        setScanning(false);
        return;
      }

      if (sourceChoice === 'camera') {
            // 请求相机权限
            const { status: cameraStatus } = await ImagePicker.requestCameraPermissionsAsync();
            if (cameraStatus !== 'granted') {
              Alert.alert(t('permissions.cameraDeniedTitle'), t('permissions.cameraDeniedMessage'));
              setScanning(false);
              return;
            }

            // 拍照
            const cameraResult = await ImagePicker.launchCameraAsync({
              mediaTypes: 'images',
              quality: 1,
              allowsEditing: false,
            });

            if (cameraResult.canceled) {
              setScanning(false);
              return;
            }

            const uri = cameraResult.assets[0]?.uri;
            if (!uri) {
              setScanning(false);
              return;
            }

        // 确认识别对话框（包含隐私说明）
        const confirmResult = await new Promise<boolean>((resolve) => {
          Alert.alert(
            t('home.scan.confirmTitle'),
            `${t('home.scan.confirmMessage')}\n\n${t('ocr.privacyNotice')}`,
            [
              { text: t('home.scan.confirmCancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('home.scan.confirmAction'), onPress: () => resolve(true) },
            ]
          );
        });

            if (!confirmResult) {
              setScanning(false);
              return;
            }

        await processReceiptImage(uri);
      } else if (sourceChoice === 'album') {
        // 请求相册权限
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert(t('permissions.libraryDeniedTitle'), t('permissions.libraryDeniedMessage'));
          setScanning(false);
          return;
        }

        // 选择图片（启用多选）
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: 'images',
          quality: 1,
          allowsMultipleSelection: true,
          orderedSelection: true,
        });

        if (result.canceled) {
          setScanning(false);
          return;
        }

        const assets = result.assets || [];
        if (assets.length === 0) {
          setScanning(false);
          Alert.alert(t('home.scan.error'), t('home.scan.noImages'));
          return;
        }

        // 确认识别对话框（包含隐私说明）
        const confirmTitle = assets.length === 1
          ? t('home.scan.confirmTitle')
          : t('home.scan.confirmTitleMultiple', { count: assets.length });
        const confirmMessage = `${t('home.scan.confirmMessage')}\n\n${t('ocr.privacyNotice')}`;
        
        const confirmResult = await new Promise<boolean>((resolve) => {
          Alert.alert(
            confirmTitle,
            confirmMessage,
            [
              { text: t('home.scan.confirmCancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('home.scan.confirmAction'), onPress: () => resolve(true) },
            ]
          );
        });

        if (!confirmResult) {
          setScanning(false);
          return;
        }

        // 处理多张图片（顺序处理）
        if (assets.length === 1) {
          // 单张图片，使用原有流程
          await processReceiptImage(assets[0].uri);
        } else {
          // 多张图片，顺序处理
          await processMultipleReceiptImages(assets.map(a => a.uri));
        }
      }
    } catch (err: any) {
      logger.error('Home', 'Scan error', err);
      
      const errorMessage = err?.message || getScanErrorMessage(err?.code || 'FAILED');
      Alert.alert(t('home.scan.error'), errorMessage);
      setScanning(false);
    }
  };

  // 处理多张收据：逐张识别进审核草稿队列，再进入第一张审核页
  const processMultipleReceiptImages = async (uris: string[]) => {
    const total = uris.length;
    const results: ScanOneResult[] = [];
    const draftIds: string[] = [];

    try {
      await clearScanReviewQueue();
      for (let i = 0; i < uris.length; i++) {
        setProcessingProgress({ current: i + 1, total });
        const result = await runScanPipelineToReview(uris[i]);
        results.push(result);
        if (result.ok && result.kind === 'review') {
          draftIds.push(result.draftId);
        }
        if (!result.ok) {
          logger.error('MultiScan', `image ${i + 1}/${total} failed`, { code: result.code, message: result.message });
        }
      }

      setProcessingProgress(null);

      const { successCount, failCount, failureReasonsByCode } = aggregateBatchScanResults(results);
      const reasonParts = Object.entries(failureReasonsByCode)
        .map(([code, count]) => t('home.scan.failureReasonCount', { label: getScanErrorMessage(code), count }))
        .join('、');
      const reasonsLine = Object.keys(failureReasonsByCode).length > 0
        ? t('home.scan.failureReasonsPrefix') + reasonParts
        : '';
      const summaryMessage = reasonsLine
        ? t('home.scan.doneSummaryWithReasons', { ok: successCount, fail: failCount, reasons: reasonsLine })
        : t('home.scan.doneSummary', { ok: successCount, fail: failCount });

      if (draftIds.length > 0) {
        await setScanReviewQueue(draftIds);
        setScanning(false);
        router.push(`/scan-review/${draftIds[0]}` as any);
        if (failCount > 0) {
          Alert.alert(t('home.scan.partialTitle'), summaryMessage, [{ text: t('easterEgg.ok') || 'OK' }]);
        }
        return;
      }

      await clearScanReviewQueue();
      await loadReceipts();
      Alert.alert(t('home.scan.error'), summaryMessage || getScanErrorMessage('FAILED'));
      setScanning(false);
    } catch (err: any) {
      logger.error('MultiScan', 'Unexpected error', err);
      setProcessingProgress(null);
      Alert.alert(t('home.scan.error'), getScanErrorMessage('FAILED'));
      setScanning(false);
    }
  };

  // 处理单张收据：OCR → 分类 → 审核页（保存、彩蛋、增长分析在审核页完成）
  const processReceiptImage = async (uri: string) => {
    const t0 = Date.now();
    if (__DEV__) {
      console.log('[ScanTiming] ui_start_ms', { t0 });
    }

    const result = await runScanPipelineToReview(uri);
    if (!result.ok) {
      Alert.alert(t('home.scan.error'), getScanErrorMessage(result.code));
      setScanning(false);
      return;
    }

    if (result.kind !== 'review') {
      setScanning(false);
      return;
    }

    await clearScanReviewQueue();
    await setScanReviewQueue([result.draftId]);
    setScanning(false);
    if (__DEV__) {
      console.log('[ScanTiming] navigate_review_ms', { ms: Date.now() - t0 });
    }
    router.push(`/scan-review/${result.draftId}` as any);
  };

  // 只显示前5个类别
  const topCategories = useMemo(() => {
    return categoryData.slice(0, 5);
  }, [categoryData]);

  // Calculate bottom padding for sticky button dynamically
  // stickyHeight is measured via onLayout and includes the container's padding
  // Use fallback height for initial render to prevent overlap before measurement
  const FALLBACK_STICKY_HEIGHT = 88; // Conservative estimate: button (~48) + padding (40)
  const bottomPadding = (stickyHeight || FALLBACK_STICKY_HEIGHT) + 16;

  return (
    <View style={styles.screenContainer}>
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingBottom: bottomPadding },
        ]}
      >
        <Text style={styles.title}>{t('home.title')}</Text>
        <Text style={styles.subtitle}>{t('home.subtitle')}</Text>

        {/* 时间范围选择器 */}
        <View style={styles.timeRangeContainer}>
        <Pressable
          style={[styles.timeRangeButton, timeRange === '7D' && styles.timeRangeButtonSelected]}
          onPress={() => handleTimeRangeChange('7D')}
        >
          <Text
            style={[
              styles.timeRangeButtonText,
              timeRange === '7D' && styles.timeRangeButtonTextSelected,
            ]}
          >
            {t('home.timeRange.7d')}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.timeRangeButton, timeRange === '30D' && styles.timeRangeButtonSelected]}
          onPress={() => handleTimeRangeChange('30D')}
        >
          <Text
            style={[
              styles.timeRangeButtonText,
              timeRange === '30D' && styles.timeRangeButtonTextSelected,
            ]}
          >
            {t('home.timeRange.30d')}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.timeRangeButton, timeRange === 'ALL' && styles.timeRangeButtonSelected]}
          onPress={() => handleTimeRangeChange('ALL')}
        >
          <Text
            style={[
              styles.timeRangeButtonText,
              timeRange === 'ALL' && styles.timeRangeButtonTextSelected,
            ]}
          >
            {t('home.timeRange.all')}
          </Text>
        </Pressable>
      </View>

      {/* KPI Summary Card */}
      {!loadingReceipts && kpiData && (
        <View style={styles.kpiCard}>
          <View style={styles.kpiRow}>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiLabel}>{t('home.kpi.totalSpending')}</Text>
              <Text style={styles.kpiValue}>
                {formatJPY(kpiData.totalSpending)}
              </Text>
            </View>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiLabel}>{t('home.kpi.topCategory')}</Text>
              <Text
                style={styles.kpiValue}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {(() => {
                  const lab = getCategoryShortLabel(kpiData.topCategory);
                  return (lab !== kpiData.topCategory ? lab : t('analysisV2.labels.other')) + ` (${Math.round(kpiData.topCategoryPct)}%)`;
                })()}
              </Text>
            </View>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiLabel}>{t('home.kpi.nonEssential')}</Text>
              <Text style={styles.kpiValue}>{Math.round(kpiData.nonEssentialPct)}%</Text>
            </View>
          </View>
          {uncategorizedSummary.count > 0 && (
            <View style={{ marginTop: 6 }}>
              <Text style={styles.uncategorizedHint}>
                {t('home.kpi.uncategorizedHint', {
                  count: String(uncategorizedSummary.count),
                })}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* 饼图 */}
      {!loadingReceipts && (
        <View style={styles.pieChartContainer}>
          {totalAmount > 0 ? (
            <>
              <PieChart data={categoryData} total={totalAmount} />
              
              {/* 类别列表 - 只显示前5个 */}
              <View style={styles.categoryList}>
                {topCategories.map((item) => {
                  const color = getCategoryColor(item.category);
                  return (
                    <View key={item.category} style={styles.categoryListItem}>
                      <View style={[styles.categoryDot, { backgroundColor: color }]} />
                      <Text style={styles.categoryName}>{getCategoryLabel(item.category)}</Text>
                      <Text style={styles.categoryAmount}>
                        {formatJPY(item.amount)}
                      </Text>
                      <Text style={styles.categoryPercentage}>
                        {Math.round(item.percentage)}%
                      </Text>
                    </View>
                  );
                })}
              </View>

            </>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>{t('home.pieChart.emptyData')}</Text>
            </View>
          )}
        </View>
      )}
      </ScrollView>

      {/* Sticky Scan Button */}
      <View
        style={[styles.stickyButtonContainer, { paddingBottom: insets.bottom + 16 }]}
        onLayout={(e) => setStickyHeight(e.nativeEvent.layout.height)}
      >
        <Pressable
          style={[styles.scanButton, scanning && styles.scanButtonDisabled]}
          onPress={handleScanReceipt}
          disabled={scanning}
        >
          <Text style={styles.scanButtonText}>
            {processingProgress
              ? t('home.scan.processingMulti', {
                  current: processingProgress.current,
                  total: processingProgress.total,
                })
              : scanning
              ? t('home.scan.processing')
              : t('home.scan.button')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
  },
  container: {
    paddingTop: 80,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#555',
  },
  timeRangeContainer: {
    flexDirection: 'row',
    marginTop: 20,
    marginBottom: 10,
    backgroundColor: '#f3f3f3',
    borderRadius: 10,
    padding: 4,
  },
  timeRangeButton: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeRangeButtonSelected: {
    backgroundColor: '#111',
  },
  timeRangeButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#666',
  },
  timeRangeButtonTextSelected: {
    color: '#fff',
  },
  pieChartContainer: {
    marginTop: 30,
    marginBottom: 20,
  },
  categoryList: {
    marginTop: 20,
    paddingHorizontal: 12,
  },
  categoryListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  categoryDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 12,
  },
  categoryName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: '#333',
  },
  categoryAmount: {
    fontSize: 14,
    fontWeight: '800',
    color: '#111',
    marginRight: 12,
    minWidth: 80,
    textAlign: 'right',
  },
  categoryPercentage: {
    fontSize: 14,
    fontWeight: '700',
    color: '#666',
    minWidth: 50,
    textAlign: 'right',
  },
  advancedInsightContainer: {
    marginTop: 20,
    paddingHorizontal: 12,
  },
  advancedInsightRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#f8f8f8',
    borderRadius: 8,
    padding: 12,
  },
  insightBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    flexShrink: 0,
  },
  insightBadgeAlert: {
    backgroundColor: '#ff4444',
  },
  insightBadgeWarn: {
    backgroundColor: '#ff8800',
  },
  insightBadgeInfo: {
    backgroundColor: '#4488ff',
  },
  insightBadgeText: {
    fontSize: 12,
    fontWeight: '900',
    color: '#fff',
  },
  advancedInsightText: {
    flex: 1,
    fontSize: 13,
    color: '#333',
    lineHeight: 18,
  },
  emptyState: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 16,
    color: '#999',
  },
  kpiCard: {
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  kpiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  kpiItem: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  kpiLabel: {
    fontSize: 12,
    color: '#666',
    marginBottom: 4,
    fontWeight: '600',
  },
  kpiValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
  },
  uncategorizedHint: {
    fontSize: 12,
    color: '#666',
  },
  insightAnalysisContainer: {
    marginTop: 20,
    paddingHorizontal: 12,
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  insightHeadline: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
    marginLeft: 8,
  },
  insightReasons: {
    marginBottom: 12,
  },
  insightReasonText: {
    fontSize: 13,
    color: '#555',
    lineHeight: 20,
    marginBottom: 4,
  },
  insightSuggestion: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  insightSuggestionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#333',
    marginBottom: 4,
  },
  insightSuggestionText: {
    fontSize: 14,
    color: '#111',
    fontWeight: '600',
    lineHeight: 20,
  },
  stickyButtonContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 5,
  },
  scanButton: {
    backgroundColor: '#111',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButtonDisabled: {
    opacity: 0.6,
  },
  scanButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});
