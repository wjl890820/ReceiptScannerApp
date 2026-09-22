/**
 * Product Detail occurrence exclusion set — same SSOT as Analysis / milestones.
 * Must be built from the uncapped owner-scoped receipt universe (not History 200).
 *
 * Slice 3C–3D.2: cached analytics selection + occurrence index, with receipt-read
 * analyticsGeneration provenance (never capture generation after the read).
 */

import type { AnalyticsReceiptSelection } from './analyticsReceiptSelection';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  getAnalyticsReceiptSelectionBuildCount,
  getAnalyticsReceiptSelectionDataGeneration,
  selectAnalyticsReceiptsCached,
} from './analyticsReceiptSelectionCache';
import {
  AnalyticsGenerationStaleError,
  assertLiveAnalyticsGeneration,
} from './analyticsReceiptReadProvenance';
import { applyOccurrenceRepresentativeUniverse } from './canonicalPurchaseOccurrence';
import { applyOccurrenceRepresentativeUniverseCached } from './canonicalPurchaseOccurrenceCache';
import type { ReceiptRow } from './db';
import { measureProductDetailLoadStageSync } from './productDetailLoadTimings';

export type ProductDetailExclusionCacheState = 'hit' | 'miss' | 'direct';

export type BuildProductDetailExcludedReceiptIdsOptions = {
  /**
   * Ready local owner key (same contract as selectAnalyticsReceiptsCached).
   * Empty / missing → direct authoritative selectAnalyticsReceipts (no skip).
   */
  ownerKey?: string | null;
  /** Privacy-safe diagnostics only (merchant_product | personal_product). */
  targetType?: string;
  /**
   * Generation captured BEFORE the owner-scoped receipt read that produced
   * `ownerScopedReceipts`. Production Product Detail loads must pass this.
   * When omitted (unit tests with sync in-memory rows), uses live generation.
   */
  analyticsGeneration?: number;
};

export type ProductDetailAnalyticsSelectionResult = {
  selection: AnalyticsReceiptSelection;
  cacheState: ProductDetailExclusionCacheState;
  /** Same generation as the receipt-read provenance. */
  analyticsGeneration: number;
};

/**
 * Authoritative Product Detail analytics selection with production cacheState.
 * Observational — selection truth matches pre-instrumentation paths.
 */
export function selectProductDetailAnalyticsReceipts(
  ownerScopedReceipts: readonly ReceiptRow[],
  options: BuildProductDetailExcludedReceiptIdsOptions = {}
): ProductDetailAnalyticsSelectionResult {
  const analyticsGeneration =
    options.analyticsGeneration ??
    getAnalyticsReceiptSelectionDataGeneration();
  assertLiveAnalyticsGeneration(
    analyticsGeneration,
    'product_detail_pre_selection'
  );

  const rows = [...ownerScopedReceipts];
  const ownerKey =
    typeof options.ownerKey === 'string' ? options.ownerKey.trim() : '';

  if (!ownerKey) {
    return {
      selection: selectAnalyticsReceipts(rows),
      cacheState: 'direct',
      analyticsGeneration,
    };
  }

  const buildsBefore = getAnalyticsReceiptSelectionBuildCount();
  const cached = selectAnalyticsReceiptsCached({
    ownerKey,
    receipts: rows,
    // Never skip: Product Detail must always obtain an authoritative result.
  });
  if (!cached) {
    return {
      selection: selectAnalyticsReceipts(rows),
      cacheState: 'direct',
      analyticsGeneration,
    };
  }
  const buildsAfter = getAnalyticsReceiptSelectionBuildCount();
  return {
    selection: cached,
    cacheState: buildsAfter > buildsBefore ? 'miss' : 'hit',
    analyticsGeneration,
  };
}

/**
 * HC analytics exclusions ∪ non-representative occurrence members.
 * Callers must pass the full owner-scoped receipt set used for Product History
 * aggregation (e.g. listReceiptsForAnalysis), never a display-capped slice.
 */
export function buildProductDetailExcludedReceiptIds(
  ownerScopedReceipts: readonly ReceiptRow[],
  options: BuildProductDetailExcludedReceiptIdsOptions = {}
): ReadonlySet<string> {
  const receiptCount = ownerScopedReceipts.length;

  const { selection, cacheState, analyticsGeneration } =
    measureProductDetailLoadStageSync(
      'productDetail.exclusionAnalyticsSelection',
      () => selectProductDetailAnalyticsReceipts(ownerScopedReceipts, options),
      (result) => ({
        targetType: options.targetType,
        cacheState: result.cacheState,
        receiptCount,
        selectedReceiptCount: result.selection.analyticsReceipts.length,
        excludedCount: result.selection.excludedDuplicateReceiptIds.size,
      })
    );

  const ownerKey =
    typeof options.ownerKey === 'string' ? options.ownerKey.trim() : '';

  assertLiveAnalyticsGeneration(
    analyticsGeneration,
    'product_detail_pre_occurrence'
  );

  return measureProductDetailLoadStageSync(
    'productDetail.exclusionOccurrence',
    () => {
      const universe = applyOccurrenceRepresentativeUniverseCached(
        selection.analyticsReceipts,
        selection.excludedDuplicateReceiptIds,
        {
          ownerKey: ownerKey || undefined,
          analyticsGeneration,
        }
      );
      if (!universe.ok) {
        throw new AnalyticsGenerationStaleError(
          'product_detail_occurrence_stale'
        );
      }
      return {
        excludedReceiptIds: universe.excludedReceiptIds,
        cacheState: universe.cacheState,
      };
    },
    (result) => ({
      targetType: options.targetType,
      cacheState: result.cacheState,
      receiptCount,
      selectedReceiptCount: selection.analyticsReceipts.length,
      excludedCount: result.excludedReceiptIds.size,
    })
  ).excludedReceiptIds;
}

/**
 * Legacy uncached path — used only for differential equivalence tests.
 * Production callers must use buildProductDetailExcludedReceiptIds.
 */
export function buildProductDetailExcludedReceiptIdsUncached(
  ownerScopedReceipts: readonly ReceiptRow[]
): ReadonlySet<string> {
  const selection = selectAnalyticsReceipts([...ownerScopedReceipts]);
  return applyOccurrenceRepresentativeUniverse(
    selection.analyticsReceipts,
    selection.excludedDuplicateReceiptIds
  ).excludedReceiptIds;
}
