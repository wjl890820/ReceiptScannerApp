/**
 * G5-2B — personal-aware Product Detail return targets for History surfaces.
 */

import {
  buildPersonalProductInventoryRowKey,
  type PersonalProductEndpointInventory,
} from './personalProductEndpointInventory';
import {
  isAuthorizedPersonalInventoryRow,
  resolvePersonalProductTargetFromInventory,
} from './personalProductTargetResolver';
import {
  buildProductDetailHref,
  resolveProductDetailTarget,
  type AggregatableProductDetailTarget,
  type ProductDetailTarget,
  type ProductDetailTargetSource,
} from './productDetailTarget';

export type PersonalAwareProductReturnSource = {
  source: ProductDetailTargetSource;
  sourceIndex: number;
  /**
   * Physical/source receipt whose receipt_items row produced this result.
   * History purchase-truth projection may rewrite source.receiptId while this
   * field preserves the original search-hit row provenance.
   */
  personalEvidenceReceiptId?: string;
};

function isValidPersistedSourceIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function sanitizeRenderSourceIndex(renderIndex: number): number {
  if (Number.isInteger(renderIndex) && renderIndex >= 0) {
    return renderIndex;
  }
  if (Number.isFinite(renderIndex) && renderIndex >= 0) {
    return Math.floor(renderIndex);
  }
  return 0;
}

export function resolveReceiptItemPersistedSourceIndex(
  item: Record<string, unknown>,
  renderIndex: number
): number {
  if (isValidPersistedSourceIndex(item.review_source_index)) {
    return item.review_source_index;
  }
  if (isValidPersistedSourceIndex(item.source_index)) {
    return item.source_index;
  }
  return sanitizeRenderSourceIndex(renderIndex);
}

export function resolvePersonalAwareProductDetailTarget(
  input: PersonalAwareProductReturnSource,
  personalInventory: PersonalProductEndpointInventory | null
): ProductDetailTarget {
  const fallback = resolveProductDetailTarget(input.source);
  if (!personalInventory) {
    return fallback;
  }

  const truthReceiptId =
    input.personalEvidenceReceiptId ?? input.source.receiptId;

  if (personalInventory.excludedDuplicateReceiptIds.has(truthReceiptId)) {
    return fallback;
  }

  const rowKey = buildPersonalProductInventoryRowKey(
    truthReceiptId,
    input.sourceIndex
  );
  const inventoryItem = personalInventory.itemsByRowKey.get(rowKey);
  if (!inventoryItem) {
    return fallback;
  }

  const resolution = resolvePersonalProductTargetFromInventory(
    inventoryItem.merchantProductId,
    personalInventory
  );
  if (resolution.status !== 'ready') {
    return fallback;
  }

  if (
    !isAuthorizedPersonalInventoryRow(
      resolution.resolved,
      truthReceiptId,
      input.sourceIndex,
      inventoryItem.merchantProductId
    )
  ) {
    return fallback;
  }

  return resolution.resolved.canonicalTarget;
}

export function buildPersonalAwareAggregatableProductDetailHref(
  input: PersonalAwareProductReturnSource,
  personalInventory: PersonalProductEndpointInventory | null
): `/product/${AggregatableProductDetailTarget['type']}?key=${string}` | null {
  const target = resolvePersonalAwareProductDetailTarget(
    input,
    personalInventory
  );
  return target.type === 'occurrence' ? null : buildProductDetailHref(target);
}

export function buildPersonalAwareProductSearchResultHref(
  input: PersonalAwareProductReturnSource,
  personalInventory: PersonalProductEndpointInventory | null
):
  | `/product/${AggregatableProductDetailTarget['type']}?key=${string}`
  | `/history/${string}` {
  const target = resolvePersonalAwareProductDetailTarget(
    input,
    personalInventory
  );
  return target.type === 'occurrence'
    ? `/history/${encodeURIComponent(input.source.receiptId)}`
    : buildProductDetailHref(target);
}
