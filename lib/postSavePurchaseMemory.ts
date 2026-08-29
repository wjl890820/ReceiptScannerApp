/**
 * G5-1 — post-save repeat purchase memory (read-only).
 *
 * Surfaces "you've bought this before" when identity is already known.
 * G4 identity prompt always outranks this memory surface.
 */

import {
  buildPersonalIdentityPromptCandidateV1,
  findPersonalIdentityPromptCandidatesForInventory,
  type PersonalIdentityPromptCandidateV1,
} from './personalProductIdentityCandidateService';
import {
  buildPersonalProductInventoryRowKey,
  inventoryItemHasUsableMerchantEndpoint,
  loadPersonalProductEndpointInventoryWithDb,
  type LoadPersonalProductEndpointInventoryDeps,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventoryDatabase,
  type PersonalProductInventoryItem,
} from './personalProductEndpointInventory';
import {
  resolvePersonalProductTargetFromInventory,
  type ResolvedPersonalProductTarget,
} from './personalProductTargetResolver';
import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import { interpretProductPriceChange } from './productPriceChangeInterpretation';
import type { AggregatableProductDetailTarget } from './productDetailTarget';
import { loadProductPriceHistoryWithDb } from './productPriceHistory';
import type { LocalOwnershipStamp } from './receiptOwnershipContext';
import { isUnknownMerchantScopeKey } from './productIdentityResolver';

export type PostSavePurchaseMemoryTarget = Extract<
  AggregatableProductDetailTarget,
  { type: 'personal_product' | 'sku' | 'merchant_product' }
>;

export type PostSavePreviousPurchase = {
  receiptId: string;
  occurredAt: number;
  merchantName: string | null;
};

export type PostSavePurchaseMemory = {
  savedReceiptId: string;
  target: PostSavePurchaseMemoryTarget;
  identityKind: PostSavePurchaseMemoryTarget['type'];
  displayName: string;
  purchaseOccurrenceCount: number;
  previousPurchase: PostSavePreviousPurchase;
  merchantCount: number | null;
  priceInterpretation:
    | (ProductPriceChangeInterpretation & { status: 'available' })
    | null;
};

export type LoadPostSavePurchaseMemoryResult =
  | { status: 'memory'; memory: PostSavePurchaseMemory }
  | {
      status: 'identity_candidate';
      candidate: PersonalIdentityPromptCandidateV1;
    }
  | { status: 'none' }
  | { status: 'owner_unavailable' }
  | {
      status: 'current_endpoint_context_incomplete';
      reason?: string;
    };

export type LoadPostSavePurchaseMemoryDeps =
  LoadPersonalProductEndpointInventoryDeps & {
    loadInventory?: (
      db: PersonalProductEndpointInventoryDatabase,
      stamp?: LocalOwnershipStamp
    ) => Promise<
      | { status: 'ready'; inventory: PersonalProductEndpointInventory }
      | { status: 'owner_unavailable' }
      | { status: 'current_endpoint_context_incomplete'; reason?: string }
    >;
    resolveTarget?: typeof resolvePersonalProductTargetFromInventory;
    loadPriceHistory?: typeof loadProductPriceHistoryWithDb;
    interpretPriceChange?: typeof interpretProductPriceChange;
  };

type MemoryIdentityKind = PostSavePurchaseMemoryTarget['type'];

type MemoryCandidateDraft = {
  target: PostSavePurchaseMemoryTarget;
  identityKind: MemoryIdentityKind;
  identityRank: number;
  displayName: string;
  savedSourceIndex: number;
  personalResolved?: ResolvedPersonalProductTarget;
};

const IDENTITY_RANK: Record<MemoryIdentityKind, number> = {
  personal_product: 3,
  sku: 2,
  merchant_product: 1,
};

