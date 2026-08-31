/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({ status: 'unauthenticated', userId: null })),
  subscribeAuthState: jest.fn(() => () => undefined),
  ensureAnonAuth: jest.fn(async () => undefined),
}));
jest.mock('./installationId', () => ({
  getOrCreateInstallationId: jest.fn(async () => 'install-test'),
}));

jest.mock('./analyticsReceiptSelection', () => ({
  selectAnalyticsReceipts: (receipts: unknown[]) => ({
    excludedDuplicateReceiptIds: new Set<string>(),
    highConfidenceDuplicateGroups: [],
    analyticsReceipts: receipts,
    storedReceipts: receipts,
  }),
  indexHighConfidenceDuplicateGroupsByReceiptId: () => new Map(),
}));

import {
  buildOwnerScopedInventoryPredicates,
  buildPersonalProductEndpointInventory,
  buildPersonalProductInventoryRowKey,
  hasMeaningfulPersonalIdentityStructuralEvidence,
  loadPersonalProductEndpointInventoryWithDb,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import {
  buildPersonalMerchantProductEndpointV1,
  type StoredPersonalProductIdentityDecision,
} from './personalProductIdentityContract';
import { buildProductAttributes } from './productIdentityContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import type { ReceiptRow } from './db';

const OWNER = 'user:inventory-owner';
const OTHER_OWNER = 'user:other-owner';
const INSTALL_OWNER = 'installation:install-a';

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> & {
    user_id?: string | null;
    installation_id?: string | null;
  } = {}
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
    itemId: 'i1',
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

function storedDecision(
  leftId: string,
  rightId: string,
  decision: StoredPersonalProductIdentityDecision['decision'] = 'same_product'
): StoredPersonalProductIdentityDecision {
  const left = buildPersonalMerchantProductEndpointV1({
    merchantProductId: leftId,
    merchantScopeKey: 'lawson',
    comparisonKey: `cmp-${leftId}`,
    attributes: buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml' },
    ]),
  });
  const right = buildPersonalMerchantProductEndpointV1({
    merchantProductId: rightId,
    merchantScopeKey: 'seven',
    comparisonKey: `cmp-${rightId}`,
    attributes: buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml' },
    ]),
  });
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

