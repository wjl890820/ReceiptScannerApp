/**
 * Review date initialization — must never carry forward a prior receipt date.
 */

import type { ScanReviewEditorStateV1 } from './scanReviewDraftStore';

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
