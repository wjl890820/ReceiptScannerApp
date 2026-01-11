// app/(tabs)/index.tsx

import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Path, Text as SvgText, TSpan } from 'react-native-svg';

import {
  analyzeReceiptImage,
  type ReceiptAnalysis,
  type ReceiptItem,
} from '@/lib/receiptAnalyzer';

import { listReceipts, saveReceipt, type ReceiptRow } from '@/lib/db';
import { t } from '@/lib/i18n';

// ---------- 本地分类（低成本，0 调用 AI）----------
// 规则：如果 item.category 已经存在就保留；否则根据商品名做简单归类。
// 你现在 Home 里能分类，说明你项目里可能已经有分类逻辑；
// 这份逻辑的核心作用是：确保“分类字段最终写入 analysis.items[].category”，从而保存进历史。
function inferCategory(name: string): string {
  const n = (name || '').toLowerCase();

  // 饮料
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

  // 零食/甜品
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

  // 主食（面包/米/面/便当）
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

  // 冷冻/熟食（惣菜、天ぷら、揚げ物等）
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

  // 生鲜（肉/鱼/蔬菜/菌菇）
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

  // 调味料
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
      category, // 关键：把分类字段写进 items
    } as any;
  });

  return {
    ...analysis,
    items: enrichedItems as any,
  };
}