describe('G4-2A personalProductEndpointInventory', () => {
  it('owner predicates scope user receipts to receipts.user_id', () => {
    const predicates = buildOwnerScopedInventoryPredicates(OWNER);
    expect(predicates).toEqual({
      itemWhereSql: 'receipts.user_id = ?',
      receiptWhereSql: 'receipts.user_id = ?',
      params: ['inventory-owner'],
    });
  });

  it('installation owner predicate requires user_id IS NULL and installation_id', () => {
    const predicates = buildOwnerScopedInventoryPredicates(INSTALL_OWNER);
    expect(predicates).toEqual({
      itemWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
      receiptWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
      params: ['install-a'],
    });
  });

  it('loads owner-scoped rows via receipt_items join without listReceipts', async () => {
    const calls: Array<{ source: string; params: unknown[] }> = [];
    const db = {
      async getAllAsync<T>(source: string, params: unknown[] = []) {
        calls.push({ source, params });
        if (/FROM receipt_items/i.test(source) && /receipts\.user_id = \?/i.test(source)) {
          return [
            itemRow({
              receiptId: 'r-user',
              itemId: 'i-user',
              displayName: 'コカ・コーラ 500ml',
              rawName: 'コカ・コーラ 500ml',
            }),
          ] as T[];
        }
        if (/FROM receipts/i.test(source) && /receipts\.user_id = \?/i.test(source)) {
          return [receipt('r-user')] as T[];
        }
        if (/personal_product_identity_decisions/i.test(source)) {
          return [] as T[];
        }
        return [] as T[];
      },
    };

    const result = await loadPersonalProductEndpointInventoryWithDb(
      db as never,
      { userId: 'inventory-owner', installationId: null, transactionSource: 'receipt_ocr' },
      { listDecisions: async () => [] }
    );

    expect(result.status).toBe('ready');
    expect(calls.some((call) => /FROM receipt_items/i.test(call.source))).toBe(true);
    expect(calls.some((call) => /receipts\.user_id = \?/i.test(call.source))).toBe(true);
    expect(
      calls.some(
        (call) =>
          /FROM receipts/i.test(call.source) &&
          /receipts\.transaction_source AS transaction_source/i.test(call.source)
      )
    ).toBe(true);
    expect(calls.every((call) => !/listReceipts/i.test(call.source))).toBe(true);
    expect(calls[0]?.params).toEqual(['inventory-owner']);
  });

  it('does not leak cross-owner rows in SQL predicates', async () => {
    const db = {
      async getAllAsync<T>(source: string, params: unknown[] = []) {
        if (/receipts\.user_id = \?/i.test(source)) {
          expect(params[0]).toBe('inventory-owner');
          expect(source).not.toContain(OTHER_OWNER);
          return [] as T[];
        }
        return [] as T[];
      },
    };
    await loadPersonalProductEndpointInventoryWithDb(
      db as never,
      { userId: 'inventory-owner', installationId: 'ignored', transactionSource: 'receipt_ocr' },
      { listDecisions: async () => [] }
    );
  });

  it('uses one ProductIdentityStore for the full owner resolver pass', () => {
    let storeCount = 0;
    const store = createMemoryProductIdentityStore();
    const wrapped = {
      ...store,
      upsertMerchantProduct: ((input) => {
        storeCount += 1;
        return store.upsertMerchantProduct(input);
      }) as typeof store.upsertMerchantProduct,
    };

    const result = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [
        itemRow({
          receiptId: 'r1',
          sourceIndex: 0,
          displayName: 'コカ・コーラ 500ml',
          rawName: 'コカ・コーラ 500ml',
          merchantNormalized: 'lawson',
        }),
        itemRow({
          receiptId: 'r2',
          sourceIndex: 0,
          displayName: 'コカ・コーラ 500ml',
          rawName: 'コカ・コーラ 500ml',
          merchantNormalized: 'seven',
          merchantRaw: 'Seven',
          occurredAt: 1_700_000_100_000,
        }),
      ],
      receipts: [receipt('r1'), receipt('r2', { merchant_normalized: 'seven', merchant_raw: 'Seven' })],
      decisionRows: [],
      store: wrapped,
    });

    expect(result.status).toBe('ready');
    expect(storeCount).toBeGreaterThan(0);
    const inventory = result.status === 'ready' ? result.inventory : null;
    expect(inventory?.itemsByRowKey.size).toBe(2);
    const ids = [...(inventory?.merchantProductsById.keys() ?? [])];
    expect(new Set(ids).size).toBe(2);
  });

  it('stable ordering drives deterministic MerchantProduct mapping', () => {
    const first = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [
        itemRow({ receiptId: 'r2', sourceIndex: 1, occurredAt: 2 }),
        itemRow({ receiptId: 'r1', sourceIndex: 0, occurredAt: 1 }),
      ],
      receipts: [receipt('r1'), receipt('r2')],
      decisionRows: [],
    });
    const second = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [
        itemRow({ receiptId: 'r1', sourceIndex: 0, occurredAt: 1 }),
        itemRow({ receiptId: 'r2', sourceIndex: 1, occurredAt: 2 }),
      ],
      receipts: [receipt('r1'), receipt('r2')],
      decisionRows: [],
    });
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    if (first.status !== 'ready' || second.status !== 'ready') return;
    expect(
      first.inventory.itemsByRowKey.get(buildPersonalProductInventoryRowKey('r1', 0))
        ?.merchantProductId
    ).toBe(
      second.inventory.itemsByRowKey.get(buildPersonalProductInventoryRowKey('r1', 0))
        ?.merchantProductId
    );
  });

  it('builds endpoints from MerchantProduct records via shared builder', () => {
    const result = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [itemRow()],
      receipts: [receipt('r1')],
      decisionRows: [],
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const item = result.inventory.itemsByRowKey.values().next().value;
    const endpoint = result.inventory.endpointsById.get(item!.merchantProductId);
    const record = result.inventory.merchantProductsById.get(item!.merchantProductId);
    expect(endpoint).toEqual(
      buildPersonalMerchantProductEndpointV1({
        merchantProductId: record!.id,
        merchantScopeKey: record!.merchantKey,
        comparisonKey: record!.comparisonKey,
        attributes: record!.attributes,
      })
    );
  });

  it('includes required stored graph endpoint objects in snapshot when present', () => {
    const built = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [itemRow()],
      receipts: [receipt('r1')],
      decisionRows: [],
    });
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') return;
    const mpId = [...built.inventory.merchantProductsById.keys()][0]!;
    const missingId = 'mp-missing-graph-node';
    const result = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [itemRow()],
      receipts: [receipt('r1')],
      decisionRows: [storedDecision(mpId, missingId)],
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.inventory.snapshot.get(mpId)).toBeTruthy();
    expect(result.inventory.snapshot.get(missingId)).toBeNull();
  });

  it('marks query failure as current_endpoint_context_incomplete, not null snapshot entries', async () => {
    const db = {
      async getAllAsync() {
        throw new Error('db down');
      },
    };
    const result = await loadPersonalProductEndpointInventoryWithDb(
      db as never,
      { userId: 'inventory-owner', installationId: null, transactionSource: 'receipt_ocr' }
    );
    expect(result.status).toBe('current_endpoint_context_incomplete');
    expect(result).not.toHaveProperty('inventory');
  });

  it('keeps duplicate receipt rows in endpoint existence inventory', () => {
    const result = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [
        itemRow({ receiptId: 'dup-a', itemId: 'i1' }),
        itemRow({ receiptId: 'dup-b', itemId: 'i2', occurredAt: 1_700_000_000_001 }),
      ],
      receipts: [
        receipt('dup-a'),
        receipt('dup-b', { transaction_at: 1_700_000_000_001 }),
      ],
      decisionRows: [],
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.inventory.itemsByRowKey.size).toBe(2);
  });

  it('does not write personal decisions during inventory build', async () => {
    let insertCalls = 0;
    const db = {
      async getAllAsync<T>(source: string) {
        if (/receipt_items/i.test(source)) {
          return [itemRow()] as T[];
        }
        if (/FROM receipts/i.test(source)) {
          return [receipt('r1')] as T[];
        }
        return [] as T[];
      },
      async runAsync(source: string) {
        if (/INSERT INTO personal_product_identity_decisions/i.test(source)) {
          insertCalls += 1;
        }
        return { changes: 0 };
      },
    };
    await loadPersonalProductEndpointInventoryWithDb(
      db,
      { userId: 'inventory-owner', installationId: null, transactionSource: 'receipt_ocr' },
      { listDecisions: async () => [] }
    );
    expect(insertCalls).toBe(0);
  });

  it('uses resolver-selected merchantProductId, not comparisonKey collision candidate', () => {
    const store = createMemoryProductIdentityStore();
    const merchantKey = 'lawson';
    const productName = 'コカ・コーラ 500ml';
    const norm = normalizeProductForIdentity(productName);
    const selectedId = 'mp-y-selected';

    store.upsertMerchantProduct({
      id: selectedId,
      merchantKey,
      comparisonKey: `${norm.comparisonKey}-selected`,
      canonicalDisplayName: productName,
      normalizedName: productName,
      brand: null,
      attributes: buildProductAttributes([
        { dimension: 'volume', value: 500, unit: 'ml' },
      ]),
    });
    store.upsertMerchantProduct({
      id: 'mp-x-conflict',
      merchantKey,
      comparisonKey: norm.comparisonKey,
      canonicalDisplayName: productName,
      normalizedName: productName,
      brand: null,
      attributes: buildProductAttributes([
        { dimension: 'volume', value: 1000, unit: 'ml' },
      ]),
    });

    const resolved = resolveReceiptItemIdentity(
      {
        rawName: productName,
        merchantKey,
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store
    );
    expect(resolved.link.merchantProductId).toBe(selectedId);

    const result = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [
        itemRow({
          receiptId: 'r1',
          displayName: productName,
          rawName: productName,
        }),
      ],
      receipts: [receipt('r1')],
      decisionRows: [],
      store,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const inventoryItem = result.inventory.itemsByRowKey.get(
      buildPersonalProductInventoryRowKey('r1', 0)
    );
    expect(inventoryItem?.merchantProductId).toBe(selectedId);
    expect(inventoryItem?.merchantProductId).not.toBe('mp-x-conflict');
    expect(result.inventory.endpointsById.get(selectedId)?.merchantProductId).toBe(
      selectedId
    );
    expect(result.inventory.endpointsById.has('mp-x-conflict')).toBe(false);
  });

  it('fails closed when resolver-selected merchant product record is missing from store', () => {
    const store = createMemoryProductIdentityStore();
    jest.spyOn(store, 'getMerchantProduct').mockReturnValue(null);
    const result = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [itemRow()],
      receipts: [receipt('r1')],
      decisionRows: [],
      store,
    });
    expect(result.status).toBe('current_endpoint_context_incomplete');
    expect(result).toMatchObject({
      reason: 'resolver_selected_merchant_product_missing',
    });
    expect('inventory' in result).toBe(false);
  });

  it('returns current_endpoint_context_incomplete when inventory build throws', async () => {
    const db = {
      async getAllAsync<T>(source: string) {
        if (/receipt_items/i.test(source)) return [] as T[];
        if (/FROM receipts/i.test(source)) return [receipt('r1')] as T[];
        return [] as T[];
      },
    };
    const result = await loadPersonalProductEndpointInventoryWithDb(
      db as never,
      { userId: 'inventory-owner', installationId: null, transactionSource: 'receipt_ocr' },
      {
        listDecisions: async () => [],
        buildInventory: () => {
          throw new Error('resolver exploded');
        },
      }
    );
    expect(result.status).toBe('current_endpoint_context_incomplete');
    expect(result).toMatchObject({ reason: 'inventory_construction_failed' });
    expect(result).not.toHaveProperty('inventory');
  });
});

