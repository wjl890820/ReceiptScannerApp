/**
 * G4-2C — post-save personal identity confirmation coordinator.
 *
 * Revalidates G4-2A candidates before every write, persists through G4-1 only,
 * and reloads G4-2B personal history/price context after SAME.
 */

import {
  buildPersonalIdentityPromptCandidateV1,
  findPersonalIdentityPromptCandidatesForInventory,
  type PersonalIdentityPromptCandidateV1,
} from './personalProductIdentityCandidateService';
import {
  evaluatePersonalRelationshipWithSnapshot,
  type PersonalMerchantProductEndpointV1,
  type PersonalProductIdentityDecision,
} from './personalProductIdentityContract';
import {
  loadPersonalProductEndpointInventoryWithDb,
  type LoadPersonalProductEndpointInventoryDeps,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventoryDatabase,
} from './personalProductEndpointInventory';
import {
  recordPersonalProductIdentityDecisionWithDb,
  type PersonalProductIdentityDatabase,
  type RecordPersonalDecisionResult,
} from './personalProductIdentityRepository';
import {
  resolvePersonalProductTargetFromInventory,
  type ResolvedPersonalProductTarget,
} from './personalProductTargetResolver';
import { interpretProductPriceChange } from './productPriceChangeInterpretation';
import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import { loadProductHistoryWithDb } from './productHistory';
import { loadProductPriceHistoryWithDb } from './productPriceHistory';
import type { Locale } from './i18n';
import type { LocalOwnershipStamp } from './receiptOwnershipContext';

export type PersonalIdentityConfirmationChoice = PersonalProductIdentityDecision;

export type PersonalIdentityConfirmationFeedback =
  | {
      kind: 'exact_price';
      target: { type: 'personal_product'; key: string };
      purchaseOccurrenceCount: number;
      merchantCount: number;
      interpretation: ProductPriceChangeInterpretation & { status: 'available' };
    }
  | {
      kind: 'history_unlocked';
      target: { type: 'personal_product'; key: string } | null;
      purchaseOccurrenceCount: number | null;
      merchantCount: number | null;
    };

export type PersonalIdentityConfirmationResult =
  | {
      status: 'saved';
      choice: PersonalIdentityConfirmationChoice;
      feedback?: PersonalIdentityConfirmationFeedback;
    }
  | { status: 'stale_candidate' }
  | {
      status:
        | 'owner_unavailable'
        | 'current_endpoint_context_incomplete'
        | 'decision_conflict'
        | 'write_failed';
      reason?: string;
    };

export type PersonalIdentityConfirmationDatabase =
  PersonalProductEndpointInventoryDatabase & PersonalProductIdentityDatabase;

export type PersonalIdentityConfirmationDeps =
  LoadPersonalProductEndpointInventoryDeps & {
    loadInventory?: (
      db: PersonalProductEndpointInventoryDatabase,
      stamp?: LocalOwnershipStamp
    ) => Promise<
      | { status: 'ready'; inventory: PersonalProductEndpointInventory }
      | { status: 'owner_unavailable' }
      | { status: 'current_endpoint_context_incomplete'; reason?: string }
    >;
    recordDecision?: typeof recordPersonalProductIdentityDecisionWithDb;
    resolveTarget?: typeof resolvePersonalProductTargetFromInventory;
    loadHistory?: typeof loadProductHistoryWithDb;
    loadPriceHistory?: typeof loadProductPriceHistoryWithDb;
    interpretPriceChange?: typeof interpretProductPriceChange;
    locale?: Locale;
  };

export function personalMerchantProductEndpointsAreExactlyEqual(
  left: PersonalMerchantProductEndpointV1,
  right: PersonalMerchantProductEndpointV1
): boolean {
  return (
    left.merchantProductId === right.merchantProductId &&
    left.merchantScopeKey === right.merchantScopeKey &&
    left.comparisonKey === right.comparisonKey &&
    left.structuralSignature === right.structuralSignature &&
    left.identityPipelineVersion === right.identityPipelineVersion
  );
}

