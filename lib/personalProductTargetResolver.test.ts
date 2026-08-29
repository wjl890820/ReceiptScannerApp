import {
  buildPersonalProductEndpointInventory,
  buildPersonalProductInventoryRowKey,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import {
  buildPersonalMerchantProductEndpointV1,
  type PersonalProductCurrentEndpointSnapshot,
  type StoredPersonalProductIdentityDecision,
} from './personalProductIdentityContract';
import { buildProductAttributes } from './productIdentityContract';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import type { ReceiptRow } from './db';
import {
  resolvePersonalProductTargetFromInventory,
} from './personalProductTargetResolver';

const OWNER = 'user:resolver-owner';

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow {
  return {
    id,
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_000_000,
    image_uri: 'file://x',
    merchant_raw: 'Store',
    merchant_normalized: 'store',
    merchant_type: 'convenience',
    total: 500,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: '{}',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: OWNER.slice('user:'.length),
    installation_id: null,
    ...overrides,
  };
}

function itemRow(
  overrides: Partial<PersonalProductEndpointInventorySourceRow> = {}
): PersonalProductEndpointInventorySourceRow {
  return {
    receiptId: 'r1',
    itemId: 'i1',
    sourceIndex: 0,
    occurredAt: 1_700_000_000_000,
    merchantRaw: 'AEON',
    merchantNormalized: 'aeon',
    displayName: 'コカ・コーラ 500ml',
    rawName: 'コカ・コーラ 500ml',
    lineTotal: 150,
    purchaseQuantity: 1,
    skuKey: null,
    brand: null,
    ...overrides,
  };
}

function storedDecisionFromInventory(
  inventory: PersonalProductEndpointInventory,
  leftId: string,
  rightId: string,
  decision: StoredPersonalProductIdentityDecision['decision'] = 'same_product'
): StoredPersonalProductIdentityDecision {
  const left = inventory.endpointsById.get(leftId)!;
  const right = inventory.endpointsById.get(rightId)!;
  const [leftEndpoint, rightEndpoint, leftMerchantProductId, rightMerchantProductId] =
    left.merchantProductId < right.merchantProductId
      ? [left, right, left.merchantProductId, right.merchantProductId]
      : [right, left, right.merchantProductId, left.merchantProductId];
  return {
    ownerKey: OWNER,
    leftMerchantProductId,
    rightMerchantProductId,
    leftMerchantScopeKey: leftEndpoint.merchantScopeKey,
    rightMerchantScopeKey: rightEndpoint.merchantScopeKey,
    leftComparisonKey: leftEndpoint.comparisonKey,
    rightComparisonKey: rightEndpoint.comparisonKey,
    leftStructuralSignature: leftEndpoint.structuralSignature,
    rightStructuralSignature: rightEndpoint.structuralSignature,
    identityPipelineVersion: leftEndpoint.identityPipelineVersion,
    decision,
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildCrossStoreInventory(
  excludedDuplicateReceiptIds: ReadonlySet<string> = new Set()
): PersonalProductEndpointInventory {
  const store = createMemoryProductIdentityStore();
  const sourceRows = [
    itemRow({
      receiptId: 'r-aeon',
      itemId: 'r-aeon:0',
      sourceIndex: 0,
      merchantRaw: 'AEON',
      merchantNormalized: 'aeon',
    }),
    itemRow({
      receiptId: 'r-york',
      itemId: 'r-york:0',
      sourceIndex: 0,
      merchantRaw: 'York',
      merchantNormalized: 'york',
    }),
  ];
  const receipts = [
    receipt('r-aeon'),
    receipt('r-york', { merchant_raw: 'York', merchant_normalized: 'york' }),
  ];

  const preliminary = buildPersonalProductEndpointInventory({
    ownerKey: OWNER,
    sourceRows,
    receipts,
    decisionRows: [],
    store,
  });
  if (preliminary.status !== 'ready') {
    throw new Error(`preliminary inventory failed: ${JSON.stringify(preliminary)}`);
  }
  const endpointIds = [...preliminary.inventory.endpointsById.keys()].sort();
  const mpA = endpointIds[0]!;
  const mpB = endpointIds[1]!;

  const result = buildPersonalProductEndpointInventory({
    ownerKey: OWNER,
    sourceRows,
    receipts,
    decisionRows: [storedDecisionFromInventory(preliminary.inventory, mpA, mpB)],
    store,
    excludedDuplicateReceiptIds,
  });
  if (result.status !== 'ready') {
    throw new Error(`inventory build failed: ${JSON.stringify(result)}`);
  }
  return result.inventory;
}

describe('G4-2B personalProductTargetResolver', () => {
  it('resolves active component by anchor key to canonical anchor', () => {
    const inventory = buildCrossStoreInventory();
    const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
    const result = resolvePersonalProductTargetFromInventory(anchorId, inventory);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.resolved.canonicalTarget).toEqual({
      type: 'personal_product',
      key: anchorId,
    });
    expect(result.resolved.anchorMerchantProductId).toBe(anchorId);
    expect(result.resolved.memberMerchantProductIds).toHaveLength(2);
  });

  it('resolves older member locator to current anchor', () => {
    const inventory = buildCrossStoreInventory();
    const [anchorId, memberId] = [...inventory.endpointsById.keys()].sort();
    const result = resolvePersonalProductTargetFromInventory(memberId!, inventory);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.resolved.requestedTarget.key).toBe(memberId);
    expect(result.resolved.canonicalTarget.key).toBe(anchorId);
  });

  it('returns not_found when target is absent from inventory snapshot', () => {
    const inventory = buildCrossStoreInventory();
    const result = resolvePersonalProductTargetFromInventory('mp_unrelated', inventory);
    expect(result.status).toBe('personal_product_not_found');
  });

  it('returns unauthorized for current endpoint outside positive component', () => {
    const store = createMemoryProductIdentityStore();
    const inventoryResult = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [
        itemRow({
          receiptId: 'r-solo',
          itemId: 'r-solo:0',
          merchantRaw: 'AEON',
          merchantNormalized: 'aeon',
        }),
      ],
      receipts: [receipt('r-solo')],
      decisionRows: [],
      store,
    });
    expect(inventoryResult.status).toBe('ready');
    if (inventoryResult.status !== 'ready') return;
    const soloId = [...inventoryResult.inventory.endpointsById.keys()][0]!;
    const result = resolvePersonalProductTargetFromInventory(
      soloId,
      inventoryResult.inventory
    );
    expect(result.status).toBe('personal_product_not_authorized');
  });

  it('returns stale when member endpoint is absent in snapshot', () => {
    const inventory = buildCrossStoreInventory();
    const staleSnapshot = new Map(inventory.snapshot);
    const memberId = [...inventory.endpointsById.keys()].sort()[1]!;
    staleSnapshot.set(memberId, null);
    const staleInventory: PersonalProductEndpointInventory = {
      ...inventory,
      snapshot: staleSnapshot,
    };
    const result = resolvePersonalProductTargetFromInventory(memberId, staleInventory);
    expect(result.status).toBe('personal_product_stale');
  });

  it('returns corrupt for contradictory component graph', () => {
    const store = createMemoryProductIdentityStore();
    const sourceRows = [
      itemRow({ receiptId: 'r1', itemId: 'r1:0', merchantRaw: 'AEON', merchantNormalized: 'aeon' }),
      itemRow({ receiptId: 'r2', itemId: 'r2:0', merchantRaw: 'York', merchantNormalized: 'york' }),
      itemRow({ receiptId: 'r3', itemId: 'r3:0', merchantRaw: 'Seven', merchantNormalized: 'seven' }),
    ];
    const receipts = [receipt('r1'), receipt('r2'), receipt('r3')];
    const preliminary = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows,
      receipts,
      decisionRows: [],
      store,
    });
    expect(preliminary.status).toBe('ready');
    if (preliminary.status !== 'ready') return;
    const [mpA, mpB, mpC] = [...preliminary.inventory.endpointsById.keys()].sort();

    const inventoryResult = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows,
      receipts,
      decisionRows: [
        storedDecisionFromInventory(preliminary.inventory, mpA!, mpB!),
        storedDecisionFromInventory(preliminary.inventory, mpB!, mpC!),
        storedDecisionFromInventory(
          preliminary.inventory,
          mpA!,
          mpC!,
          'not_same_product'
        ),
      ],
      store,
    });
    expect(inventoryResult.status).toBe('ready');
    if (inventoryResult.status !== 'ready') return;
    const result = resolvePersonalProductTargetFromInventory(
      mpA!,
      inventoryResult.inventory
    );
    expect(result.status).toBe('personal_product_corrupt');
  });

  it('builds authorized row keys across component members', () => {
    const inventory = buildCrossStoreInventory();
    const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
    const result = resolvePersonalProductTargetFromInventory(anchorId, inventory);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(
      result.resolved.authorizedRowKeys.has(
        buildPersonalProductInventoryRowKey('r-aeon', 0)
      )
    ).toBe(true);
    expect(
      result.resolved.authorizedRowKeys.has(
        buildPersonalProductInventoryRowKey('r-york', 0)
      )
    ).toBe(true);
    expect(result.resolved.authorizedRowKeys.size).toBe(2);
  });

  it('isolates owner inventory membership', () => {
    const ownerAInventory = buildCrossStoreInventory();
    const ownerBStore = createMemoryProductIdentityStore();
    const ownerBResult = buildPersonalProductEndpointInventory({
      ownerKey: 'user:other-owner',
      sourceRows: [
        itemRow({
          receiptId: 'r-other',
          merchantRaw: 'Lawson',
          merchantNormalized: 'lawson',
        }),
      ],
      receipts: [receipt('r-other', { user_id: 'other-owner' })],
      decisionRows: [],
      store: ownerBStore,
    });
    expect(ownerBResult.status).toBe('ready');
    if (ownerBResult.status !== 'ready') return;

    const ownerAResult = resolvePersonalProductTargetFromInventory(
      [...ownerAInventory.endpointsById.keys()].sort()[0]!,
      ownerAInventory
    );
    const ownerBResolve = resolvePersonalProductTargetFromInventory(
      [...ownerAInventory.endpointsById.keys()].sort()[0]!,
      ownerBResult.inventory
    );
    expect(ownerAResult.status).toBe('ready');
    expect(ownerBResolve.status).toBe('personal_product_not_found');
  });
});
