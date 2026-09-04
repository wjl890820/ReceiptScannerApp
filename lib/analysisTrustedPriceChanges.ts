/**
 * AP-3 — Analysis trusted price change selection.
 *
 * Consumes existing Safe Price History + interpretProductPriceChange truth only.
 * Does not reimplement comparison, identity, or quality gates.
 *
 * Performance (C2A): one-pass prepared identity + evidence + buckets; history
 * builds only from the candidate's membership/SKU bucket.
 */

import type { ProductDetailTarget } from './productDetailTarget';
import { interpretProductPriceChange } from './productPriceChangeInterpretation';
import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import type { ProductIdentitySourceV1 } from './productIdentityContract';
import {
  prepareAnalysisPriceInsightContext,
  recordAnalysisPriceHistoryInputSize,
  type PreparedAnalysisPriceInsightContext,
} from './analysisPricePreparedContext';
import {
  buildProductPriceHistory,
  type ProductPriceHistoryPoint,
  type ProductPriceHistoryRow,
  type ProductPriceHistoryResult,
} from './productPriceHistory';

/** AP-3-only exact merchant_product identity sources (resolver deterministic paths). */
export const ANALYSIS_MERCHANT_PRODUCT_APPROVED_IDENTITY_SOURCES = [
  'normalized_exact',
  'alias_exact',
  'dictionary_exact',
  'merchant_exact',
] as const satisfies readonly ProductIdentitySourceV1[];

export type AnalysisMerchantProductApprovedIdentitySource =
  (typeof ANALYSIS_MERCHANT_PRODUCT_APPROVED_IDENTITY_SOURCES)[number];

export function isAnalysisApprovedMerchantProductIdentitySource(
  source: unknown
): source is AnalysisMerchantProductApprovedIdentitySource {
  return (
    typeof source === 'string' &&
    (ANALYSIS_MERCHANT_PRODUCT_APPROVED_IDENTITY_SOURCES as readonly string[]).includes(
      source
    )
  );
}

export function isAnalysisApprovedMerchantProductHistoryPoint(
  point: ProductPriceHistoryPoint
): boolean {
  if (point.identityLevel !== 'merchant_product') return false;
  if (!point.merchantProductId?.trim()) return false;
  return isAnalysisApprovedMerchantProductIdentitySource(point.identitySource);
}

/**
 * AP-3 fail-closed: both purchase events used in interpretation must have
 * trusted history points whose identity provenance is exact-approved.
 */
export function merchantProductInterpretationPurchasePointsApproved(
  history: ProductPriceHistoryResult,
  interpretation: Extract<ProductPriceChangeInterpretation, { status: 'available' }>
): boolean {
  const purchaseReceiptIds = new Set([
    interpretation.current.receiptId,
    interpretation.previous.receiptId,
  ]);
  for (const receiptId of purchaseReceiptIds) {
    const trustedReceiptPoints = history.points.filter(
      (point) =>
        point.receiptId === receiptId && point.qualityLevel === 'trusted'
    );
    if (trustedReceiptPoints.length === 0) return false;
    if (
      !trustedReceiptPoints.every(isAnalysisApprovedMerchantProductHistoryPoint)
    ) {
      return false;
    }
  }
  return true;
}

export type AnalysisPriceChangeTarget = Extract<
  ProductDetailTarget,
  { type: 'sku' | 'merchant_product' }
>;

export type AnalysisTrustedPriceChangeCandidate = {
  target: AnalysisPriceChangeTarget;
  displayName: string;
  interpretation: Extract<ProductPriceChangeInterpretation, { status: 'available' }>;
  comparableOccurrenceCount: number;
  /** Trusted timestamp of the current purchase event (period filter later). */
  latestOccurredAt: number;
};

export type CollectAnalysisTrustedPriceChangeCandidatesInput = {
  rows: readonly ProductPriceHistoryRow[];
  /** Receipt ids in the duplicate-safe analytics universe (discovery seed). */
  seedReceiptIds: ReadonlySet<string>;
  canonicalDuplicateSelectionApplied?: boolean;
  buildHistory?: typeof buildProductPriceHistory;
  interpretChange?: typeof interpretProductPriceChange;
  /** Optional prebuilt context (tests / shared preparation). */
  prepared?: PreparedAnalysisPriceInsightContext;
};

function pickDisplayLabel(rows: readonly ProductPriceHistoryRow[]): string {
  const labels = rows
    .map((row) => row.displayName?.trim())
    .filter((label): label is string => !!label);
  if (labels.length === 0) return 'product';
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0])
  )[0]![0];
}

