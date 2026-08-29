/**
 * G4-2A — conservative post-save personal identity prompt candidate service (read-only).
 */

import { distinctReceiptCount } from './engagementMilestones';
import { merchantAnalyticsKey } from './merchantAnalytics';
import {
  buildPersonalProductEndpointInventory,
  hasMeaningfulPersonalIdentityStructuralEvidence,
  inventoryItemHasUsableMerchantEndpoint,
  loadPersonalProductEndpointInventoryWithDb,
  type BuildPersonalProductEndpointInventoryInput,
  type LoadPersonalProductEndpointInventoryDeps,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventoryDatabase,
  type PersonalProductInventoryItem,
} from './personalProductEndpointInventory';
import {
  buildPersonalMerchantProductEndpointV1,
  evaluatePersonalRelationshipWithSnapshot,
  normalizePersonalProductIdentityPair,
  type PersonalMerchantProductEndpointV1,
} from './personalProductIdentityContract';
import {
  attributesAreCompatible,
  findVariantTokenConflicts,
} from './productIdentityStructuralConflict';
import { combinedNameSimilarity } from './productIdentitySimilarity';
import { emptyProductAttributes } from './productIdentityContract';
import type { LocalOwnershipStamp } from './receiptOwnershipContext';

export const PERSONAL_IDENTITY_CANDIDATE_VERSION =
  'personal-identity-candidate-v1' as const;

export type PersonalIdentityPromptCandidateV1 = {
  version: typeof PERSONAL_IDENTITY_CANDIDATE_VERSION;
  savedReceiptId: string;
  pair: {
    leftMerchantProductId: string;
    rightMerchantProductId: string;
  };
  current: {
    receiptId: string;
    itemId: string;
    sourceIndex: number;
    endpoint: PersonalMerchantProductEndpointV1;
    displayName: string;
    merchantName: string;
    specificationLabel: string | null;
    brand: string | null;
  };
  historical: {
    representativeReceiptId: string;
    representativeItemId: string;
    endpoint: PersonalMerchantProductEndpointV1;
    displayName: string;
    merchantName: string;
    specificationLabel: string | null;
    brand: string | null;
    lastPurchasedAt: number;
  };
  evidence: {
    normalizedNameSimilarity: number;
    structuralSignature: string;
    brandAgreement: 'matching' | 'unknown';
    variantConflictCount: 0;
    automaticExactEvidence: 'none';
  };
  value: {
    reason: 'cross_merchant_history' | 'repeat_purchase_history';
    prospectivePurchaseEventCount: number;
    prospectiveMerchantCount: number;
  };
};

export type PersonalIdentityCandidateClassification =
  | 'automatic_exact'
  | 'prompt_candidate'
  | 'no_match';

export type PersonalIdentityPromptCandidateResult =
  | { status: 'candidate'; candidate: PersonalIdentityPromptCandidateV1 }
  | { status: 'none' }
  | { status: 'owner_unavailable' }
  | { status: 'current_endpoint_context_incomplete'; reason?: string };

export type FindPersonalIdentityPromptCandidateDeps =
  LoadPersonalProductEndpointInventoryDeps & {
    loadInventory?: (
      db: PersonalProductEndpointInventoryDatabase,
      stamp?: LocalOwnershipStamp
    ) => Promise<
      | { status: 'ready'; inventory: PersonalProductEndpointInventory }
      | { status: 'owner_unavailable' }
      | { status: 'current_endpoint_context_incomplete'; reason?: string }
    >;
  };

const PROMPT_NAME_SIMILARITY_THRESHOLD = 0.96;

function normalizeBrand(brand: string | null | undefined): string | null {
  const value = typeof brand === 'string' ? brand.trim().toLowerCase() : '';
  return value || null;
}

function brandsAreCompatible(
  left: string | null,
  right: string | null
): boolean {
  const normalizedLeft = normalizeBrand(left);
  const normalizedRight = normalizeBrand(right);
  if (!normalizedLeft || !normalizedRight) return true;
  return normalizedLeft === normalizedRight;
}

function brandAgreementLabel(
  left: string | null,
  right: string | null
): 'matching' | 'unknown' {
  const normalizedLeft = normalizeBrand(left);
  const normalizedRight = normalizeBrand(right);
  if (normalizedLeft && normalizedRight && normalizedLeft === normalizedRight) {
    return 'matching';
  }
  return 'unknown';
}

