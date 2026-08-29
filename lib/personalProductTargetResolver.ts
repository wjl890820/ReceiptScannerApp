/**
 * G4-2B — personal_product ProductDetail target resolver.
 *
 * Consumes G4-2A inventory as the single membership truth source.
 */

import type { PersonalExactAuthority } from './personalProductIdentityContract';
import {
  buildPersonalDecisionGraph,
  collectOwnerGraphMerchantProductIds,
  derivePersonalExactAuthority,
} from './personalProductIdentityContract';
import {
  buildPersonalProductInventoryRowKey,
  loadPersonalProductEndpointInventoryWithDb,
  type LoadPersonalProductEndpointInventoryDeps,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventoryDatabase,
} from './personalProductEndpointInventory';
import type { LocalOwnershipStamp } from './receiptOwnershipContext';

export type ResolvedPersonalProductTarget = {
  requestedTarget: {
    type: 'personal_product';
    key: string;
  };
  canonicalTarget: {
    type: 'personal_product';
    key: string;
  };
  ownerKey: string;
  authority: PersonalExactAuthority;
  anchorMerchantProductId: string;
  memberMerchantProductIds: readonly string[];
  authorizedRowKeys: ReadonlySet<string>;
  inventory: PersonalProductEndpointInventory;
};

export type ResolvePersonalProductTargetResult =
  | {
      status: 'ready';
      resolved: ResolvedPersonalProductTarget;
    }
  | {
      status:
        | 'owner_unavailable'
        | 'current_endpoint_context_incomplete'
        | 'personal_product_not_found'
        | 'personal_product_not_authorized'
        | 'personal_product_corrupt'
        | 'personal_product_stale';
      reason?: string;
    };

function sortedMembers(members: readonly string[]): string[] {
  return [...members].sort();
}

function buildAuthorizedRowKeys(
  inventory: PersonalProductEndpointInventory,
  memberMerchantProductIds: readonly string[]
):
  | { ok: true; authorizedRowKeys: ReadonlySet<string> }
  | { ok: false; reason: string } {
  const memberSet = new Set(memberMerchantProductIds);
  const authorizedRowKeys = new Set<string>();

  for (const merchantProductId of memberMerchantProductIds) {
    const rowKeys =
      inventory.itemKeysByMerchantProductId.get(merchantProductId) ?? [];
    for (const rowKey of rowKeys) {
      const item = inventory.itemsByRowKey.get(rowKey);
      if (!item) {
        return { ok: false, reason: 'inventory_row_missing_for_member_key' };
      }
      if (!memberSet.has(item.merchantProductId)) {
        return {
          ok: false,
          reason: 'inventory_row_merchant_product_not_in_component',
        };
      }
      authorizedRowKeys.add(rowKey);
    }
  }

  return { ok: true, authorizedRowKeys };
}

