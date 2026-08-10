/**
 * 首页 KPI / 分类汇总等计算：饼图用分类聚合、未分类汇总。
 * 与首页展示口径一致，不包含 UI。
 */
import type { ReceiptRow } from './db';
import type { ReceiptAnalysis, ReceiptItem } from './receiptAnalyzer';
import { getReceiptItems } from './receiptItems';
import { filterV1SupportedReceipts } from './merchantType';
import { isGroceryCategory, isExcludedFromAnalytics } from './categories';
import { normalizeProductCategory } from './productCategory';

export type CategoryData = {
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

function filterV1SupportedReceiptRows(receipts: ReceiptRow[]): ReceiptRow[] {
  return filterV1SupportedReceipts(receipts);
}

/**
 * 计算单个商品的“最终展示分类”（与饼图口径一致）：
 * 归一到新一级分类；若分类状态不可接受或仍为 uncategorized，则落到 'uncategorized'。
 */
export function resolveItemFinalCategory(item: ReceiptItem): string {
  const rawCategory = (item as any).category ?? (item as any).categoryKey;
  const category = normalizeProductCategory(
    rawCategory,
    typeof (item as any).name === 'string' ? (item as any).name : undefined
  );
  const rawStatus = (item as any).classification_status as
    | 'ok'
    | 'pending'
    | 'failed'
    | 'fallback'
    | undefined;
  const hasCategory = category !== 'uncategorized';
  const status: 'ok' | 'pending' | 'failed' | 'fallback' =
    rawStatus || (hasCategory ? 'ok' : 'failed');
  const statusAcceptable = status === 'ok' || status === 'fallback';
  return statusAcceptable && hasCategory ? category : 'uncategorized';
}

/**
 * 按分类聚合 V1 支持零售小票（supermarket + convenience）商品金额（饼图数据）。
 */
export function aggregateCategoryData(receipts: ReceiptRow[]): CategoryData[] {
  const supportedReceipts = filterV1SupportedReceiptRows(receipts);
  const categoryMap = new Map<string, number>();

  for (const receipt of supportedReceipts) {
    const items = getReceiptItems(receipt) as ReceiptItem[];
    if (!Array.isArray(items) || items.length === 0) continue;

    let hadAnyLineTotal = false;
    for (const item of items) {
      const lineTotal = typeof item.lineTotal === 'number' ? item.lineTotal : 0;
      if (lineTotal <= 0) continue;
      hadAnyLineTotal = true;

      // 统一归一到新一级分类（饼图含“待分类”分片，不在此排除）。
      const finalCategory = resolveItemFinalCategory(item);

      if (finalCategory !== 'uncategorized' && isExcludedFromAnalytics(finalCategory)) continue;
      if (finalCategory !== 'uncategorized' && !isGroceryCategory(finalCategory)) continue;

      categoryMap.set(finalCategory, (categoryMap.get(finalCategory) ?? 0) + lineTotal);
    }

    // If items exist but no valid lineTotal, still provide a stable fallback bucket
    // so the home "ALL" tab doesn't show empty while history has receipts.
    if (!hadAnyLineTotal && typeof receipt.total === 'number' && receipt.total > 0) {
      categoryMap.set('uncategorized', (categoryMap.get('uncategorized') ?? 0) + receipt.total);
    }
  }

  const total = Array.from(categoryMap.values()).reduce((sum, val) => sum + val, 0);
  return Array.from(categoryMap.entries())
    .map(([category, amount]) => ({
      category,
      amount,
      percentage: total > 0 ? (amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * 待确认（uncategorized）商品条数与金额汇总。
 * 口径：只统计“最终展示分类”为 'uncategorized' 的商品行（与饼图“待分类”分片完全一致）。
 * 不再使用商品总数 / classification_status='fallback' / repeated category 等口径，
 * 避免出现“30 个商品待分类”这类与饼图（约 2%）和成长分析（count=2）矛盾的假象。
 */
export function computeUncategorizedSummary(
  receipts: ReceiptRow[]
): { count: number; total: number } {
  const supportedReceipts = filterV1SupportedReceiptRows(receipts);
  let count = 0;
  let total = 0;

  for (const receipt of supportedReceipts) {
    const items = getReceiptItems(receipt) as ReceiptItem[];
    if (!Array.isArray(items) || items.length === 0) continue;

    for (const item of items) {
      const lineTotal = typeof item.lineTotal === 'number' ? item.lineTotal : 0;
      if (lineTotal <= 0) continue;

      if (resolveItemFinalCategory(item) === 'uncategorized') {
        count += 1;
        total += lineTotal;
      }
    }
  }

  return { count, total };
}

/**
 * 最大支出分类（用于首页“最大支出”指标）。
 * 优先返回占比最大的非“待分类”分类；若全部为待分类则退回第一项；无数据返回 null。
 */
export function computeTopCategory(
  categoryData: CategoryData[]
): { category: string; amount: number; percentage: number } | null {
  if (!Array.isArray(categoryData) || categoryData.length === 0) return null;
  const sorted = [...categoryData].sort((a, b) => b.amount - a.amount);
  const top = sorted.find((c) => c.category !== 'uncategorized') ?? sorted[0];
  return { category: top.category, amount: top.amount, percentage: top.percentage };
}

/**
 * 嗜好消费占比（snacks_drinks）。
 * 仅统计饮料零食，不包含 ready_to_eat（即食餐不属于嗜好消费）。
 */
export function computeIndulgenceShare(categoryData: CategoryData[]): number {
  if (!Array.isArray(categoryData) || categoryData.length === 0) return 0;
  const total = categoryData.reduce((sum, c) => sum + c.amount, 0);
  if (total <= 0) return 0;
  const indulgence = categoryData
    .filter((c) => c.category === 'snacks_drinks')
    .reduce((sum, c) => sum + c.amount, 0);
  return (indulgence / total) * 100;
}