export function collectCanonicalReceiptIdsForMerchantProduct(
  inventory: PersonalProductEndpointInventory,
  merchantProductId: string
): Set<string> {
  const receiptIds = new Set<string>();
  const rowKeys = inventory.itemKeysByMerchantProductId.get(merchantProductId) ?? [];
  for (const rowKey of rowKeys) {
    const item = inventory.itemsByRowKey.get(rowKey);
    if (!item) continue;
    if (inventory.excludedDuplicateReceiptIds.has(item.receiptId)) continue;
    receiptIds.add(item.receiptId);
  }
  return receiptIds;
}

export function collectCanonicalReceiptIdsForMerchantProducts(
  inventory: PersonalProductEndpointInventory,
  merchantProductIds: readonly string[]
): Set<string> {
  const receiptIds = new Set<string>();
  for (const merchantProductId of merchantProductIds) {
    for (const receiptId of collectCanonicalReceiptIdsForMerchantProduct(
      inventory,
      merchantProductId
    )) {
      receiptIds.add(receiptId);
    }
  }
  return receiptIds;
}

export function savedReceiptQualifiesAsCurrentCanonicalEvent(
  inventory: PersonalProductEndpointInventory,
  savedReceiptId: string
): boolean {
  return !inventory.excludedDuplicateReceiptIds.has(savedReceiptId);
}

export function historicalMerchantProductHasCanonicalEvent(
  inventory: PersonalProductEndpointInventory,
  historicalMerchantProductId: string,
  savedReceiptId: string
): boolean {
  const rowKeys =
    inventory.itemKeysByMerchantProductId.get(historicalMerchantProductId) ?? [];
  for (const rowKey of rowKeys) {
    const item = inventory.itemsByRowKey.get(rowKey);
    if (!item) continue;
    if (item.receiptId === savedReceiptId) continue;
    if (inventory.excludedDuplicateReceiptIds.has(item.receiptId)) continue;
    return true;
  }
  return false;
}

export function currentMerchantProductIncludesSavedReceipt(
  inventory: PersonalProductEndpointInventory,
  currentMerchantProductId: string,
  savedReceiptId: string
): boolean {
  return collectCanonicalReceiptIdsForMerchantProduct(
    inventory,
    currentMerchantProductId
  ).has(savedReceiptId);
}

export function countProspectiveCandidatePurchaseEvents(
  inventory: PersonalProductEndpointInventory,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): {
  prospectivePurchaseEventCount: number;
  prospectiveMerchantCount: number;
} {
  const receiptIds = collectCanonicalReceiptIdsForMerchantProducts(inventory, [
    leftMerchantProductId,
    rightMerchantProductId,
  ]);
  const merchantKeys = new Set<string>();
  for (const receiptId of receiptIds) {
    const receipt = inventory.receiptsById.get(receiptId);
    if (!receipt) continue;
    merchantKeys.add(
      merchantAnalyticsKey({
        merchant_raw: receipt.merchant_raw,
        merchant_normalized: receipt.merchant_normalized,
      })
    );
  }
  return {
    prospectivePurchaseEventCount: distinctReceiptCount(
      [...receiptIds].map((receiptId) => ({ receiptId }))
    ),
    prospectiveMerchantCount: merchantKeys.size,
  };
}

export function selectHistoricalRepresentativeItem(
  inventory: PersonalProductEndpointInventory,
  historicalMerchantProductId: string,
  savedReceiptId: string
): PersonalProductInventoryItem | null {
  const rowKeys =
    inventory.itemKeysByMerchantProductId.get(historicalMerchantProductId) ?? [];
  const candidates = rowKeys
    .map((rowKey) => inventory.itemsByRowKey.get(rowKey))
    .filter((item): item is PersonalProductInventoryItem => item != null)
    .filter((item) => item.receiptId !== savedReceiptId)
    .filter((item) => !inventory.excludedDuplicateReceiptIds.has(item.receiptId));

  candidates.sort(
    (left, right) =>
      right.occurredAt - left.occurredAt ||
      right.receiptId.localeCompare(left.receiptId) ||
      right.sourceIndex - left.sourceIndex
  );

  return candidates[0] ?? null;
}

export type ClassifyPersonalIdentityCandidatePairInput = {
  inventory: PersonalProductEndpointInventory;
  currentItem: PersonalProductInventoryItem;
  historicalItem: PersonalProductInventoryItem;
  savedReceiptId: string;
};