export function resolvePersonalProductTargetFromInventory(
  requestedKey: string,
  inventory: PersonalProductEndpointInventory
): ResolvePersonalProductTargetResult {
  const trimmedKey = requestedKey.trim();
  if (!trimmedKey) {
    return { status: 'personal_product_not_found' };
  }

  if (!inventory.snapshot.has(trimmedKey)) {
    return { status: 'personal_product_not_found' };
  }

  const requestedEndpoint = inventory.snapshot.get(trimmedKey);
  if (requestedEndpoint == null) {
    return { status: 'personal_product_stale', reason: 'requested_endpoint_absent' };
  }

  const graphResult = buildPersonalDecisionGraph(
    inventory.decisionRows,
    inventory.snapshot,
    { requiredIds: collectOwnerGraphMerchantProductIds(inventory.decisionRows) }
  );
  if (!graphResult.ok) {
    return {
      status: 'current_endpoint_context_incomplete',
      reason: graphResult.code,
    };
  }

  if (graphResult.graph.corruptMerchantProductIds.has(trimmedKey)) {
    return { status: 'personal_product_corrupt' };
  }

  const authority = derivePersonalExactAuthority(
    graphResult.graph,
    trimmedKey
  );
  if (!authority) {
    return { status: 'personal_product_not_authorized' };
  }

  if (
    authority.identityLevel !== 'product_exact' ||
    authority.sourceTier !== 'personal_manual' ||
    authority.authority.kind !== 'personal_product'
  ) {
    return { status: 'personal_product_not_authorized' };
  }

  const memberMerchantProductIds = sortedMembers(
    authority.authority.memberMerchantProductIds
  );
  if (!memberMerchantProductIds.includes(trimmedKey)) {
    return { status: 'personal_product_not_authorized' };
  }

  for (const memberId of memberMerchantProductIds) {
    if (graphResult.graph.corruptMerchantProductIds.has(memberId)) {
      return { status: 'personal_product_corrupt' };
    }
    if (!inventory.snapshot.has(memberId)) {
      return { status: 'personal_product_stale', reason: 'member_missing_from_snapshot' };
    }
    if (inventory.snapshot.get(memberId) == null) {
      return { status: 'personal_product_stale', reason: 'member_endpoint_absent' };
    }
    if (!inventory.endpointsById.has(memberId)) {
      return { status: 'personal_product_stale', reason: 'member_endpoint_missing' };
    }
  }

  const authorized = buildAuthorizedRowKeys(inventory, memberMerchantProductIds);
  if (!authorized.ok) {
    return {
      status: 'current_endpoint_context_incomplete',
      reason: authorized.reason,
    };
  }

  const anchorMerchantProductId = authority.authority.anchorMerchantProductId;

  return {
    status: 'ready',
    resolved: {
      requestedTarget: { type: 'personal_product', key: trimmedKey },
      canonicalTarget: { type: 'personal_product', key: anchorMerchantProductId },
      ownerKey: inventory.ownerKey,
      authority,
      anchorMerchantProductId,
      memberMerchantProductIds,
      authorizedRowKeys: authorized.authorizedRowKeys,
      inventory,
    },
  };
}

export function assertPersonalProductContextMatchesTarget(
  target: { type: 'personal_product'; key: string },
  context: ResolvedPersonalProductTarget
): boolean {
  return context.memberMerchantProductIds.includes(target.key);
}

export type ResolvePersonalProductTargetWithDbDeps =
  LoadPersonalProductEndpointInventoryDeps & {
    resolveStamp?: () => Promise<LocalOwnershipStamp>;
    loadInventory?: typeof loadPersonalProductEndpointInventoryWithDb;
  };

export async function resolvePersonalProductTargetWithDb(
  requestedKey: string,
  db: PersonalProductEndpointInventoryDatabase,
  stamp?: LocalOwnershipStamp,
  deps: ResolvePersonalProductTargetWithDbDeps = {}
): Promise<ResolvePersonalProductTargetResult> {
  const inventoryResult = await (deps.loadInventory ??
    ((database, ownership) =>
      loadPersonalProductEndpointInventoryWithDb(database, ownership, deps)))(
    db,
    stamp ??
      (deps.resolveStamp
        ? await deps.resolveStamp()
        : await (
            await import('./receiptOwnershipContext')
          ).resolveOwnershipStamp())
  );

  if (inventoryResult.status === 'owner_unavailable') {
    return { status: 'owner_unavailable' };
  }
  if (inventoryResult.status !== 'ready') {
    return {
      status: 'current_endpoint_context_incomplete',
      reason: inventoryResult.reason,
    };
  }

  return resolvePersonalProductTargetFromInventory(
    requestedKey,
    inventoryResult.inventory
  );
}

export function isAuthorizedPersonalInventoryRow(
  resolved: ResolvedPersonalProductTarget,
  receiptId: string,
  sourceIndex: number,
  merchantProductId?: string
): boolean {
  const rowKey = buildPersonalProductInventoryRowKey(receiptId, sourceIndex);
  if (!resolved.authorizedRowKeys.has(rowKey)) {
    return false;
  }
  if (merchantProductId == null) {
    return true;
  }
  const item = resolved.inventory.itemsByRowKey.get(rowKey);
  return (
    item != null &&
    resolved.memberMerchantProductIds.includes(item.merchantProductId) &&
    item.merchantProductId === merchantProductId
  );
}
