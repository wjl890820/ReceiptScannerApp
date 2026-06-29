/**
 * 首页 KPI / 分类汇总等计算：饼图用分类聚合、未分类汇总。
 * 与首页展示口径一致，不包含 UI。
 */
import type { ReceiptRow } from './db';
import type { ReceiptAnalysis, ReceiptItem } from './receiptAnalyzer';
import { isGroceryMerchant } from './groceryDetector';
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

function filterGroceryReceipts(receipts: ReceiptRow[]): ReceiptRow[] {
  return receipts.filter((r) => {
    if (isGroceryMerchant(r.merchant_raw || null, r.merchant_normalized || null)) return true;
    try {
      const analysis = JSON.parse(r.analysis_json || '{}');
      return analysis.is_grocery === true;
    } catch {
      return false;
    }
  });
}

/**
 * 按分类聚合生鲜收据商品金额（饼图数据）；仅统计分类成功且为 grocery 类别的行。
 */
export function aggregateCategoryData(receipts: ReceiptRow[]): CategoryData[] {
  const groceryReceipts = filterGroceryReceipts(receipts);
  const categoryMap = new Map<string, number>();

  for (const receipt of groceryReceipts) {
    const items = receipt.user_items_json
      ? safeParseItems(receipt.user_items_json)
      : safeParseAnalysis(receipt.analysis_json)?.items ?? null;
    if (!items || !Array.isArray(items)) continue;

    let hadAnyLineTotal = false;
    for (const item of items) {
      const lineTotal = typeof item.lineTotal === 'number' ? item.lineTotal : 0;
      if (lineTotal <= 0) continue;
      hadAnyLineTotal = true;

      // 统一归一到新一级分类，避免新旧 enum 在饼图里产生同义重复分片。
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

      // Homepage "ALL" should not become empty just because categories are missing.
      // - If classification not ok / missing category -> bucket as 'uncategorized'
      // - Allow 'uncategorized' bucket in home pie chart (do not exclude it here)
      const statusAcceptable = status === 'ok' || status === 'fallback';
      const finalCategory = statusAcceptable && hasCategory ? category : 'uncategorized';

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
 * 未分类商品条数与金额汇总（与 aggregateCategoryData 口径一致：非 ok/非 grocery 类别计入未分类）。
 */
export function computeUncategorizedSummary(
  receipts: ReceiptRow[]
): { count: number; total: number } {
  const groceryReceipts = filterGroceryReceipts(receipts);
  let count = 0;
  let total = 0;

  for (const receipt of groceryReceipts) {
    const items = receipt.user_items_json
      ? safeParseItems(receipt.user_items_json)
      : safeParseAnalysis(receipt.analysis_json)?.items ?? null;
    if (!items || !Array.isArray(items)) continue;

    for (const item of items) {
      const lineTotal = typeof item.lineTotal === 'number' ? item.lineTotal : 0;
      if (lineTotal <= 0) continue;

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

      if (
        status !== 'ok' ||
        !hasCategory ||
        isExcludedFromAnalytics(category) ||
        !isGroceryCategory(category)
      ) {
        count += 1;
        total += lineTotal;
      }
    }
  }

  return { count, total };
}
