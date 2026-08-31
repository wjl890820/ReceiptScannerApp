/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  getReceiptsDatabase: jest.fn(),
}));

import {
  buildPersonalIdentityPromptCandidateV1,
  type PersonalIdentityPromptCandidateV1,
} from './personalProductIdentityCandidateService';
import {
  buildPersonalProductEndpointInventory,
  type PersonalProductEndpointInventory,
  type PersonalProductInventoryItem,
} from './personalProductEndpointInventory';
import {
  buildPersonalMerchantProductEndpointV1,
  type PersonalMerchantProductEndpointV1,
  type StoredPersonalProductIdentityDecision,
} from './personalProductIdentityContract';
import { buildProductAttributes } from './productIdentityContract';
import {
  confirmPersonalIdentityCandidateWithDb,
  displayedPersonalIdentityCandidateMatchesFresh,
  personalMerchantProductEndpointsAreExactlyEqual,
  revalidateDisplayedPersonalIdentityCandidate,
  type PersonalIdentityConfirmationDeps,
} from './personalProductIdentityConfirmationCoordinator';
import { createMemoryPersonalProductIdentityDatabase } from './personalProductIdentityRepository';
import type { ReceiptRow } from './db';
import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import type { ProductHistorySummary } from './productHistory';
import type { ProductPriceHistoryResult } from './productPriceHistory';

const OWNER = 'user:confirm-owner';
const SAVED = 'saved-r';
const MP_CURRENT = 'mp-current';
const MP_HISTORICAL = 'mp-historical';

function endpoint(
  id: string,
  scope: string,
  comparisonKey?: string
): PersonalMerchantProductEndpointV1 {
  return buildPersonalMerchantProductEndpointV1({
    merchantProductId: id,
    merchantScopeKey: scope,
    comparisonKey: comparisonKey ?? id,
    attributes: buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml' },
    ]),
  });
}

function item(
  overrides: Partial<PersonalProductInventoryItem> & {
    merchantProductId: string;
    receiptId: string;
    sourceIndex: number;
  }
): PersonalProductInventoryItem {
  const ep = endpoint(
    overrides.merchantProductId,
    overrides.merchantScopeKey ?? 'lawson'
  );
  return {
    itemId: `${overrides.receiptId}-${overrides.sourceIndex}`,
    occurredAt: overrides.occurredAt ?? 1_700_000_000_000,
    identityLevel: overrides.identityLevel ?? 'merchant_product',
    displayName: overrides.displayName ?? 'コカ・コーラ 500ml',
    merchantName: overrides.merchantName ?? 'Lawson',
    rawName: overrides.rawName ?? 'コカ・コーラ 500ml',
    merchantScopeKey: overrides.merchantScopeKey ?? ep.merchantScopeKey,
    skuKey: overrides.skuKey ?? null,
    brand: overrides.brand ?? null,
    attributes: buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml' },
    ]),
    specificationLabel: '500ml',
    ...overrides,
  };
}

function receiptRow(id: string, merchant = 'lawson', merchantRaw = 'Lawson'): ReceiptRow {
  return {
    id,
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_000_000,
    image_uri: 'file://x',
    merchant_raw: merchantRaw,
    merchant_normalized: merchant,
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
  };
}

