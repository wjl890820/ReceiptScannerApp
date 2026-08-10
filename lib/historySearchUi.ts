/**
 * History search UI state helpers — presentation/control only.
 * Does not change SQL / indexing / identity.
 */

import { normalizeReceiptItemSearchQuery } from './receiptItemSearchNormalize';

export type HistorySearchSubmitAction =
  | { type: 'clear' }
  | { type: 'keep_results' }
  | { type: 'search'; query: string };

/** Ignore no-op re-fires (IME confirm / Search with unchanged text). */
export function shouldApplyHistorySearchQueryChange(
  previousRaw: string,
  nextRaw: string
): boolean {
  return previousRaw !== nextRaw;
}

/**
 * Keyboard Search / return key.
 * - empty → clear loading/results
 * - same query already completed → keep results (do not re-enter loading)
 * - otherwise → run the shared search path immediately
 */
export function resolveHistorySearchSubmitAction(input: {
  rawQuery: string;
  lastCompletedNormalizedQuery: string;
}): HistorySearchSubmitAction {
  const normalized = normalizeReceiptItemSearchQuery(input.rawQuery);
  if (!normalized) {
    return { type: 'clear' };
  }
  if (input.lastCompletedNormalizedQuery === normalized) {
    return { type: 'keep_results' };
  }
  return { type: 'search', query: input.rawQuery };
}

export type HistoryPurchaseSearchOutcome =
  | { status: 'empty' }
  | { status: 'stale' }
  | {
      status: 'ok';
      normalizedQuery: string;
      itemResults: unknown[];
      receiptResults: unknown[];
    }
  | { status: 'error'; error: unknown };

/**
 * Shared async search execution. Callers must set loading true before await
 * and clear loading in finally when the request is still current.
 */
export async function performHistoryPurchaseSearch(input: {
  rawQuery: string;
  isCurrent: () => boolean;
  searchFn: (normalizedQuery: string) => Promise<{
    itemResults: unknown[];
    receiptResults: unknown[];
  }>;
}): Promise<HistoryPurchaseSearchOutcome> {
  const normalizedQuery = normalizeReceiptItemSearchQuery(input.rawQuery);
  if (!normalizedQuery) {
    return { status: 'empty' };
  }

  try {
    const results = await input.searchFn(normalizedQuery);
    if (!input.isCurrent()) {
      return { status: 'stale' };
    }
    return {
      status: 'ok',
      normalizedQuery,
      itemResults: results.itemResults,
      receiptResults: results.receiptResults,
    };
  } catch (error) {
    if (!input.isCurrent()) {
      return { status: 'stale' };
    }
    return { status: 'error', error };
  }
}
