export type AnalysisCurrencyReceipt = {
  currency?: unknown;
};

/**
 * V1 Analysis is JPY-only and performs no FX conversion.
 *
 * Missing/blank values retain the established Japan-only ingestion contract:
 * every production save/restore path defaults them to JPY before persistence.
 * The yen symbols remain accepted for legacy OCR clients that emitted them.
 */
export function isAnalysisJpyCurrency(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return false;

  const currency = value.trim();
  if (!currency) return true;
  if (currency === '¥' || currency === '￥') return true;
  return currency.toUpperCase() === 'JPY';
}

export function isAnalysisJpyReceipt(
  receipt: AnalysisCurrencyReceipt
): boolean {
  return isAnalysisJpyCurrency(receipt.currency);
}

export function filterAnalysisJpyReceipts<
  T extends AnalysisCurrencyReceipt,
>(receipts: readonly T[]): T[] {
  return receipts.filter(isAnalysisJpyReceipt);
}
