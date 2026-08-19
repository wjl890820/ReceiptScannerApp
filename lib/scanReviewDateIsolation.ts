/**
 * Review date initialization — must never carry forward a prior receipt date.
 */

import type { ScanReviewEditorStateV1 } from './scanReviewDraftStore';
import { parseReceiptDateTime } from './dateParser';

export function resolveInitialReviewDateStr(params: {
  editorState?: ScanReviewEditorStateV1 | null;
  snapshotTransactionDate?: string | null;
}): string {
  const es = params.editorState;
  if (es?.version === 1 && Array.isArray(es.lineItems)) {
    return typeof es.dateStr === 'string' ? es.dateStr : '';
  }
  const tx = params.snapshotTransactionDate;
  return typeof tx === 'string' && tx.trim() ? tx.trim() : '';
}

/** True when OCR/snapshot provides no usable purchase date for a new draft. */
export function isReviewDateUnknown(dateStr: string | null | undefined): boolean {
  return !dateStr || !String(dateStr).trim();
}

/**
 * Review "date needs confirm" banner.
 * Must pass merchant so Costco ambiguous MDY can parse the same way save does.
 * Empty / unparsable → confirm. Never invents a date.
 */
export function reviewDateNeedsConfirm(
  dateStr: string | null | undefined,
  merchant?: string | null
): boolean {
  return (
    parseReceiptDateTime(dateStr?.trim() || null, {
      fallbackToNow: false,
      merchant: merchant ?? null,
    }) == null
  );
}
