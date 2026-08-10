// lib/priceRadar.ts
import type { ReceiptRow } from './db';
import { getReceiptItems } from './receiptItems';
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
 * 全链路null-safety：任何异常都降级为跳过，不throw
 */
export function extractProductPrices(receipts: ReceiptRow[]): ProductPriceRecord[] {
  const records: ProductPriceRecord[] = [];

  if (!Array.isArray(receipts)) {
    console.warn('[priceRadar] extractProductPrices: receipts is not an array');
    return records;
  }

  for (const receipt of receipts) {
    try {
      if (!receipt || !receipt.id) continue;

      const items = getReceiptItems(receipt) as any[];
      
      const merchantKey = normalizeMerchantName(
        receipt.merchant_normalized || receipt.merchant_raw || ''
      );

      if (!merchantKey) continue;

      for (const item of items) {
        if (!item || !item.name) continue;
        
        try {
          const normalized = normalizeProductName(item.name || '');
          // Fix: use optional chaining and null check
          if (!normalized?.normalizedName) continue;

          const quantity = Number(item.quantity) || 1;
          const lineTotal = Number(item.lineTotal) || 0;
          const unitPrice = calculateUnitPrice(lineTotal, quantity);

          if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

          const date = receipt.transaction_at || receipt.created_at;
          if (!Number.isFinite(date)) continue;

          records.push({
            normalizedName: normalized.normalizedName,
            merchantKey,
            unitPrice,
            date,
            receiptId: receipt.id,
          });
        } catch (e) {
          // Skip this item, continue to next
          console.warn('[priceRadar] Failed to process item:', item?.name, e);
        }
      }
    } catch (e) {
      // Skip this receipt, continue to next
      console.warn('[priceRadar] Failed to parse receipt:', receipt?.id, e);
    }
  }

  return records;
}

/**
 * 计算每个产品的最便宜商家
 * 全链路null-safety：任何异常都降级为返回空Map
 */
export function computeCheapestMerchants(
  records: ProductPriceRecord[]
): Map<string, CheapestMerchantInfo> {
  const result = new Map<string, CheapestMerchantInfo>();

  try {
    if (!Array.isArray(records) || records.length === 0) {
      return result;
    }

    const productMap = new Map<string, ProductPriceRecord[]>();

    // 按产品分组
    for (const record of records) {
      try {
        if (!record || !record.normalizedName || !Number.isFinite(record.unitPrice)) {
          continue;
        }

        const existing = productMap.get(record.normalizedName) || [];
        existing.push(record);
        productMap.set(record.normalizedName, existing);
      } catch (e) {
        console.warn('[priceRadar] Failed to group record:', e);
        continue;
      }
    }

    for (const [normalizedName, productRecords] of productMap.entries()) {
      try {
        if (!Array.isArray(productRecords) || productRecords.length === 0) continue;

        // 找到最低单价
        let minRecord = productRecords[0];
        for (const record of productRecords) {
          if (record && Number.isFinite(record.unitPrice) && record.unitPrice < minRecord.unitPrice) {
            minRecord = record;
          }
        }

        if (!minRecord || !Number.isFinite(minRecord.unitPrice)) continue;

        result.set(normalizedName, {
          normalizedName,
          minUnitPrice: minRecord.unitPrice,
          merchantKey: minRecord.merchantKey || '',
          date: Number.isFinite(minRecord.date) ? minRecord.date : Date.now(),
          frequency: productRecords.length,
        });
      } catch (e) {
        console.warn('[priceRadar] Failed to compute cheapest for:', normalizedName, e);
        continue;
      }
    }
  } catch (e) {
    console.error('[priceRadar] computeCheapestMerchants failed:', e);
    return new Map();
  }

  return result;
}

/**
 * 获取最常购买商品的最便宜商家（Top N）
 * 全链路null-safety：任何异常都降级为返回空数组
 */
export function getTopCheapestProducts(
  cheapestMap: Map<string, CheapestMerchantInfo>,
  topN: number = 10
): CheapestMerchantInfo[] {
  try {
    if (!cheapestMap || cheapestMap.size === 0) {
      return [];
    }

    const items = Array.from(cheapestMap.values()).filter((item) => {
      return item && Number.isFinite(item.frequency) && Number.isFinite(item.minUnitPrice);
    });

    if (items.length === 0) return [];

    // 按频率降序排序，然后取前N个
    items.sort((a, b) => (b.frequency || 0) - (a.frequency || 0));

    return items.slice(0, Math.max(1, Math.floor(topN)));
  } catch (e) {
    console.error('[priceRadar] getTopCheapestProducts failed:', e);
    return [];
  }
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
  try {
    if (!Array.isArray(receipts) || receipts.length === 0 || !category) {
      return null;
    }

    const merchantItems = new Map<string, number[]>(); // merchant -> prices[]

    for (const receipt of receipts) {
      try {
        if (!receipt || !receipt.id) continue;

        const items = getReceiptItems(receipt) as any[];
        const merchantKey = normalizeMerchantName(
          receipt.merchant_normalized || receipt.merchant_raw || ''
        );

        if (!merchantKey) continue;

        for (const item of items) {
          try {
            if (!item) continue;

            const itemCategory = item.category || 'Other';
            if (itemCategory !== category) continue;

            const quantity = Number(item.quantity) || 1;
            const lineTotal = Number(item.lineTotal) || 0;
            const unitPrice = calculateUnitPrice(lineTotal, quantity);

            if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

            const existing = merchantItems.get(merchantKey) || [];
            existing.push(unitPrice);
            merchantItems.set(merchantKey, existing);
          } catch (e) {
            console.warn('[priceRadar] Failed to process item for category index:', e);
            continue;
          }
        }
      } catch (e) {
        console.warn('[priceRadar] Failed to parse receipt for category index:', receipt?.id, e);
        continue;
      }
    }

    // 只保留满足最小样本量的商家
    const merchantAverages: Array<{ merchantKey: string; averagePrice: number; itemCount: number }> =
      [];

    for (const [merchantKey, prices] of merchantItems.entries()) {
      try {
        if (!Array.isArray(prices) || prices.length < minItemsPerMerchant) continue;

        const validPrices = prices.filter((p) => Number.isFinite(p) && p > 0);
        if (validPrices.length < minItemsPerMerchant) continue;

        const sum = validPrices.reduce((a, b) => a + b, 0);
        const average = sum / validPrices.length;

        if (!Number.isFinite(average)) continue;

        merchantAverages.push({
          merchantKey: merchantKey || '',
          averagePrice: average,
          itemCount: validPrices.length,
        });
      } catch (e) {
        console.warn('[priceRadar] Failed to compute average for merchant:', merchantKey, e);
        continue;
      }
    }

    if (merchantAverages.length < 2) return null; // 至少需要2个商家才能比较

    merchantAverages.sort((a, b) => (a.averagePrice || 0) - (b.averagePrice || 0));

    return {
      category,
      merchantAverages,
    };
  } catch (e) {
    console.error('[priceRadar] computeCategoryPriceIndex failed:', e);
    return null;
  }
}
