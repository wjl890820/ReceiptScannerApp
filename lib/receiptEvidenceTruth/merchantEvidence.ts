/**
 * A1.4A — Receipt merchant evidence (read-only).
 * Reuses deriveRetailerIdentity — no competing retailer normalizer.
 */

import type { ReceiptRow } from '../db';
import { merchantAnalyticsKey } from '../merchantAnalytics';
import { deriveRetailerIdentity } from '../retailerIdentity';
import type {
  MerchantEvidenceCompatibility,
  MerchantEvidenceCompatibilityResult,
  MerchantStoreHintEvidenceStatus,
  ReceiptMerchantEvidence,
} from './types';

function normalizeStoreHint(hint: string | null): string | null {
  if (hint == null) return null;
  const trimmed = hint.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, ' ');
}

export function buildReceiptMerchantEvidence(
  receipt: ReceiptRow
): ReceiptMerchantEvidence {
  const derived = deriveRetailerIdentity({
    merchantRaw: receipt.merchant_raw,
    merchantNormalized: receipt.merchant_normalized,
    merchantType: receipt.merchant_type,
  });

  const storeHint = normalizeStoreHint(derived.storeHint);
  let storeHintEvidenceStatus: MerchantStoreHintEvidenceStatus;
  if (!derived.retailerKey) {
    storeHintEvidenceStatus = 'unresolved';
  } else if (storeHint) {
    storeHintEvidenceStatus = 'observed_store_hint';
  } else {
    storeHintEvidenceStatus = 'missing_store_hint';
  }

  const evidence: string[] = [];
  const reasonCodes: string[] = [];

  if (derived.retailerKey) {
    evidence.push(`retailerKey=${derived.retailerKey}`);
  } else {
    reasonCodes.push('retailer_key_unresolved');
  }
  if (storeHint) {
    evidence.push(`observed_store_hint=${storeHint}`);
    evidence.push('store_hint_not_verified_branch_id');
  } else if (derived.retailerKey) {
    reasonCodes.push('store_hint_missing');
  }

  return {
    receiptId: receipt.id,
    retailerKey: derived.retailerKey,
    retailerDisplayName: derived.retailerDisplayName,
    storeHint,
    storeHintEvidenceStatus,
    confidence: derived.confidence,
    source: derived.source,
    analyticsMerchantKey: merchantAnalyticsKey(receipt),
    evidence,
    reasonCodes,
  };
}

/**
 * Conservative merchant compatibility for shadow duplicate evaluation.
 * Unresolved retailer => fail closed. No analyticsMerchantKey fallback.
 */
export function evaluateMerchantEvidenceCompatibility(
  a: ReceiptMerchantEvidence,
  b: ReceiptMerchantEvidence
): MerchantEvidenceCompatibilityResult {
  if (!a.retailerKey || !b.retailerKey) {
    return {
      compatibility: 'fail_closed',
      evidence: [],
      reasonCodes: ['retailer_key_unresolved_fail_closed'],
    };
  }

  if (a.retailerKey !== b.retailerKey) {
    return {
      compatibility: 'incompatible',
      evidence: [`retailerKey_mismatch:${a.retailerKey}|${b.retailerKey}`],
      reasonCodes: ['retailer_key_mismatch'],
    };
  }

  const hintA = a.storeHint;
  const hintB = b.storeHint;

  if (hintA && hintB) {
    if (hintA === hintB) {
      return {
        compatibility: 'compatible_same_observed_store_hint',
        evidence: [
          `same_retailer_same_observed_store_hint:${a.retailerKey}`,
          'not_verified_same_physical_branch',
        ],
        reasonCodes: [],
      };
    }
    return {
      compatibility: 'incompatible',
      evidence: [
        `same_retailer_different_observed_store_hints:${hintA}|${hintB}`,
      ],
      reasonCodes: ['observed_store_hint_conflict'],
    };
  }

  if (!hintA || !hintB) {
    return {
      compatibility: 'compatible_missing_store_hint',
      evidence: [
        `same_retailer_missing_store_hint:${a.retailerKey}`,
        hintA ? `observed_store_hint_a=${hintA}` : 'store_hint_a_missing',
        hintB ? `observed_store_hint_b=${hintB}` : 'store_hint_b_missing',
        'missing_store_hint_is_uncertainty_not_same_branch_proof',
      ],
      reasonCodes: ['compatible_missing_store_hint'],
    };
  }

  return {
    compatibility: 'fail_closed',
    evidence: [],
    reasonCodes: ['merchant_evidence_unresolved_fail_closed'],
  };
}

export function isMerchantEvidenceShadowCompatible(
  result: MerchantEvidenceCompatibilityResult
): boolean {
  return (
    result.compatibility === 'compatible_same_observed_store_hint' ||
    result.compatibility === 'compatible_missing_store_hint'
  );
}

export function merchantMetadataVariantRequiresDifferentKeys(
  a: ReceiptMerchantEvidence,
  b: ReceiptMerchantEvidence
): boolean {
  return a.analyticsMerchantKey !== b.analyticsMerchantKey;
}
