// lib/statsCalculator.ts
import type { ReceiptItem } from './receiptAnalyzer';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { getReceiptItems } from './receiptItems';
import { merchantAnalyticsKey } from './merchantAnalytics';
import { isGroceryCategory, isExcludedFromAnalytics } from './categories';
import { isGroceryMerchant } from './groceryDetector';
import { isV1SupportedReceipt } from './merchantType';
import { resolveItemFinalCategory } from './homeMetricsHelpers';
import type { ReceiptRow } from './db';
import { filterAnalysisReceiptsByTimeRange } from './analysisPeriod';

export type TimeRange = 'week' | 'month' | 'all';

export type WeeklyMonthlyStats = {
  totalSpend: number; // All receipts total
  /** Legacy：仅 supermarket 小票合计（不含 convenience） */
  grocerySpend: number;
  /** V1：supermarket + convenience 小票合计 */
  supportedSpend: number;
  supportedReceiptCount: number;
  /** All eligible categorized rows (same universe as categoryCompositionTotal). */
  categoryBreakdown: Array<{ category: string; amount: number }>;
  topCategories: Array<{ category: string; amount: number }>; // V1 supported receipts only (top 3)
  /**
   * Sum of ALL eligible categorized merchandise amounts (before top-N truncation).
   * Used as the shared denominator for category bars + category-share insights.
   * Does NOT include uncategorized, and is NOT forced to equal supportedSpend.
   */
  categoryCompositionTotal: number;
  topMerchants: Array<{ merchant: string; count: number; total: number }>;
  highestSingleReceipt: { amount: number; merchant: string; date: number } | null;
  mostFrequentMerchant: { merchant: string; count: number } | null;
  // 未分类/失败分类（不参与 topCategories）的统计，用于 UI 提示
  uncategorizedCount: number;
  uncategorizedTotal: number;
};

/**
 * Check if a receipt is a grocery receipt
 */
function isGroceryReceipt(receipt: ReceiptRow): boolean {
  // Use improved grocery detection
  if (isGroceryMerchant(receipt.merchant_raw || null, receipt.merchant_normalized || null)) {
    return true;
  }

  // Fallback: check analysis_json for is_grocery flag
  try {
    const analysis = JSON.parse(receipt.analysis_json || '{}');
    if (analysis.is_grocery === true) {
      return true;
    }
  } catch (e) {
    // Ignore parse errors
  }

  return false;
}

/**
 * Calculate statistics for specified time range
 * Category analytics only include grocery receipts/items
 */
export function calculateStats(
  receipts: ReceiptRow[],
  range: TimeRange = 'all'
): WeeklyMonthlyStats {
  const now = Date.now();
  const filteredReceipts = filterAnalysisReceiptsByTimeRange(
    receipts,
    range,
    now
  );

  // Total spend (all receipts)
  const totalSpend = filteredReceipts.reduce((sum, r) => sum + (r.total || 0), 0);

  // Grocery spend (supermarket only — legacy field, unchanged semantics)
  const groceryReceipts = filteredReceipts.filter(isGroceryReceipt);
  const grocerySpend = groceryReceipts.reduce((sum, r) => sum + (r.total || 0), 0);

  // V1 supported spend (supermarket + convenience)
  const supportedReceipts = filteredReceipts.filter(isV1SupportedReceipt);
  const supportedSpend = supportedReceipts.reduce((sum, r) => sum + (r.total || 0), 0);
  const supportedReceiptCount = supportedReceipts.length;

  // Category statistics (V1 supported receipts only)
  const categoryMap = new Map<string, number>();
  let uncategorizedCount = 0;
  let uncategorizedTotal = 0;
  for (const receipt of supportedReceipts) {
    try {
      const items = getReceiptItems(receipt) as ReceiptItem[];
      for (const item of items) {
        const amount = itemAmountForAnalytics(item);

        // 与首页 computeUncategorizedSummary / aggregateCategoryData 完全一致的口径：
        // 复用共享 resolveItemFinalCategory（fallback 但有真实分类不算待分类）。
        const finalCategory = resolveItemFinalCategory(item);

        // 待确认：最终分类为 uncategorized
        if (finalCategory === 'uncategorized') {
          uncategorizedCount += 1;
          uncategorizedTotal += amount;
          continue;
        }

        // 非分析类别（理论上仅历史脏数据）：跳过，不进入 topCategories 也不计入待确认
        if (isExcludedFromAnalytics(finalCategory) || !isGroceryCategory(finalCategory)) {
          continue;
        }

        categoryMap.set(finalCategory, (categoryMap.get(finalCategory) || 0) + amount);
      }
    } catch (e) {
      console.error('Failed to parse receipt for stats:', receipt.id, e);
    }
  }

  const allCategoryRows = Array.from(categoryMap.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
  const categoryCompositionTotal = allCategoryRows.reduce(
    (sum, row) => sum + row.amount,
    0
  );
  const categoryBreakdown = allCategoryRows;
  const topCategories = categoryBreakdown.slice(0, 3);

  // Merchant analytics (V1 supported receipts only — same universe as overview).
  // Spend uses authoritative receipt.total; grouping prefers merchant_normalized.
  const merchantMap = new Map<string, { count: number; total: number }>();
  for (const receipt of supportedReceipts) {
    const merchantKey = merchantAnalyticsKey(receipt);
    if (!merchantKey) continue;

    const existing = merchantMap.get(merchantKey) || { count: 0, total: 0 };
    existing.count += 1;
    existing.total += receipt.total || 0;
    merchantMap.set(merchantKey, existing);
  }

  const topMerchants = Array.from(merchantMap.entries())
    .map(([merchant, data]) => ({ merchant, ...data }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.total - a.total ||
        a.merchant.localeCompare(b.merchant)
    )
    .slice(0, 3);

  // Highest single receipt within V1 supported universe
  let highestSingleReceipt: { amount: number; merchant: string; date: number } | null = null;
  for (const receipt of supportedReceipts) {
    const amount = receipt.total || 0;
    if (!highestSingleReceipt || amount > highestSingleReceipt.amount) {
      const merchantKey = merchantAnalyticsKey(receipt);
      // Prefer transaction_at; fall back to created_at (never invent "now")
      highestSingleReceipt = {
        amount,
        merchant: merchantKey || 'Unknown',
        date: receipt.transaction_at || receipt.created_at,
      };
    }
  }

  // Most frequent merchant (V1 supported only)
  let mostFrequentMerchant: { merchant: string; count: number } | null = null;
  for (const row of topMerchants) {
    // Reuse deterministic ranking (count → spend → name)
    mostFrequentMerchant = { merchant: row.merchant, count: row.count };
    break;
  }
  if (!mostFrequentMerchant) {
    for (const [merchant, data] of [...merchantMap.entries()].sort(
      (a, b) =>
        b[1].count - a[1].count ||
        b[1].total - a[1].total ||
        a[0].localeCompare(b[0])
    )) {
      mostFrequentMerchant = { merchant, count: data.count };
      break;
    }
  }

  return {
    totalSpend,
    grocerySpend,
    supportedSpend,
    supportedReceiptCount,
    categoryBreakdown,
    topCategories,
    categoryCompositionTotal,
    topMerchants,
    highestSingleReceipt,
    mostFrequentMerchant,
    uncategorizedCount,
    uncategorizedTotal,
  };
}
