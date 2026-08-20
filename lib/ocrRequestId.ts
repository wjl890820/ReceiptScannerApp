/**
 * Extract Edge OCR provenance.requestId without mutating analysis.
 */
export function extractOcrRequestIdFromEdgeResponse(responseData: unknown): string | null {
  try {
    if (!responseData || typeof responseData !== 'object') return null;
    const provenance = (responseData as { provenance?: unknown }).provenance;
    if (!provenance || typeof provenance !== 'object') return null;
    const requestId = (provenance as { requestId?: unknown }).requestId;
    if (typeof requestId !== 'string') return null;
    const trimmed = requestId.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
