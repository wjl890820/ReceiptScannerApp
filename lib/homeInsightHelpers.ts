/**
 * 首页洞察相关的上下文与规则选择（不包含 JSX 与 i18n）。
 */
import type { ReceiptRow } from './db';
import type { CategoryData } from './homeMetricsHelpers';
import { getCategoryLabel } from './categoryPalette';
import { formatJPY } from './formatJPY';
import type { ReceiptAnalysis, ReceiptItem } from './receiptAnalyzer';

export type InsightLevel = 'info' | 'warn' | 'alert';

export type InsightContext = {
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

export type InsightRuleWithMessages = {
  priority: number;
  level: InsightLevel;
  condition: (ctx: InsightContext) => boolean;
  messages: ((ctx: InsightContext) => string)[];
};

export type StructuredInsightCore = {
  level: InsightLevel;
  rule: InsightRuleWithMessages;
};

export function computeInsightContext(
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
  const uncategorizedPct =
    totalSpending > 0 ? (uncategorizedAmount / totalSpending) * 100 : 0;

  const nonEssentialCategories = ['snacks', 'non_alcoholic_drinks', 'ready_meals'];
  const nonEssentialAmount = nonEssentialCategories.reduce(
    (sum, cat) => sum + (totalsByCategory.get(cat) || 0),
    0
  );
  const nonEssentialPct =
    totalSpending > 0 ? (nonEssentialAmount / totalSpending) * 100 : 0;

  const safeParseItems = (json: string | null): ReceiptItem[] | null => {
    if (!json) return null;
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) return null;
      return arr;
    } catch {
      return null;
    }
  };

  const safeParseAnalysis = (json: string | null): ReceiptAnalysis | null => {
    if (!json) return null;
    try {
      const obj = JSON.parse(json);
      if (!obj || typeof obj !== 'object') return null;
      return obj as ReceiptAnalysis;
    } catch {
      return null;
    }
  };

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

export const INSIGHT_RULES: InsightRuleWithMessages[] = [
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
        return `前两大类别【${label1}】和【${label2}】合计占比${Math.round(
          ctx.top1Pct + ctx.top2Pct
        )}% ，消费较为集中。`;
      },
      (ctx) => {
        const label1 = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        const label2 = ctx.top2Category ? getCategoryLabel(ctx.top2Category) : '';
        return `【${label1}】和【${label2}】共占${Math.round(
          ctx.top1Pct + ctx.top2Pct
        )}% ，建议增加其他类别支出。`;
      },
      (ctx) => {
        const label1 = ctx.top1Category ? getCategoryLabel(ctx.top1Category) : '';
        const label2 = ctx.top2Category ? getCategoryLabel(ctx.top2Category) : '';
        return `消费集中在【${label1}】和【${label2}】（合计${Math.round(
          ctx.top1Pct + ctx.top2Pct
        )}%），可适当分散。`;
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
        `存在单笔大额消费（${formatJPY(ctx.maxReceiptTotal)}），是平均值的${Math.round(
          (ctx.maxReceiptTotal / ctx.avgReceiptTotal) * 10
        ) / 10}倍。`,
      (ctx) =>
        `最大单笔消费${formatJPY(ctx.maxReceiptTotal)}，显著高于平均值${formatJPY(
          ctx.avgReceiptTotal
        )}。`,
      (ctx) =>
        `单笔最大支出${formatJPY(ctx.maxReceiptTotal)}，远超平均${formatJPY(
          ctx.avgReceiptTotal
        )}。`,
    ],
  },
];

export function pickInsightRule(context: InsightContext): InsightRuleWithMessages | null {
  const sortedRules = [...INSIGHT_RULES].sort((a, b) => b.priority - a.priority);
  return sortedRules.find((rule) => rule.condition(context)) ?? null;
}

export type PeriodComparison = {
  category: string;
  change: number;
  from: number;
  to: number;
} | null;

export type HomeInsightPayload = {
  headline: { key: string; params?: Record<string, string> };
  reasons: Array<{ key: string; params?: Record<string, string> }>;
  suggestion: { key: string };
};

/**
 * 构建“洞察结构（不做 i18n 拼接）”
 * - 选择规则与所有纯计算都在这里完成
 * - 不调用 t()，页面层负责根据 key/params 拼 headline/reasons/suggestion
 */
export function buildHomeInsight(
  context: InsightContext,
  periodComparison: PeriodComparison
): { level: InsightLevel; code: number; payload: HomeInsightPayload } | null {
  if (context.totalSpending === 0) return null;

  const matchedRule = pickInsightRule(context);
  if (!matchedRule) return null;

  const concentration = context.top1Pct + context.top2Pct;
  const reasons: HomeInsightPayload['reasons'] = [];

  // Build quantified reasons (order must match page)
  if (context.top1Pct >= 50) {
    reasons.push({
      key: 'home.insight.reason.top1',
      params: {
        category: context.top1Category || '',
        percentage: String(Math.round(context.top1Pct)),
      },
    });
  }

  if (concentration >= 80) {
    reasons.push({
      key: 'home.insight.reason.concentration',
      params: { percentage: String(Math.round(concentration)) },
    });
  }

  if (context.nonEssentialPct >= 35) {
    reasons.push({
      key: 'home.insight.reason.nonEssential',
      params: { percentage: String(Math.round(context.nonEssentialPct)) },
    });
  }

  if (context.uncategorizedPct >= 20) {
    reasons.push({
      key: 'home.insight.reason.uncategorized',
      params: { percentage: String(Math.round(context.uncategorizedPct)) },
    });
  }

  if (periodComparison && Math.abs(periodComparison.change) > 2) {
    const changeAbs = String(Math.round(Math.abs(periodComparison.change)));
    if (periodComparison.change > 0) {
      reasons.push({
        key: 'home.insight.comparison.increased',
        params: {
          category: periodComparison.category,
          change: changeAbs,
          from: String(Math.round(periodComparison.from)),
          to: String(Math.round(periodComparison.to)),
        },
      });
    } else {
      reasons.push({
        key: 'home.insight.comparison.decreased',
        params: {
          category: periodComparison.category,
          change: changeAbs,
          from: String(Math.round(periodComparison.from)),
          to: String(Math.round(periodComparison.to)),
        },
      });
    }
  }

  // Headline based on concentration
  let headline: HomeInsightPayload['headline'];
  if (concentration >= 80) {
    headline = {
      key: 'home.insight.headline.highConcentration',
      params: { percentage: String(Math.round(concentration)) },
    };
  } else if (concentration >= 60) {
    headline = {
      key: 'home.insight.headline.moderateConcentration',
      params: { percentage: String(Math.round(concentration)) },
    };
  } else {
    headline = { key: 'home.insight.headline.balanced' };
  }

  // Suggestion based on matched rule level
  let suggestionKey = '';
  if (matchedRule.level === 'alert') {
    if (context.top1Pct >= 60) suggestionKey = 'home.insight.suggestion.diversify';
    else if (context.nonEssentialPct >= 45)
      suggestionKey = 'home.insight.suggestion.controlNonEssential';
    else if (context.uncategorizedPct >= 35)
      suggestionKey = 'home.insight.suggestion.improveCategories';
  } else if (matchedRule.level === 'warn') {
    suggestionKey = 'home.insight.suggestion.monitor';
  } else {
    suggestionKey = 'home.insight.suggestion.maintain';
  }

  return {
    level: matchedRule.level,
    code: matchedRule.priority,
    payload: {
      headline,
      reasons,
      suggestion: { key: suggestionKey },
    },
  };
}
