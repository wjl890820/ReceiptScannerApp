/**
 * A1 — Canonical merchant (read-only).
 * Reuses R1-B2 DerivedRetailerIdentity; does not invent a second normalization system.
 */

import type { ReceiptRow } from '../db';
import { merchantAnalyticsKey } from '../merchantAnalytics';
import { deriveRetailerIdentity } from '../retailerIdentity';
import type { CanonicalMerchant } from './types';

export function deriveCanonicalMerchant(receipt: ReceiptRow): CanonicalMerchant {
  const derived = deriveRetailerIdentity({
    merchantRaw: receipt.merchant_raw,
    merchantNormalized: receipt.merchant_normalized,
    merchantType: receipt.merchant_type,
  });
  const analyticsKey = merchantAnalyticsKey(receipt);
  return {
    retailerKey: derived.retailerKey,
    displayName:
      derived.retailerDisplayName ??
      ((receipt.merchant_normalized || receipt.merchant_raw || '').trim() ||
        null),
    storeBranch: derived.storeHint,
    confidence: derived.confidence,
    source: derived.source,
    analyticsKey,
  };
}
