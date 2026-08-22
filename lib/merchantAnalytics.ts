/**
 * Merchant analytics grouping for Analysis V1.
 *
 * Contract:
 * - Prefer persisted merchant_normalized (chain key from canonicalizeMerchantChain
 *   at save/review time) over merchant_raw.
 * - Apply normalizeMerchantName for light cleanup (width, trailing 店, case).
 * - Do NOT invent fuzzy merges beyond existing chain aliases.
 * - Store/branch remain distinct when the saved identity does not collapse them.
 */

import { normalizeMerchantName } from './productNormalizer';
import { isV1SupportedReceipt, type V1SupportedReceiptSource } from './merchantType';

export type MerchantAnalyticsReceipt = V1SupportedReceiptSource & {
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
  total?: number | null;
};

/**
 * Stable grouping key for merchant spend / frequency analytics.
 */
export function merchantAnalyticsKey(
  receipt: Pick<MerchantAnalyticsReceipt, 'merchant_raw' | 'merchant_normalized'>
): string {
  return normalizeMerchantName(
    receipt.merchant_normalized || receipt.merchant_raw || ''
  );
}

export type MerchantSpendAggregate = {
  merchant: string;
  count: number;
  total: number;
};

/**
 * Aggregate merchant spend for V1 core analytics.
 * - Only supermarket + convenience receipts
 * - Spend = authoritative receipt.total (not item sum)
 * - Empty merchant keys skipped
 */
export function aggregateV1MerchantSpend(
  receipts: MerchantAnalyticsReceipt[]
): MerchantSpendAggregate[] {
  const map = new Map<string, { count: number; total: number }>();
  for (const receipt of receipts) {
    if (!isV1SupportedReceipt(receipt)) continue;
    const key = merchantAnalyticsKey(receipt);
    if (!key) continue;
    const existing = map.get(key) || { count: 0, total: 0 };
    existing.count += 1;
    existing.total += Number(receipt.total) || 0;
    map.set(key, existing);
  }
  return Array.from(map.entries())
    .map(([merchant, data]) => ({ merchant, ...data }))
    .sort((a, b) => b.count - a.count || b.total - a.total);
}
