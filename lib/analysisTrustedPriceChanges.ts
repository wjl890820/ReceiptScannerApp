/**
 * AP-3 — Analysis trusted price change selection.
 *
 * Consumes existing Safe Price History + interpretProductPriceChange truth only.
 * Does not reimplement comparison, identity, or quality gates.
 */

import type { ProductDetailTarget } from './productDetailTarget';
import { interpretProductPriceChange } from './productPriceChangeInterpretation';
import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import type { ProductIdentitySourceV1 } from './productIdentityContract';
import {
  identityObservationsFromPriceHistoryRows,
  resolveIdentityConsumerObservations,
  resolveMerchantProductTargetMembershipRowKeys,
} from './productIdentityConsumer';
import {
  buildProductPriceHistory,
  buildReceiptEvidenceCache,
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
  latestOccurredAt: number;
};

export type CollectAnalysisTrustedPriceChangeCandidatesInput = {
  rows: readonly ProductPriceHistoryRow[];
  /** Receipt ids in the duplicate-safe analytics universe (discovery seed). */
  seedReceiptIds: ReadonlySet<string>;
  canonicalDuplicateSelectionApplied?: boolean;
  buildHistory?: typeof buildProductPriceHistory;
  interpretChange?: typeof interpretProductPriceChange;
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

function discoverSeededSkuKeys(
  rows: readonly ProductPriceHistoryRow[],
  seedReceiptIds: ReadonlySet<string>
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!seedReceiptIds.has(row.receiptId)) continue;
    const sku = row.skuKey?.trim();
    if (sku) keys.add(sku);
  }
  return keys;
}

export function discoverSeededMerchantProductIds(
  rows: readonly ProductPriceHistoryRow[],
  seedReceiptIds: ReadonlySet<string>
): Set<string> {
  const seedRows = rows.filter((row) => seedReceiptIds.has(row.receiptId));
  if (seedRows.length === 0) return new Set();

  const { qualified } = resolveIdentityConsumerObservations(
    identityObservationsFromPriceHistoryRows(seedRows)
  );
  const ids = new Set<string>();
  for (const row of qualified) {
    const merchantProductId = row.merchantProductId?.trim();
    if (merchantProductId) ids.add(merchantProductId);
  }
  return ids;
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
  allRows: readonly ProductPriceHistoryRow[],
  options: {
    canonicalDuplicateSelectionApplied: boolean;
    buildHistory: typeof buildProductPriceHistory;
    interpretChange: typeof interpretProductPriceChange;
  }
): AnalysisTrustedPriceChangeCandidate | null {
  const skuRows = allRows.filter((row) => row.skuKey?.trim() === skuKey);
  if (skuRows.length < 2) return null;

  const receiptEvidenceCache = buildReceiptEvidenceCache(skuRows);
  const history: ProductPriceHistoryResult = options.buildHistory(
    { type: 'sku', key: skuKey },
    skuRows,
    {
      receiptEvidenceCache,
      canonicalDuplicateSelectionApplied: options.canonicalDuplicateSelectionApplied,
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
  allRows: readonly ProductPriceHistoryRow[],
  options: {
    canonicalDuplicateSelectionApplied: boolean;
    buildHistory: typeof buildProductPriceHistory;
    interpretChange: typeof interpretProductPriceChange;
  }
): AnalysisTrustedPriceChangeCandidate | null {
  const membershipKeys = resolveMerchantProductTargetMembershipRowKeys(
    [...allRows],
    merchantProductId
  );
  if (membershipKeys.length < 2) return null;

  const membershipKeySet = new Set(
    membershipKeys.map((key) => `${key.receiptId}:${key.itemSourceIndex}`)
  );
  const membershipRows = allRows.filter((row) =>
    membershipKeySet.has(`${row.receiptId}:${row.sourceIndex}`)
  );
  if (membershipRows.length < 2) return null;

  const receiptEvidenceCache = buildReceiptEvidenceCache([...allRows]);
  const history: ProductPriceHistoryResult = options.buildHistory(
    { type: 'merchant_product', key: merchantProductId },
    [...allRows],
    {
      receiptEvidenceCache,
      canonicalDuplicateSelectionApplied: options.canonicalDuplicateSelectionApplied,
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
 * Discovery is seeded by analytics receipts; history uses full comparable rows per target.
 */
export function collectAnalysisTrustedPriceChangeCandidates(
  input: CollectAnalysisTrustedPriceChangeCandidatesInput
): AnalysisTrustedPriceChangeCandidate[] {
  const buildHistory = input.buildHistory ?? buildProductPriceHistory;
  const interpretChange = input.interpretChange ?? interpretProductPriceChange;
  const duplicateApplied = input.canonicalDuplicateSelectionApplied ?? true;
  const seededSkuKeys = discoverSeededSkuKeys(input.rows, input.seedReceiptIds);
  const seededMerchantProductIds = discoverSeededMerchantProductIds(
    input.rows,
    input.seedReceiptIds
  );
  if (seededSkuKeys.size === 0 && seededMerchantProductIds.size === 0) {
    return [];
  }

  const skuCandidates: AnalysisTrustedPriceChangeCandidate[] = [];
  for (const skuKey of [...seededSkuKeys].sort()) {
    const skuRows = input.rows.filter((row) => row.skuKey?.trim() === skuKey);
    try {
      const candidate = buildCandidateForSku(skuKey, skuRows, {
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
  for (const merchantProductId of [...seededMerchantProductIds].sort()) {
    try {
      const candidate = buildCandidateForMerchantProduct(
        merchantProductId,
        input.rows,
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
