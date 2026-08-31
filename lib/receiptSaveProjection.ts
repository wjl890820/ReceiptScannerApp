import { parseReceiptDateTime } from './dateParser';
import { resolvePersistedMerchantObservation } from './merchantObservationPersist';
import type { ReceiptAnalysis } from './receiptAnalyzer';
import { persistReceiptTaxFields } from './receiptOcrNormalize';

export type ReceiptSaveMaterialProjection = {
  merchantRaw: string | null;
  merchantNormalized: string | null;
  merchantType: ReturnType<typeof resolvePersistedMerchantObservation>['merchantType'];
  transactionAt: number | null;
  transactionSource: 'receipt_ocr';
  total: number;
  tax: number;
  taxIsKnown: 0 | 1;
  currency: string;
  items: unknown[];
  persistedAnalysis: ReceiptAnalysis & Record<string, unknown>;
};

function resolveTransactionDateText(
  analysis: ReceiptAnalysis & Record<string, unknown>
): string | null {
  const value =
    analysis.transactionDate ||
    analysis.transactionAt ||
    analysis.purchasedAt ||
    analysis.datetime;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pure material projection shared by persisted saves and transient Scan Review
 * collision evidence. It deliberately excludes IDs, ownership, DB writes, and
 * navigation.
 */
export function projectReceiptSaveMaterialEvidence(input: {
  analysis: ReceiptAnalysis & Record<string, unknown>;
  reviewedSave: boolean;
}): ReceiptSaveMaterialProjection {
  const { analysis } = input;
  const merchant = resolvePersistedMerchantObservation(
    {
      merchant: analysis.merchant,
      merchant_normalized: analysis.merchant_normalized,
      merchant_type: analysis.merchant_type,
      items: Array.isArray(analysis.items) ? analysis.items : null,
      ocr_raw_text:
        typeof analysis.ocr_raw_text === 'string' ? analysis.ocr_raw_text : null,
      rawText: typeof analysis.rawText === 'string' ? analysis.rawText : null,
    },
    { recomputeType: input.reviewedSave }
  );
  const persistedTax = persistReceiptTaxFields(analysis);
  const total = Number.isFinite(analysis.total) ? analysis.total : 0;
  const currency =
    typeof analysis.currency === 'string' && analysis.currency.trim()
      ? analysis.currency
      : 'JPY';
  const transactionDateText = resolveTransactionDateText(analysis);
  let transactionAt: number | null = null;
  if (transactionDateText) {
    try {
      const rawMerchantHint =
        analysis.merchant ||
        analysis.merchant_normalized ||
        analysis.merchantNormalized;
      transactionAt = parseReceiptDateTime(transactionDateText, {
        fallbackToNow: false,
        merchant:
          typeof rawMerchantHint === 'string'
            ? rawMerchantHint
            : null,
      });
    } catch {
      transactionAt = null;
    }
  }
  const items = Array.isArray(analysis.items) ? analysis.items : [];
  const persistedAnalysis = {
    ...analysis,
    merchant: merchant.merchantRaw ?? undefined,
    merchant_normalized: merchant.merchantNormalized,
    merchant_type: merchant.merchantType,
    tax: persistedTax.tax,
    tax_is_known: persistedTax.taxIsKnown === 1,
  } as ReceiptAnalysis & Record<string, unknown>;

  return {
    merchantRaw: merchant.merchantRaw,
    merchantNormalized: merchant.merchantNormalized,
    merchantType: merchant.merchantType,
    transactionAt,
    transactionSource: 'receipt_ocr',
    total,
    tax: persistedTax.tax,
    taxIsKnown: persistedTax.taxIsKnown,
    currency,
    items,
    persistedAnalysis,
  };
}
