/**
 * Product Detail main-load pipeline (instrumented).
 * Slice 3B: full-screen loading exits when core history is ready; PPH continues.
 * Personal history null/reject keeps history_load_failed → loadFailed authority.
 * Slice 3D.2: receipt-read generation provenance; stale cancels without fail-open.
 * Slice 3D.3: stale returns explicit outcome; auto-retry at coordinator (not cache).
 */

import {
  AnalyticsGenerationStaleError,
  assertLiveAnalyticsGeneration,
  isAnalyticsGenerationStaleError,
  isLiveAnalyticsGeneration,
  readWithAnalyticsGeneration,
} from './analyticsReceiptReadProvenance';
import { listReceiptsForAnalysis } from './db';
import type { Locale } from './i18n';
import { buildProductDetailExcludedReceiptIds } from './productDetailOccurrenceExclusions';
import {
  loadPersonalProductDetailProgressiveWithDb,
  type PersonalProductDetailLoadDeps,
} from './productDetailPersonalLoader';
import {
  measureProductDetailLoadStage,
  measureProductDetailLoadStageSync,
  recordProductDetailLoadTiming,
} from './productDetailLoadTimings';
import type { AggregatableProductDetailTarget } from './productDetailTarget';
import {
  loadProductHistory,
  type ProductHistorySummary,
} from './productHistory';
import {
  loadProductPriceHistory,
  type ProductPriceHistoryResult,
} from './productPriceHistory';
import { resolveCurrentLocalReceiptOwnerScope } from './receiptOwnershipScope';

export type ProductDetailLoadOutcome =
  | { status: 'success' }
  | { status: 'stale' }
  | { status: 'canceled' };

/** Initial attempt + this many automatic stale retries within one screen cycle. */
export const PRODUCT_DETAIL_STALE_AUTO_RETRY_LIMIT = 1;

export type ProductDetailMainLoadCallbacks = {
  isActive: () => boolean;
  setSummary: (value: ProductHistorySummary | null) => void;
  setPriceHistory: (value: ProductPriceHistoryResult | null) => void;
  setLoadFailed: (value: boolean) => void;
  setPriceLoadFailed: (value: boolean) => void;
  setLoading: (value: boolean) => void;
  setPriceLoading: (value: boolean) => void;
};

export type ProductDetailMainLoadDeps = {
  listReceiptsForAnalysis?: typeof listReceiptsForAnalysis;
  buildProductDetailExcludedReceiptIds?: typeof buildProductDetailExcludedReceiptIds;
  resolveOwnerScope?: typeof resolveCurrentLocalReceiptOwnerScope;
  loadProductHistory?: typeof loadProductHistory;
  loadProductPriceHistory?: typeof loadProductPriceHistory;
  loadPersonalProgressive?: typeof loadPersonalProductDetailProgressiveWithDb;
  personalLoadDeps?: PersonalProductDetailLoadDeps;
};

function revealCoreIfActive(
  callbacks: ProductDetailMainLoadCallbacks,
  loadStarted: number,
  targetType: string,
  loadSuccess: boolean
): void {
  if (!callbacks.isActive()) return;
  recordProductDetailLoadTiming({
    stage: 'productDetail.total',
    durationMs: Date.now() - loadStarted,
    targetType,
    success: loadSuccess,
  });
  callbacks.setLoading(false);
}

/**
 * Stale cancellation: record timing, stop PPH spinner, but do NOT setLoading(false).
 * Leaving loading true prevents false noHistory while the coordinator retries.
 */
function abandonStaleProductDetailLoad(
  callbacks: ProductDetailMainLoadCallbacks,
  loadStarted: number,
  targetType: string
): void {
  if (!callbacks.isActive()) return;
  callbacks.setPriceLoading(false);
  recordProductDetailLoadTiming({
    stage: 'productDetail.total',
    durationMs: Date.now() - loadStarted,
    targetType,
    success: false,
  });
}

function applyPriceResultIfActive(
  callbacks: ProductDetailMainLoadCallbacks,
  priceResult: PromiseSettledResult<ProductPriceHistoryResult>
): void {
  if (!callbacks.isActive()) return;
  if (priceResult.status === 'fulfilled') {
    callbacks.setPriceHistory(priceResult.value);
  } else {
    console.error(
      '[ProductDetail] price history load failed',
      priceResult.reason
    );
    callbacks.setPriceLoadFailed(true);
  }
  callbacks.setPriceLoading(false);
}