export function displayedPersonalIdentityCandidateMatchesFresh(
  displayed: PersonalIdentityPromptCandidateV1,
  fresh: PersonalIdentityPromptCandidateV1
): boolean {
  if (displayed.savedReceiptId !== fresh.savedReceiptId) return false;
  if (
    displayed.pair.leftMerchantProductId !== fresh.pair.leftMerchantProductId ||
    displayed.pair.rightMerchantProductId !== fresh.pair.rightMerchantProductId
  ) {
    return false;
  }

  if (displayed.current.receiptId !== fresh.current.receiptId) return false;
  if (displayed.current.itemId !== fresh.current.itemId) return false;
  if (displayed.current.sourceIndex !== fresh.current.sourceIndex) return false;
  if (
    !personalMerchantProductEndpointsAreExactlyEqual(
      displayed.current.endpoint,
      fresh.current.endpoint
    )
  ) {
    return false;
  }

  if (
    displayed.historical.representativeReceiptId !==
    fresh.historical.representativeReceiptId
  ) {
    return false;
  }
  if (
    displayed.historical.representativeItemId !==
    fresh.historical.representativeItemId
  ) {
    return false;
  }
  if (
    !personalMerchantProductEndpointsAreExactlyEqual(
      displayed.historical.endpoint,
      fresh.historical.endpoint
    )
  ) {
    return false;
  }

  return true;
}

