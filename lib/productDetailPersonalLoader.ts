/**
 * G4-2C — personal_product Product Detail loading helper.
 *
 * Resolves one personal context and reuses it for history + price loaders.
 */

import { getReceiptsDatabase } from './db';
import type { Locale } from './i18n';
import {
  resolvePersonalProductTargetWithDb,
  type ResolvedPersonalProductTarget,
} from './personalProductTargetResolver';
import { loadProductHistoryWithDb } from './productHistory';
import type { ProductHistorySummary } from './productHistory';
import {
  loadProductPriceHistoryWithDb,
  type ProductPriceHistoryResult,
} from './productPriceHistory';

export type PersonalProductDetailLoadResult =
  | {
      ok: true;
      resolved: ResolvedPersonalProductTarget;
      history: ProductHistorySummary;
      priceHistory: ProductPriceHistoryResult;
    }
  | {
      ok: false;
      reason:
        | 'owner_unavailable'
        | 'current_endpoint_context_incomplete'
        | 'personal_product_not_found'
        | 'personal_product_not_authorized'
        | 'personal_product_corrupt'
        | 'personal_product_stale'
        | 'history_load_failed'
        | 'price_load_failed';
    };

export type PersonalProductDetailLoadDeps = {
  getDatabase?: typeof getReceiptsDatabase;
  resolveTarget?: typeof resolvePersonalProductTargetWithDb;
  loadHistory?: typeof loadProductHistoryWithDb;
  loadPriceHistory?: typeof loadProductPriceHistoryWithDb;
};

export async function loadPersonalProductDetailDataWithDb(
  requestedKey: string,
  options: {
    locale: Locale;
    excludedReceiptIds?: ReadonlySet<string>;
  },
  deps: PersonalProductDetailLoadDeps = {}
): Promise<PersonalProductDetailLoadResult> {
  const getDatabase = deps.getDatabase ?? getReceiptsDatabase;
  const resolveTarget = deps.resolveTarget ?? resolvePersonalProductTargetWithDb;
  const loadHistory = deps.loadHistory ?? loadProductHistoryWithDb;
  const loadPriceHistory = deps.loadPriceHistory ?? loadProductPriceHistoryWithDb;

  const db = await getDatabase();
  const resolveResult = await resolveTarget(requestedKey, db);
  if (resolveResult.status !== 'ready') {
    return { ok: false, reason: resolveResult.status };
  }

  const resolved = resolveResult.resolved;
  const target = resolved.canonicalTarget;

  const [historyResult, priceResult] = await Promise.allSettled([
    loadHistory(db, target, {
      locale: options.locale,
      excludedReceiptIds: options.excludedReceiptIds,
      personalProductContext: resolved,
    }),
    loadPriceHistory(db, target, {
      excludedReceiptIds: options.excludedReceiptIds,
      personalProductContext: resolved,
    }),
  ]);

  if (historyResult.status !== 'fulfilled' || historyResult.value == null) {
    return { ok: false, reason: 'history_load_failed' };
  }
  if (priceResult.status !== 'fulfilled') {
    return { ok: false, reason: 'price_load_failed' };
  }

  return {
    ok: true,
    resolved,
    history: historyResult.value,
    priceHistory: priceResult.value,
  };
}