describe('G4-2A meaningful structural evidence', () => {
  it('accepts meaningful same structural attrs', () => {
    expect(
      hasMeaningfulPersonalIdentityStructuralEvidence(
        buildProductAttributes([{ dimension: 'volume', value: 500, unit: 'ml' }])
      )
    ).toBe(true);
  });

  it('rejects empty-vs-empty structural signatures for prompt evidence', () => {
    const empty = buildProductAttributes([]);
    expect(hasMeaningfulPersonalIdentityStructuralEvidence(empty)).toBe(false);
    const left = buildPersonalMerchantProductEndpointV1({
      merchantProductId: 'a',
      merchantScopeKey: 'lawson',
      comparisonKey: 'a',
      attributes: empty,
    });
    const right = buildPersonalMerchantProductEndpointV1({
      merchantProductId: 'b',
      merchantScopeKey: 'seven',
      comparisonKey: 'b',
      attributes: empty,
    });
    expect(left.structuralSignature).toBe('struct-v1:empty');
    expect(right.structuralSignature).toBe('struct-v1:empty');
    expect(
      hasMeaningfulPersonalIdentityStructuralEvidence(empty) &&
        left.structuralSignature === right.structuralSignature
    ).toBe(false);
  });

  it('rejects one-sided structural evidence', () => {
    expect(
      hasMeaningfulPersonalIdentityStructuralEvidence(
        buildProductAttributes([{ dimension: 'volume', value: 500, unit: 'ml' }])
      ) &&
        hasMeaningfulPersonalIdentityStructuralEvidence(buildProductAttributes([]))
    ).toBe(false);
  });
});