export function buildFreshTopPersonalIdentityCandidate(
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

export type RevalidateDisplayedPersonalIdentityCandidateResult =
  | {
      status: 'ready';
      inventory: PersonalProductEndpointInventory;
      freshCandidate: PersonalIdentityPromptCandidateV1;
    }
  | { status: 'stale_candidate' }
  | { status: 'owner_unavailable' }
  | { status: 'current_endpoint_context_incomplete'; reason?: string };

export async function revalidateDisplayedPersonalIdentityCandidate(
  displayed: PersonalIdentityPromptCandidateV1,
  db: PersonalProductEndpointInventoryDatabase,
  stamp?: LocalOwnershipStamp,
  deps: PersonalIdentityConfirmationDeps = {}
): Promise<RevalidateDisplayedPersonalIdentityCandidateResult> {
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

  const freshCandidate = buildFreshTopPersonalIdentityCandidate(
    inventoryResult.inventory,
    displayed.savedReceiptId
  );
  if (!freshCandidate) {
    return { status: 'stale_candidate' };
  }

  if (!displayedPersonalIdentityCandidateMatchesFresh(displayed, freshCandidate)) {
    return { status: 'stale_candidate' };
  }

  const relationship = evaluatePersonalRelationshipWithSnapshot(
    inventoryResult.inventory.decisionRows,
    inventoryResult.inventory.snapshot,
    freshCandidate.pair.leftMerchantProductId,
    freshCandidate.pair.rightMerchantProductId
  );
  if (relationship.kind !== 'none') {
    return { status: 'stale_candidate' };
  }

  return {
    status: 'ready',
    inventory: inventoryResult.inventory,
    freshCandidate,
  };
}

function mapWriteFailure(
  result: Extract<RecordPersonalDecisionResult, { ok: false }>
): PersonalIdentityConfirmationResult {
  if (result.code === 'owner_unavailable') {
    return { status: 'owner_unavailable' };
  }
  if (result.code === 'current_endpoint_context_incomplete') {
    return {
      status: 'current_endpoint_context_incomplete',
      reason: result.missingMerchantProductIds?.join(','),
    };
  }
  if (
    result.code === 'decision_conflict' ||
    result.code === 'personal_not_same_conflict' ||
    result.code === 'personal_same_component_conflict'
  ) {
    return {
      status: 'decision_conflict',
      reason: result.existingDecision,
    };
  }
  return { status: 'write_failed', reason: result.code };
}

function historyUnlockedFeedback(
  target: { type: 'personal_product'; key: string } | null,
  purchaseOccurrenceCount: number | null,
  merchantCount: number | null
): PersonalIdentityConfirmationFeedback {
  return {
    kind: 'history_unlocked',
    target,
    purchaseOccurrenceCount,
    merchantCount,
  };
}

function safeIdentitySavedFeedback(): PersonalIdentityConfirmationFeedback {
  return historyUnlockedFeedback(null, null, null);
}

async function buildSameProductFeedback(
  db: PersonalIdentityConfirmationDatabase,
  freshCandidate: PersonalIdentityPromptCandidateV1,
  deps: PersonalIdentityConfirmationDeps
): Promise<PersonalIdentityConfirmationFeedback> {
  try {
    const loadInventory =
      deps.loadInventory ??
      ((database, ownership) =>
        loadPersonalProductEndpointInventoryWithDb(database, ownership, deps));
    const resolveTarget =
      deps.resolveTarget ?? resolvePersonalProductTargetFromInventory;
    const loadHistory = deps.loadHistory ?? loadProductHistoryWithDb;
    const loadPriceHistory = deps.loadPriceHistory ?? loadProductPriceHistoryWithDb;
    const interpretPriceChange =
      deps.interpretPriceChange ?? interpretProductPriceChange;
    const locale = deps.locale ?? 'en';

    let postInventoryResult:
      | { status: 'ready'; inventory: PersonalProductEndpointInventory }
      | { status: 'owner_unavailable' }
      | { status: 'current_endpoint_context_incomplete'; reason?: string };
    try {
      postInventoryResult = await loadInventory(db);
    } catch {
      return safeIdentitySavedFeedback();
    }

    if (postInventoryResult.status !== 'ready') {
      return safeIdentitySavedFeedback();
    }

    let resolveResult: ReturnType<typeof resolvePersonalProductTargetFromInventory>;
    try {
      resolveResult = resolveTarget(
        freshCandidate.current.endpoint.merchantProductId,
        postInventoryResult.inventory
      );
    } catch {
      return safeIdentitySavedFeedback();
    }

    if (resolveResult.status !== 'ready') {
      return safeIdentitySavedFeedback();
    }

    const resolved: ResolvedPersonalProductTarget = resolveResult.resolved;
    const target = resolved.canonicalTarget;

    const [historyResult, priceResult] = await Promise.allSettled([
      loadHistory(db, target, {
        locale,
        personalProductContext: resolved,
      }),
      loadPriceHistory(db, target, {
        personalProductContext: resolved,
      }),
    ]);

    const historySummary =
      historyResult.status === 'fulfilled' && historyResult.value != null
        ? historyResult.value
        : null;

    if (!historySummary) {
      return historyUnlockedFeedback(target, null, null);
    }

    const purchaseOccurrenceCount = historySummary.purchaseOccurrenceCount;
    const merchantCount = historySummary.merchantCount;

    if (priceResult.status !== 'fulfilled') {
      return historyUnlockedFeedback(
        target,
        purchaseOccurrenceCount,
        merchantCount
      );
    }

    const interpretation = interpretPriceChange({
      history: priceResult.value,
      targetType: target.type,
      targetKey: target.key,
    });

    if (interpretation.status === 'available') {
      return {
        kind: 'exact_price',
        target,
        purchaseOccurrenceCount,
        merchantCount,
        interpretation,
      };
    }

    return historyUnlockedFeedback(target, purchaseOccurrenceCount, merchantCount);
  } catch {
    return safeIdentitySavedFeedback();
  }
}

export async function confirmPersonalIdentityCandidateWithDb(
  db: PersonalIdentityConfirmationDatabase,
  displayedCandidate: PersonalIdentityPromptCandidateV1,
  choice: PersonalIdentityConfirmationChoice,
  stamp?: LocalOwnershipStamp,
  deps: PersonalIdentityConfirmationDeps = {}
): Promise<PersonalIdentityConfirmationResult> {
  const revalidated = await revalidateDisplayedPersonalIdentityCandidate(
    displayedCandidate,
    db,
    stamp,
    deps
  );

  if (revalidated.status === 'stale_candidate') {
    return { status: 'stale_candidate' };
  }
  if (revalidated.status === 'owner_unavailable') {
    return { status: 'owner_unavailable' };
  }
  if (revalidated.status === 'current_endpoint_context_incomplete') {
    return {
      status: 'current_endpoint_context_incomplete',
      reason: revalidated.reason,
    };
  }

  const { inventory, freshCandidate } = revalidated;
  const recordDecision = deps.recordDecision ?? recordPersonalProductIdentityDecisionWithDb;

  let writeResult: RecordPersonalDecisionResult;
  try {
    writeResult = await recordDecision(
      db,
      inventory.ownerKey,
      freshCandidate.current.endpoint,
      freshCandidate.historical.endpoint,
      choice,
      { currentEndpoints: inventory.snapshot }
    );
  } catch {
    return { status: 'write_failed' };
  }

  if (!writeResult.ok) {
    return mapWriteFailure(writeResult);
  }

  if (choice !== 'same_product') {
    return { status: 'saved', choice };
  }

  let feedback: PersonalIdentityConfirmationFeedback;
  try {
    feedback = await buildSameProductFeedback(db, freshCandidate, deps);
  } catch {
    feedback = safeIdentitySavedFeedback();
  }
  return { status: 'saved', choice, feedback };
}
