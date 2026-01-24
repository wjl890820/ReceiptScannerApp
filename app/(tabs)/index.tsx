// app/(tabs)/index.tsx

import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
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

import {
  analyzeReceiptImage,
  type ReceiptAnalysis,
  type ReceiptItem,
} from '@/lib/receiptAnalyzer';
import { pingOcrEdge, probeSupabaseNetwork } from '@/lib/ocrService';

import { listReceipts, saveReceipt, type ReceiptRow } from '@/lib/db';
import { t, getCurrentLocale } from '@/lib/i18n';
import { applyCategoriesWithLearning } from '@/lib/receiptEnricher';
import { isGroceryMerchant } from '@/lib/groceryDetector';
import { isGroceryCategory, isExcludedFromAnalytics } from '@/lib/categories';
import {
  shouldTriggerMilestone,
  hasShownMilestone,
  markMilestoneShown,
  generateEasterEggContent,
  type Milestone,
} from '@/lib/easterEggs';

// ---------- 本地分类（低成本，0 调用 AI）----------
function inferCategory(name: string): string {
  const n = (name || '').toLowerCase();

  if (
    n.includes('お茶') ||
    n.includes('茶') ||
    n.includes('コーヒー') ||
    n.includes('coffee') ||
    n.includes('コーラ') ||
    n.includes('ファンタ') ||
    n.includes('ジュース') ||
    n.includes('drink') ||
    n.includes('水')
  ) {
    return '饮料';
  }

  if (
    n.includes('チョコ') ||
    n.includes('ビス') ||
    n.includes('ビスケット') ||
    n.includes('クッキー') ||
    n.includes('スナック') ||
    n.includes('ナッツ') ||
    n.includes('アイス') ||
    n.includes('デザート') ||
    n.includes('菓子')
  ) {
    return '零食/甜品';
  }

  if (
    n.includes('ロール') ||
    n.includes('パン') ||
    n.includes('ご飯') ||
    n.includes('米') ||
    n.includes('うどん') ||
    n.includes('そば') ||
    n.includes('ラーメン') ||
    n.includes('パスタ') ||
    n.includes('弁当') ||
    n.includes('おにぎり')
  ) {
    return '主食';
  }

  if (
    n.includes('惣菜') ||
    n.includes('天') ||
    n.includes('揚げ') ||
    n.includes('からあげ') ||
    n.includes('唐揚') ||
    n.includes('フライ') ||
    n.includes('コロッケ') ||
    n.includes('とり天') ||
    n.includes('冷凍')
  ) {
    return '冷冻/熟食';
  }

  if (
    n.includes('牛') ||
    n.includes('豚') ||
    n.includes('鶏') ||
    n.includes('とり') ||
    n.includes('魚') ||
    n.includes('刺身') ||
    n.includes('野菜') ||
    n.includes('白菜') ||
    n.includes('ねぎ') ||
    n.includes('えのき') ||
    n.includes('茸') ||
    n.includes('椎茸') ||
    n.includes('きのこ')
  ) {
    return '生鲜';
  }

  if (
    n.includes('みそ') ||
    n.includes('味噌') ||
    n.includes('しょうゆ') ||
    n.includes('醤油') ||
    n.includes('塩') ||
    n.includes('砂糖') ||
    n.includes('酢') ||
    n.includes('だし') ||
    n.includes('スパイス')
  ) {
    return '调味料';
  }

  return '未分类';
}

// 保留applyLocalCategories作为fallback（已迁移到receiptEnricher）
function applyLocalCategories(analysis: ReceiptAnalysis): ReceiptAnalysis {
  const items = Array.isArray(analysis.items) ? analysis.items : [];
  const enrichedItems: ReceiptItem[] = items.map((it: any) => {
    const name = typeof it?.name === 'string' ? it.name : '';
    const category =
      typeof it?.category === 'string' && it.category.trim()
        ? it.category.trim()
        : inferCategory(name);

    return {
      name,
      quantity: typeof it?.quantity === 'number' ? it.quantity : 1,
      unitPrice: typeof it?.unitPrice === 'number' ? it.unitPrice : 0,
      lineTotal: typeof it?.lineTotal === 'number' ? it.lineTotal : 0,
      category,
    } as any;
  });

  return {
    ...analysis,
    items: enrichedItems as any,
  };
}
// ---------- 本地分类结束 ----------

