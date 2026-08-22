/**
 * Merchant analytics grouping for Analysis V1.
 *
 * Domain SSOT: docs/merchant-domain-contract.md (R1-B1 freeze).
 *
 * Contract:
 * - merchantAnalyticsKey is the ONE V1 merchant aggregation identity.
 * - Prefer persisted merchant_normalized (retailer-ish derived key) over merchant_raw.
 * - Apply normalizeMerchantName for light cleanup (width, trailing 店, case).
 * - Do NOT invent fuzzy merges beyond existing chain aliases (R1-B2 expands rules).
 * - Do NOT use legacy store mirror columns as branch identity.
 * - Do NOT use UI display strings as analytics identity.
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
