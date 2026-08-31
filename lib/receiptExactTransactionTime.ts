import type { ReceiptRow } from './db';

export function hasValidTransactionAt(receipt: ReceiptRow): boolean {
  const value = receipt.transaction_at;
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Date-only parser output is Asia/Tokyo midnight and is not clock evidence. */
export function hasExactTransactionTime(receipt: ReceiptRow): boolean {
  if (!hasValidTransactionAt(receipt)) return false;
  const date = new Date(receipt.transaction_at as number);
  if (!Number.isFinite(date.getTime())) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
    const second = parts.find((part) => part.type === 'second')?.value ?? '';
    return !(hour === '00' && minute === '00' && second === '00');
  } catch {
    return false;
  }
}

