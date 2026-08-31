/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./productPriceHistory', () => ({
  loadProductPriceHistoryWithDb: jest.fn(),
}));

import {
  buildPersonalProductEndpointInventory,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import type { StoredPersonalProductIdentityDecision } from './personalProductIdentityContract';
import { resolvePersonalProductTargetFromInventory } from './personalProductTargetResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import type { ReceiptRow } from './db';
import type {
  ProductPriceChangeInterpretation,
  ProductPriceChangeUnavailableReason,
} from './productPriceChangeInterpretation';
import {
  buildPostSavePurchaseMemoryFromInventory,
  countDistinctMerchants,
  loadPostSavePurchaseMemoryWithDb,
  rankBuiltMemoryEntries,
} from './postSavePurchaseMemory';
import {
  cloneCollisionReceipt,
  makeYorkCollisionReceiptA,
  makeYorkCollisionReceiptC,
} from './receiptExactTransactionCollision.testFixtures';

const OWNER = 'user:memory-owner';

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow {
  return {
    id,
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_000_000,
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

function itemRow(
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

function buildCrossStorePersonalInventory(
  currentReceiptId: string
): PersonalProductEndpointInventory {
  const sourceRows = [
    itemRow({
      receiptId: 'r-aeon',
      itemId: 'r-aeon:0',
      sourceIndex: 0,
      occurredAt: 1_699_000_000_000,
      merchantRaw: 'AEON',
      merchantNormalized: 'aeon',
    }),
    itemRow({
      receiptId: currentReceiptId,
      itemId: `${currentReceiptId}:0`,
      sourceIndex: 0,
      occurredAt: 1_700_000_000_000,
      merchantRaw: 'York',
      merchantNormalized: 'york',
    }),
  ];
  const receipts = [
    receipt('r-aeon', { merchant_raw: 'AEON', merchant_normalized: 'aeon' }),
    receipt(currentReceiptId, { merchant_raw: 'York', merchant_normalized: 'york' }),
  ];
  const preliminary = buildInventory(sourceRows, receipts);
  const [mpA, mpB] = [...preliminary.endpointsById.keys()].sort();
  return buildInventory(sourceRows, receipts, {
    decisionRows: [storedDecisionFromInventory(preliminary, mpA!, mpB!)],
  });
}

describe('G5-1 postSavePurchaseMemory', () => {
  it('returns merchant_product memory for repeated same MerchantProduct purchases', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          itemId: 'r-old:0',
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          itemId: 'r-current:0',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [receipt('r-old'), receipt('r-current')]
    );
    const result = buildPostSavePurchaseMemoryFromInventory('r-current', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.target.type).toBe('merchant_product');
    expect(result.memory.purchaseOccurrenceCount).toBe(2);
    expect(result.memory.previousPurchase.receiptId).toBe('r-old');
  });

  it('counts distinct receipt IDs, not item rows', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          itemId: 'r-old:0',
          sourceIndex: 0,
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-old',
          itemId: 'r-old:1',
          sourceIndex: 1,
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          itemId: 'r-current:0',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [receipt('r-old'), receipt('r-current')]
    );
    const result = buildPostSavePurchaseMemoryFromInventory('r-current', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.purchaseOccurrenceCount).toBe(2);
  });

  it('returns none when saved receipt is duplicate-excluded', () => {
    const inventory = buildInventory(
      [
        itemRow({ receiptId: 'r-old', occurredAt: 1_699_000_000_000 }),
        itemRow({ receiptId: 'r-current', occurredAt: 1_700_000_000_000 }),
      ],
      [receipt('r-old'), receipt('r-current')],
      { excludedDuplicateReceiptIds: new Set(['r-current']) }
    );
    expect(buildPostSavePurchaseMemoryFromInventory('r-current', inventory)).toEqual({
      status: 'none',
    });
  });

  it('suppresses Purchase Memory for a classifier-missed exact York rescan', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          itemId: 'r-old:0',
          skuKey: 'persisted-york-item',
          occurredAt: 1_699_000_000_000,
          merchantRaw: 'ヨークベニマル',
          merchantNormalized: 'ヨークベニマル',
        }),
        itemRow({
          receiptId: 'r-current',
          itemId: 'r-current:0',
          skuKey: 'persisted-york-item',
          occurredAt: 1_700_000_000_000,
          merchantRaw: 'ヨークベニマル古川南店',
          merchantNormalized: 'ヨークベニマル古川南',
        }),
      ],
      [
        cloneCollisionReceipt(makeYorkCollisionReceiptA(), {
          id: 'r-old',
          user_id: OWNER.slice('user:'.length),
        }),
        cloneCollisionReceipt(makeYorkCollisionReceiptC(), {
          id: 'r-current',
          user_id: OWNER.slice('user:'.length),
        }),
      ]
    );
    expect(
      buildPostSavePurchaseMemoryFromInventory('r-current', inventory)
    ).toEqual({ status: 'none' });
  });

  it.each(['representative', 'excluded'] as const)(
    'suppresses Purchase Memory for a high-confidence group %s',
    (memberKind) => {
      const inventory = buildInventory(
        [
          itemRow({
            receiptId: 'r-old',
            itemId: 'r-old:0',
            occurredAt: 1_699_000_000_000,
          }),
          itemRow({
            receiptId: 'r-current',
            itemId: 'r-current:0',
            occurredAt: 1_700_000_000_000,
          }),
        ],
        [receipt('r-old'), receipt('r-current')]
      );
      const membership = {
        representativeReceiptId:
          memberKind === 'representative' ? 'r-current' : 'r-old',
        receiptIds: ['r-current', 'r-old'],
        confidence: 'CONTENT_EXACT_DUPLICATE' as const,
      };
      inventory.highConfidenceDuplicateGroupByReceiptId = new Map([
        ['r-current', membership],
        ['r-old', membership],
      ]);
      if (memberKind === 'excluded') {
        inventory.excludedDuplicateReceiptIds = new Set(['r-current']);
      }
      expect(
        buildPostSavePurchaseMemoryFromInventory('r-current', inventory)
      ).toEqual({ status: 'none' });
    }
  );

  it('ignores duplicate-excluded historical receipt events', () => {
    const inventory = buildInventory(
      [
        itemRow({ receiptId: 'r-old', occurredAt: 1_699_000_000_000 }),
        itemRow({ receiptId: 'r-dup', occurredAt: 1_699_500_000_000 }),
        itemRow({ receiptId: 'r-current', occurredAt: 1_700_000_000_000 }),
      ],
      [receipt('r-old'), receipt('r-dup'), receipt('r-current')],
      { excludedDuplicateReceiptIds: new Set(['r-dup']) }
    );
    const result = buildPostSavePurchaseMemoryFromInventory('r-current', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.purchaseOccurrenceCount).toBe(2);
    expect(result.memory.previousPurchase.receiptId).toBe('r-old');
  });

  it('prefers sku over merchant_product when no personal authority exists', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          skuKey: 'sku-coke-500',
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          skuKey: 'sku-coke-500',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [receipt('r-old'), receipt('r-current')]
    );
    const result = buildPostSavePurchaseMemoryFromInventory('r-current', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.target).toEqual({ type: 'sku', key: 'sku-coke-500' });
  });

  it('prefers personal_product over sku and merchant_product', () => {
    const inventory = buildCrossStorePersonalInventory('r-current');
    const result = buildPostSavePurchaseMemoryFromInventory('r-current', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.target.type).toBe('personal_product');
    const anchor = [...inventory.endpointsById.keys()].sort()[0];
    expect(result.memory.target.key).toBe(anchor);
    expect(result.personalResolved?.canonicalTarget.key).toBe(anchor);
  });

  it('returns one personal_product memory across stores without merging MPs', () => {
    const inventory = buildCrossStorePersonalInventory('r-york');
    const result = buildPostSavePurchaseMemoryFromInventory('r-york', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.purchaseOccurrenceCount).toBe(2);
    expect(result.memory.target.type).toBe('personal_product');
  });

  it('does not claim repeat memory from family/canonical-only similarity', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          displayName: 'Milk A',
          rawName: 'Milk A',
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          displayName: 'Milk B',
          rawName: 'Milk B',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [receipt('r-old'), receipt('r-current')]
    );
    expect(buildPostSavePurchaseMemoryFromInventory('r-current', inventory)).toEqual({
      status: 'none',
    });
  });

  it('returns exactly one top memory card candidate', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old-a',
          displayName: 'コカ・コーラ 500ml',
          rawName: 'コカ・コーラ 500ml',
          occurredAt: 1_699_500_000_000,
        }),
        itemRow({
          receiptId: 'r-old-b',
          displayName: 'お茶 500ml',
          rawName: 'お茶 500ml',
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          sourceIndex: 0,
          displayName: 'コカ・コーラ 500ml',
          rawName: 'コカ・コーラ 500ml',
          occurredAt: 1_700_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          sourceIndex: 1,
          itemId: 'r-current:1',
          displayName: 'お茶 500ml',
          rawName: 'お茶 500ml',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [
        receipt('r-old-a'),
        receipt('r-old-b'),
        receipt('r-current'),
      ]
    );
    const result = buildPostSavePurchaseMemoryFromInventory('r-current', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.displayName).toBe('コカ・コーラ 500ml');
  });

  it('returns identity_candidate when fresh inventory has a G4 prompt candidate', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'saved-r',
          merchantRaw: 'Lawson',
          merchantNormalized: 'lawson',
          occurredAt: 1_700_000_000_000,
        }),
        itemRow({
          receiptId: 'hist-r',
          merchantRaw: 'Seven',
          merchantNormalized: 'seven',
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'hist-r-2',
          merchantRaw: 'Seven',
          merchantNormalized: 'seven',
          occurredAt: 1_698_000_000_000,
        }),
        itemRow({
          receiptId: 'old-current-r',
          merchantRaw: 'Lawson',
          merchantNormalized: 'lawson',
          occurredAt: 1_698_500_000_000,
        }),
      ],
      [
        receipt('saved-r'),
        receipt('hist-r', { merchant_raw: 'Seven', merchant_normalized: 'seven' }),
        receipt('hist-r-2', { merchant_raw: 'Seven', merchant_normalized: 'seven' }),
        receipt('old-current-r'),
      ]
    );
    const result = buildPostSavePurchaseMemoryFromInventory('saved-r', inventory);
    expect(result.status).toBe('identity_candidate');
  });

  it('attaches priceInterpretation when G3 is available for personal_product', async () => {
    const inventory = buildCrossStorePersonalInventory('r-current');
    const interpretation: ProductPriceChangeInterpretation & { status: 'available' } = {
      status: 'available',
      identityAuthority: {
        kind: 'personal_product',
        anchorMerchantProductId: 'mp-anchor',
        memberMerchantProductIds: ['mp-anchor'],
      },
      previous: {
        receiptId: 'r-aeon',
        occurredAt: 1,
        priceValue: 150,
        grossLineAmount: 150,
        purchaseQuantity: 1,
        currency: 'JPY',
        priceKind: 'purchase_unit',
        amountBasis: 'tax_included',
        promoContext: 'none_observed',
        promoState: 'none_observed',
        discountAllocated: 0,
        effectiveLineAmount: 150,
      },
      current: {
        receiptId: 'r-current',
        occurredAt: 2,
        priceValue: 120,
        grossLineAmount: 120,
        purchaseQuantity: 1,
        currency: 'JPY',
        priceKind: 'purchase_unit',
        amountBasis: 'tax_included',
        promoContext: 'none_observed',
        promoState: 'none_observed',
        discountAllocated: 0,
        effectiveLineAmount: 120,
      },
      grossDirection: 'decreased',
      grossDelta: -30,
      promoTransition: 'none',
      previousPromo: 'none_observed',
      currentPromo: 'none_observed',
      previousDiscountAllocated: 0,
      currentDiscountAllocated: 0,
    };
    const loadPriceHistory = jest.fn(async () =>
      ({
        status: 'ready',
        target: { type: 'personal_product', key: 'mp-anchor' },
        points: [],
        observations: [],
        currency: 'JPY',
        dimension: 'volume',
        priceKind: 'purchase_unit',
        totalOccurrenceCount: 2,
        comparableOccurrenceCount: 2,
        excludedOccurrenceCount: 0,
      }) as never
    );
    const interpretPriceChange = jest.fn(() => interpretation);
    const result = await loadPostSavePurchaseMemoryWithDb('r-current', {} as never, undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      loadPriceHistory,
      interpretPriceChange,
    });
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.target.type).toBe('personal_product');
    expect(result.memory.priceInterpretation?.status).toBe('available');
    expect(loadPriceHistory).toHaveBeenCalledTimes(1);
    expect(interpretPriceChange).toHaveBeenCalledTimes(1);
  });

  it('keeps sku memory without calling the non-owner-scoped price loader', async () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          skuKey: 'sku-coke-500',
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          skuKey: 'sku-coke-500',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [receipt('r-old'), receipt('r-current')]
    );
    const loadPriceHistory = jest.fn(async () =>
      ({
        status: 'ready',
        target: { type: 'sku', key: 'sku-coke-500' },
        points: [],
        observations: [],
        currency: 'JPY',
        dimension: 'volume',
        priceKind: 'purchase_unit',
        totalOccurrenceCount: 2,
        comparableOccurrenceCount: 2,
        excludedOccurrenceCount: 0,
      }) as never
    );
    const interpretPriceChange = jest.fn(
      () =>
        ({
          status: 'available',
        }) as ProductPriceChangeInterpretation & { status: 'available' }
    );
    const result = await loadPostSavePurchaseMemoryWithDb('r-current', {} as never, undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      loadPriceHistory,
      interpretPriceChange,
    });
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.target.type).toBe('sku');
    expect(result.memory.purchaseOccurrenceCount).toBe(2);
    expect(result.memory.priceInterpretation).toBeNull();
    expect(loadPriceHistory).not.toHaveBeenCalled();
    expect(interpretPriceChange).not.toHaveBeenCalled();
  });

  it('keeps merchant_product memory without calling the non-owner-scoped price loader', async () => {
    const inventory = buildInventory(
      [
        itemRow({ receiptId: 'r-old', occurredAt: 1_699_000_000_000 }),
        itemRow({ receiptId: 'r-current', occurredAt: 1_700_000_000_000 }),
      ],
      [receipt('r-old'), receipt('r-current')]
    );
    const loadPriceHistory = jest.fn(async () =>
      ({
        status: 'ready',
        target: { type: 'merchant_product', key: 'mp' },
        points: [],
        observations: [],
        currency: 'JPY',
        dimension: 'volume',
        priceKind: 'purchase_unit',
        totalOccurrenceCount: 2,
        comparableOccurrenceCount: 2,
        excludedOccurrenceCount: 0,
      }) as never
    );
    const interpretPriceChange = jest.fn(
      () =>
        ({
          status: 'available',
        }) as ProductPriceChangeInterpretation & { status: 'available' }
    );
    const result = await loadPostSavePurchaseMemoryWithDb('r-current', {} as never, undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      loadPriceHistory,
      interpretPriceChange,
    });
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.target.type).toBe('merchant_product');
    expect(result.memory.priceInterpretation).toBeNull();
    expect(loadPriceHistory).not.toHaveBeenCalled();
    expect(interpretPriceChange).not.toHaveBeenCalled();
  });

  it('keeps personal_product memory when G3 interpretation is unavailable', async () => {
    const inventory = buildCrossStorePersonalInventory('r-current');
    const loadPriceHistory = jest.fn(async () =>
      ({
        status: 'not_enough_points',
        target: { type: 'personal_product', key: 'mp' },
        points: [],
        observations: [],
        currency: null,
        dimension: null,
        priceKind: 'purchase_unit',
        totalOccurrenceCount: 2,
        comparableOccurrenceCount: 0,
        excludedOccurrenceCount: 0,
      }) as never
    );
    const interpretPriceChange = jest.fn(() => ({
      status: 'unavailable' as const,
      reasonCodes: [
        'not_enough_distinct_purchase_events',
      ] as ProductPriceChangeUnavailableReason[],
    }));
    const result = await loadPostSavePurchaseMemoryWithDb('r-current', {} as never, undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      loadPriceHistory,
      interpretPriceChange,
    });
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.target.type).toBe('personal_product');
    expect(result.memory.priceInterpretation).toBeNull();
    expect(loadPriceHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps personal_product memory when price loader throws', async () => {
    const inventory = buildCrossStorePersonalInventory('r-current');
    const loadPriceHistory = jest.fn(async () => {
      throw new Error('price failed');
    });
    const result = await loadPostSavePurchaseMemoryWithDb('r-current', {} as never, undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      loadPriceHistory,
    });
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.target.type).toBe('personal_product');
    expect(result.memory.priceInterpretation).toBeNull();
    expect(loadPriceHistory).toHaveBeenCalledTimes(1);
  });

  it('reuses the same personal resolved context for personal price load', async () => {
    const inventory = buildCrossStorePersonalInventory('r-current');
    const storedResolved: { value?: unknown } = {};
    const resolveTarget: typeof resolvePersonalProductTargetFromInventory = (
      merchantProductId,
      endpointInventory
    ) => {
      const result = resolvePersonalProductTargetFromInventory(
        merchantProductId,
        endpointInventory
      );
      if (result.status === 'ready') {
        storedResolved.value = result.resolved;
      }
      return result;
    };

    const contexts: unknown[] = [];
    const loadPriceHistory = jest.fn(async (_db, target, options) => {
      contexts.push(options?.personalProductContext);
      return {
        status: 'not_enough_points',
        target,
        points: [],
        observations: [],
        currency: null,
        dimension: null,
        priceKind: 'purchase_unit',
        totalOccurrenceCount: 2,
        comparableOccurrenceCount: 0,
        excludedOccurrenceCount: 0,
      } as never;
    });
    const result = await loadPostSavePurchaseMemoryWithDb(
      'r-current',
      {} as never,
      undefined,
      {
        loadInventory: async () => ({ status: 'ready', inventory }),
        resolveTarget,
        loadPriceHistory,
        interpretPriceChange: () => ({
          status: 'unavailable',
          reasonCodes: ['not_enough_distinct_purchase_events'],
        }),
      }
    );

    expect(result.status).toBe('memory');
    expect(loadPriceHistory).toHaveBeenCalledTimes(1);
    expect(contexts[0]).toBe(storedResolved.value);
  });

  it('returns merchantCount null when all merchant scopes are unknown', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          merchantRaw: '',
          merchantNormalized: '',
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          merchantRaw: '',
          merchantNormalized: '',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [
        receipt('r-old', { merchant_raw: '', merchant_normalized: '' }),
        receipt('r-current', { merchant_raw: '', merchant_normalized: '' }),
      ]
    );
    const items = [...inventory.itemsByRowKey.values()];
    expect(countDistinctMerchants(items)).toBeNull();
  });

  it('counts stable distinct merchant scopes for merchantCount', () => {
    const inventory = buildCrossStorePersonalInventory('r-current');
    const result = buildPostSavePurchaseMemoryFromInventory('r-current', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.merchantCount).toBe(2);
  });

  it('counts each stable merchant scope once across multiple rows', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          itemId: 'r-old:0',
          sourceIndex: 0,
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-old',
          itemId: 'r-old:1',
          sourceIndex: 1,
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [receipt('r-old'), receipt('r-current')]
    );
    const result = buildPostSavePurchaseMemoryFromInventory('r-current', inventory);
    expect(result.status).toBe('memory');
    if (result.status !== 'memory') return;
    expect(result.memory.merchantCount).toBe(1);
  });

  it('does not count raw merchant display names when scopes are unknown', () => {
    const inventory = buildInventory(
      [
        itemRow({
          receiptId: 'r-old',
          merchantRaw: 'Store A Label',
          merchantNormalized: '',
          occurredAt: 1_699_000_000_000,
        }),
        itemRow({
          receiptId: 'r-current',
          merchantRaw: 'Store B Label',
          merchantNormalized: '',
          occurredAt: 1_700_000_000_000,
        }),
      ],
      [
        receipt('r-old', { merchant_raw: 'Store A Label', merchant_normalized: '' }),
        receipt('r-current', {
          merchant_raw: 'Store B Label',
          merchant_normalized: '',
        }),
      ]
    );
    const items = [...inventory.itemsByRowKey.values()];
    expect(items[0]?.merchantName).toBe('Store A Label');
    expect(items[1]?.merchantName).toBe('Store B Label');
    expect(countDistinctMerchants(items)).toBeNull();
  });

  it('ranks personal_product above sku in one-card selection', () => {
    const inventory = buildCrossStorePersonalInventory('r-current');
    const mpId = [...inventory.itemsByRowKey.values()].find(
      (item) => item.receiptId === 'r-current'
    )!.merchantProductId;
    const ranked = rankBuiltMemoryEntries([
      {
        memory: {
          savedReceiptId: 'r-current',
          target: { type: 'sku', key: 'sku-1' },
          identityKind: 'sku',
          displayName: 'Tea',
          purchaseOccurrenceCount: 5,
          previousPurchase: {
            receiptId: 'x',
            occurredAt: 1,
            merchantName: 'Store',
          },
          merchantCount: 1,
        },
        savedSourceIndex: 0,
      },
      {
        memory: {
          savedReceiptId: 'r-current',
          target: { type: 'personal_product', key: mpId },
          identityKind: 'personal_product',
          displayName: 'Coke',
          purchaseOccurrenceCount: 2,
          previousPurchase: {
            receiptId: 'r-aeon',
            occurredAt: 2,
            merchantName: 'AEON',
          },
          merchantCount: 2,
        },
        savedSourceIndex: 0,
      },
    ]);
    expect(ranked?.memory.identityKind).toBe('personal_product');
  });
});
