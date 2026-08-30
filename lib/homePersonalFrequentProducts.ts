/**
 * G5-2A — propagate active G4 personal_manual SAME truth into Home frequent products.
 */

import type { MilestoneFrequentProduct } from './engagementMilestones';
import {
  buildPersonalProductInventoryRowKey,
  type PersonalProductEndpointInventory,
} from './personalProductEndpointInventory';
import {
  resolvePersonalProductTargetFromInventory,
  type ResolvedPersonalProductTarget,
} from './personalProductTargetResolver';
import type {
  IdentityFrequentProductGroup,
  QualifiedIdentityObservation,
} from './productIdentityConsumer';
import { classifyLineKind } from './receiptOcrNormalize';

export type ApplyHomePersonalFrequentOverlayInput = {
  baseGroups: readonly IdentityFrequentProductGroup[];
  qualified: readonly QualifiedIdentityObservation[];
  personalInventory: PersonalProductEndpointInventory;
  supportedReceiptIds: ReadonlySet<string>;
};

function personalComponentDedupeKey(canonicalAnchorKey: string): string {
  return `personal_product:${canonicalAnchorKey}`;
}

function observationIsNonProductRow(
  obs: Pick<QualifiedIdentityObservation, 'rawName' | 'lineTotal' | 'isNonProductRow'>
): boolean {
  if (obs.isNonProductRow === true) return true;
  const kind = classifyLineKind(obs.rawName || '', Number(obs.lineTotal) || 0);
  return kind !== 'item';
}

function isPurchaseEligibleRow(row: QualifiedIdentityObservation): boolean {
  return row.quality !== 'invalid' && !observationIsNonProductRow(row);
}

function isProductRow(row: QualifiedIdentityObservation): boolean {
  return !observationIsNonProductRow(row);
}

function compareQualifiedRows(
  left: QualifiedIdentityObservation,
  right: QualifiedIdentityObservation
): number {
  if (left.occurredAt !== right.occurredAt) {
    return right.occurredAt - left.occurredAt;
  }
  if (left.receiptId !== right.receiptId) {
    return right.receiptId.localeCompare(left.receiptId);
  }
  return right.itemSourceIndex - left.itemSourceIndex;
}

function selectPersonalDisplayLabel(
  rows: readonly QualifiedIdentityObservation[]
): string | null {
  const purchaseRows = rows.filter(isPurchaseEligibleRow);
  const sorted = [...purchaseRows].sort(compareQualifiedRows);
  for (const row of sorted) {
    const label = (row.displayName || row.rawName || '').trim();
    if (label) return label;
  }

  const fallbackSorted = [...rows].sort(compareQualifiedRows);
  for (const row of fallbackSorted) {
    const label = (row.displayName || row.rawName || '').trim();
    if (label) return label;
  }
  return null;
}

function sumPositivePurchaseQuantity(
  rows: readonly QualifiedIdentityObservation[]
): number {
  return rows.filter(isProductRow).reduce((sum, row) => {
    const quantity =
      typeof row.quantity === 'number' && Number.isFinite(row.quantity)
        ? row.quantity
        : 0;
    return sum + (quantity > 0 ? quantity : 0);
  }, 0);
}

function compareHomeFrequentProducts(
  left: MilestoneFrequentProduct,
  right: MilestoneFrequentProduct
): number {
  if (left.purchaseOccurrenceCount !== right.purchaseOccurrenceCount) {
    return right.purchaseOccurrenceCount - left.purchaseOccurrenceCount;
  }
  if (left.lastPurchasedAt !== right.lastPurchasedAt) {
    return right.lastPurchasedAt - left.lastPurchasedAt;
  }
  const labelCmp = left.displayLabel.localeCompare(right.displayLabel);
  if (labelCmp !== 0) return labelCmp;
  const typeCmp = left.groupingType.localeCompare(right.groupingType);
  if (typeCmp !== 0) return typeCmp;
  return left.key.localeCompare(right.key);
}

export function mapIdentityFrequentGroupToHomeProduct(
  group: IdentityFrequentProductGroup
): MilestoneFrequentProduct {
  return {
    groupingType: 'merchant_product',
    key: group.key,
    displayLabel: group.displayName,
    displayLabelKey: null,
    purchaseOccurrenceCount: group.distinctReceiptCount,
    totalPurchaseQuantity: group.totalPurchaseQuantity,
    lastPurchasedAt: group.latestPurchaseAt ?? 0,
    priceSummary: null,
  };
}

function buildQualifiedByRowKey(
  qualified: readonly QualifiedIdentityObservation[]
): Map<string, QualifiedIdentityObservation> {
  const byRowKey = new Map<string, QualifiedIdentityObservation>();
  for (const row of qualified) {
    byRowKey.set(
      buildPersonalProductInventoryRowKey(row.receiptId, row.itemSourceIndex),
      row
    );
  }
  return byRowKey;
}