function inventoryFromItems(
  items: PersonalProductInventoryItem[],
  decisionRows: StoredPersonalProductIdentityDecision[] = []
): PersonalProductEndpointInventory {
  const endpointsById = new Map(
    items.map((row) => [
      row.merchantProductId,
      endpoint(row.merchantProductId, row.merchantScopeKey),
    ])
  );
  const itemsByRowKey = new Map(
    items.map((row) => [`${row.receiptId}:${row.sourceIndex}`, row])
  );
  const itemKeysByMerchantProductId = new Map<string, string[]>();
  for (const row of items) {
    const key = `${row.receiptId}:${row.sourceIndex}`;
    const list = itemKeysByMerchantProductId.get(row.merchantProductId) ?? [];
    list.push(key);
    itemKeysByMerchantProductId.set(row.merchantProductId, list);
  }
  const snapshot = new Map<string, PersonalMerchantProductEndpointV1 | null>();
  for (const id of new Set(items.map((row) => row.merchantProductId))) {
    snapshot.set(id, endpointsById.get(id) ?? null);
  }
  for (const row of decisionRows) {
    snapshot.set(
      row.leftMerchantProductId,
      endpointsById.get(row.leftMerchantProductId) ??
        snapshot.get(row.leftMerchantProductId) ??
        null
    );
    snapshot.set(
      row.rightMerchantProductId,
      endpointsById.get(row.rightMerchantProductId) ??
        snapshot.get(row.rightMerchantProductId) ??
        null
    );
  }
  return {
    ownerKey: OWNER,
    snapshot,
    endpointsById,
    merchantProductsById: new Map(),
    itemsByRowKey,
    itemKeysByMerchantProductId,
    receiptsById: new Map(
      items.map((row) => [row.receiptId, receiptRow(row.receiptId)])
    ),
    excludedDuplicateReceiptIds: new Set(),
    highConfidenceDuplicateGroupByReceiptId: new Map(),
    decisionRows,
  };
}

