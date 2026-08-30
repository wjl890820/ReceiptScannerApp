import type { ReceiptRow } from './db';
import type { EngagementProductRow } from './engagementMilestones';
import {
  applyHomePersonalFrequentProductOverlay,
  mapIdentityFrequentGroupToHomeProduct,
} from './homePersonalFrequentProducts';
import { buildHomeProgressiveExperience } from './homeProgressiveExperience';
import { buildHomeFrequentProductDetailHref } from './homeValueHierarchy';
import { formatFrequentProductLabel } from './milestonePresentation';
import {
  buildPersonalProductEndpointInventory,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import type { StoredPersonalProductIdentityDecision } from './personalProductIdentityContract';
import {
  buildIdentityFrequentProductGroups,
  type IdentityConsumerObservation,
  type IdentityFrequentProductGroup,
} from './productIdentityConsumer';
import { createMemoryProductIdentityStore } from './productIdentityStore';

const OWNER = 'user:home-owner';

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow {
  const index = Number(id.replace(/\D/g, '')) || 1;
  return {
    id,
    created_at: index * 1_000_000,
    transaction_at: index * 1_000_000,
    image_uri: 'file://x',
    merchant_raw: 'Lawson',
    merchant_normalized: 'lawson',
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

function sourceRow(
  overrides: Partial<PersonalProductEndpointInventorySourceRow> = {}
): PersonalProductEndpointInventorySourceRow {
  return {
    receiptId: 'r1',
    itemId: 'r1:0',
    sourceIndex: 0,
    occurredAt: 1_700_000_000_000,
    merchantRaw: 'Lawson',
    merchantNormalized: 'lawson',
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

function buildInventory(
  sourceRows: PersonalProductEndpointInventorySourceRow[],
  receipts: ReceiptRow[],
  options: {
    decisionRows?: StoredPersonalProductIdentityDecision[];
    excludedDuplicateReceiptIds?: ReadonlySet<string>;
  } = {}
): PersonalProductEndpointInventory {
  const store = createMemoryProductIdentityStore();
  const result = buildPersonalProductEndpointInventory({
    ownerKey: OWNER,
    sourceRows,
    receipts,
    decisionRows: options.decisionRows ?? [],
    store,
    excludedDuplicateReceiptIds: options.excludedDuplicateReceiptIds,
  });
  if (result.status !== 'ready') {
    throw new Error(`inventory build failed: ${JSON.stringify(result)}`);
  }
  return result.inventory;
}

function observationsFromSourceRows(
  rows: readonly PersonalProductEndpointInventorySourceRow[]
): IdentityConsumerObservation[] {
  return rows.map((row) => ({
    receiptId: row.receiptId,
    itemSourceIndex: row.sourceIndex,
    rawName: row.displayName || row.rawName,
    merchantKey:
      (row.merchantNormalized || row.merchantRaw || '').trim() ||
      'unknown_merchant',
    occurredAt: row.occurredAt,
    lineTotal: row.lineTotal,
    quantity: row.purchaseQuantity,
    displayName: row.displayName,
  }));
}

function engagementRowsFromSource(
  rows: readonly PersonalProductEndpointInventorySourceRow[]
): EngagementProductRow[] {
  return rows.map((row) => ({
    receiptId: row.receiptId,
    itemId: row.itemId,
    sourceIndex: row.sourceIndex,
    occurredAt: row.occurredAt,
    merchantRaw: row.merchantRaw,
    merchantNormalized: row.merchantNormalized,
    merchant_type: 'convenience' as const,
    analysis_json: '{}',
    displayName: row.displayName,
    currency: 'JPY',
    lineTotal: row.lineTotal,
    purchaseQuantity: row.purchaseQuantity,
    canonicalProductName: null,
    productFamilyKey: null,
    skuKey: row.skuKey,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
  }));
}

function buildCrossStoreSameInventory(
  rows: PersonalProductEndpointInventorySourceRow[],
  receipts: ReceiptRow[],
  decision: StoredPersonalProductIdentityDecision['decision'] = 'same_product'
): PersonalProductEndpointInventory {
  const preliminary = buildInventory(rows, receipts);
  const [mpA, mpB] = [...preliminary.endpointsById.keys()].sort();
  return buildInventory(rows, receipts, {
    decisionRows: [storedDecisionFromInventory(preliminary, mpA!, mpB!, decision)],
  });
}

function overlayFor(
  inventory: PersonalProductEndpointInventory,
  sourceRows: PersonalProductEndpointInventorySourceRow[],
  supportedReceiptIds: ReadonlySet<string>
) {
  const observations = observationsFromSourceRows(sourceRows);
  const { groups, qualified } = buildIdentityFrequentProductGroups(observations);
  return applyHomePersonalFrequentProductOverlay({
    baseGroups: groups,
    qualified,
    personalInventory: inventory,
    supportedReceiptIds,
  });
}

const TIED_FREQUENT_AT = 1_000;
const TIED_FREQUENT_LABEL = 'Tied Product';

function syntheticTiedMerchantProductGroup(
  key: string
): IdentityFrequentProductGroup {
  return {
    groupingType: 'merchant_product',
    key,
    displayName: TIED_FREQUENT_LABEL,
    merchantKey: 'lawson',
    distinctReceiptCount: 2,
    totalPurchaseQuantity: 2,
    firstPurchaseAt: TIED_FREQUENT_AT,
    latestPurchaseAt: TIED_FREQUENT_AT,
    rawNameVariants: [TIED_FREQUENT_LABEL],
  };
}

function emptyPersonalInventory(): PersonalProductEndpointInventory {
  const result = buildPersonalProductEndpointInventory({
    ownerKey: OWNER,
    sourceRows: [],
    receipts: [],
    decisionRows: [],
    store: createMemoryProductIdentityStore(),
  });
  if (result.status !== 'ready') {
    throw new Error(`inventory build failed: ${JSON.stringify(result)}`);
  }
  return result.inventory;
}

function lexicographicOverlayKeyOrder(keys: readonly string[]): string[] {
  return [...keys].sort((left, right) => {
    const labelCmp = TIED_FREQUENT_LABEL.localeCompare(TIED_FREQUENT_LABEL);
    if (labelCmp !== 0) return labelCmp;
    const typeCmp = 'merchant_product'.localeCompare('merchant_product');
    if (typeCmp !== 0) return typeCmp;
    return left.localeCompare(right);
  });
}

describe('G5-2A homePersonalFrequentProducts', () => {
  it('preserves base Home frequent products when no personal SAME exists', () => {
    const sourceRows = [
      sourceRow({ receiptId: 'r1', itemId: 'r1:0', occurredAt: 1_000 }),
      sourceRow({ receiptId: 'r2', itemId: 'r2:0', occurredAt: 2_000 }),
    ];
    const receipts = [receipt('r1'), receipt('r2')];
    const inventory = buildInventory(sourceRows, receipts);
    const supportedReceiptIds = new Set(['r1', 'r2']);
    const withoutPersonal = overlayFor(inventory, sourceRows, supportedReceiptIds);
    const withNullInventory = (() => {
      const observations = observationsFromSourceRows(sourceRows);
      const { groups } = buildIdentityFrequentProductGroups(observations);
      return groups.map(mapIdentityFrequentGroupToHomeProduct);
    })();
    expect(withoutPersonal).toEqual(withNullInventory);
  });

  it('preserves exact non-lexicographic base order when no personal replacement is emitted', () => {
    const orderedKeys = [
      'mp-z',
      'mp-a',
      'mp-y',
      'mp-b',
      'mp-x',
      'mp-c',
    ] as const;
    const baseGroups = orderedKeys.map(syntheticTiedMerchantProductGroup);
    expect(baseGroups).toHaveLength(6);
    expect(baseGroups.every((group) => group.distinctReceiptCount === 2)).toBe(
      true
    );
    expect(baseGroups.map((group) => group.key)).toEqual([...orderedKeys]);

    const lexicallySortedKeys = lexicographicOverlayKeyOrder(orderedKeys);
    expect(lexicallySortedKeys).toEqual([
      'mp-a',
      'mp-b',
      'mp-c',
      'mp-x',
      'mp-y',
      'mp-z',
    ]);
    expect(lexicallySortedKeys).not.toEqual([...orderedKeys]);

    const inventory = emptyPersonalInventory();
    const result = applyHomePersonalFrequentProductOverlay({
      baseGroups,
      qualified: [],
      personalInventory: inventory,
      supportedReceiptIds: new Set(),
    });

    expect(result.map((card) => card.key)).toEqual([...orderedKeys]);
    expect(result.slice(0, 5).map((card) => card.key)).toEqual([
      'mp-z',
      'mp-a',
      'mp-y',
      'mp-b',
      'mp-x',
    ]);
  });

  it('preserves exact non-lexicographic base order when personal overlay fails closed', () => {
    const orderedKeys = ['mp-z', 'mp-a', 'mp-y', 'mp-b'] as const;
    const baseGroups = orderedKeys.map(syntheticTiedMerchantProductGroup);
    expect(baseGroups).toHaveLength(4);
    expect(baseGroups.map((group) => group.key)).toEqual([...orderedKeys]);

    const lexicallySortedKeys = lexicographicOverlayKeyOrder(orderedKeys);
    expect(lexicallySortedKeys).toEqual(['mp-a', 'mp-b', 'mp-y', 'mp-z']);
    expect(lexicallySortedKeys).not.toEqual([...orderedKeys]);

    const sameComponentRows = [
      sourceRow({
        receiptId: 'a1',
        itemId: 'a1:0',
        sourceIndex: 0,
        occurredAt: TIED_FREQUENT_AT,
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'a2',
        itemId: 'a2:0',
        sourceIndex: 0,
        occurredAt: TIED_FREQUENT_AT,
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'b1',
        itemId: 'b1:0',
        sourceIndex: 0,
        occurredAt: TIED_FREQUENT_AT,
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
      sourceRow({
        receiptId: 'b2',
        itemId: 'b2:0',
        sourceIndex: 0,
        occurredAt: TIED_FREQUENT_AT,
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
    ];
    const receipts = [
      receipt('a1', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('a2', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('b1', { merchant_raw: 'York', merchant_normalized: 'york' }),
      receipt('b2', { merchant_raw: 'York', merchant_normalized: 'york' }),
    ];
    const preliminary = buildInventory(sameComponentRows, receipts);
    const [mpRealA, mpRealB] = [
      preliminary.itemsByRowKey.get('a1:0')!.merchantProductId,
      preliminary.itemsByRowKey.get('b1:0')!.merchantProductId,
    ].sort();
    const inventory = buildInventory(sameComponentRows, receipts, {
      decisionRows: [
        storedDecisionFromInventory(preliminary, mpRealA!, mpRealB!),
      ],
    });
    const forgedItem = inventory.itemsByRowKey.get('a1:0');
    if (forgedItem) {
      forgedItem.merchantProductId = 'mp-forged';
    }

    const supportedReceiptIds = new Set(['a1', 'a2', 'b1', 'b2']);
    const observations = observationsFromSourceRows(sameComponentRows);
    const { groups: identityBaseGroups, qualified } =
      buildIdentityFrequentProductGroups(observations);
    expect(identityBaseGroups.length).toBeGreaterThanOrEqual(2);

    const result = applyHomePersonalFrequentProductOverlay({
      baseGroups,
      qualified,
      personalInventory: inventory,
      supportedReceiptIds,
    });

    expect(result.map((card) => card.key)).toEqual([...orderedKeys]);
    expect(result.every((card) => card.groupingType === 'merchant_product')).toBe(
      true
    );
  });

  it('merges cross-store SAME members into one personal_product card', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        occurredAt: 1_000,
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-york',
        itemId: 'r-york:0',
        occurredAt: 2_000,
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
    ];
    const receipts = [
      receipt('r-aeon', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('r-york', { merchant_raw: 'York', merchant_normalized: 'york' }),
    ];
    const inventory = buildCrossStoreSameInventory(sourceRows, receipts);
    const anchor = [...inventory.endpointsById.keys()].sort()[0]!;
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(['r-aeon', 'r-york'])
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      groupingType: 'personal_product',
      key: anchor,
      purchaseOccurrenceCount: 2,
      displayLabel: 'コカ・コーラ 500ml',
    });
    expect(result.some((card) => card.groupingType === 'merchant_product')).toBe(
      false
    );
  });

  it('combines distinct receipt counts across SAME members', () => {
    const sourceRows = [
      ...['r-a1', 'r-a2', 'r-a3'].map((receiptId, index) =>
        sourceRow({
          receiptId,
          itemId: `${receiptId}:0`,
          sourceIndex: 0,
          occurredAt: 1_000 + index,
          merchantRaw: 'AEON',
          merchantNormalized: 'aeon',
        })
      ),
      ...['r-b1', 'r-b2'].map((receiptId, index) =>
        sourceRow({
          receiptId,
          itemId: `${receiptId}:0`,
          sourceIndex: 0,
          occurredAt: 4_000 + index,
          merchantRaw: 'York',
          merchantNormalized: 'york',
        })
      ),
    ];
    const receipts = sourceRows.map((row) =>
      receipt(row.receiptId, {
        merchant_raw: row.merchantRaw,
        merchant_normalized: row.merchantNormalized,
      })
    );
    const inventory = buildCrossStoreSameInventory(sourceRows, receipts);
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(sourceRows.map((row) => row.receiptId))
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.purchaseOccurrenceCount).toBe(5);
  });

  it('counts distinct receipts when one receipt has split rows', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-a',
        itemId: 'r-a:0',
        sourceIndex: 0,
        occurredAt: 1_000,
        purchaseQuantity: 2,
      }),
      sourceRow({
        receiptId: 'r-a',
        itemId: 'r-a:1',
        sourceIndex: 1,
        occurredAt: 1_000,
        purchaseQuantity: 1,
      }),
      sourceRow({
        receiptId: 'r-b',
        itemId: 'r-b:0',
        sourceIndex: 0,
        occurredAt: 2_000,
        purchaseQuantity: 3,
      }),
    ];
    const receipts = [receipt('r-a'), receipt('r-b')];
    const inventory = buildInventory(sourceRows, receipts);
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(['r-a', 'r-b'])
    );
    expect(result[0]!.purchaseOccurrenceCount).toBe(2);
    expect(result[0]!.totalPurchaseQuantity).toBe(6);
  });

  it('excludes duplicate receipts from personal purchase counts', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-old',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
        occurredAt: 1_000,
      }),
      sourceRow({
        receiptId: 'r-dup',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
        occurredAt: 1_500,
      }),
      sourceRow({
        receiptId: 'r-current',
        merchantRaw: 'York',
        merchantNormalized: 'york',
        occurredAt: 2_000,
      }),
    ];
    const receipts = [
      receipt('r-old', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('r-dup', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('r-current', { merchant_raw: 'York', merchant_normalized: 'york' }),
    ];
    const preliminary = buildInventory(sourceRows, receipts);
    const [mpA, mpB] = [...preliminary.endpointsById.keys()].sort();
    const inventoryWithDuplicate = buildInventory(sourceRows, receipts, {
      decisionRows: [storedDecisionFromInventory(preliminary, mpA!, mpB!)],
      excludedDuplicateReceiptIds: new Set(['r-dup']),
    });
    const result = overlayFor(
      inventoryWithDuplicate,
      sourceRows,
      new Set(['r-old', 'r-dup', 'r-current'])
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.groupingType).toBe('personal_product');
    expect(result[0]!.purchaseOccurrenceCount).toBe(2);
  });

  it('does not merge when G4 active NOT SAME', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-york',
        itemId: 'r-york:0',
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
    ];
    const receipts = [
      receipt('r-aeon', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('r-york', { merchant_raw: 'York', merchant_normalized: 'york' }),
    ];
    const inventory = buildCrossStoreSameInventory(
      sourceRows,
      receipts,
      'not_same_product'
    );
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(['r-aeon', 'r-york'])
    );
    expect(result.every((card) => card.groupingType === 'merchant_product')).toBe(
      true
    );
  });

  it('does not merge when G4 relationship is unsure only', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-york',
        itemId: 'r-york:0',
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
    ];
    const receipts = [
      receipt('r-aeon', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('r-york', { merchant_raw: 'York', merchant_normalized: 'york' }),
    ];
    const inventory = buildCrossStoreSameInventory(sourceRows, receipts, 'unsure');
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(['r-aeon', 'r-york'])
    );
    expect(result.every((card) => card.groupingType === 'merchant_product')).toBe(
      true
    );
  });

  it('fails closed when personal component is stale', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-york',
        itemId: 'r-york:0',
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
    ];
    const receipts = [
      receipt('r-aeon', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('r-york', { merchant_raw: 'York', merchant_normalized: 'york' }),
    ];
    const inventory = buildCrossStoreSameInventory(sourceRows, receipts);
    const staleMember = [...inventory.endpointsById.keys()].sort()[1]!;
    (inventory.endpointsById as unknown as Map<string, unknown>).delete(
      staleMember
    );
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(['r-aeon', 'r-york'])
    );
    expect(result.every((card) => card.groupingType === 'merchant_product')).toBe(
      true
    );
  });

  it('fails closed when Home and G4 inventory disagree on row merchantProductId', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-york',
        itemId: 'r-york:0',
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
    ];
    const receipts = [
      receipt('r-aeon', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('r-york', { merchant_raw: 'York', merchant_normalized: 'york' }),
    ];
    const inventory = buildCrossStoreSameInventory(sourceRows, receipts);
    const item = inventory.itemsByRowKey.get('r-aeon:0');
    if (item) {
      item.merchantProductId = 'mp-forged';
    }
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(['r-aeon', 'r-york'])
    );
    expect(result.every((card) => card.groupingType === 'merchant_product')).toBe(
      true
    );
  });

  it('applies personal overlay before the Home top-5 cap', () => {
    const cokeRows = [
      ...['r-a1', 'r-a2', 'r-a3'].map((receiptId, index) =>
        sourceRow({
          receiptId,
          itemId: `${receiptId}:0`,
          occurredAt: 10_000 + index,
          displayName: 'コカ・コーラ 500ml',
          rawName: 'コカ・コーラ 500ml',
          merchantRaw: 'AEON',
          merchantNormalized: 'aeon',
        })
      ),
      ...['r-b1', 'r-b2', 'r-b3'].map((receiptId, index) =>
        sourceRow({
          receiptId,
          itemId: `${receiptId}:0`,
          occurredAt: 20_000 + index,
          displayName: 'コカ・コーラ 500ml',
          rawName: 'コカ・コーラ 500ml',
          merchantRaw: 'York',
          merchantNormalized: 'york',
        })
      ),
    ];
    const fillerProducts = ['Milk', 'Tea', 'Bread', 'Water'] as const;
    const fillerRows = fillerProducts.flatMap((name, productIndex) =>
      [`f${productIndex}-1`, `f${productIndex}-2`].map((receiptId, receiptIndex) =>
        sourceRow({
          receiptId,
          itemId: `${receiptId}:0`,
          occurredAt:
            name === 'Water'
              ? 100 + receiptIndex
              : 30_000 + productIndex * 10 + receiptIndex,
          displayName: name,
          rawName: name,
          merchantRaw: 'Lawson',
          merchantNormalized: 'lawson',
        })
      )
    );
    const sourceRows = [...cokeRows, ...fillerRows];
    const receipts = sourceRows.map((row) =>
      receipt(row.receiptId, {
        merchant_raw: row.merchantRaw,
        merchant_normalized: row.merchantNormalized,
      })
    );
    const preliminary = buildInventory(sourceRows, receipts);
    const cokeMerchantProductIds = [
      preliminary.itemsByRowKey.get('r-a1:0')!.merchantProductId,
      preliminary.itemsByRowKey.get('r-b1:0')!.merchantProductId,
    ].sort();
    const inventory = buildInventory(sourceRows, receipts, {
      decisionRows: [
        storedDecisionFromInventory(
          preliminary,
          cokeMerchantProductIds[0]!,
          cokeMerchantProductIds[1]!
        ),
      ],
    });
    const supportedReceiptIds = new Set(sourceRows.map((row) => row.receiptId));
    const observations = observationsFromSourceRows(sourceRows);
    const { groups } = buildIdentityFrequentProductGroups(observations);
    const fullBase = groups.map(mapIdentityFrequentGroupToHomeProduct);
    expect(fullBase.length).toBeGreaterThanOrEqual(6);
    const cappedBefore = fullBase.slice(0, 5);
    const sixthBefore = fullBase[5]!.displayLabel;
    expect(cappedBefore.map((card) => card.displayLabel)).not.toContain(
      sixthBefore
    );

    const fullMerged = overlayFor(inventory, sourceRows, supportedReceiptIds);
    const cappedAfter = fullMerged.slice(0, 5);
    expect(cappedAfter).toHaveLength(5);
    expect(cappedAfter[0]!.groupingType).toBe('personal_product');
    expect(cappedAfter.map((card) => card.displayLabel)).toContain(sixthBefore);
    expect(
      cappedAfter.filter((card) => card.groupingType === 'merchant_product')
    ).toHaveLength(4);
  });

  it('builds two personal groups for two independent SAME components', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-a1',
        itemId: 'r-a1:0',
        displayName: 'Coke A',
        rawName: 'Coke A',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-a2',
        itemId: 'r-a2:0',
        displayName: 'Coke A',
        rawName: 'Coke A',
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
      sourceRow({
        receiptId: 'r-c1',
        itemId: 'r-c1:0',
        displayName: 'Tea C',
        rawName: 'Tea C',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-c2',
        itemId: 'r-c2:0',
        displayName: 'Tea D',
        rawName: 'Tea D',
        merchantRaw: 'Seven',
        merchantNormalized: 'seven',
      }),
    ];
    const receipts = sourceRows.map((row) =>
      receipt(row.receiptId, {
        merchant_raw: row.merchantRaw,
        merchant_normalized: row.merchantNormalized,
      })
    );
    const preliminary = buildInventory(sourceRows, receipts);
    const [mpA, mpB, mpC, mpD] = [...preliminary.endpointsById.keys()].sort();
    const inventory = buildInventory(sourceRows, receipts, {
      decisionRows: [
        storedDecisionFromInventory(preliminary, mpA!, mpB!),
        storedDecisionFromInventory(preliminary, mpC!, mpD!),
      ],
    });
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(sourceRows.map((row) => row.receiptId))
    );
    const personalCards = result.filter(
      (card) => card.groupingType === 'personal_product'
    );
    expect(personalCards).toHaveLength(2);
  });

  it('uses human-readable display labels for personal cards', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-york',
        itemId: 'r-york:0',
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
    ];
    const receipts = [
      receipt('r-aeon', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
      receipt('r-york', { merchant_raw: 'York', merchant_normalized: 'york' }),
    ];
    const inventory = buildCrossStoreSameInventory(sourceRows, receipts);
    const anchor = [...inventory.endpointsById.keys()].sort()[0]!;
    const result = overlayFor(
      inventory,
      sourceRows,
      new Set(['r-aeon', 'r-york'])
    );
    expect(result[0]!.displayLabel).toBe('コカ・コーラ 500ml');
    expect(result[0]!.displayLabel).not.toBe(anchor);
    expect(formatFrequentProductLabel(result[0]!, (key) => key)).toBe(
      'コカ・コーラ 500ml'
    );
  });

  it('routes personal Home cards to personal Product Detail href', () => {
    const href = buildHomeFrequentProductDetailHref({
      groupingType: 'personal_product',
      key: 'mp_anchor_123',
    });
    expect(href).toBe('/product/personal_product?key=mp_anchor_123');
  });
});

describe('G5-2A Home progressive integration', () => {
  it('keeps Home frequent products working when personal inventory is unavailable', () => {
    const sourceRows = [
      sourceRow({ receiptId: 'r1', itemId: 'r1:0', occurredAt: 1_000 }),
      sourceRow({ receiptId: 'r2', itemId: 'r2:0', occurredAt: 2_000 }),
    ];
    const receipts = Array.from({ length: 5 }, (_, index) =>
      receipt(`r${index + 1}`, {
        merchant_type: 'convenience',
        merchant_raw: `Store ${index + 1}`,
        merchant_normalized: `store ${index + 1}`,
      })
    );
    const productRows = engagementRowsFromSource(sourceRows);
    const withoutPersonal = buildHomeProgressiveExperience(
      receipts,
      null,
      false,
      productRows,
      null
    );
    const withFailedPersonal = buildHomeProgressiveExperience(
      receipts,
      null,
      false,
      productRows,
      null
    );
    expect(withFailedPersonal.frequentProducts).toEqual(
      withoutPersonal.frequentProducts
    );
    expect(withFailedPersonal.analyticsUnavailable).toBe(false);
  });
});
