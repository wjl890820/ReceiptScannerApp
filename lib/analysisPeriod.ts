import {
  MS_PER_DAY,
  rollingDaysForAnalysisRange,
} from './rollingTimeWindow';

export type AnalysisPeriodRange = 'week' | 'month' | 'all';

export type AnalysisPeriodReceipt = {
  transaction_at?: unknown;
};

export function validAnalysisTransactionAt(
  receipt: AnalysisPeriodReceipt
): number | null {
  const value = receipt.transaction_at;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function filterAnalysisReceiptsByTransactionWindow<
  T extends AnalysisPeriodReceipt,
>(
  receipts: readonly T[],
  startMs: number,
  endMs: number,
  options?: { includeEnd?: boolean }
): T[] {
  const includeEnd = options?.includeEnd ?? false;
  return receipts.filter((receipt) => {
    const transactionAt = validAnalysisTransactionAt(receipt);
    if (transactionAt == null || transactionAt < startMs) return false;
    return includeEnd ? transactionAt <= endMs : transactionAt < endMs;
  });
}

export function filterAnalysisReceiptsByTimeRange<
  T extends AnalysisPeriodReceipt,
>(
  receipts: readonly T[],
  range: AnalysisPeriodRange,
  nowMs: number = Date.now()
): T[] {
  const days = rollingDaysForAnalysisRange(range);
  if (days == null) return [...receipts];
  return filterAnalysisReceiptsByTransactionWindow(
    receipts,
    nowMs - days * MS_PER_DAY,
    nowMs,
    { includeEnd: true }
  );
}
