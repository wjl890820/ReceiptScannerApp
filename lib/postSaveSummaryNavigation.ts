export type PostSaveSummaryRouteContext = {
  receiptId: string;
  nextDraftId: string | null;
};

function nonEmptyString(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : null;
}

export function buildPostSaveSummaryHref(
  receiptId: string,
  nextDraftId: string | null
): `/post-save-summary/${string}` {
  const path = `/post-save-summary/${encodeURIComponent(receiptId)}` as const;
  return nextDraftId
    ? `${path}?nextDraftId=${encodeURIComponent(nextDraftId)}`
    : path;
}

export function parsePostSaveSummaryRouteContext(
  receiptId: unknown,
  nextDraftId: unknown
): PostSaveSummaryRouteContext | null {
  const parsedReceiptId = nonEmptyString(receiptId);
  if (!parsedReceiptId) return null;
  return {
    receiptId: parsedReceiptId,
    nextDraftId: nonEmptyString(nextDraftId),
  };
}

export function getPostSavePrimaryDestination(
  nextDraftId: string | null
): '/' | `/scan-review/${string}` {
  return nextDraftId
    ? `/scan-review/${encodeURIComponent(nextDraftId)}`
    : '/';
}
