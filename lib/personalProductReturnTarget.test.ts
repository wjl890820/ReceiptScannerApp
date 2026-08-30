/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import {
  buildPersonalProductEndpointInventory,
  buildPersonalProductInventoryRowKey,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import type { StoredPersonalProductIdentityDecision } from './personalProductIdentityContract';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import type { ReceiptRow } from './db';
import {
  buildHistoryPurchaseTruthView,
  projectHistorySearchToPurchaseTruth,
} from './historyPurchaseTruth';
import {
  buildProductSearchResultHref,
  resolveProductDetailTarget,
} from './productDetailTarget';
import * as personalProductTargetResolver from './personalProductTargetResolver';
import {
  buildPersonalAwareAggregatableProductDetailHref,
  buildPersonalAwareProductSearchResultHref,
  resolvePersonalAwareProductDetailTarget,
  resolveReceiptItemPersistedSourceIndex,
  type PersonalAwareProductReturnSource,
} from './personalProductReturnTarget';

const OWNER = 'user:return-target-owner';

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
  excludedDuplicateReceiptIds: ReadonlySet<string> = new Set(),
  rowOverrides?: {
    aeon?: Partial<PersonalProductEndpointInventorySourceRow>;
    york?: Partial<PersonalProductEndpointInventorySourceRow>;
  }
): PersonalProductEndpointInventory {
  const store = createMemoryProductIdentityStore();
  const sourceRows = [
    itemRow({
      receiptId: 'r-aeon',
      itemId: 'r-aeon:0',
      sourceIndex: 0,
      merchantRaw: 'AEON',
      merchantNormalized: 'aeon',
      ...rowOverrides?.aeon,
    }),
    itemRow({
      receiptId: 'r-york',
      itemId: 'r-york:0',
      sourceIndex: 0,
      merchantRaw: 'York',
      merchantNormalized: 'york',
      ...rowOverrides?.york,
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

function buildSoloInventory(): PersonalProductEndpointInventory {
  const store = createMemoryProductIdentityStore();
  const result = buildPersonalProductEndpointInventory({
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
  if (result.status !== 'ready') {
    throw new Error(`solo inventory failed: ${JSON.stringify(result)}`);
  }
  return result.inventory;
}

function buildDuplicateRowInventory(
  excludedDuplicateReceiptIds: ReadonlySet<string> = new Set()
): PersonalProductEndpointInventory {
  const store = createMemoryProductIdentityStore();
  const sourceRows = [
    itemRow({
      receiptId: 'r-dup',
      itemId: 'r-dup:2',
      sourceIndex: 2,
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
    receipt('r-dup'),
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
  expect(
    result.inventory.itemsByRowKey.has(
      buildPersonalProductInventoryRowKey('r-dup', 2)
    )
  ).toBe(true);
  return result.inventory;
}

function sourceInput(
  overrides: Partial<PersonalAwareProductReturnSource['source']> & {
    sourceIndex?: number;
    personalEvidenceReceiptId?: string;
  } = {}
): PersonalAwareProductReturnSource {
  const { sourceIndex = 0, personalEvidenceReceiptId, ...source } = overrides;
  return {
    source: {
      receiptId: 'r-aeon',
      itemId: 'r-aeon:0',
      skuKey: null,
      canonicalProductName: null,
      productFamilyKey: null,
      ...source,
    },
    sourceIndex,
    personalEvidenceReceiptId,
  };
}

describe('G5-2B personalProductReturnTarget', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('resolvePersonalAwareProductDetailTarget', () => {
    it('A. returns exact existing fallback when personal inventory is unavailable', () => {
      const input = sourceInput({
        skuKey: 'SKU-A',
        receiptId: 'r-x',
        itemId: 'r-x:1',
        sourceIndex: 1,
      });
      const fallback = resolveProductDetailTarget(input.source);
      expect(
        resolvePersonalAwareProductDetailTarget(input, null)
      ).toEqual(fallback);
    });

    it('B. returns fallback when inventory row exists but no personal SAME', () => {
      const inventory = buildSoloInventory();
      const input = sourceInput({
        receiptId: 'r-solo',
        itemId: 'r-solo:0',
        skuKey: 'SKU-SOLO',
      });
      const fallback = resolveProductDetailTarget(input.source);
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual(fallback);
    });

    it('C. returns personal_product canonical anchor for active SAME member A', () => {
      const inventory = buildCrossStoreInventory();
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
      });
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual({
        type: 'personal_product',
        key: anchorId,
      });
    });

    it('D. returns the same canonical anchor for active SAME member B', () => {
      const inventory = buildCrossStoreInventory();
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const memberA = resolvePersonalAwareProductDetailTarget(
        sourceInput({ receiptId: 'r-aeon', itemId: 'r-aeon:0' }),
        inventory
      );
      const memberB = resolvePersonalAwareProductDetailTarget(
        sourceInput({
          receiptId: 'r-york',
          itemId: 'r-york:0',
        }),
        inventory
      );
      expect(memberB).toEqual({
        type: 'personal_product',
        key: anchorId,
      });
      expect(memberB).toEqual(memberA);
    });

    it('E. personal overrides existing SKU fallback', () => {
      const inventory = buildCrossStoreInventory(new Set(), {
        aeon: { skuKey: 'SKU-AEON' },
        york: { skuKey: 'SKU-YORK' },
      });
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        skuKey: 'SKU-AEON',
      });
      expect(resolveProductDetailTarget(input.source)).toEqual({
        type: 'sku',
        key: 'SKU-AEON',
      });
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual({
        type: 'personal_product',
        key: anchorId,
      });
    });

    it('F. personal overrides canonical fallback', () => {
      const inventory = buildCrossStoreInventory(new Set(), {
        aeon: { skuKey: null },
      });
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        canonicalProductName: 'Coca-Cola 500ml',
      });
      expect(resolveProductDetailTarget(input.source)).toEqual({
        type: 'canonical',
        key: 'Coca-Cola 500ml',
      });
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual({
        type: 'personal_product',
        key: anchorId,
      });
    });

    it('G. personal overrides family fallback', () => {
      const store = createMemoryProductIdentityStore();
      const sourceRows = [
        itemRow({
          receiptId: 'r-aeon',
          itemId: 'r-aeon:0',
          merchantRaw: 'AEON',
          merchantNormalized: 'aeon',
          skuKey: null,
        }),
        itemRow({
          receiptId: 'r-york',
          itemId: 'r-york:0',
          merchantRaw: 'York',
          merchantNormalized: 'york',
          skuKey: null,
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
      if (preliminary.status !== 'ready') throw new Error('preliminary failed');
      const [mpA, mpB] = [...preliminary.inventory.endpointsById.keys()].sort();
      const inventoryResult = buildPersonalProductEndpointInventory({
        ownerKey: OWNER,
        sourceRows,
        receipts,
        decisionRows: [storedDecisionFromInventory(preliminary.inventory, mpA!, mpB!)],
        store,
      });
      if (inventoryResult.status !== 'ready') throw new Error('inventory failed');
      const inventory = inventoryResult.inventory;
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        productFamilyKey: 'family:coca-cola',
      });
      expect(resolveProductDetailTarget(input.source)).toEqual({
        type: 'family',
        key: 'family:coca-cola',
      });
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual({
        type: 'personal_product',
        key: anchorId,
      });
    });

    it('H. personal overrides automatic occurrence fallback', () => {
      const inventory = buildCrossStoreInventory();
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
      });
      expect(resolveProductDetailTarget(input.source).type).toBe('occurrence');
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual({
        type: 'personal_product',
        key: anchorId,
      });
    });

    it('I. not_same decision does not override fallback', () => {
      const store = createMemoryProductIdentityStore();
      const sourceRows = [
        itemRow({
          receiptId: 'r-aeon',
          itemId: 'r-aeon:0',
          merchantRaw: 'AEON',
          merchantNormalized: 'aeon',
          skuKey: 'SKU-A',
        }),
        itemRow({
          receiptId: 'r-york',
          itemId: 'r-york:0',
          merchantRaw: 'York',
          merchantNormalized: 'york',
          skuKey: 'SKU-B',
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
      if (preliminary.status !== 'ready') throw new Error('preliminary failed');
      const [mpA, mpB] = [...preliminary.inventory.endpointsById.keys()].sort();
      const inventoryResult = buildPersonalProductEndpointInventory({
        ownerKey: OWNER,
        sourceRows,
        receipts,
        decisionRows: [
          storedDecisionFromInventory(
            preliminary.inventory,
            mpA!,
            mpB!,
            'not_same_product'
          ),
        ],
        store,
      });
      if (inventoryResult.status !== 'ready') throw new Error('inventory failed');
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        skuKey: 'SKU-A',
      });
      const fallback = resolveProductDetailTarget(input.source);
      expect(
        resolvePersonalAwareProductDetailTarget(
          input,
          inventoryResult.inventory
        )
      ).toEqual(fallback);
    });

    it('J. unsure decision does not override fallback', () => {
      const store = createMemoryProductIdentityStore();
      const sourceRows = [
        itemRow({
          receiptId: 'r-aeon',
          itemId: 'r-aeon:0',
          merchantRaw: 'AEON',
          merchantNormalized: 'aeon',
        }),
        itemRow({
          receiptId: 'r-york',
          itemId: 'r-york:0',
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
      if (preliminary.status !== 'ready') throw new Error('preliminary failed');
      const [mpA, mpB] = [...preliminary.inventory.endpointsById.keys()].sort();
      const inventoryResult = buildPersonalProductEndpointInventory({
        ownerKey: OWNER,
        sourceRows,
        receipts,
        decisionRows: [
          storedDecisionFromInventory(
            preliminary.inventory,
            mpA!,
            mpB!,
            'unsure'
          ),
        ],
        store,
      });
      if (inventoryResult.status !== 'ready') throw new Error('inventory failed');
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        skuKey: 'SKU-A',
      });
      const fallback = resolveProductDetailTarget(input.source);
      expect(
        resolvePersonalAwareProductDetailTarget(
          input,
          inventoryResult.inventory
        )
      ).toEqual(fallback);
    });

    it('K. stale/corrupt/non-ready personal resolution returns fallback', () => {
      const inventory = buildCrossStoreInventory();
      const memberId = [...inventory.endpointsById.keys()].sort()[1]!;
      const staleSnapshot = new Map(inventory.snapshot);
      staleSnapshot.set(memberId, null);
      const staleInventory: PersonalProductEndpointInventory = {
        ...inventory,
        snapshot: staleSnapshot,
      };
      const input = sourceInput({
        receiptId: 'r-york',
        itemId: 'r-york:0',
        skuKey: 'SKU-YORK',
      });
      const fallback = resolveProductDetailTarget(input.source);
      expect(
        resolvePersonalAwareProductDetailTarget(input, staleInventory)
      ).toEqual(fallback);
    });

    it('L. returns fallback when inventory row is absent', () => {
      const inventory = buildCrossStoreInventory();
      const input = sourceInput({
        receiptId: 'r-missing',
        itemId: 'r-missing:0',
        skuKey: 'SKU-MISSING',
      });
      const fallback = resolveProductDetailTarget(input.source);
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual(fallback);
    });

    it('M. returns fallback for wrong sourceIndex', () => {
      const inventory = buildCrossStoreInventory();
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        skuKey: 'SKU-A',
        sourceIndex: 99,
      });
      const fallback = resolveProductDetailTarget(input.source);
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual(fallback);
    });

    it('N. returns fallback when evidence receipt is duplicate-excluded', () => {
      const inventory = buildCrossStoreInventory(new Set(['r-dup']));
      const input = sourceInput({
        receiptId: 'r-rep',
        itemId: 'r-dup:2',
        sourceIndex: 2,
        personalEvidenceReceiptId: 'r-dup',
        skuKey: 'SKU-DUP',
      });
      const fallback = resolveProductDetailTarget(input.source);
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual(fallback);
    });

    it('O. returns fallback when authorized-row check fails', () => {
      const inventory = buildCrossStoreInventory();
      const input = sourceInput({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        skuKey: 'SKU-A',
      });
      const fallback = resolveProductDetailTarget(input.source);
      jest
        .spyOn(personalProductTargetResolver, 'isAuthorizedPersonalInventoryRow')
        .mockReturnValue(false);
      expect(
        resolvePersonalAwareProductDetailTarget(input, inventory)
      ).toEqual(fallback);
    });
  });

  describe('buildPersonalAwareProductSearchResultHref', () => {
    it('1. active personal component resolves to personal_product href', () => {
      const inventory = buildCrossStoreInventory();
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const href = buildPersonalAwareProductSearchResultHref(
        sourceInput({ receiptId: 'r-aeon', itemId: 'r-aeon:0' }),
        inventory
      );
      expect(href).toBe(
        `/product/personal_product?key=${encodeURIComponent(anchorId)}`
      );
    });

    it('2. no personal truth preserves existing SKU/canonical/family href', () => {
      const input = sourceInput({
        receiptId: 'r-x',
        itemId: 'r-x:0',
        skuKey: 'SKU-X',
      });
      const href = buildPersonalAwareProductSearchResultHref(input, null);
      expect(href).toBe(buildProductSearchResultHref(input.source));
    });

    it('3. occurrence fallback navigates to projected receipt history route', () => {
      const input = sourceInput({
        receiptId: 'r-visible',
        itemId: 'r-visible:3',
        sourceIndex: 3,
      });
      const href = buildPersonalAwareProductSearchResultHref(input, null);
      expect(href).toBe('/history/r-visible');
    });

    it('4. projected duplicate uses personalEvidenceReceiptId for personal lookup, not projected receiptId', () => {
      const inventory = buildCrossStoreInventory();
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const withEvidence = sourceInput({
        receiptId: 'r-representative',
        itemId: 'r-york:0',
        personalEvidenceReceiptId: 'r-york',
      });
      expect(
        buildPersonalAwareProductSearchResultHref(withEvidence, inventory)
      ).toBe(
        `/product/personal_product?key=${encodeURIComponent(anchorId)}`
      );
      const withoutEvidence = sourceInput({
        receiptId: 'r-representative',
        itemId: 'r-york:0',
      });
      expect(
        buildPersonalAwareProductSearchResultHref(withoutEvidence, inventory)
      ).not.toBe(
        `/product/personal_product?key=${encodeURIComponent(anchorId)}`
      );
    });

    it('4b. projectHistorySearchToPurchaseTruth preserves personalEvidenceReceiptId', () => {
      const stored = [0, 1, 2, 3].map((i) =>
        receipt(`aeon-scan-${i}`, {
          merchant_raw: 'イオン古川店',
          merchant_normalized: 'イオン古川店',
          total: 4118,
          analysis_json: JSON.stringify({
            items: [
              { name: '卵', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
              { name: '牛乳', category: 'food_ingredients', lineTotal: 3918, quantity: 1 },
            ],
          }),
        })
      );
      const view = buildHistoryPurchaseTruthView(stored);
      const duplicateId = 'aeon-scan-2';
      const representativeId = view.visibleRows[0]!.id;
      expect(representativeId).not.toBe(duplicateId);
      expect(view.selection.excludedDuplicateReceiptIds.has(duplicateId)).toBe(
        true
      );

      const rawHit = {
        receiptId: duplicateId,
        itemId: `${duplicateId}:2`,
        sourceIndex: 2,
        displayName: '牛乳',
        personalEvidenceReceiptId: duplicateId,
      };
      const projected = projectHistorySearchToPurchaseTruth(
        { itemResults: [rawHit], receiptResults: [] },
        view.selection
      ).itemResults[0] as typeof rawHit & { receiptId: string };

      expect(projected.receiptId).toBe(representativeId);
      expect(projected.personalEvidenceReceiptId).toBe(duplicateId);
      expect(projected.sourceIndex).toBe(2);
    });

    it('5. duplicate-excluded real inventory row rejects personal despite active SAME', () => {
      const withoutExclusion = buildDuplicateRowInventory(new Set());
      const withExclusion = buildDuplicateRowInventory(new Set(['r-dup']));
      const anchorId = [...withoutExclusion.endpointsById.keys()].sort()[0]!;
      const input = sourceInput({
        receiptId: 'r-rep',
        itemId: 'r-dup:2',
        sourceIndex: 2,
        personalEvidenceReceiptId: 'r-dup',
      });

      expect(
        resolvePersonalAwareProductDetailTarget(input, withoutExclusion)
      ).toEqual({
        type: 'personal_product',
        key: anchorId,
      });

      const excludedTarget = resolvePersonalAwareProductDetailTarget(
        input,
        withExclusion
      );
      expect(excludedTarget).toEqual(resolveProductDetailTarget(input.source));
      expect(excludedTarget.type).toBe('occurrence');

      const href = buildPersonalAwareProductSearchResultHref(
        input,
        withExclusion
      );
      expect(href).toBe('/history/r-rep');
    });

    it('6. occurrence navigation still uses projected representative receiptId', () => {
      const input = sourceInput({
        receiptId: 'r-representative',
        itemId: 'r-dup:1',
        sourceIndex: 1,
        personalEvidenceReceiptId: 'r-dup',
      });
      const href = buildPersonalAwareProductSearchResultHref(input, null);
      expect(href).toBe('/history/r-representative');
    });
  });

  describe('buildPersonalAwareAggregatableProductDetailHref (receipt detail)', () => {
    it('1. active personal SAME with SKU resolves to personal href', () => {
      const inventory = buildCrossStoreInventory(new Set(), {
        aeon: { skuKey: 'SKU-AEON' },
      });
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const href = buildPersonalAwareAggregatableProductDetailHref(
        sourceInput({
          receiptId: 'r-aeon',
          itemId: 'r-aeon:0',
          skuKey: 'SKU-AEON',
        }),
        inventory
      );
      expect(href).toBe(
        `/product/personal_product?key=${encodeURIComponent(anchorId)}`
      );
    });

    it('2. active personal SAME without automatic identity still resolves to personal href', () => {
      const inventory = buildCrossStoreInventory();
      const anchorId = [...inventory.endpointsById.keys()].sort()[0]!;
      const href = buildPersonalAwareAggregatableProductDetailHref(
        sourceInput({ receiptId: 'r-aeon', itemId: 'r-aeon:0' }),
        inventory
      );
      expect(href).toBe(
        `/product/personal_product?key=${encodeURIComponent(anchorId)}`
      );
    });

    it('3. no personal with SKU preserves existing SKU href', () => {
      const input = sourceInput({
        receiptId: 'r-solo',
        itemId: 'r-solo:0',
        skuKey: 'SKU-SOLO',
      });
      const href = buildPersonalAwareAggregatableProductDetailHref(
        input,
        buildSoloInventory()
      );
      expect(href).toBe('/product/sku?key=SKU-SOLO');
    });

    it('4. no personal with occurrence returns null product link', () => {
      const input = sourceInput({
        receiptId: 'r-solo',
        itemId: 'r-solo:0',
      });
      const href = buildPersonalAwareAggregatableProductDetailHref(
        input,
        buildSoloInventory()
      );
      expect(href).toBeNull();
    });

    it('8. personal inventory unavailable preserves existing behavior', () => {
      const input = sourceInput({
        receiptId: 'r-x',
        itemId: 'r-x:0',
        skuKey: 'SKU-X',
      });
      expect(
        buildPersonalAwareAggregatableProductDetailHref(input, null)
      ).toBe('/product/sku?key=SKU-X');
      const occurrenceInput = sourceInput({
        receiptId: 'r-x',
        itemId: 'r-x:0',
      });
      expect(
        buildPersonalAwareAggregatableProductDetailHref(occurrenceInput, null)
      ).toBeNull();
    });
  });

  describe('resolveReceiptItemPersistedSourceIndex', () => {
    it('prefers valid review_source_index over source_index and render index', () => {
      expect(
        resolveReceiptItemPersistedSourceIndex(
          { review_source_index: 3, source_index: 4 },
          5
        )
      ).toBe(3);
    });

    it('falls back to source_index when review_source_index is invalid', () => {
      expect(
        resolveReceiptItemPersistedSourceIndex(
          { review_source_index: -1, source_index: 4 },
          5
        )
      ).toBe(4);
      expect(
        resolveReceiptItemPersistedSourceIndex(
          { review_source_index: 1.5, source_index: 4 },
          5
        )
      ).toBe(4);
      expect(
        resolveReceiptItemPersistedSourceIndex(
          { review_source_index: '3', source_index: 4 },
          5
        )
      ).toBe(4);
    });

    it('falls back to render index when persisted indices are invalid', () => {
      expect(
        resolveReceiptItemPersistedSourceIndex(
          { review_source_index: -1, source_index: -2 },
          5
        )
      ).toBe(5);
      expect(
        resolveReceiptItemPersistedSourceIndex({ source_index: 2.5 }, 5)
      ).toBe(5);
      expect(
        resolveReceiptItemPersistedSourceIndex({ source_index: '2' }, 5)
      ).toBe(5);
    });

    it('ignores camelCase persisted alternatives', () => {
      expect(
        resolveReceiptItemPersistedSourceIndex(
          { reviewSourceIndex: 1, sourceIndex: 2 },
          5
        )
      ).toBe(5);
    });

    it('5. prefers review_source_index over render index', () => {
      expect(
        resolveReceiptItemPersistedSourceIndex(
          { review_source_index: 7, source_index: 3 },
          0
        )
      ).toBe(7);
    });

    it('6. prefers source_index over render index when review_source_index is absent', () => {
      expect(
        resolveReceiptItemPersistedSourceIndex({ source_index: 4 }, 0)
      ).toBe(4);
    });

    it('7. falls back to render index when persisted indices are absent', () => {
      expect(resolveReceiptItemPersistedSourceIndex({}, 2)).toBe(2);
    });
  });

  describe('canonical target cross-store convergence', () => {
    it('Store A and Store B members share identical personal_product key', () => {
      const inventory = buildCrossStoreInventory();
      const storeA = resolvePersonalAwareProductDetailTarget(
        sourceInput({ receiptId: 'r-aeon', itemId: 'r-aeon:0' }),
        inventory
      );
      const storeB = resolvePersonalAwareProductDetailTarget(
        sourceInput({ receiptId: 'r-york', itemId: 'r-york:0' }),
        inventory
      );
      expect(storeA.type).toBe('personal_product');
      expect(storeB.type).toBe('personal_product');
      if (storeA.type !== 'personal_product' || storeB.type !== 'personal_product') {
        return;
      }
      expect(storeA.key).toBe(storeB.key);
      expect(
        buildPersonalProductInventoryRowKey('r-aeon', 0)
      ).not.toBe(buildPersonalProductInventoryRowKey('r-york', 0));
    });
  });
});