/** @deprecated Prefer prepareAnalysisPriceInsightContext; kept for tests. */
export function discoverSeededMerchantProductIds(
  rows: readonly ProductPriceHistoryRow[],
  seedReceiptIds: ReadonlySet<string>
): Set<string> {
  return new Set(
    prepareAnalysisPriceInsightContext(rows, seedReceiptIds)
      .seededMerchantProductIds
  );
}

function skuPurchaseEventKey(receiptId: string, skuKey: string): string {
  return `${receiptId}:${skuKey}`;
}

export function collectSkuCoveredPurchaseEvents(
  candidates: readonly AnalysisTrustedPriceChangeCandidate[]
): Set<string> {
  const covered = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.target.type !== 'sku') continue;
    const skuKey = candidate.target.key;
    const { current, previous } = candidate.interpretation;
    if (current?.receiptId) {
      covered.add(skuPurchaseEventKey(current.receiptId, skuKey));
    }
    if (previous?.receiptId) {
      covered.add(skuPurchaseEventKey(previous.receiptId, skuKey));
    }
  }
  return covered;
}

export function isMerchantProductDuplicateOfSku(
  candidate: AnalysisTrustedPriceChangeCandidate,
  skuCoveredEvents: ReadonlySet<string>
): boolean {
  const { current, previous } = candidate.interpretation;
  const currentSku = current.skuKey?.trim();
  const previousSku = previous.skuKey?.trim();
  if (!currentSku || !previousSku || currentSku !== previousSku) return false;
  return (
    skuCoveredEvents.has(skuPurchaseEventKey(current.receiptId, currentSku)) &&
    skuCoveredEvents.has(skuPurchaseEventKey(previous.receiptId, previousSku))
  );
}

function buildCandidateForSku(
  skuKey: string,
  skuRows: readonly ProductPriceHistoryRow[],
  prepared: PreparedAnalysisPriceInsightContext,
  options: {
    canonicalDuplicateSelectionApplied: boolean;
    buildHistory: typeof buildProductPriceHistory;
    interpretChange: typeof interpretProductPriceChange;
  }
): AnalysisTrustedPriceChangeCandidate | null {
  if (skuRows.length < 2) return null;

  recordAnalysisPriceHistoryInputSize(skuRows.length);
  const history: ProductPriceHistoryResult = options.buildHistory(
    { type: 'sku', key: skuKey },
    [...skuRows],
    {
      receiptEvidenceCache: prepared.receiptEvidenceCache,
      canonicalDuplicateSelectionApplied:
        options.canonicalDuplicateSelectionApplied,
    }
  );
  const interpretation = options.interpretChange({
    history,
    targetType: 'sku',
    targetKey: skuKey,
  });
  if (interpretation.status !== 'available') return null;
  if (interpretation.grossDirection === 'unchanged') return null;

  return {
    target: { type: 'sku', key: skuKey },
    displayName: pickDisplayLabel(skuRows),
    interpretation,
    comparableOccurrenceCount: history.comparableOccurrenceCount,
    latestOccurredAt: interpretation.current.occurredAt,
  };
}

function buildCandidateForMerchantProduct(
  merchantProductId: string,
  prepared: PreparedAnalysisPriceInsightContext,
  options: {
    canonicalDuplicateSelectionApplied: boolean;
    buildHistory: typeof buildProductPriceHistory;
    interpretChange: typeof interpretProductPriceChange;
  }
): AnalysisTrustedPriceChangeCandidate | null {
  const membershipRows =
    prepared.merchantProductBuckets.get(merchantProductId) ?? [];
  if (membershipRows.length < 2) return null;

  const identityView =
    prepared.merchantProductIdentityViews.get(merchantProductId) ?? null;
  if (!identityView) return null;

  // Bucket-scoped metadata only (still sourced from the one-pass full resolve).
  const bucketMetadata = new Map<
    string,
    NonNullable<
      ReturnType<
        PreparedAnalysisPriceInsightContext['rowIdentityMetadata']['get']
      >
    >
  >();
  for (const row of membershipRows) {
    const key = `${row.receiptId}:${row.sourceIndex}`;
    const meta = prepared.rowIdentityMetadata.get(key);
    if (meta) bucketMetadata.set(key, meta);
  }

  recordAnalysisPriceHistoryInputSize(membershipRows.length);
  const history: ProductPriceHistoryResult = options.buildHistory(
    { type: 'merchant_product', key: merchantProductId },
    [...membershipRows],
    {
      receiptEvidenceCache: prepared.receiptEvidenceCache,
      canonicalDuplicateSelectionApplied:
        options.canonicalDuplicateSelectionApplied,
      preparedMerchantProductIdentityView: identityView,
      preparedRowIdentityMetadata: bucketMetadata,
    }
  );
  const interpretation = options.interpretChange({
    history,
    targetType: 'merchant_product',
    targetKey: merchantProductId,
  });
  if (interpretation.status !== 'available') return null;
  if (interpretation.grossDirection === 'unchanged') return null;
  if (
    !merchantProductInterpretationPurchasePointsApproved(history, interpretation)
  ) {
    return null;
  }

  return {
    target: { type: 'merchant_product', key: merchantProductId },
    displayName: pickDisplayLabel(membershipRows),
    interpretation,
    comparableOccurrenceCount: history.comparableOccurrenceCount,
    latestOccurredAt: interpretation.current.occurredAt,
  };
}

