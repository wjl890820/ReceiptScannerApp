/**
 * R1-B3b — Persist merchant observation → derived merchant_* consistently.
 *
 * Used by saveReceipt / updateReceipt so user-edited merchant text cannot leave
 * stale merchant_normalized / merchant_type behind.
 *
 * Does NOT change alias/detection rules — only when/how they are applied.
 */

import {
  detectMerchantTypeFromReceipt,
  persistMerchantTypeFromAnalysis,
  type MerchantType,
} from './merchantType';
import { canonicalizeMerchantChain } from './receiptOcrNormalize';

export type MerchantObservationAnalysis = {
  merchant?: unknown;
  merchant_normalized?: unknown;
  merchant_type?: unknown;
  items?: Array<{ name?: string | null }> | null;
  rawText?: string | null;
  ocr_raw_text?: string | null;
};

export type PersistedMerchantObservation = {
  merchantRaw: string | null;
  merchantNormalized: string | null;
  merchantType: MerchantType;
};

export function trimMerchantObservation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function merchantObservationEquals(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return (a?.trim() || '') === (b?.trim() || '');
}

/**
 * Derive merchant_raw / merchant_normalized / merchant_type from the current
 * merchant observation (and optional receipt signals for Costco weak headers).
 *
 * @param recomputeType When true, ignore analysis.merchant_type and redetect
 *   (user merchant edit / reviewedSave path). When false, keep
 *   persistMerchantTypeFromAnalysis semantics (trust enriched type).
 */
export function resolvePersistedMerchantObservation(
  analysis: MerchantObservationAnalysis,
  options?: { recomputeType?: boolean }
): PersistedMerchantObservation {
  const merchantRaw = trimMerchantObservation(analysis.merchant);
  const merchantNormalized = merchantRaw
    ? canonicalizeMerchantChain(merchantRaw) || merchantRaw
    : null;

  const items = Array.isArray(analysis.items) ? analysis.items : null;
  const rawText = analysis.ocr_raw_text ?? analysis.rawText ?? null;

  const merchantType = options?.recomputeType
    ? detectMerchantTypeFromReceipt({
        merchant: merchantRaw,
        merchant_normalized: merchantNormalized,
        items,
        rawText,
        ocr_raw_text: analysis.ocr_raw_text ?? null,
      })
    : persistMerchantTypeFromAnalysis({
        merchant_type: analysis.merchant_type,
        merchant: merchantRaw,
        merchant_normalized: merchantNormalized,
        items,
        rawText,
        ocr_raw_text: analysis.ocr_raw_text ?? null,
      });

  return { merchantRaw, merchantNormalized, merchantType };
}