function buildCategoryTotals(items: any[]) {
  const map = new Map<string, number>();

  for (const it of items) {
    const cat = (it?.category || '未分类').trim() || '未分类';
    const amt =
      typeof it?.lineTotal === 'number'
        ? it.lineTotal
        : typeof it?.unitPrice === 'number' && typeof it?.quantity === 'number'
          ? it.unitPrice * it.quantity
          : 0;

    map.set(cat, (map.get(cat) ?? 0) + (Number.isFinite(amt) ? amt : 0));
  }

  const arr = Array.from(map.entries()).map(([category, total]) => ({
    category,
    total,
  }));
  arr.sort((a, b) => b.total - a.total);
  return arr;
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
  const categoryMap = new Map<string, number>();

  for (const receipt of receipts) {
    let items: ReceiptItem[] | null = null;

    // 优先使用 user_items_json，否则使用 analysis_json
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
        (typeof (item as any).category === 'string' && (item as any).category.trim()) || '未分类';
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
  priority: number; // 越高越优先
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

  const uncategorizedAmount = totalsByCategory.get('未分类') || 0;
  const uncategorizedPct = totalSpending > 0 ? (uncategorizedAmount / totalSpending) * 100 : 0;

  const nonEssentialCategories = ['零食/甜品', '饮料', '外食'];
  const nonEssentialAmount = nonEssentialCategories.reduce(
    (sum, cat) => sum + (totalsByCategory.get(cat) || 0),
    0
  );
  const nonEssentialPct = totalSpending > 0 ? (nonEssentialAmount / totalSpending) * 100 : 0;

  // 计算收据级别的统计
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

function generateInsight(context: InsightContext): { message: string; level: InsightLevel } | null {
  if (context.totalSpending === 0) {
    return null;
  }

  // 按优先级降序排序，找到第一个匹配的规则（最高优先级）
  const sortedRules = [...INSIGHT_RULES].sort((a, b) => b.priority - a.priority);
  const matchedRule = sortedRules.find((rule) => rule.condition(context));

  if (!matchedRule) {
    return null;
  }

  // 随机选择一个消息模板（使用稳定的随机数，基于总金额）
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
  let currentAngle = -90; // 从顶部开始

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

  // 过滤掉百分比为0的数据
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
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ReceiptAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>('ALL');

  // 是否已保存（防止重复保存）
  const [savedId, setSavedId] = useState<string | null>(null);
  const canSave = useMemo(
    () => !!imageUri && !!analysis && !savedId,
    [imageUri, analysis, savedId]
  );

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

  // 当保存成功后刷新收据列表
  useEffect(() => {
    if (savedId) {
      loadReceipts();
    }
  }, [savedId, loadReceipts]);

  // 当屏幕获得焦点时刷新数据（例如从 History 删除收据后返回）
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

  // 生成基础洞察文本
  const insightText = useMemo(() => {
    if (totalAmount === 0) {
      return t('home.insight.noData');
    }

    if (categoryData.length === 0) {
      return t('home.insight.noData');
    }

    const topCategory = categoryData[0];
    const percentage = Math.round(topCategory.percentage);
    let text = t('home.insight.mainCategory', {
      category: topCategory.category,
      percentage: String(percentage),
    });

    if (topCategory.percentage >= 60) {
      text += t('home.insight.structureConcentrated');
    }

    return text;
  }, [categoryData, totalAmount]);

  // 生成高级洞察（规则引擎）
  const advancedInsight = useMemo(() => {
    const context = computeInsightContext(filteredReceipts, categoryData);
    return generateInsight(context);
  }, [filteredReceipts, categoryData]);

  const itemsForUI = useMemo(() => {
    const items = analysis?.items;
    return Array.isArray(items) ? (items as any[]) : [];
  }, [analysis]);

  const categoryTotals = useMemo(() => {
    return buildCategoryTotals(itemsForUI);
  }, [itemsForUI]);

  // 选择相册里的小票图片
  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('权限被拒绝', '请在系统设置中允许本应用访问相册。');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      // 你日志提示 MediaTypeOptions deprecated，这个先不动也能用
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });

    if (!result.canceled) {
      const uri = result.assets[0]?.uri;
      if (uri) {
        setImageUri(uri);
        setAnalysis(null);
        setSavedId(null);
      }
    }
  };

  // 调用 Gemini 识别（识别后：把分类写回 analysis，再展示/再保存）
  const handleAnalyze = async () => {
    if (!imageUri) {
      Alert.alert('提示', '请先选择一张小票照片。');
      return;
    }

    try {
      setLoading(true);
      const raw = await analyzeReceiptImage(imageUri);

      // 关键：把分类字段写进 analysis.items[].category
      const enriched = applyLocalCategories(raw);

      setAnalysis(enriched);
      setSavedId(null);
    } catch (err: any) {
      console.error(err);
      Alert.alert('识别失败', err?.message ?? '请稍后重试。');
    } finally {
      setLoading(false);
    }
  };

  // 手动保存：保存“带分类字段”的 analysis（这样历史才不会全是未分类）
  const handleSave = async () => {
    if (!imageUri || !analysis) return;

    try {
      const id = await saveReceipt({
        imageUri,
        analysis, // 这里的 analysis 已经是 enriched 过的
      });

      setSavedId(id);
      await loadReceipts(); // 刷新收据列表以更新饼图
      Alert.alert('已保存', '这条记录已保存到历史。');
    } catch (e: any) {
      console.error(e);
      Alert.alert('保存失败', e?.message ?? '请重试');
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
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

      {/* 饼图 */}
      {!loadingReceipts && (
        <View style={styles.pieChartContainer}>
          {totalAmount > 0 ? (
            <>
              <PieChart data={categoryData} total={totalAmount} />
              <View style={styles.categoryList}>
                {categoryData.map((item) => {
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
              <Text style={styles.insightText}>{insightText}</Text>
              {advancedInsight && (
                <View style={styles.advancedInsightContainer}>
                  <View style={styles.advancedInsightRow}>
                    {advancedInsight.level === 'alert' && (
                      <View style={[styles.insightBadge, styles.insightBadgeAlert]}>
                        <Text style={styles.insightBadgeText}>⚠</Text>
                      </View>
                    )}
                    {advancedInsight.level === 'warn' && (
                      <View style={[styles.insightBadge, styles.insightBadgeWarn]}>
                        <Text style={styles.insightBadgeText}>!</Text>
                      </View>
                    )}
                    {advancedInsight.level === 'info' && (
                      <View style={[styles.insightBadge, styles.insightBadgeInfo]}>
                        <Text style={styles.insightBadgeText}>i</Text>
                      </View>
                    )}
                    <Text style={styles.advancedInsightText}>{advancedInsight.message}</Text>
                  </View>
                </View>
              )}
            </>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>{t('home.pieChart.emptyData')}</Text>
            </View>
          )}

          {/* 高级洞察 Pro 入口点 - 始终显示 */}
          <Pressable
            style={styles.proEntryCard}
            onPress={() => router.push('/(tabs)/pro-insight')}
          >
            <View style={styles.proEntryContent}>
              <Text style={styles.proEntryTitle}>{t('home.pro.title')}</Text>
              <Text style={styles.proEntrySubtitle}>
                {totalAmount <= 0
                  ? t('home.pro.subtitleNoData')
                  : t('home.pro.subtitleWithData')}
              </Text>
            </View>
            <Text style={styles.proEntryArrow}>→</Text>
          </Pressable>
        </View>
      )}

      <View style={{ marginTop: 40 }}>
        <Button title="从相册选择照片" onPress={handlePickImage} />
      </View>

      {imageUri && (
        <View style={styles.imageWrapper}>
          <Image source={{ uri: imageUri }} style={styles.receiptImage} />
        </View>
      )}

      {imageUri && (
        <View style={{ marginTop: 20 }}>
          <Button
            title={loading ? '识别中…' : '识别小票（调用 Gemini）'}
            onPress={handleAnalyze}
            disabled={loading}
          />
        </View>
      )}

      {analysis && (
        <View style={styles.resultContainer}>
          <Text style={styles.sectionTitle}>识别结果：</Text>

          {analysis.merchant ? (
            <Text style={styles.resultText}>商店：{analysis.merchant}</Text>
          ) : null}

          <Text style={styles.resultText}>
            总金额：{analysis.total} {analysis.currency}
          </Text>
          <Text style={styles.resultText}>税额：{analysis.tax}</Text>

          <View style={{ marginTop: 14 }}>
            <Button
              title={savedId ? '已保存到历史' : '保存到历史'}
              onPress={handleSave}
              disabled={!canSave}
            />
          </View>

          {/* 分类汇总 */}
          <Text style={[styles.sectionTitle, { marginTop: 18 }]}>分类汇总：</Text>
          <View style={styles.catCard}>
            {categoryTotals.length === 0 ? (
              <Text style={styles.resultText}>暂无分类数据</Text>
            ) : (
              categoryTotals.map((c) => (
                <View key={c.category} style={styles.catRow}>
                  <Text style={styles.catName}>{c.category}</Text>
                  <Text style={styles.catValue}>
                    {Math.round(c.total)} {analysis.currency}
                  </Text>
                </View>
              ))
            )}
          </View>

          {/* 商品明细：右侧分类标签 */}
          <Text style={[styles.sectionTitle, { marginTop: 18 }]}>商品明细：</Text>

          {(!analysis.items || analysis.items.length === 0) && (
            <Text style={styles.resultText}>未识别到商品。</Text>
          )}

          {itemsForUI.map((item: any, index: number) => (
            <View key={index} style={styles.itemRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemDetail}>
                  数量: {item.quantity}   单价: {item.unitPrice}   小计: {item.lineTotal}
                </Text>
              </View>

              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.category || '未分类'}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
  imageWrapper: {
    marginTop: 20,
    alignItems: 'center',
  },
  receiptImage: {
    width: 260,
    height: 360,
    resizeMode: 'contain',
    borderRadius: 8,
    backgroundColor: '#eee',
  },
  resultContainer: {
    marginTop: 30,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 10,
  },
  resultText: {
    fontSize: 15,
    marginBottom: 6,
  },
  catCard: {
    backgroundColor: '#f3f3f3',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  catRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  catName: {
    fontSize: 15,
    fontWeight: '700',
  },
  catValue: {
    fontSize: 15,
    fontWeight: '800',
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  itemName: {
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 3,
  },
  itemDetail: {
    fontSize: 13,
    color: '#555',
  },
  badge: {
    minWidth: 64,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#ececec',
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  badgeText: {
    fontSize: 12,
    color: '#444',
    fontWeight: '700',
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
  insightText: {
    marginTop: 20,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#555',
    lineHeight: 20,
    textAlign: 'center',
  },
  advancedInsightContainer: {
    marginTop: 12,
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
  proEntryCard: {
    marginTop: 20,
    marginHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  proEntryContent: {
    flex: 1,
  },
  proEntryTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
    marginBottom: 4,
  },
  proEntrySubtitle: {
    fontSize: 13,
    color: '#666',
    lineHeight: 18,
  },
  proEntryArrow: {
    fontSize: 20,
    color: '#999',
    marginLeft: 12,
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
});
