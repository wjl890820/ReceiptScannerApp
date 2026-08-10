/**
 * 分析页辅助逻辑：将 price radar / category index 的数据准备从页面抽离。
 */

import type { ReceiptRow } from './db';
import {
  extractProductPrices,
  computeCheapestMerchants,
  getTopCheapestProducts,
  computeCategoryPriceIndex,
  type CategoryPriceIndex,
} from './priceRadar';
import { calculateStats, type WeeklyMonthlyStats, type TimeRange } from './statsCalculator';
import { filterGroceryReceipts } from './groceryDetector';
import { logger } from './logger';

export type PriceRadarData = {
  records: ReturnType<typeof extractProductPrices>;
  cheapestMap: ReturnType<typeof computeCheapestMerchants>;
  topProducts: ReturnType<typeof getTopCheapestProducts>;
};

export function createEmptyStats(): WeeklyMonthlyStats {
  return {
    totalSpend: 0,
    grocerySpend: 0,
    supportedSpend: 0,
    supportedReceiptCount: 0,
    topCategories: [],
    topMerchants: [],
    highestSingleReceipt: null,
    mostFrequentMerchant: null,
    uncategorizedCount: 0,
    uncategorizedTotal: 0,
  };
}

/**
 * 包裹 calculateStats，统一默认结构与异常 fallback。
 */
export function buildStatsSafe(
  receipts: ReceiptRow[] | unknown,
  range: TimeRange
): WeeklyMonthlyStats {
  try {
    if (!Array.isArray(receipts)) {
      return createEmptyStats();
    }
    return calculateStats(receipts, range);
  } catch (e) {
    logger.error('Analysis', 'stats computation failed', e);
    return createEmptyStats();
  }
}

/**
 * 构建价格雷达数据：仅 grocery 收据，至少 5 张；任一步骤失败均返回 null。
 */
export function buildPriceRadarData(receipts: ReceiptRow[]): PriceRadarData | null {
  try {
    if (!Array.isArray(receipts) || receipts.length === 0) return null;

    const groceryReceipts = filterGroceryReceipts(receipts);
    if (groceryReceipts.length < 5) return null;

    const records = extractProductPrices(groceryReceipts);
    if (!Array.isArray(records) || records.length === 0) return null;

    const cheapestMap = computeCheapestMerchants(records);
    if (!cheapestMap || cheapestMap.size === 0) return null;

    const topProducts = getTopCheapestProducts(cheapestMap, 10);
    if (!Array.isArray(topProducts) || topProducts.length === 0) return null;

    return { records, cheapestMap, topProducts };
  } catch (e) {
    logger.error('Analysis', 'priceRadarData computation failed', e);
    return null;
  }
}

/**
 * 构建分类价格指数：仅 grocery 收据，至少 10 张；内部使用 computeCategoryPriceIndex。
 */
export function buildCategoryIndexData(receipts: ReceiptRow[]): CategoryPriceIndex | null {
  try {
    if (!Array.isArray(receipts) || receipts.length === 0) return null;
    const groceryReceipts = filterGroceryReceipts(receipts);
    if (groceryReceipts.length < 10) return null;
    return computeCategoryPriceIndex(groceryReceipts, 'produce', 5);
  } catch (e) {
    logger.error('Analysis', 'categoryIndex computation failed', e);
    return null;
  }
}