// ====== 饼图相关 ======
const CATEGORIES = [
  '生鲜',
  '主食',
  '冷冻/熟食',
  '零食/甜品',
  '饮料',
  '日用品',
  '外食',
  '未分类',
] as const;

const CATEGORY_COLORS: Record<string, string> = {
  生鲜: '#FF6B6B',
  主食: '#4ECDC4',
  '冷冻/熟食': '#45B7D1',
  '零食/甜品': '#FFA07A',
  饮料: '#98D8C8',
  日用品: '#F7DC6F',
  外食: '#BB8FCE',
  未分类: '#95A5A6',
};

type CategoryData = {
  category: string;
  amount: number;
  percentage: number;
};

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

function aggregateCategoryData(receipts: ReceiptRow[]): CategoryData[] {
  // Filter to grocery receipts only
  const groceryReceipts = receipts.filter((r) => {
    // Use improved grocery detection
    if (isGroceryMerchant(r.merchant_raw || null, r.merchant_normalized || null)) {
      return true;
    }
    // Fallback: check analysis_json for is_grocery flag
    try {
      const analysis = JSON.parse(r.analysis_json || '{}');
      return analysis.is_grocery === true;
    } catch {
      return false;
    }
  });

  const categoryMap = new Map<string, number>();

  for (const receipt of groceryReceipts) {
    let items: ReceiptItem[] | null = null;

    if (receipt.user_items_json) {
      items = safeParseItems(receipt.user_items_json);
    } else {
      const analysis = safeParseAnalysis(receipt.analysis_json);
      items = analysis?.items ?? null;
    }

    if (!items || !Array.isArray(items)) continue;

    for (const item of items) {
      const lineTotal = typeof item.lineTotal === 'number' ? item.lineTotal : 0;
      if (lineTotal <= 0) continue;

      const category =
        (typeof (item as any).category === 'string' && (item as any).category.trim()) || 'uncategorized';
      
      // Only count grocery categories, exclude non_grocery and uncategorized from analytics
      if (isExcludedFromAnalytics(category)) {
        continue;
      }

      // Only count valid grocery categories
      if (!isGroceryCategory(category)) {
        continue;
      }

      categoryMap.set(category, (categoryMap.get(category) ?? 0) + lineTotal);
    }
  }

  const total = Array.from(categoryMap.values()).reduce((sum, val) => sum + val, 0);

  const data: CategoryData[] = Array.from(categoryMap.entries())
    .map(([category, amount]) => ({
      category,
      amount,
      percentage: total > 0 ? (amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return data;
}

// ====== 洞察规则引擎 ======
type InsightLevel = 'info' | 'warn' | 'alert';

type InsightContext = {
  totalSpending: number;
  totalsByCategory: Map<string, number>;
  top1Category: string | null;
  top1Pct: number;
  top2Category: string | null;
  top2Pct: number;
  uncategorizedPct: number;
  nonEssentialPct: number;
  avgReceiptTotal: number;
  maxReceiptTotal: number;
};

type InsightRule = {
  priority: number;
  level: InsightLevel;
  condition: (ctx: InsightContext) => boolean;
  messages: string[];
};

function computeInsightContext(
  receipts: ReceiptRow[],
  categoryData: CategoryData[]
): InsightContext {
  const totalSpending = categoryData.reduce((sum, item) => sum + item.amount, 0);

  const totalsByCategory = new Map<string, number>();
  categoryData.forEach((item) => {
    totalsByCategory.set(item.category, item.amount);
  });

  const top1Category = categoryData.length > 0 ? categoryData[0].category : null;
  const top1Pct = categoryData.length > 0 ? categoryData[0].percentage : 0;
  const top2Category = categoryData.length > 1 ? categoryData[1].category : null;
  const top2Pct = categoryData.length > 1 ? categoryData[1].percentage : 0;

  const uncategorizedAmount = totalsByCategory.get('uncategorized') || 0;
  const uncategorizedPct = totalSpending > 0 ? (uncategorizedAmount / totalSpending) * 100 : 0;

  const nonEssentialCategories = ['snacks', 'non_alcoholic_drinks', 'ready_meals'];
  const nonEssentialAmount = nonEssentialCategories.reduce(
    (sum, cat) => sum + (totalsByCategory.get(cat) || 0),
    0
  );
  const nonEssentialPct = totalSpending > 0 ? (nonEssentialAmount / totalSpending) * 100 : 0;

  const receiptTotals: number[] = [];
  for (const receipt of receipts) {
    let items: ReceiptItem[] | null = null;
    if (receipt.user_items_json) {
      items = safeParseItems(receipt.user_items_json);
    } else {
      const analysis = safeParseAnalysis(receipt.analysis_json);
      items = analysis?.items ?? null;
    }

    if (!items || !Array.isArray(items)) continue;

    const receiptTotal = items.reduce((sum, item) => {
      const lineTotal = typeof item.lineTotal === 'number' ? item.lineTotal : 0;
      return sum + (lineTotal > 0 ? lineTotal : 0);
    }, 0);

    if (receiptTotal > 0) {
      receiptTotals.push(receiptTotal);
    }
  }

  const avgReceiptTotal =
    receiptTotals.length > 0
      ? receiptTotals.reduce((sum, val) => sum + val, 0) / receiptTotals.length
      : 0;
  const maxReceiptTotal = receiptTotals.length > 0 ? Math.max(...receiptTotals) : 0;

  return {
    totalSpending,
    totalsByCategory,
    top1Category,
    top1Pct,
    top2Category,
    top2Pct,
    uncategorizedPct,
    nonEssentialPct,
    avgReceiptTotal,
    maxReceiptTotal,
  };
}

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
      (ctx) =>
        `消费高度集中在【${ctx.top1Category}】（${Math.round(ctx.top1Pct)}%），建议分散支出。`,
      (ctx) =>
        `【${ctx.top1Category}】占比过高（${Math.round(ctx.top1Pct)}%），消费结构需要优化。`,
      (ctx) =>
        `超过六成支出用于【${ctx.top1Category}】（${Math.round(ctx.top1Pct)}%），建议平衡消费。`,
    ],
  },
  {
    priority: 90,
    level: 'warn',
    condition: (ctx) => ctx.top1Pct >= 50,
    messages: [
      (ctx) =>
        `【${ctx.top1Category}】占比较高（${Math.round(ctx.top1Pct)}%），注意消费平衡。`,
      (ctx) =>
        `消费主要集中在【${ctx.top1Category}】（${Math.round(ctx.top1Pct)}%），建议多样化。`,
      (ctx) =>
        `【${ctx.top1Category}】支出占比达${Math.round(ctx.top1Pct)}%，可考虑分散。`,
    ],
  },
  {
    priority: 85,
    level: 'warn',
    condition: (ctx) => ctx.top1Pct + ctx.top2Pct >= 80,
    messages: [
      (ctx) =>
        `前两大类别【${ctx.top1Category}】和【${ctx.top2Category}】合计占比${Math.round(ctx.top1Pct + ctx.top2Pct)}%，消费较为集中。`,
      (ctx) =>
        `【${ctx.top1Category}】和【${ctx.top2Category}】共占${Math.round(ctx.top1Pct + ctx.top2Pct)}%，建议增加其他类别支出。`,
      (ctx) =>
        `消费集中在【${ctx.top1Category}】和【${ctx.top2Category}】（合计${Math.round(ctx.top1Pct + ctx.top2Pct)}%），可适当分散。`,
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
        `存在单笔大额消费（${Math.round(ctx.maxReceiptTotal)} JPY），是平均值的${Math.round((ctx.maxReceiptTotal / ctx.avgReceiptTotal) * 10) / 10}倍。`,
      (ctx) =>
        `最大单笔消费${Math.round(ctx.maxReceiptTotal)} JPY，显著高于平均值${Math.round(ctx.avgReceiptTotal)} JPY。`,
      (ctx) =>
        `单笔最大支出${Math.round(ctx.maxReceiptTotal)} JPY，远超平均${Math.round(ctx.avgReceiptTotal)} JPY。`,
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

  const currentReceipts = receipts.filter((r) => r.created_at >= currentStart);
  const previousReceipts = receipts.filter(
    (r) => r.created_at >= previousStart && r.created_at < previousEnd
  );

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

  const sortedRules = [...INSIGHT_RULES].sort((a, b) => b.priority - a.priority);
  const matchedRule = sortedRules.find((rule) => rule.condition(context));

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
          const color = CATEGORY_COLORS[item.category] || CATEGORY_COLORS['未分类'];
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
  const [timeRange, setTimeRange] = useState<TimeRange>('ALL');
  const [scanning, setScanning] = useState(false);
  const successAlertShownRef = useRef(false); // Guard for duplicate success alerts
  const [stickyHeight, setStickyHeight] = useState(0);

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

  // 根据时间范围过滤收据
  const filteredReceipts = useMemo(() => {
    if (timeRange === 'ALL') {
      return receipts;
    }

    const now = Date.now();
    const days = timeRange === '7D' ? 7 : 30;
    const cutoffTime = now - days * 24 * 60 * 60 * 1000;

    return receipts.filter((receipt) => receipt.created_at >= cutoffTime);
  }, [receipts, timeRange]);

  // 聚合类别数据
  const categoryData = useMemo(() => {
    return aggregateCategoryData(filteredReceipts);
  }, [filteredReceipts]);

  const totalAmount = useMemo(() => {
    return categoryData.reduce((sum, item) => sum + item.amount, 0);
  }, [categoryData]);

  // Compute insight context
  const insightContext = useMemo(() => {
    return computeInsightContext(filteredReceipts, categoryData);
  }, [filteredReceipts, categoryData]);

  // Period-over-period comparison
  const periodComparison = useMemo(() => {
    return computePeriodComparison(receipts, timeRange);
  }, [receipts, timeRange]);

  // Generate structured insight
  const structuredInsight = useMemo(() => {
    return generateStructuredInsight(insightContext, periodComparison);
  }, [insightContext, periodComparison]);

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
          t('scan.title'),
          '',
          [
            { text: t('scan.cancel'), style: 'cancel', onPress: () => resolve('cancel') },
            { text: t('scan.takePhoto'), onPress: () => resolve('camera') },
            { text: t('scan.chooseFromLibrary'), onPress: () => resolve('album') },
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
            t('scan.confirmTitle'),
            `${t('scan.confirmMessage')}\n\n${t('ocr.privacyNotice')}`,
            [
              { text: t('scan.confirmCancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('scan.confirmAction'), onPress: () => resolve(true) },
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

        // 选择图片
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: 'images',
          quality: 1,
        });

        if (result.canceled) {
          setScanning(false);
          return;
        }

        const uri = result.assets[0]?.uri;
        if (!uri) {
          setScanning(false);
          return;
        }

        // 确认识别对话框（包含隐私说明）
        const confirmResult = await new Promise<boolean>((resolve) => {
          Alert.alert(
            t('scan.confirmTitle'),
            `${t('scan.confirmMessage')}\n\n${t('ocr.privacyNotice')}`,
            [
              { text: t('scan.confirmCancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('scan.confirmAction'), onPress: () => resolve(true) },
            ]
          );
        });

        if (!confirmResult) {
          setScanning(false);
          return;
        }

        await processReceiptImage(uri);
      }
    } catch (err: any) {
      console.error('Scan error:', err);
      
      // Handle specific OCR error codes
      let errorMessage = t('ocr.failed');
      if (err?.code === 'RATE_LIMIT') {
        errorMessage = t('ocr.rateLimit');
      } else if (err?.code === 'PAYLOAD_TOO_LARGE') {
        errorMessage = t('ocr.payloadTooLarge');
      } else if (err?.code === 'NETWORK_ERROR') {
        errorMessage = t('ocr.networkError');
      } else if (err?.code === 'SERVER_ERROR') {
        errorMessage = t('ocr.serverError');
      } else if (err?.message) {
        errorMessage = err.message;
      }
      
      Alert.alert(t('home.scan.error'), errorMessage);
      setScanning(false);
    }
  };

  // 处理收据图片（提取为独立函数，避免重复代码）
  const processReceiptImage = async (uri: string) => {
    // Reset guard at start of new scan
    successAlertShownRef.current = false;

    try {
      // 分析小票
      const raw = await analyzeReceiptImage(uri);
      const enriched = await applyCategoriesWithLearning(raw);

      // 保存到历史
      await saveReceipt({
        imageUri: uri,
        analysis: enriched,
      });

      // 刷新数据
      await loadReceipts();

      // 检查复活节彩蛋
      const allReceipts = await listReceipts();
      const receiptCount = allReceipts.length;
      const locale = getCurrentLocale();

      const milestones: Milestone[] = [3, 5, 7, 10];
      for (const milestone of milestones) {
        if (shouldTriggerMilestone(receiptCount, milestone)) {
          const hasShown = await hasShownMilestone(milestone);
          if (!hasShown) {
            const content = generateEasterEggContent(milestone, allReceipts, locale);
            await markMilestoneShown(milestone);

            // 显示复活节彩蛋（这会显示一个 Alert）
            // 使用 Promise 等待用户关闭彩蛋
            await new Promise<void>((resolve) => {
              Alert.alert(
                content.title,
                content.bullets.join('\n\n') + (content.cta ? `\n\n${content.cta}` : ''),
                [
                  {
                    text: t('easterEgg.ok'),
                    style: 'default',
                    onPress: () => resolve(),
                  },
                ]
              );
            });
            // 复活节彩蛋关闭后，显示成功提示
            if (!successAlertShownRef.current) {
              successAlertShownRef.current = true;
              Alert.alert(t('home.scan.success'), t('home.scan.successMessage'));
            }
            setScanning(false);
            return;
          }
        }
      }

      // 如果没有显示复活节彩蛋，直接显示成功提示
      if (!successAlertShownRef.current) {
        successAlertShownRef.current = true;
        Alert.alert(t('home.scan.success'), t('home.scan.successMessage'));
      }
      
      setScanning(false);
    } catch (err: any) {
      console.error('Process receipt image error:', err);
      setScanning(false);
      // 错误已在主流程中处理，这里不需要重复显示
    }
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
          onPress={() => setTimeRange('7D')}
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
          onPress={() => setTimeRange('30D')}
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
          onPress={() => setTimeRange('ALL')}
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
                {Math.round(kpiData.totalSpending)} {t('home.kpi.currency')}
              </Text>
            </View>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiLabel}>{t('home.kpi.topCategory')}</Text>
              <Text style={styles.kpiValue}>
                {kpiData.topCategory} ({Math.round(kpiData.topCategoryPct)}%)
              </Text>
            </View>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiLabel}>{t('home.kpi.nonEssential')}</Text>
              <Text style={styles.kpiValue}>{Math.round(kpiData.nonEssentialPct)}%</Text>
            </View>
          </View>
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
                  const color = CATEGORY_COLORS[item.category] || CATEGORY_COLORS['未分类'];
                  return (
                    <View key={item.category} style={styles.categoryListItem}>
                      <View style={[styles.categoryDot, { backgroundColor: color }]} />
                      <Text style={styles.categoryName}>{item.category}</Text>
                      <Text style={styles.categoryAmount}>
                        {Math.round(item.amount)} JPY
                      </Text>
                      <Text style={styles.categoryPercentage}>
                        {Math.round(item.percentage)}%
                      </Text>
                    </View>
                  );
                })}
              </View>

              {/* Structured Insight Analysis */}
              {structuredInsight && (
                <View style={styles.insightAnalysisContainer}>
                  <View style={styles.insightHeader}>
                    {structuredInsight.level === 'alert' && (
                      <View style={[styles.insightBadge, styles.insightBadgeAlert]}>
                        <Text style={styles.insightBadgeText}>⚠</Text>
                      </View>
                    )}
                    {structuredInsight.level === 'warn' && (
                      <View style={[styles.insightBadge, styles.insightBadgeWarn]}>
                        <Text style={styles.insightBadgeText}>!</Text>
                      </View>
                    )}
                    {structuredInsight.level === 'info' && (
                      <View style={[styles.insightBadge, styles.insightBadgeInfo]}>
                        <Text style={styles.insightBadgeText}>i</Text>
                      </View>
                    )}
                    <Text style={styles.insightHeadline}>{structuredInsight.headline}</Text>
                  </View>
                  <View style={styles.insightReasons}>
                    {structuredInsight.reasons.map((reason, idx) => (
                      <Text key={idx} style={styles.insightReasonText}>
                        • {reason}
                      </Text>
                    ))}
                  </View>
                  <View style={styles.insightSuggestion}>
                    <Text style={styles.insightSuggestionLabel}>
                      {t('home.insight.suggestion.label')}:
                    </Text>
                    <Text style={styles.insightSuggestionText}>
                      {structuredInsight.suggestion}
                    </Text>
                  </View>
                </View>
              )}
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
            {scanning ? t('home.scan.processing') : t('home.scan.button')}
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
