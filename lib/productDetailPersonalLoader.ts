/**
 * G4-2C — personal_product Product Detail loading helper.
 *
 * Resolves one personal context and reuses it for history + price loaders
 * on a shared DB handle. Progressive callers await history for core authority
 * only; PPH may complete afterward without reinterpreting core failure.
 */

import { getReceiptsDatabase } from './db';
import type { Locale } from './i18n';
import {
  resolvePersonalProductTargetWithDb,
  type ResolvedPersonalProductTarget,
} from './personalProductTargetResolver';
import { measureProductDetailLoadStage } from './productDetailLoadTimings';
import { loadProductHistoryWithDb } from './productHistory';
import type { ProductHistorySummary } from './productHistory';
import {
  loadProductPriceHistoryWithDb,
  type ProductPriceHistoryResult,
} from './productPriceHistory';

export type PersonalProductDetailFailureReason =
  | 'owner_unavailable'
  | 'current_endpoint_context_incomplete'
  | 'personal_product_not_found'
  | 'personal_product_not_authorized'
  | 'personal_product_corrupt'
  | 'personal_product_stale'
  | 'history_load_failed'
  | 'price_load_failed';

export type PersonalProductDetailLoadResult =
  | {
      ok: true;
      resolved: ResolvedPersonalProductTarget;
      history: ProductHistorySummary;
      priceHistory: ProductPriceHistoryResult;
    }
  | {
      ok: false;
      reason: PersonalProductDetailFailureReason;
    };

export type PersonalProductDetailLoadDeps = {
  getDatabase?: typeof getReceiptsDatabase;
  resolveTarget?: typeof resolvePersonalProductTargetWithDb;
  loadHistory?: typeof loadProductHistoryWithDb;
  loadPriceHistory?: typeof loadProductPriceHistoryWithDb;
};

export type PersonalProductDetailCoreResult =
  | {
      ok: true;
      resolved: ResolvedPersonalProductTarget;
      history: ProductHistorySummary;
    }
  | {
      ok: false;
      reason: PersonalProductDetailFailureReason;
    };

export type PersonalProductDetailProgressiveHandlers = {
  isActive: () => boolean;
  /** Fired once personal core authority is known (resolve soft-fail or history). */
  onCore: (result: PersonalProductDetailCoreResult) => void;
  /**
   * Fired when PPH settles. Callers must ignore price writes when core failed
   * or the load is stale.
   */
  onPrice: (
    result: PromiseSettledResult<ProductPriceHistoryResult>
  ) => void;
};

/**
 * Progressive personal Detail load: shared resolve + WithDb history∥PPH.
 * Core authority matches loadPersonalProductDetailDataWithDb history rules:
 * rejected or null history → history_load_failed (not ordinary noHistory).
 */
export async function loadPersonalProductDetailProgressiveWithDb(
  requestedKey: string,
  options: {
    locale: Locale;
    excludedReceiptIds?: ReadonlySet<string>;
  },
  handlers: PersonalProductDetailProgressiveHandlers,
  deps: PersonalProductDetailLoadDeps = {}
): Promise<void> {
  const getDatabase = deps.getDatabase ?? getReceiptsDatabase;
  const resolveTarget = deps.resolveTarget ?? resolvePersonalProductTargetWithDb;
  const loadHistory = deps.loadHistory ?? loadProductHistoryWithDb;
  const loadPriceHistory = deps.loadPriceHistory ?? loadProductPriceHistoryWithDb;

  const db = await getDatabase();
  const resolveResult = await measureProductDetailLoadStage(
    'productDetail.personalResolve',
    () => resolveTarget(requestedKey, db),
    { targetType: 'personal_product' }
  );
  if (!handlers.isActive()) return;
  if (resolveResult.status !== 'ready') {
    handlers.onCore({ ok: false, reason: resolveResult.status });
    return;
  }

  const resolved = resolveResult.resolved;
  const target = resolved.canonicalTarget;

  const historyPromise = measureProductDetailLoadStage(
    'productDetail.historyLoad',
    () =>
      loadHistory(db, target, {
        locale: options.locale,
        excludedReceiptIds: options.excludedReceiptIds,
        personalProductContext: resolved,
      }),
    (history) => ({
      targetType: 'personal_product',
      purchaseOccurrenceCount: history?.purchaseOccurrenceCount,
      success: history != null,
    })
  );
  const pricePromise = measureProductDetailLoadStage(
    'productDetail.pphLoad',
    () =>
      loadPriceHistory(db, target, {
        excludedReceiptIds: options.excludedReceiptIds,
        personalProductContext: resolved,
      }),
    (priceHistory) => ({
      targetType: 'personal_product',
      pointCount: priceHistory.points.length,
      comparableOccurrenceCount: priceHistory.comparableOccurrenceCount,
    })
  );

  const [historyResult] = await Promise.allSettled([historyPromise]);
  if (!handlers.isActive()) {
    await Promise.allSettled([pricePromise]);
    return;
  }

  if (historyResult.status !== 'fulfilled' || historyResult.value == null) {
    handlers.onCore({ ok: false, reason: 'history_load_failed' });
  } else {
    handlers.onCore({
      ok: true,
      resolved,
      history: historyResult.value,
    });
  }

  const [priceResult] = await Promise.allSettled([pricePromise]);
  if (!handlers.isActive()) return;
  handlers.onPrice(priceResult);
}

export async function loadPersonalProductDetailDataWithDb(
  requestedKey: string,
  options: {
    locale: Locale;
    excludedReceiptIds?: ReadonlySet<string>;
  },
  deps: PersonalProductDetailLoadDeps = {}
): Promise<PersonalProductDetailLoadResult> {
  // Box avoids TS control-flow treating closure-assigned locals as still null.
  const state: {
    core: PersonalProductDetailCoreResult | null;
    price: PromiseSettledResult<ProductPriceHistoryResult> | null;
  } = { core: null, price: null };

  await loadPersonalProductDetailProgressiveWithDb(
    requestedKey,
    options,
    {
      isActive: () => true,
      onCore: (result) => {
        state.core = result;
      },
      onPrice: (result) => {
        state.price = result;
      },
    },
    deps
  );

  if (!state.core) {
    return { ok: false, reason: 'history_load_failed' };
  }
  if (state.core.ok === false) {
    return { ok: false, reason: state.core.reason };
  }
  if (!state.price || state.price.status !== 'fulfilled') {
    return { ok: false, reason: 'price_load_failed' };
  }
  return {
    ok: true,
    resolved: state.core.resolved,
    history: state.core.history,
    priceHistory: state.price.value,
  };
}