function homeUniverseRowsHaveConsistentMerchantProductMapping(
  qualified: readonly QualifiedIdentityObservation[],
  inventory: PersonalProductEndpointInventory,
  supportedReceiptIds: ReadonlySet<string>,
  memberMerchantProductIds: ReadonlySet<string>
): boolean {
  for (const row of qualified) {
    if (!supportedReceiptIds.has(row.receiptId)) continue;
    if (!memberMerchantProductIds.has(row.merchantProductId)) continue;
    const rowKey = buildPersonalProductInventoryRowKey(
      row.receiptId,
      row.itemSourceIndex
    );
    const inventoryItem = inventory.itemsByRowKey.get(rowKey);
    if (!inventoryItem || inventoryItem.merchantProductId !== row.merchantProductId) {
      return false;
    }
  }
  return true;
}

function collectRetainedQualifiedRows(
  resolved: ResolvedPersonalProductTarget,
  qualifiedByRowKey: Map<string, QualifiedIdentityObservation>,
  supportedReceiptIds: ReadonlySet<string>
):
  | { ok: true; rows: QualifiedIdentityObservation[] }
  | { ok: false } {
  const memberSet = new Set(resolved.memberMerchantProductIds);
  const retained: QualifiedIdentityObservation[] = [];

  for (const rowKey of resolved.authorizedRowKeys) {
    const item = resolved.inventory.itemsByRowKey.get(rowKey);
    if (!item) continue;
    if (!supportedReceiptIds.has(item.receiptId)) continue;
    if (resolved.inventory.excludedDuplicateReceiptIds.has(item.receiptId)) {
      continue;
    }
    if (!memberSet.has(item.merchantProductId)) continue;

    const qualified = qualifiedByRowKey.get(rowKey);
    if (!qualified || qualified.merchantProductId !== item.merchantProductId) {
      return { ok: false };
    }
    retained.push(qualified);
  }

  return { ok: true, rows: retained };
}

function buildPersonalHomeFrequentProduct(
  resolved: ResolvedPersonalProductTarget,
  retainedRows: readonly QualifiedIdentityObservation[]
): MilestoneFrequentProduct | null {
  const purchaseRows = retainedRows.filter(isPurchaseEligibleRow);
  const receiptIds = new Set(purchaseRows.map((row) => row.receiptId));
  if (receiptIds.size < 2) return null;

  const displayLabel = selectPersonalDisplayLabel(retainedRows);
  if (!displayLabel) return null;

  const lastPurchasedAt = purchaseRows.reduce(
    (latest, row) => Math.max(latest, row.occurredAt),
    0
  );

  return {
    groupingType: 'personal_product',
    key: resolved.canonicalTarget.key,
    displayLabel,
    displayLabelKey: null,
    purchaseOccurrenceCount: receiptIds.size,
    totalPurchaseQuantity: sumPositivePurchaseQuantity(retainedRows),
    lastPurchasedAt,
    priceSummary: null,
  };
}

export function applyHomePersonalFrequentProductOverlay(
  input: ApplyHomePersonalFrequentOverlayInput
): MilestoneFrequentProduct[] {
  const { baseGroups, qualified, personalInventory, supportedReceiptIds } = input;
  const qualifiedByRowKey = buildQualifiedByRowKey(qualified);
  const resolveTarget = resolvePersonalProductTargetFromInventory;

  const personalResolutionByMp = new Map<string, ResolvedPersonalProductTarget>();
  const seenMerchantProductIds = new Set<string>();

  for (const row of qualified) {
    if (!supportedReceiptIds.has(row.receiptId)) continue;
    if (seenMerchantProductIds.has(row.merchantProductId)) continue;
    seenMerchantProductIds.add(row.merchantProductId);

    const resolution = resolveTarget(row.merchantProductId, personalInventory);
    if (resolution.status !== 'ready') continue;
    personalResolutionByMp.set(row.merchantProductId, resolution.resolved);
  }

  const personalGroupsByKey = new Map<string, MilestoneFrequentProduct>();
  const suppressedMemberMerchantProductIds = new Set<string>();

  for (const resolved of personalResolutionByMp.values()) {
    const dedupeKey = personalComponentDedupeKey(resolved.canonicalTarget.key);
    if (personalGroupsByKey.has(dedupeKey)) continue;

    const memberSet = new Set(resolved.memberMerchantProductIds);
    if (
      !homeUniverseRowsHaveConsistentMerchantProductMapping(
        qualified,
        personalInventory,
        supportedReceiptIds,
        memberSet
      )
    ) {
      continue;
    }

    const retained = collectRetainedQualifiedRows(
      resolved,
      qualifiedByRowKey,
      supportedReceiptIds
    );
    if (!retained.ok) continue;

    const personalGroup = buildPersonalHomeFrequentProduct(
      resolved,
      retained.rows
    );
    if (!personalGroup) continue;

    personalGroupsByKey.set(dedupeKey, personalGroup);
    for (const memberId of resolved.memberMerchantProductIds) {
      suppressedMemberMerchantProductIds.add(memberId);
    }
  }

  const baseProductsInOrder = baseGroups.map(mapIdentityFrequentGroupToHomeProduct);

  if (personalGroupsByKey.size === 0) {
    return baseProductsInOrder;
  }

  const remainingBaseProducts = baseGroups
    .filter((group) => !suppressedMemberMerchantProductIds.has(group.key))
    .map(mapIdentityFrequentGroupToHomeProduct);

  return [...remainingBaseProducts, ...personalGroupsByKey.values()].sort(
    compareHomeFrequentProducts
  );
}