export function isValidPersistedSkuKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isUsableDisplayName(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function targetDedupeKey(target: PostSavePurchaseMemoryTarget): string {
  return `${target.type}\0${target.key}`;
}

function comparePreviousPurchaseRows(
  left: PersonalProductInventoryItem,
  right: PersonalProductInventoryItem
): number {
  if (left.occurredAt !== right.occurredAt) {
    return right.occurredAt - left.occurredAt;
  }
  if (left.receiptId !== right.receiptId) {
    return right.receiptId.localeCompare(left.receiptId);
  }
  return left.sourceIndex - right.sourceIndex;
}

export function countDistinctMerchants(
  items: readonly PersonalProductInventoryItem[]
): number | null {
  const scopes = new Set<string>();
  for (const item of items) {
    if (
      item.merchantScopeKey &&
      !isUnknownMerchantScopeKey(item.merchantScopeKey)
    ) {
      scopes.add(item.merchantScopeKey);
    }
  }
  return scopes.size > 0 ? scopes.size : null;
}

function collectRetainedItemsForTarget(
  inventory: PersonalProductEndpointInventory,
  draft: MemoryCandidateDraft
): PersonalProductInventoryItem[] {
  const excluded = inventory.excludedDuplicateReceiptIds;
  const retained: PersonalProductInventoryItem[] = [];

  if (draft.identityKind === 'personal_product' && draft.personalResolved) {
    for (const rowKey of draft.personalResolved.authorizedRowKeys) {
      const item = inventory.itemsByRowKey.get(rowKey);
      if (!item) continue;
      if (excluded.has(item.receiptId)) continue;
      retained.push(item);
    }
    return retained;
  }

  if (draft.identityKind === 'sku') {
    for (const item of inventory.itemsByRowKey.values()) {
      if (item.skuKey !== draft.target.key) continue;
      if (excluded.has(item.receiptId)) continue;
      retained.push(item);
    }
    return retained;
  }

  const rowKeys =
    inventory.itemKeysByMerchantProductId.get(draft.target.key) ?? [];
  for (const rowKey of rowKeys) {
    const item = inventory.itemsByRowKey.get(rowKey);
    if (!item) continue;
    if (excluded.has(item.receiptId)) continue;
    retained.push(item);
  }
  return retained;
}

function selectPreviousPurchase(
  items: readonly PersonalProductInventoryItem[],
  savedReceiptId: string
): PostSavePreviousPurchase | null {
  const historical = items.filter((item) => item.receiptId !== savedReceiptId);
  if (historical.length === 0) return null;

  const sorted = [...historical].sort(comparePreviousPurchaseRows);
  const previous = sorted[0]!;
  return {
    receiptId: previous.receiptId,
    occurredAt: previous.occurredAt,
    merchantName: previous.merchantName?.trim() || null,
  };
}

function buildMemoryCandidate(
  inventory: PersonalProductEndpointInventory,
  savedReceiptId: string,
  draft: MemoryCandidateDraft
): Omit<PostSavePurchaseMemory, 'priceInterpretation'> | null {
  const retained = collectRetainedItemsForTarget(inventory, draft);
  const receiptIds = new Set(retained.map((item) => item.receiptId));
  if (!receiptIds.has(savedReceiptId)) return null;
  if (receiptIds.size < 2) return null;

  const previousPurchase = selectPreviousPurchase(retained, savedReceiptId);
  if (!previousPurchase) return null;

  if (!isUsableDisplayName(draft.displayName)) return null;

  return {
    savedReceiptId,
    target: draft.target,
    identityKind: draft.identityKind,
    displayName: draft.displayName.trim(),
    purchaseOccurrenceCount: receiptIds.size,
    previousPurchase,
    merchantCount: countDistinctMerchants(retained),
  };
}

export function deriveRepeatTargetForSavedItem(
  item: PersonalProductInventoryItem,
  inventory: PersonalProductEndpointInventory,
  resolveTarget: typeof resolvePersonalProductTargetFromInventory = resolvePersonalProductTargetFromInventory
): MemoryCandidateDraft | null {
  if (!inventoryItemHasUsableMerchantEndpoint(item, inventory)) {
    return null;
  }

  const personal = resolveTarget(item.merchantProductId, inventory);
  if (personal.status === 'ready') {
    if (!isUsableDisplayName(item.displayName)) return null;
    return {
      target: personal.resolved.canonicalTarget,
      identityKind: 'personal_product',
      identityRank: IDENTITY_RANK.personal_product,
      displayName: item.displayName,
      savedSourceIndex: item.sourceIndex,
      personalResolved: personal.resolved,
    };
  }

  if (isValidPersistedSkuKey(item.skuKey)) {
    if (!isUsableDisplayName(item.displayName)) return null;
    return {
      target: { type: 'sku', key: item.skuKey },
      identityKind: 'sku',
      identityRank: IDENTITY_RANK.sku,
      displayName: item.displayName,
      savedSourceIndex: item.sourceIndex,
    };
  }

  if (!isUsableDisplayName(item.displayName)) return null;
  return {
    target: { type: 'merchant_product', key: item.merchantProductId },
    identityKind: 'merchant_product',
    identityRank: IDENTITY_RANK.merchant_product,
    displayName: item.displayName,
    savedSourceIndex: item.sourceIndex,
  };
}

export function rankBuiltMemoryEntries(
  entries: readonly {
    memory: Omit<PostSavePurchaseMemory, 'priceInterpretation'>;
    savedSourceIndex: number;
    personalResolved?: ResolvedPersonalProductTarget;
  }[]
): {
  memory: Omit<PostSavePurchaseMemory, 'priceInterpretation'>;
  savedSourceIndex: number;
  personalResolved?: ResolvedPersonalProductTarget;
} | null {
  if (entries.length === 0) return null;

  return [...entries].sort((left, right) => {
    const leftRank = IDENTITY_RANK[left.memory.identityKind];
    const rightRank = IDENTITY_RANK[right.memory.identityKind];
    if (leftRank !== rightRank) return rightRank - leftRank;

    if (
      left.memory.purchaseOccurrenceCount !== right.memory.purchaseOccurrenceCount
    ) {
      return (
        right.memory.purchaseOccurrenceCount - left.memory.purchaseOccurrenceCount
      );
    }

    if (
      left.memory.previousPurchase.occurredAt !==
      right.memory.previousPurchase.occurredAt
    ) {
      return (
        right.memory.previousPurchase.occurredAt -
        left.memory.previousPurchase.occurredAt
      );
    }

    if (left.savedSourceIndex !== right.savedSourceIndex) {
      return left.savedSourceIndex - right.savedSourceIndex;
    }

    const leftKey = targetDedupeKey(left.memory.target);
    const rightKey = targetDedupeKey(right.memory.target);
    return leftKey.localeCompare(rightKey);
  })[0]!;
}

export function rankMemoryCandidates(
  candidates: readonly Omit<PostSavePurchaseMemory, 'priceInterpretation'>[]
): Omit<PostSavePurchaseMemory, 'priceInterpretation'> | null {
  if (candidates.length === 0) return null;
  return (
    rankBuiltMemoryEntries(
      candidates.map((memory, index) => ({
        memory,
        savedSourceIndex: index,
      }))
    )?.memory ?? null
  );
}

export type PostSavePurchaseMemoryBuildResult =
  | {
      status: 'memory';
      memory: PostSavePurchaseMemory;
      personalResolved?: ResolvedPersonalProductTarget;
    }
  | {
      status: 'identity_candidate';
      candidate: PersonalIdentityPromptCandidateV1;
    }
  | { status: 'none' };

export function recheckFreshIdentityPromptCandidate(
  inventory: PersonalProductEndpointInventory,
  savedReceiptId: string
): PersonalIdentityPromptCandidateV1 | null {
  const ranked = findPersonalIdentityPromptCandidatesForInventory(
    inventory,
    savedReceiptId
  );
  const top = ranked[0];
  if (!top) return null;

  return (
    buildPersonalIdentityPromptCandidateV1({
      savedReceiptId,
      currentItem: top.currentItem,
      historicalItem: top.historicalItem,
      inventory,
      similarity: top.similarity,
      valueReason: top.valueReason,
      prospectivePurchaseEventCount: top.prospectivePurchaseEventCount,
      prospectiveMerchantCount: top.prospectiveMerchantCount,
    }) ?? null
  );
}

export function buildPostSavePurchaseMemoryFromInventory(
  savedReceiptId: string,
  inventory: PersonalProductEndpointInventory,
  deps: Pick<LoadPostSavePurchaseMemoryDeps, 'resolveTarget'> = {}
): PostSavePurchaseMemoryBuildResult {
  if (inventory.excludedDuplicateReceiptIds.has(savedReceiptId)) {
    return { status: 'none' };
  }

  const freshCandidate = recheckFreshIdentityPromptCandidate(
    inventory,
    savedReceiptId
  );
  if (freshCandidate) {
    return { status: 'identity_candidate', candidate: freshCandidate };
  }

  const resolveTarget =
    deps.resolveTarget ?? resolvePersonalProductTargetFromInventory;
  const savedItems = [...inventory.itemsByRowKey.values()].filter(
    (item) =>
      item.receiptId === savedReceiptId &&
      inventoryItemHasUsableMerchantEndpoint(item, inventory)
  );

  const draftByTarget = new Map<string, MemoryCandidateDraft>();
  for (const item of savedItems) {
    const draft = deriveRepeatTargetForSavedItem(item, inventory, resolveTarget);
    if (!draft) continue;

    const key = targetDedupeKey(draft.target);
    const existing = draftByTarget.get(key);
    if (!existing) {
      draftByTarget.set(key, draft);
      continue;
    }

    if (draft.identityRank > existing.identityRank) {
      draftByTarget.set(key, {
        ...draft,
        savedSourceIndex: Math.min(
          draft.savedSourceIndex,
          existing.savedSourceIndex
        ),
      });
      continue;
    }

    if (
      draft.identityRank === existing.identityRank &&
      draft.savedSourceIndex < existing.savedSourceIndex
    ) {
      draftByTarget.set(key, {
        ...existing,
        displayName: draft.displayName,
        savedSourceIndex: draft.savedSourceIndex,
      });
    }
  }

  const built: Array<{
    memory: Omit<PostSavePurchaseMemory, 'priceInterpretation'>;
    savedSourceIndex: number;
    personalResolved?: ResolvedPersonalProductTarget;
  }> = [];

  for (const draft of draftByTarget.values()) {
    const memory = buildMemoryCandidate(inventory, savedReceiptId, draft);
    if (!memory) continue;
    built.push({
      memory,
      savedSourceIndex: draft.savedSourceIndex,
      personalResolved: draft.personalResolved,
    });
  }

  const winner = rankBuiltMemoryEntries(built);
  if (!winner) {
    return { status: 'none' };
  }

  return {
    status: 'memory',
    memory: {
      ...winner.memory,
      priceInterpretation: null,
    },
    personalResolved: winner.personalResolved,
  };
}

async function enrichMemoryWithPrice(
  db: PersonalProductEndpointInventoryDatabase,
  memory: PostSavePurchaseMemory,
  inventory: PersonalProductEndpointInventory,
  personalResolved: ResolvedPersonalProductTarget | undefined,
  deps: LoadPostSavePurchaseMemoryDeps
): Promise<PostSavePurchaseMemory> {
  // Non-personal post-save price enrichment is disabled until the general price loader is owner-scoped.
  if (memory.target.type !== 'personal_product' || !personalResolved) {
    return { ...memory, priceInterpretation: null };
  }

  const loadPriceHistory = deps.loadPriceHistory ?? loadProductPriceHistoryWithDb;
  const interpretPriceChange =
    deps.interpretPriceChange ?? interpretProductPriceChange;

  try {
    const priceHistory = await loadPriceHistory(db, memory.target, {
      personalProductContext: personalResolved,
      excludedReceiptIds: inventory.excludedDuplicateReceiptIds,
    });

    const interpretation = interpretPriceChange({
      history: priceHistory,
      targetType: memory.target.type,
      targetKey: memory.target.key,
    });

    if (interpretation.status === 'available') {
      return { ...memory, priceInterpretation: interpretation };
    }
  } catch {
    // Price failure is not memory failure.
  }

  return { ...memory, priceInterpretation: null };
}

export async function loadPostSavePurchaseMemoryWithDb(
  savedReceiptId: string,
  db: PersonalProductEndpointInventoryDatabase,
  stamp?: LocalOwnershipStamp,
  deps: LoadPostSavePurchaseMemoryDeps = {}
): Promise<LoadPostSavePurchaseMemoryResult> {
  const inventoryResult = await (deps.loadInventory ??
    ((database, ownership) =>
      loadPersonalProductEndpointInventoryWithDb(database, ownership, deps)))(
    db,
    stamp
  );

  if (inventoryResult.status === 'owner_unavailable') {
    return { status: 'owner_unavailable' };
  }
  if (inventoryResult.status === 'current_endpoint_context_incomplete') {
    return {
      status: 'current_endpoint_context_incomplete',
      reason: inventoryResult.reason,
    };
  }

  const baseResult = buildPostSavePurchaseMemoryFromInventory(
    savedReceiptId,
    inventoryResult.inventory,
    deps
  );

  if (baseResult.status !== 'memory') {
    return baseResult;
  }

  const memory = await enrichMemoryWithPrice(
    db,
    baseResult.memory,
    inventoryResult.inventory,
    baseResult.personalResolved,
    deps
  );

  return { status: 'memory', memory };
}

export { buildPersonalProductInventoryRowKey };