async function runMerchantHistoryAndPriceProgressive(
  target: AggregatableProductDetailTarget,
  locale: Locale,
  excludedReceiptIds: ReadonlySet<string> | undefined,
  callbacks: ProductDetailMainLoadCallbacks,
  loadStarted: number,
  loadHistory: typeof loadProductHistory,
  loadPrice: typeof loadProductPriceHistory
): Promise<ProductDetailLoadOutcome> {
  const historyPromise = measureProductDetailLoadStage(
    'productDetail.historyLoad',
    () => loadHistory(target, { locale, excludedReceiptIds }),
    (history) => ({
      targetType: target.type,
      purchaseOccurrenceCount: history?.purchaseOccurrenceCount,
      success: history != null,
    })
  );
  const pricePromise = measureProductDetailLoadStage(
    'productDetail.pphLoad',
    () => loadPrice(target, { excludedReceiptIds }),
    (priceHistory) => ({
      targetType: target.type,
      pointCount: priceHistory.points.length,
      comparableOccurrenceCount: priceHistory.comparableOccurrenceCount,
    })
  );

  const [historyResult] = await Promise.allSettled([historyPromise]);
  if (!callbacks.isActive()) {
    await Promise.allSettled([pricePromise]);
    return { status: 'canceled' };
  }

  let loadSuccess = false;
  if (historyResult.status === 'fulfilled') {
    callbacks.setSummary(historyResult.value);
    loadSuccess = historyResult.value != null;
  } else {
    console.error(
      '[ProductDetail] history load failed',
      historyResult.reason
    );
    callbacks.setLoadFailed(true);
  }
  revealCoreIfActive(callbacks, loadStarted, target.type, loadSuccess);

  const [priceResult] = await Promise.allSettled([pricePromise]);
  applyPriceResultIfActive(callbacks, priceResult);
  return { status: 'success' };
}

/**
 * Single Product Detail load attempt.
 * Stale → { status: 'stale' } without clearing loading into noHistory.
 */