/**
 * Collect trusted Analysis price-change candidates from indexed product rows.
 * Discovery is seeded by analytics receipts; history uses full comparable
 * bucket rows per target (baseline may lie outside a future UI period).
 */
export function collectAnalysisTrustedPriceChangeCandidates(
  input: CollectAnalysisTrustedPriceChangeCandidatesInput
): AnalysisTrustedPriceChangeCandidate[] {
  const buildHistory = input.buildHistory ?? buildProductPriceHistory;
  const interpretChange = input.interpretChange ?? interpretProductPriceChange;
  const duplicateApplied = input.canonicalDuplicateSelectionApplied ?? true;

  const prepared =
    input.prepared ??
    prepareAnalysisPriceInsightContext(input.rows, input.seedReceiptIds);

  if (
    prepared.seededSkuKeys.size === 0 &&
    prepared.seededMerchantProductIds.size === 0
  ) {
    return [];
  }

  const skuCandidates: AnalysisTrustedPriceChangeCandidate[] = [];
  for (const skuKey of [...prepared.seededSkuKeys].sort()) {
    const skuRows = prepared.skuBuckets.get(skuKey) ?? [];
    try {
      const candidate = buildCandidateForSku(skuKey, skuRows, prepared, {
        canonicalDuplicateSelectionApplied: duplicateApplied,
        buildHistory,
        interpretChange,
      });
      if (candidate) skuCandidates.push(candidate);
    } catch {
      // Optional surface: skip SKUs that fail candidate construction.
    }
  }

  const skuCoveredEvents = collectSkuCoveredPurchaseEvents(skuCandidates);
  const merchantProductCandidates: AnalysisTrustedPriceChangeCandidate[] = [];
  for (const merchantProductId of [
    ...prepared.seededMerchantProductIds,
  ].sort()) {
    try {
      const candidate = buildCandidateForMerchantProduct(
        merchantProductId,
        prepared,
        {
          canonicalDuplicateSelectionApplied: duplicateApplied,
          buildHistory,
          interpretChange,
        }
      );
      if (
        candidate &&
        !isMerchantProductDuplicateOfSku(candidate, skuCoveredEvents)
      ) {
        merchantProductCandidates.push(candidate);
      }
    } catch {
      // Optional surface: skip merchant products that fail candidate construction.
    }
  }

  return [...skuCandidates, ...merchantProductCandidates];
}

/** Deterministic ranking: magnitude → recency → evidence → label → target. */
export function rankAnalysisTrustedPriceChangeCandidates(
  candidates: readonly AnalysisTrustedPriceChangeCandidate[]
): AnalysisTrustedPriceChangeCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftMag = Math.abs(left.interpretation.grossDelta);
    const rightMag = Math.abs(right.interpretation.grossDelta);
    if (rightMag !== leftMag) return rightMag - leftMag;
    if (right.latestOccurredAt !== left.latestOccurredAt) {
      return right.latestOccurredAt - left.latestOccurredAt;
    }
    if (right.comparableOccurrenceCount !== left.comparableOccurrenceCount) {
      return right.comparableOccurrenceCount - left.comparableOccurrenceCount;
    }
    const labelCmp = left.displayName.localeCompare(right.displayName);
    if (labelCmp !== 0) return labelCmp;
    return left.target.key.localeCompare(right.target.key);
  });
}

export function selectAnalysisTrustedPriceChangeCandidates(
  candidates: readonly AnalysisTrustedPriceChangeCandidate[],
  limit = 3
): AnalysisTrustedPriceChangeCandidate[] {
  return rankAnalysisTrustedPriceChangeCandidates(candidates).slice(
    0,
    Math.max(0, limit)
  );
}
