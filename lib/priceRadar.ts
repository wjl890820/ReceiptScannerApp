// lib/priceRadar.ts
import type { ReceiptRow } from './db';
import { normalizeProductName, normalizeMerchantName, calculateUnitPrice } from './productNormalizer';

export type ProductPriceRecord = {
  normalizedName: string;
  merchantKey: string;
  unitPrice: number;
  date: number;
  receiptId: string;
};

export type CheapestMerchantInfo = {
  normalizedName: string;
  minUnitPrice: number;
  merchantKey: string;
  date: number;
  frequency: number; // 该商品出现的总次数
};

export type PriceComparison = {
  normalizedName: string;
  currentPrice: number;
  minPrice: number;
  minMerchant: string;
  minDate: number;
  priceDelta: number; // currentPrice - minPrice
  priceDeltaPercent: number; // (currentPrice - minPrice) / minPrice * 100
};

/**
 * 从收据历史中提取所有产品价格记录
 */
export function extractProductPrices(receipts: ReceiptRow[]): ProductPriceRecord[] {
  const records: ProductPriceRecord[] = [];

  for (const receipt of receipts) {
    try {
      const analysis = JSON.parse(receipt.analysis_json || '{}');
      const items = analysis.items || [];
      const merchantKey = normalizeMerchantName(
        receipt.merchant_normalized || receipt.merchant_raw || ''
      );

      if (!merchantKey) continue;

      for (const item of items) {
        if (!item || !item.name) continue;
        
        const normalized = normalizeProductName(item.name || '');
        // Fix: use optional chaining and null check
        if (!normalized?.normalizedName) continue;

        const quantity = Number(item.quantity) || 1;
        const lineTotal = Number(item.lineTotal) || 0;
        const unitPrice = calculateUnitPrice(lineTotal, quantity);

        if (unitPrice <= 0) continue;

        records.push({
          normalizedName: normalized.normalizedName,
          merchantKey,
          unitPrice,
          date: receipt.transaction_at || receipt.created_at,
          receiptId: receipt.id,
        });
      }
    } catch (e) {
      console.error('Failed to parse receipt:', receipt.id, e);
    }
  }

  return records;
}

/**
 * 计算每个产品的最便宜商家
 */
export function computeCheapestMerchants(
  records: ProductPriceRecord[]
): Map<string, CheapestMerchantInfo> {
  const productMap = new Map<string, ProductPriceRecord[]>();

  // 按产品分组
  for (const record of records) {
    const existing = productMap.get(record.normalizedName) || [];
    existing.push(record);
    productMap.set(record.normalizedName, existing);
  }

  const result = new Map<string, CheapestMerchantInfo>();

  for (const [normalizedName, productRecords] of productMap.entries()) {
    if (productRecords.length === 0) continue;

    // 找到最低单价
    let minRecord = productRecords[0];
    for (const record of productRecords) {
      if (record.unitPrice < minRecord.unitPrice) {
        minRecord = record;
      }
    }

    result.set(normalizedName, {
      normalizedName,
      minUnitPrice: minRecord.unitPrice,
      merchantKey: minRecord.merchantKey,
      date: minRecord.date,
      frequency: productRecords.length,
    });
  }

  return result;
}

/**
 * 获取最常购买商品的最便宜商家（Top N）
 */
export function getTopCheapestProducts(
  cheapestMap: Map<string, CheapestMerchantInfo>,
  topN: number = 10
): CheapestMerchantInfo[] {
  const items = Array.from(cheapestMap.values());

  // 按频率降序排序，然后取前N个
  items.sort((a, b) => b.frequency - a.frequency);

  return items.slice(0, topN);
}

/**
 * 比较当前价格与历史最低价
 */
export function compareWithMinPrice(
  normalizedName: string,
  currentPrice: number,
  cheapestMap: Map<string, CheapestMerchantInfo>
): PriceComparison | null {
  const cheapest = cheapestMap.get(normalizedName);
  if (!cheapest) return null;

  const priceDelta = currentPrice - cheapest.minUnitPrice;
  const priceDeltaPercent = cheapest.minUnitPrice > 0
    ? (priceDelta / cheapest.minUnitPrice) * 100
    : 0;

  return {
    normalizedName,
    currentPrice,
    minPrice: cheapest.minUnitPrice,
    minMerchant: cheapest.merchantKey,
    minDate: cheapest.date,
    priceDelta,
    priceDeltaPercent,
  };
}

/**
 * 检查是否支付了超过最低价10%的价格
 */
export function isOverpriced(comparison: PriceComparison, thresholdPercent: number = 10): boolean {
  return comparison.priceDeltaPercent > thresholdPercent;
}

/**
 * 计算分类级别的商家价格指数（保守统计）
 */
export type CategoryPriceIndex = {
  category: string;
  merchantAverages: Array<{
    merchantKey: string;
    averagePrice: number;
    itemCount: number;
  }>;
};

export function computeCategoryPriceIndex(
  receipts: ReceiptRow[],
  category: string,
  minItemsPerMerchant: number = 5
): CategoryPriceIndex | null {
  const merchantItems = new Map<string, number[]>(); // merchant -> prices[]

  for (const receipt of receipts) {
    try {
      const analysis = JSON.parse(receipt.analysis_json || '{}');
      const items = analysis.items || [];
      const merchantKey = normalizeMerchantName(
        receipt.merchant_normalized || receipt.merchant_raw || ''
      );

      if (!merchantKey) continue;

      for (const item of items) {
        const itemCategory = item.category || 'Other';
        if (itemCategory !== category) continue;

        const quantity = Number(item.quantity) || 1;
        const lineTotal = Number(item.lineTotal) || 0;
        const unitPrice = calculateUnitPrice(lineTotal, quantity);

        if (unitPrice <= 0) continue;

        const existing = merchantItems.get(merchantKey) || [];
        existing.push(unitPrice);
        merchantItems.set(merchantKey, existing);
      }
    } catch (e) {
      console.error('Failed to parse receipt for category index:', receipt.id, e);
    }
  }

  // 只保留满足最小样本量的商家
  const merchantAverages: Array<{ merchantKey: string; averagePrice: number; itemCount: number }> =
    [];

  for (const [merchantKey, prices] of merchantItems.entries()) {
    if (prices.length < minItemsPerMerchant) continue;

    const sum = prices.reduce((a, b) => a + b, 0);
    const average = sum / prices.length;

    merchantAverages.push({
      merchantKey,
      averagePrice: average,
      itemCount: prices.length,
    });
  }

  if (merchantAverages.length < 2) return null; // 至少需要2个商家才能比较

  merchantAverages.sort((a, b) => a.averagePrice - b.averagePrice);

  return {
    category,
    merchantAverages,
  };
}