export function classifyPersonalIdentityCandidatePair(
  input: ClassifyPersonalIdentityCandidatePairInput
): {
  classification: PersonalIdentityCandidateClassification;
  similarity: number;
  prospectivePurchaseEventCount: number;
  prospectiveMerchantCount: number;
  valueReason: 'cross_merchant_history' | 'repeat_purchase_history';
} {
  const { inventory, currentItem, historicalItem, savedReceiptId } = input;

  if (currentItem.receiptId !== savedReceiptId) {
    return {
      classification: 'no_match',
      similarity: 0,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  if (
    currentItem.merchantProductId === historicalItem.merchantProductId ||
    (currentItem.skuKey &&
      historicalItem.skuKey &&
      currentItem.skuKey === historicalItem.skuKey)
  ) {
    return {
      classification: 'automatic_exact',
      similarity: 1,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  if (
    !inventoryItemHasUsableMerchantEndpoint(currentItem, inventory) ||
    !inventoryItemHasUsableMerchantEndpoint(historicalItem, inventory)
  ) {
    return {
      classification: 'no_match',
      similarity: 0,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  const currentEndpoint = inventory.endpointsById.get(currentItem.merchantProductId);
  const historicalEndpoint = inventory.endpointsById.get(
    historicalItem.merchantProductId
  );
  if (!currentEndpoint || !historicalEndpoint) {
    return {
      classification: 'no_match',
      similarity: 0,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  const relationship = evaluatePersonalRelationshipWithSnapshot(
    inventory.decisionRows,
    inventory.snapshot,
    currentItem.merchantProductId,
    historicalItem.merchantProductId
  );
  if (relationship.kind !== 'none') {
    return {
      classification: 'no_match',
      similarity: 0,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  const currentAttrs = currentItem.attributes ?? emptyProductAttributes();
  const historicalAttrs = historicalItem.attributes ?? emptyProductAttributes();
  const compatibility = attributesAreCompatible(
    currentAttrs,
    historicalAttrs,
    currentItem.rawName || currentItem.displayName,
    historicalItem.rawName || historicalItem.displayName
  );
  if (!compatibility.ok) {
    return {
      classification: 'no_match',
      similarity: 0,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  if (
    findVariantTokenConflicts(
      currentItem.rawName || currentItem.displayName,
      historicalItem.rawName || historicalItem.displayName
    ).length > 0
  ) {
    return {
      classification: 'no_match',
      similarity: 0,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  if (
    !hasMeaningfulPersonalIdentityStructuralEvidence(currentAttrs) ||
    !hasMeaningfulPersonalIdentityStructuralEvidence(historicalAttrs) ||
    currentEndpoint.structuralSignature !== historicalEndpoint.structuralSignature
  ) {
    return {
      classification: 'no_match',
      similarity: 0,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  const similarity = combinedNameSimilarity(
    currentItem.displayName,
    historicalItem.displayName
  );
  if (similarity < PROMPT_NAME_SIMILARITY_THRESHOLD) {
    return {
      classification: 'no_match',
      similarity,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  if (!brandsAreCompatible(currentItem.brand, historicalItem.brand)) {
    return {
      classification: 'no_match',
      similarity,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  if (!savedReceiptQualifiesAsCurrentCanonicalEvent(inventory, savedReceiptId)) {
    return {
      classification: 'no_match',
      similarity,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  if (
    !currentMerchantProductIncludesSavedReceipt(
      inventory,
      currentItem.merchantProductId,
      savedReceiptId
    )
  ) {
    return {
      classification: 'no_match',
      similarity,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  if (
    !historicalMerchantProductHasCanonicalEvent(
      inventory,
      historicalItem.merchantProductId,
      savedReceiptId
    )
  ) {
    return {
      classification: 'no_match',
      similarity,
      prospectivePurchaseEventCount: 0,
      prospectiveMerchantCount: 0,
      valueReason: 'repeat_purchase_history',
    };
  }

  const value = countProspectiveCandidatePurchaseEvents(
    inventory,
    currentItem.merchantProductId,
    historicalItem.merchantProductId
  );
  if (value.prospectivePurchaseEventCount < 2) {
    return {
      classification: 'no_match',
      similarity,
      prospectivePurchaseEventCount: value.prospectivePurchaseEventCount,
      prospectiveMerchantCount: value.prospectiveMerchantCount,
      valueReason: 'repeat_purchase_history',
    };
  }

  const valueReason =
    currentEndpoint.merchantScopeKey !== historicalEndpoint.merchantScopeKey
      ? 'cross_merchant_history'
      : 'repeat_purchase_history';

  return {
    classification: 'prompt_candidate',
    similarity,
    prospectivePurchaseEventCount: value.prospectivePurchaseEventCount,
    prospectiveMerchantCount: value.prospectiveMerchantCount,
    valueReason,
  };
}

export type RankablePersonalIdentityPromptCandidate = {
  currentItem: PersonalProductInventoryItem;
  historicalItem: PersonalProductInventoryItem;
  similarity: number;
  prospectivePurchaseEventCount: number;
  prospectiveMerchantCount: number;
  valueReason: 'cross_merchant_history' | 'repeat_purchase_history';
};

export function rankPersonalIdentityPromptCandidates(
  candidates: readonly RankablePersonalIdentityPromptCandidate[],
  inventory: PersonalProductEndpointInventory
): RankablePersonalIdentityPromptCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftCross =
      left.valueReason === 'cross_merchant_history' ? 1 : 0;
    const rightCross =
      right.valueReason === 'cross_merchant_history' ? 1 : 0;
    if (leftCross !== rightCross) return rightCross - leftCross;

    if (
      left.prospectivePurchaseEventCount !== right.prospectivePurchaseEventCount
    ) {
      return (
        right.prospectivePurchaseEventCount - left.prospectivePurchaseEventCount
      );
    }

    if (left.similarity !== right.similarity) {
      return right.similarity - left.similarity;
    }

    if (left.historicalItem.occurredAt !== right.historicalItem.occurredAt) {
      return right.historicalItem.occurredAt - left.historicalItem.occurredAt;
    }

    const leftEndpoint = inventory.endpointsById.get(left.currentItem.merchantProductId);
    const rightEndpoint = inventory.endpointsById.get(
      right.currentItem.merchantProductId
    );
    const historicalLeft = inventory.endpointsById.get(
      left.historicalItem.merchantProductId
    );
    const historicalRight = inventory.endpointsById.get(
      right.historicalItem.merchantProductId
    );
    if (leftEndpoint && historicalLeft && rightEndpoint && historicalRight) {
      const leftPair = normalizePersonalProductIdentityPair(
        leftEndpoint,
        historicalLeft
      );
      const rightPair = normalizePersonalProductIdentityPair(
        rightEndpoint,
        historicalRight
      );
      if (leftPair.ok && rightPair.ok) {
        const leftKey = `${leftPair.pair.leftMerchantProductId}\0${leftPair.pair.rightMerchantProductId}`;
        const rightKey = `${rightPair.pair.leftMerchantProductId}\0${rightPair.pair.rightMerchantProductId}`;
        if (leftKey !== rightKey) return leftKey.localeCompare(rightKey);
      }
    }

    return (
      left.currentItem.receiptId.localeCompare(right.currentItem.receiptId) ||
      left.currentItem.sourceIndex - right.currentItem.sourceIndex
    );
  });
}

export function buildPersonalIdentityPromptCandidateV1(input: {
  savedReceiptId: string;
  currentItem: PersonalProductInventoryItem;
  historicalItem: PersonalProductInventoryItem;
  inventory: PersonalProductEndpointInventory;
  similarity: number;
  valueReason: 'cross_merchant_history' | 'repeat_purchase_history';
  prospectivePurchaseEventCount: number;
  prospectiveMerchantCount: number;
}): PersonalIdentityPromptCandidateV1 | null {
  const currentEndpoint = input.inventory.endpointsById.get(
    input.currentItem.merchantProductId
  );
  const historicalEndpoint = input.inventory.endpointsById.get(
    input.historicalItem.merchantProductId
  );
  if (!currentEndpoint || !historicalEndpoint) return null;

  const normalizedPair = normalizePersonalProductIdentityPair(
    currentEndpoint,
    historicalEndpoint
  );
  if (!normalizedPair.ok) return null;

  return {
    version: PERSONAL_IDENTITY_CANDIDATE_VERSION,
    savedReceiptId: input.savedReceiptId,
    pair: {
      leftMerchantProductId: normalizedPair.pair.leftMerchantProductId,
      rightMerchantProductId: normalizedPair.pair.rightMerchantProductId,
    },
    current: {
      receiptId: input.currentItem.receiptId,
      itemId: input.currentItem.itemId,
      sourceIndex: input.currentItem.sourceIndex,
      endpoint: currentEndpoint,
      displayName: input.currentItem.displayName,
      merchantName: input.currentItem.merchantName,
      specificationLabel: input.currentItem.specificationLabel ?? null,
      brand: input.currentItem.brand,
    },
    historical: {
      representativeReceiptId: input.historicalItem.receiptId,
      representativeItemId: input.historicalItem.itemId,
      endpoint: historicalEndpoint,
      displayName: input.historicalItem.displayName,
      merchantName: input.historicalItem.merchantName,
      specificationLabel: input.historicalItem.specificationLabel ?? null,
      brand: input.historicalItem.brand,
      lastPurchasedAt: input.historicalItem.occurredAt,
    },
    evidence: {
      normalizedNameSimilarity: input.similarity,
      structuralSignature: currentEndpoint.structuralSignature,
      brandAgreement: brandAgreementLabel(
        input.currentItem.brand,
        input.historicalItem.brand
      ),
      variantConflictCount: 0,
      automaticExactEvidence: 'none',
    },
    value: {
      reason: input.valueReason,
      prospectivePurchaseEventCount: input.prospectivePurchaseEventCount,
      prospectiveMerchantCount: input.prospectiveMerchantCount,
    },
  };
}

export function findPersonalIdentityPromptCandidatesForInventory(
  inventory: PersonalProductEndpointInventory,
  savedReceiptId: string
): RankablePersonalIdentityPromptCandidate[] {
  const currentItems = [...inventory.itemsByRowKey.values()].filter(
    (item) =>
      item.receiptId === savedReceiptId &&
      inventoryItemHasUsableMerchantEndpoint(item, inventory)
  );

  const rankable: RankablePersonalIdentityPromptCandidate[] = [];
  const seenPairKeys = new Set<string>();

  for (const currentItem of currentItems) {
    for (const historicalItem of inventory.itemsByRowKey.values()) {
      if (historicalItem.receiptId === savedReceiptId) continue;
      if (currentItem.merchantProductId === historicalItem.merchantProductId) {
        continue;
      }
      const pairKey = [
        currentItem.merchantProductId,
        historicalItem.merchantProductId,
      ]
        .sort()
        .join('\0');
      if (seenPairKeys.has(pairKey)) continue;

      const classified = classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem,
        historicalItem,
        savedReceiptId,
      });
      if (classified.classification !== 'prompt_candidate') continue;

      const representative = selectHistoricalRepresentativeItem(
        inventory,
        historicalItem.merchantProductId,
        savedReceiptId
      );
      if (!representative) continue;

      seenPairKeys.add(pairKey);
      rankable.push({
        currentItem,
        historicalItem: representative,
        similarity: classified.similarity,
        prospectivePurchaseEventCount: classified.prospectivePurchaseEventCount,
        prospectiveMerchantCount: classified.prospectiveMerchantCount,
        valueReason: classified.valueReason,
      });
    }
  }

  return rankPersonalIdentityPromptCandidates(rankable, inventory);
}

export async function findPersonalIdentityPromptCandidateForSavedReceipt(
  savedReceiptId: string,
  db: PersonalProductEndpointInventoryDatabase,
  stamp?: LocalOwnershipStamp,
  deps: FindPersonalIdentityPromptCandidateDeps = {}
): Promise<PersonalIdentityPromptCandidateResult> {
  const inventoryResult = await (deps.loadInventory ??
    ((database, ownership) =>
      loadPersonalProductEndpointInventoryWithDb(database, ownership, deps)))(
    db,
    stamp
  );

  if (inventoryResult.status !== 'ready') {
    return inventoryResult;
  }

  const ranked = findPersonalIdentityPromptCandidatesForInventory(
    inventoryResult.inventory,
    savedReceiptId
  );
  const top = ranked[0];
  if (!top) {
    return { status: 'none' };
  }

  const candidate = buildPersonalIdentityPromptCandidateV1({
    savedReceiptId,
    currentItem: top.currentItem,
    historicalItem: top.historicalItem,
    inventory: inventoryResult.inventory,
    similarity: top.similarity,
    valueReason: top.valueReason,
    prospectivePurchaseEventCount: top.prospectivePurchaseEventCount,
    prospectiveMerchantCount: top.prospectiveMerchantCount,
  });

  if (!candidate) {
    return { status: 'none' };
  }

  return { status: 'candidate', candidate };
}

export { buildPersonalProductEndpointInventory };
export type { BuildPersonalProductEndpointInventoryInput };