export async function runProductDetailMainLoad(
  target: AggregatableProductDetailTarget,
  locale: Locale,
  callbacks: ProductDetailMainLoadCallbacks,
  deps: ProductDetailMainLoadDeps = {}
): Promise<ProductDetailLoadOutcome> {
  const listReceipts = deps.listReceiptsForAnalysis ?? listReceiptsForAnalysis;
  const buildExclusions =
    deps.buildProductDetailExcludedReceiptIds ??
    buildProductDetailExcludedReceiptIds;
  const resolveOwnerScope =
    deps.resolveOwnerScope ?? resolveCurrentLocalReceiptOwnerScope;
  const loadHistory = deps.loadProductHistory ?? loadProductHistory;
  const loadPrice = deps.loadProductPriceHistory ?? loadProductPriceHistory;
  const loadPersonalProgressive =
    deps.loadPersonalProgressive ?? loadPersonalProductDetailProgressiveWithDb;

  if (!callbacks.isActive()) {
    return { status: 'canceled' };
  }

  const loadStarted = Date.now();
  callbacks.setPriceLoading(true);

  let excludedReceiptIds: ReadonlySet<string> | undefined;
  try {
    // Capture generation BEFORE owner-scoped receipt read (Slice 3D.2).
    const receiptRead = await measureProductDetailLoadStage(
      'productDetail.ownerReceiptUniverse',
      () => readWithAnalyticsGeneration(() => listReceipts()),
      (result) =>
        result.ok
          ? {
              targetType: target.type,
              receiptCount: result.value.length,
            }
          : {
              targetType: target.type,
              success: false,
            }
    );
    if (!callbacks.isActive()) {
      return { status: 'canceled' };
    }
    if (!receiptRead.ok) {
      abandonStaleProductDetailLoad(callbacks, loadStarted, target.type);
      return { status: 'stale' };
    }
    const allReceipts = receiptRead.value;
    const analyticsGeneration = receiptRead.analyticsGeneration;

    // Owner resolution may await; drift cancels before selection.
    let ownerKey: string | undefined;
    try {
      const ownerScope = await resolveOwnerScope();
      if (!callbacks.isActive()) {
        return { status: 'canceled' };
      }
      if (!isLiveAnalyticsGeneration(analyticsGeneration)) {
        abandonStaleProductDetailLoad(callbacks, loadStarted, target.type);
        return { status: 'stale' };
      }
      if (ownerScope.status === 'ready' && ownerScope.ownerKey.trim()) {
        ownerKey = ownerScope.ownerKey;
      }
    } catch {
      if (!callbacks.isActive()) {
        return { status: 'canceled' };
      }
      if (!isLiveAnalyticsGeneration(analyticsGeneration)) {
        abandonStaleProductDetailLoad(callbacks, loadStarted, target.type);
        return { status: 'stale' };
      }
      ownerKey = undefined;
    }

    assertLiveAnalyticsGeneration(
      analyticsGeneration,
      'product_detail_pre_exclusion'
    );

    excludedReceiptIds = measureProductDetailLoadStageSync(
      'productDetail.exclusionBuild',
      () =>
        buildExclusions(allReceipts, {
          ownerKey,
          targetType: target.type,
          analyticsGeneration,
        }),
      (excluded) => ({
        targetType: target.type,
        receiptCount: allReceipts.length,
        excludedCount: excluded.size,
      })
    );
  } catch (e) {
    if (isAnalyticsGenerationStaleError(e)) {
      abandonStaleProductDetailLoad(callbacks, loadStarted, target.type);
      return { status: 'stale' };
    }
    console.error('[ProductDetail] analytics selection failed', e);
  }

  if (!callbacks.isActive()) {
    return { status: 'canceled' };
  }

  if (target.type === 'personal_product') {
    let coreSucceeded = false;
    await loadPersonalProgressive(
      target.key,
      { locale, excludedReceiptIds },
      {
        isActive: callbacks.isActive,
        onCore: (core) => {
          if (!callbacks.isActive()) return;
          if (!core.ok) {
            console.error(
              '[ProductDetail] personal product load failed',
              core.reason
            );
            callbacks.setLoadFailed(true);
            callbacks.setPriceLoadFailed(true);
            callbacks.setPriceLoading(false);
            revealCoreIfActive(callbacks, loadStarted, target.type, false);
            return;
          }
          coreSucceeded = true;
          callbacks.setSummary(core.history);
          revealCoreIfActive(callbacks, loadStarted, target.type, true);
        },
        onPrice: (priceResult) => {
          if (!callbacks.isActive()) return;
          if (!coreSucceeded) {
            callbacks.setPriceLoading(false);
            return;
          }
          applyPriceResultIfActive(callbacks, priceResult);
        },
      },
      deps.personalLoadDeps
    );
    if (!callbacks.isActive()) {
      return { status: 'canceled' };
    }
    return { status: 'success' };
  }

  return runMerchantHistoryAndPriceProgressive(
    target,
    locale,
    excludedReceiptIds,
    callbacks,
    loadStarted,
    loadHistory,
    loadPrice
  );
}

/**
 * Screen-boundary stale retry: one automatic fresh restart after stale.
 * Occurrence cache stays reject-only; this coordinator owns retry.
 *
 * Terminal stale → caller must show distinct reload UI (not noHistory).
 */
export async function runProductDetailMainLoadWithStaleRetry(
  target: AggregatableProductDetailTarget,
  locale: Locale,
  callbacks: ProductDetailMainLoadCallbacks,
  deps: ProductDetailMainLoadDeps = {}
): Promise<ProductDetailLoadOutcome> {
  let outcome = await runProductDetailMainLoad(target, locale, callbacks, deps);
  let staleRetries = 0;
  while (
    outcome.status === 'stale' &&
    staleRetries < PRODUCT_DETAIL_STALE_AUTO_RETRY_LIMIT
  ) {
    if (!callbacks.isActive()) {
      return { status: 'canceled' };
    }
    staleRetries += 1;
    // Keep full-screen loading; restart from fresh receipt read.
    callbacks.setPriceLoading(true);
    outcome = await runProductDetailMainLoad(target, locale, callbacks, deps);
  }
  return outcome;
}

export { AnalyticsGenerationStaleError, isAnalyticsGenerationStaleError };
