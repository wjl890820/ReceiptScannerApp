/** 审核页：这张小票主要错在哪（可多选） */

export const RECEIPT_REVIEW_ERROR_TAGS = [
  'OCR_ERROR',
  'PARSE_ERROR',
  'ITEM_NAME_ERROR',
  'CATEGORY_ERROR',
  'TOTAL_ERROR',
  'DATE_ERROR',
  'OTHER',
] as const;

export type ReceiptReviewErrorTag = (typeof RECEIPT_REVIEW_ERROR_TAGS)[number];

export function isReceiptReviewErrorTag(s: string): s is ReceiptReviewErrorTag {
  return (RECEIPT_REVIEW_ERROR_TAGS as readonly string[]).includes(s);
}
