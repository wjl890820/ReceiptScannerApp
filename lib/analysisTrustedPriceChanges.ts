/**
 * AP-3 — Analysis trusted price change selection.
 *
 * Consumes existing Safe Price History + interpretProductPriceChange truth only.
 * Does not reimplement comparison, identity, or quality gates.
 */

import type { ProductDetailTarget } from './productDetailTarget';
import { interpretProductPriceChange } from './productPriceChangeInterpretation';
import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import {
  buildProductPriceHistory,
  buildReceiptEvidenceCache,
  type ProductPriceHistoryRow,
  type ProductPriceHistoryResult,
} from './productPriceHistory';

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

function pickSkuDisplayLabel(rows: readonly ProductPriceHistoryRow[]): string {
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
    displayName: pickSkuDisplayLabel(skuRows),
    interpretation,
    comparableOccurrenceCount: history.comparableOccurrenceCount,
    latestOccurredAt: interpretation.current.occurredAt,
  };
}

/**
 * Collect trusted Analysis price-change candidates from indexed product rows.
 * Discovery is seeded by analytics receipts; history uses full comparable rows per SKU.
 */
export function collectAnalysisTrustedPriceChangeCandidates(
  input: CollectAnalysisTrustedPriceChangeCandidatesInput
): AnalysisTrustedPriceChangeCandidate[] {
  const buildHistory = input.buildHistory ?? buildProductPriceHistory;
  const interpretChange = input.interpretChange ?? interpretProductPriceChange;
  const duplicateApplied = input.canonicalDuplicateSelectionApplied ?? true;
  const seededSkuKeys = discoverSeededSkuKeys(input.rows, input.seedReceiptIds);
  if (seededSkuKeys.size === 0) return [];

  const candidates: AnalysisTrustedPriceChangeCandidate[] = [];
  for (const skuKey of [...seededSkuKeys].sort()) {
    const skuRows = input.rows.filter((row) => row.skuKey?.trim() === skuKey);
    try {
      const candidate = buildCandidateForSku(skuKey, skuRows, {
        canonicalDuplicateSelectionApplied: duplicateApplied,
        buildHistory,
        interpretChange,
      });
      if (candidate) candidates.push(candidate);
    } catch {
      // Optional surface: skip SKUs that fail candidate construction.
    }
  }

  return candidates;
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