function storedDecision(
  left: PersonalMerchantProductEndpointV1,
  right: PersonalMerchantProductEndpointV1,
  decision: StoredPersonalProductIdentityDecision['decision']
): StoredPersonalProductIdentityDecision {
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

function buildCandidateFixture(
  decisionRows: StoredPersonalProductIdentityDecision[] = []
): {
  inventory: PersonalProductEndpointInventory;
  candidate: PersonalIdentityPromptCandidateV1;
} {
  const baseCurrent = item({
    merchantProductId: MP_CURRENT,
    receiptId: SAVED,
    sourceIndex: 0,
    merchantScopeKey: 'lawson',
  });
  const baseHistorical = item({
    merchantProductId: MP_HISTORICAL,
    receiptId: 'hist-r',
    sourceIndex: 0,
    merchantScopeKey: 'seven',
    merchantName: 'Seven',
    occurredAt: 1_699_000_000_000,
  });
  const secondHistorical = item({
    merchantProductId: MP_HISTORICAL,
    receiptId: 'hist-r-2',
    sourceIndex: 0,
    merchantScopeKey: 'seven',
    merchantName: 'Seven',
    occurredAt: 1_698_000_000_000,
  });
  const olderCurrent = item({
    merchantProductId: MP_CURRENT,
    receiptId: 'old-current-r',
    sourceIndex: 0,
    merchantScopeKey: 'lawson',
    occurredAt: 1_698_500_000_000,
  });
  const inventory = inventoryFromItems(
    [baseCurrent, baseHistorical, secondHistorical, olderCurrent],
    decisionRows
  );
  const candidate = buildPersonalIdentityPromptCandidateV1({
    savedReceiptId: SAVED,
    currentItem: baseCurrent,
    historicalItem: baseHistorical,
    inventory,
    similarity: 0.99,
    valueReason: 'cross_merchant_history',
    prospectivePurchaseEventCount: 3,
    prospectiveMerchantCount: 2,
  })!;
  return { inventory, candidate };
}

function historySummary(
  overrides: Partial<ProductHistorySummary> = {}
): ProductHistorySummary {
  return {
    target: { type: 'personal_product', key: MP_CURRENT },
    title: 'Coke',
    purchaseOccurrenceCount: 3,
    totalPurchaseQuantity: 3,
    totalSpend: 450,
    currency: 'JPY',
    currencyTotals: [{ currency: 'JPY', totalSpend: 450 }],
    firstPurchasedAt: 1,
    lastPurchasedAt: 2,
    merchantCount: 2,
    canonicalProductCount: 1,
    skuCount: 0,
    specificationVariants: [],
    merchants: [],
    recentPurchases: [],
    ...overrides,
  };
}

function priceHistoryResult(
  overrides: Partial<ProductPriceHistoryResult> = {}
): ProductPriceHistoryResult {
  return {
    status: 'ready',
    target: { type: 'personal_product', key: MP_CURRENT },
    points: [],
    observations: [],
    currency: 'JPY',
    dimension: 'volume',
    totalOccurrenceCount: 2,
    comparableOccurrenceCount: 2,
    excludedOccurrenceCount: 0,
    ...overrides,
  } as ProductPriceHistoryResult;
}

function availableInterpretation(): ProductPriceChangeInterpretation & {
  status: 'available';
} {
  return {
    status: 'available',
    identityAuthority: {
      kind: 'personal_product',
      anchorMerchantProductId: MP_CURRENT,
      memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
    },
    previous: {
      receiptId: 'hist-r',
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
      receiptId: SAVED,
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
}

describe('G4-2C personalProductIdentityConfirmationCoordinator', () => {
  it('1 fresh candidate SAME pair => YES writes same_product', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(
      db,
      candidate,
      'same_product',
      undefined,
      {
        loadInventory: async () => ({ status: 'ready', inventory }),
        resolveTarget: () => ({
          status: 'ready',
          resolved: {
            requestedTarget: { type: 'personal_product', key: MP_CURRENT },
            canonicalTarget: { type: 'personal_product', key: MP_CURRENT },
            ownerKey: OWNER,
            authority: {
              identityLevel: 'product_exact',
              sourceTier: 'personal_manual',
              authority: {
                kind: 'personal_product',
                anchorMerchantProductId: MP_CURRENT,
                memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
              },
            },
            anchorMerchantProductId: MP_CURRENT,
            memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
            authorizedRowKeys: new Set(),
            inventory,
          },
        }),
        loadHistory: async () => historySummary(),
        loadPriceHistory: async () => priceHistoryResult(),
        interpretPriceChange: () => availableInterpretation(),
      }
    );
    expect(result.status).toBe('saved');
    if (result.status === 'saved') {
      expect(result.choice).toBe('same_product');
      expect(result.feedback?.kind).toBe('exact_price');
    }
  });

  it('2 NO writes not_same_product', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'not_same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
    });
    expect(result).toEqual({ status: 'saved', choice: 'not_same_product' });
  });

  it('3 UNSURE writes unsure', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'unsure', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
    });
    expect(result).toEqual({ status: 'saved', choice: 'unsure' });
  });

  it('4 fresh top candidate pair differs => stale_candidate and no write', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const drifted = {
      ...candidate,
      pair: {
        leftMerchantProductId: candidate.pair.leftMerchantProductId,
        rightMerchantProductId: 'mp-other',
      },
    };
    const result = await confirmPersonalIdentityCandidateWithDb(db, drifted, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
    });
    expect(result).toEqual({ status: 'stale_candidate' });
  });

  it('5 candidate disappears before click => stale_candidate and no write', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const emptyInventory = inventoryFromItems([]);
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory: emptyInventory }),
    });
    expect(result).toEqual({ status: 'stale_candidate' });
  });

  it('6 endpoint structural drift => stale_candidate and no write', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const driftedInventory = inventoryFromItems(
      [...inventory.itemsByRowKey.values()].map((row) =>
        row.merchantProductId === MP_HISTORICAL
          ? {
              ...row,
              merchantScopeKey: 'seven',
            }
          : row
      )
    );
    const driftedEndpoint = endpoint(MP_HISTORICAL, 'seven', 'changed-comparison');
    (driftedInventory.endpointsById as Map<string, PersonalMerchantProductEndpointV1>).set(
      MP_HISTORICAL,
      driftedEndpoint
    );
    (driftedInventory.snapshot as Map<string, PersonalMerchantProductEndpointV1 | null>).set(
      MP_HISTORICAL,
      driftedEndpoint
    );
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory: driftedInventory }),
    });
    expect(result).toEqual({ status: 'stale_candidate' });
  });

  it('7 relationship becomes NO before click => stale_candidate', async () => {
    const left = endpoint(MP_CURRENT, 'lawson');
    const right = endpoint(MP_HISTORICAL, 'seven');
    const { inventory, candidate } = buildCandidateFixture([
      storedDecision(left, right, 'not_same_product'),
    ]);
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
    });
    expect(result).toEqual({ status: 'stale_candidate' });
  });

  it('8 relationship becomes SAME before click => stale_candidate', async () => {
    const left = endpoint(MP_CURRENT, 'lawson');
    const right = endpoint(MP_HISTORICAL, 'seven');
    const { inventory, candidate } = buildCandidateFixture([
      storedDecision(left, right, 'same_product'),
    ]);
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
    });
    expect(result).toEqual({ status: 'stale_candidate' });
  });

  it('9 write receives fresh snapshot, not displayed stale snapshot', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const freshInventory = inventoryFromItems([...inventory.itemsByRowKey.values()]);
    let capturedSnapshot: unknown;
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'not_same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory: freshInventory }),
      recordDecision: async (_db, _owner, _left, _right, _decision, options) => {
        capturedSnapshot = options.currentEndpoints.get(MP_CURRENT);
        return { ok: true, outcome: 'created' };
      },
    });
    expect(result.status).toBe('saved');
    expect(capturedSnapshot).toBe(freshInventory.snapshot.get(MP_CURRENT));
    expect(capturedSnapshot).toEqual(candidate.current.endpoint);
  });

  it('10 YES reloads inventory AFTER write', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const calls: string[] = [];
    await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => {
        calls.push('load');
        return { status: 'ready', inventory };
      },
      resolveTarget: () => {
        calls.push('resolve');
        return {
          status: 'ready',
          resolved: {
            requestedTarget: { type: 'personal_product', key: MP_CURRENT },
            canonicalTarget: { type: 'personal_product', key: MP_CURRENT },
            ownerKey: OWNER,
            authority: {
              identityLevel: 'product_exact',
              sourceTier: 'personal_manual',
              authority: {
                kind: 'personal_product',
                anchorMerchantProductId: MP_CURRENT,
                memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
              },
            },
            anchorMerchantProductId: MP_CURRENT,
            memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
            authorizedRowKeys: new Set(),
            inventory,
          },
        };
      },
      loadHistory: async () => {
        calls.push('history');
        return historySummary({
          purchaseOccurrenceCount: 2,
          totalPurchaseQuantity: 2,
          totalSpend: 300,
        });
      },
      loadPriceHistory: async () => {
        calls.push('price');
        return priceHistoryResult({
          status: 'not_enough_points',
          currency: null,
        });
      },
      interpretPriceChange: () => ({ status: 'unavailable', reasonCodes: ['not_enough_distinct_purchase_events'] }),
    });
    expect(calls.filter((entry) => entry === 'load').length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain('resolve');
    expect(calls).toContain('history');
    expect(calls).toContain('price');
  });

  it('11 YES passes SAME ResolvedPersonalProductTarget into history + price', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const resolved = {
      requestedTarget: { type: 'personal_product' as const, key: MP_CURRENT },
      canonicalTarget: { type: 'personal_product' as const, key: MP_CURRENT },
      ownerKey: OWNER,
      authority: {
        identityLevel: 'product_exact' as const,
        sourceTier: 'personal_manual' as const,
        authority: {
          kind: 'personal_product' as const,
          anchorMerchantProductId: MP_CURRENT,
          memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
        },
      },
      anchorMerchantProductId: MP_CURRENT,
      memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
      authorizedRowKeys: new Set<string>(),
      inventory,
    };
    const historyContexts: unknown[] = [];
    const priceContexts: unknown[] = [];
    await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      resolveTarget: () => ({ status: 'ready', resolved }),
      loadHistory: async (_db, _target, options) => {
        historyContexts.push(options?.personalProductContext);
        return historySummary({
          purchaseOccurrenceCount: 2,
          totalPurchaseQuantity: 2,
          totalSpend: 300,
        });
      },
      loadPriceHistory: async (_db, _target, options) => {
        priceContexts.push(options?.personalProductContext);
        return priceHistoryResult({
          status: 'not_enough_points',
          currency: null,
        });
      },
      interpretPriceChange: () => ({ status: 'unavailable', reasonCodes: ['not_enough_distinct_purchase_events'] }),
    });
    expect(historyContexts[0]).toBe(resolved);
    expect(priceContexts[0]).toBe(resolved);
  });

  it('13 YES + available G3 interpretation => exact_price feedback', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      resolveTarget: () => ({
        status: 'ready',
        resolved: {
          requestedTarget: { type: 'personal_product', key: MP_CURRENT },
          canonicalTarget: { type: 'personal_product', key: MP_CURRENT },
          ownerKey: OWNER,
          authority: {
            identityLevel: 'product_exact',
            sourceTier: 'personal_manual',
            authority: {
              kind: 'personal_product',
              anchorMerchantProductId: MP_CURRENT,
              memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
            },
          },
          anchorMerchantProductId: MP_CURRENT,
          memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
          authorizedRowKeys: new Set(),
          inventory,
        },
      }),
      loadHistory: async () => historySummary(),
      loadPriceHistory: async () => priceHistoryResult(),
      interpretPriceChange: () => availableInterpretation(),
    });
    expect(result.status).toBe('saved');
    if (result.status === 'saved') {
      expect(result.feedback?.kind).toBe('exact_price');
    }
  });

  it('14 YES + unavailable G3 interpretation => history_unlocked feedback', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      resolveTarget: () => ({
        status: 'ready',
        resolved: {
          requestedTarget: { type: 'personal_product', key: MP_CURRENT },
          canonicalTarget: { type: 'personal_product', key: MP_CURRENT },
          ownerKey: OWNER,
          authority: {
            identityLevel: 'product_exact',
            sourceTier: 'personal_manual',
            authority: {
              kind: 'personal_product',
              anchorMerchantProductId: MP_CURRENT,
              memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
            },
          },
          anchorMerchantProductId: MP_CURRENT,
          memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
          authorizedRowKeys: new Set(),
          inventory,
        },
      }),
      loadHistory: async () =>
        historySummary({
          purchaseOccurrenceCount: 2,
          totalPurchaseQuantity: 2,
          totalSpend: 300,
        }),
      loadPriceHistory: async () =>
        priceHistoryResult({
          status: 'not_enough_points',
          currency: null,
        }),
      interpretPriceChange: () => ({ status: 'unavailable', reasonCodes: ['not_enough_distinct_purchase_events'] }),
    });
    expect(result.status).toBe('saved');
    if (result.status === 'saved') {
      expect(result.feedback?.kind).toBe('history_unlocked');
    }
  });

  it('15 SAME write succeeds but price load throws => still successful safe feedback', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      resolveTarget: () => ({
        status: 'ready',
        resolved: {
          requestedTarget: { type: 'personal_product', key: MP_CURRENT },
          canonicalTarget: { type: 'personal_product', key: MP_CURRENT },
          ownerKey: OWNER,
          authority: {
            identityLevel: 'product_exact',
            sourceTier: 'personal_manual',
            authority: {
              kind: 'personal_product',
              anchorMerchantProductId: MP_CURRENT,
              memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
            },
          },
          anchorMerchantProductId: MP_CURRENT,
          memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
          authorizedRowKeys: new Set(),
          inventory,
        },
      }),
      loadHistory: async () =>
        historySummary({
          purchaseOccurrenceCount: 2,
          totalPurchaseQuantity: 2,
          totalSpend: 300,
        }),
      loadPriceHistory: async () => {
        throw new Error('price failed');
      },
    });
    expect(result.status).toBe('saved');
    if (result.status === 'saved') {
      expect(result.feedback?.kind).toBe('history_unlocked');
    }
  });

  it('16 decision write failure => no exact feedback claim', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      recordDecision: async () => ({ ok: false, code: 'decision_conflict' }),
    });
    expect(result.status).toBe('decision_conflict');
  });

  it('17 canonical target in feedback is current anchor', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await confirmPersonalIdentityCandidateWithDb(db, candidate, 'same_product', undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
      resolveTarget: () => ({
        status: 'ready',
        resolved: {
          requestedTarget: { type: 'personal_product', key: MP_HISTORICAL },
          canonicalTarget: { type: 'personal_product', key: MP_CURRENT },
          ownerKey: OWNER,
          authority: {
            identityLevel: 'product_exact',
            sourceTier: 'personal_manual',
            authority: {
              kind: 'personal_product',
              anchorMerchantProductId: MP_CURRENT,
              memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
            },
          },
          anchorMerchantProductId: MP_CURRENT,
          memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
          authorizedRowKeys: new Set(),
          inventory,
        },
      }),
      loadHistory: async () =>
        historySummary({
          purchaseOccurrenceCount: 2,
          totalPurchaseQuantity: 2,
          totalSpend: 300,
        }),
      loadPriceHistory: async () =>
        priceHistoryResult({
          status: 'not_enough_points',
          currency: null,
        }),
      interpretPriceChange: () => ({ status: 'unavailable', reasonCodes: ['not_enough_distinct_purchase_events'] }),
    });
    expect(result.status).toBe('saved');
    if (result.status === 'saved') {
      expect(result.feedback?.target).toEqual({
        type: 'personal_product',
        key: MP_CURRENT,
      });
    }
  });

  it('endpoint equality helper requires exact identity contract fields', () => {
    const left = endpoint(MP_CURRENT, 'lawson');
    const right = endpoint(MP_CURRENT, 'lawson', 'different');
    expect(personalMerchantProductEndpointsAreExactlyEqual(left, left)).toBe(true);
    expect(personalMerchantProductEndpointsAreExactlyEqual(left, right)).toBe(false);
  });

  it('displayed candidate matcher rejects padded item identity drift', () => {
    const { inventory, candidate } = buildCandidateFixture();
    const fresh = buildPersonalIdentityPromptCandidateV1({
      savedReceiptId: SAVED,
      currentItem: {
        ...inventory.itemsByRowKey.get(`${SAVED}:0`)!,
        itemId: ' itemA ',
      },
      historicalItem: inventory.itemsByRowKey.get('hist-r:0')!,
      inventory,
      similarity: 0.99,
      valueReason: 'cross_merchant_history',
      prospectivePurchaseEventCount: 3,
      prospectiveMerchantCount: 2,
    })!;
    expect(displayedPersonalIdentityCandidateMatchesFresh(candidate, fresh)).toBe(false);
  });

  it('revalidateDisplayedPersonalIdentityCandidate returns ready for stable pair', async () => {
    const { inventory, candidate } = buildCandidateFixture();
    const result = await revalidateDisplayedPersonalIdentityCandidate(candidate, {} as never, undefined, {
      loadInventory: async () => ({ status: 'ready', inventory }),
    });
    expect(result.status).toBe('ready');
  });

  function readyResolved(inventory: PersonalProductEndpointInventory) {
    return {
      requestedTarget: { type: 'personal_product' as const, key: MP_CURRENT },
      canonicalTarget: { type: 'personal_product' as const, key: MP_CURRENT },
      ownerKey: OWNER,
      authority: {
        identityLevel: 'product_exact' as const,
        sourceTier: 'personal_manual' as const,
        authority: {
          kind: 'personal_product' as const,
          anchorMerchantProductId: MP_CURRENT,
          memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
        },
      },
      anchorMerchantProductId: MP_CURRENT,
      memberMerchantProductIds: [MP_CURRENT, MP_HISTORICAL],
      authorizedRowKeys: new Set<string>(),
      inventory,
    };
  }

  function sameWriteDeps(
    inventory: PersonalProductEndpointInventory,
    overrides: {
      postWriteInventoryThrows?: (
        loadCount: number,
        inv: PersonalProductEndpointInventory
      ) => unknown;
      postWriteInventoryNonReady?: boolean;
      resolveThrows?: boolean;
      resolveNonReady?: boolean;
      loadHistory?: PersonalIdentityConfirmationDeps['loadHistory'];
      loadPriceHistory?: PersonalIdentityConfirmationDeps['loadPriceHistory'];
      interpretPriceChange?: PersonalIdentityConfirmationDeps['interpretPriceChange'];
    } = {}
  ): PersonalIdentityConfirmationDeps {
    let inventoryLoads = 0;
    return {
      loadInventory: async () => {
        inventoryLoads += 1;
        if (overrides.postWriteInventoryThrows) {
          return (await overrides.postWriteInventoryThrows(
            inventoryLoads,
            inventory
          )) as Awaited<ReturnType<NonNullable<PersonalIdentityConfirmationDeps['loadInventory']>>>;
        }
        if (inventoryLoads === 1) {
          return { status: 'ready' as const, inventory };
        }
        if (overrides.postWriteInventoryNonReady) {
          return { status: 'owner_unavailable' as const };
        }
        return { status: 'ready' as const, inventory };
      },
      resolveTarget: () => {
        if (overrides.resolveThrows) {
          throw new Error('resolve failed');
        }
        if (overrides.resolveNonReady) {
          return { status: 'personal_product_not_authorized' as const };
        }
        return { status: 'ready' as const, resolved: readyResolved(inventory) };
      },
      loadHistory: overrides.loadHistory ?? (async () => historySummary()),
      loadPriceHistory:
        overrides.loadPriceHistory ?? (async () => priceHistoryResult()),
      interpretPriceChange:
        overrides.interpretPriceChange ?? (() => availableInterpretation()),
    };
  }

  describe('post-write SAME feedback safety', () => {
    it('keeps saved SAME when post-write inventory load throws with null target', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory, {
          postWriteInventoryThrows: (loadCount: number, inv: typeof inventory) =>
            loadCount === 1
              ? { status: 'ready', inventory: inv }
              : Promise.reject(new Error('post-write inventory failed')),
        })
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved') {
        expect(result.feedback?.kind).toBe('history_unlocked');
        expect(result.feedback?.target).toBeNull();
        expect(result.feedback?.purchaseOccurrenceCount).toBeNull();
      }
    });

    it('keeps saved SAME when post-write inventory is non-ready with null target', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory, { postWriteInventoryNonReady: true })
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved') {
        expect(result.feedback?.target).toBeNull();
      }
    });

    it('keeps saved SAME when personal target resolution throws with null target', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory, { resolveThrows: true })
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved') {
        expect(result.feedback?.target).toBeNull();
      }
    });

    it('keeps saved SAME when personal target resolution is non-ready with null target', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory, { resolveNonReady: true })
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved') {
        expect(result.feedback?.target).toBeNull();
      }
    });

    it('does not return exact_price when history rejects but price looks available', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory, {
          loadHistory: async () => Promise.reject(new Error('history failed')),
          loadPriceHistory: async () => priceHistoryResult(),
          interpretPriceChange: () => availableInterpretation(),
        })
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved') {
        expect(result.feedback?.kind).toBe('history_unlocked');
        expect(result.feedback?.purchaseOccurrenceCount).toBeNull();
        expect(result.feedback?.merchantCount).toBeNull();
      }
    });

    it('does not return exact_price when history returns null', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory, {
          loadHistory: async () => null,
          loadPriceHistory: async () => priceHistoryResult(),
          interpretPriceChange: () => availableInterpretation(),
        })
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved') {
        expect(result.feedback?.kind).not.toBe('exact_price');
      }
    });

    it('returns history_unlocked with real counts when price rejects', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory, {
          loadHistory: async () =>
            historySummary({ purchaseOccurrenceCount: 4, merchantCount: 3 }),
          loadPriceHistory: async () => Promise.reject(new Error('price failed')),
        })
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved' && result.feedback?.kind === 'history_unlocked') {
        expect(result.feedback.purchaseOccurrenceCount).toBe(4);
        expect(result.feedback.merchantCount).toBe(3);
        expect(result.feedback.kind).not.toBe('exact_price');
      }
    });

    it('returns exact_price only when history, price, and G3 all succeed', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory)
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved') {
        expect(result.feedback?.kind).toBe('exact_price');
        expect(result.feedback?.target).toEqual({
          type: 'personal_product',
          key: MP_CURRENT,
        });
        expect(result.feedback?.purchaseOccurrenceCount).toBe(3);
      }
    });

    it('never fabricates personal_product target from pre-write candidate MP', async () => {
      const { inventory, candidate } = buildCandidateFixture();
      const db = createMemoryPersonalProductIdentityDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        'same_product',
        undefined,
        sameWriteDeps(inventory, { resolveNonReady: true })
      );
      expect(result.status).toBe('saved');
      if (result.status === 'saved' && result.feedback) {
        expect(result.feedback.target).not.toEqual({
          type: 'personal_product',
          key: candidate.current.endpoint.merchantProductId,
        });
        expect(result.feedback.target).toBeNull();
      }
    });
  });
});
