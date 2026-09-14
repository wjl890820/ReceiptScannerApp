/**
 * Receipt073 A4 — personal inventory session cache lifecycle.
 * Proves Home/History-equivalent loaders share one build across focus.
 */

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
    analyticsPurchaseCandidateCount: receipts.length,
    contentExactDuplicateExtras: 0,
    structuralExactDuplicateExtras: 0,
    reconciledStructuralExactDuplicateExtras: 0,
    probableDuplicateExtras: 0,
    highConfidenceDuplicateExtras: 0,
    keepSeparateReceiptIds: new Set<string>(),
  }),
  buildAnalyticsReceiptSelectionDecision: () => ({
    excludedDuplicateReceiptIds: new Set<string>(),
    highConfidenceDuplicateGroups: [],
    contentExactDuplicateExtras: 0,
    structuralExactDuplicateExtras: 0,
    reconciledStructuralExactDuplicateExtras: 0,
    probableDuplicateExtras: 0,
    highConfidenceDuplicateExtras: 0,
    keepSeparateReceiptIds: new Set<string>(),
  }),
  materializeAnalyticsReceiptSelection: (
    receipts: unknown[],
    decision: Record<string, unknown>
  ) => ({
    ...decision,
    storedReceipts: receipts,
    analyticsReceipts: receipts,
    analyticsPurchaseCandidateCount: receipts.length,
  }),
  indexHighConfidenceDuplicateGroupsByReceiptId: () => new Map(),
}));

import * as productIdentityResolver from './productIdentityResolver';
import {
  getPersonalProductInventoryFullBuildCount,
  loadPersonalProductEndpointInventoryWithDb,
  __resetPersonalProductEndpointInventoryCacheForTests,
  type PersonalProductEndpointInventoryDatabase,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import {
  buildPersonalProductInventoryCacheKey,
  invalidatePersonalProductEndpointInventory,
  readPersonalProductEndpointInventoryCache,
  writePersonalProductEndpointInventoryCache,
} from './personalProductEndpointInventoryCache';
import { PRODUCT_IDENTITY_RESOLVER_VERSION } from './productIdentityContract';
import { PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION } from './personalProductIdentityContract';
import type { ReceiptRow } from './db';

const OWNER_A = 'user:owner-a';
const OWNER_B = 'user:owner-b';

function receipt(
  id: string,
  userId: string,
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
    user_id: userId,
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

function makeDb(options: {
  items: PersonalProductEndpointInventorySourceRow[];
  receipts: ReceiptRow[];
  onQuery?: () => void;
  delayMs?: number;
}): PersonalProductEndpointInventoryDatabase & { queryCount: number } {
  const state = { queryCount: 0 };
  return {
    get queryCount() {
      return state.queryCount;
    },
    async getAllAsync<T>(source: string) {
      state.queryCount += 1;
      options.onQuery?.();
      if (options.delayMs && options.delayMs > 0) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
      if (/receipt_items/i.test(source)) {
        return options.items as T[];
      }
      if (/FROM receipts/i.test(source)) {
        return options.receipts as T[];
      }
      return [] as T[];
    },
  };
}

const stampA = {
  userId: 'owner-a',
  installationId: null as string | null,
  transactionSource: 'receipt_ocr' as const,
};
const stampB = {
  userId: 'owner-b',
  installationId: null as string | null,
  transactionSource: 'receipt_ocr' as const,
};

describe('Receipt073 A4 personal inventory session cache', () => {
  beforeEach(() => {
    __resetPersonalProductEndpointInventoryCacheForTests();
    jest.restoreAllMocks();
  });

  it('T1 first load builds once, resolves identities, and caches ready result', async () => {
    const resolveSpy = jest.spyOn(
      productIdentityResolver,
      'resolveReceiptItemIdentity'
    );
    const db = makeDb({
      items: [
        itemRow(),
        itemRow({
          receiptId: 'r2',
          itemId: 'i2',
          sourceIndex: 0,
          displayName: '明治おいしい牛乳 900ml',
          rawName: '明治おいしい牛乳 900ml',
        }),
      ],
      receipts: [receipt('r1', 'owner-a'), receipt('r2', 'owner-a')],
    });

    const result = await loadPersonalProductEndpointInventoryWithDb(db, stampA, {
      listDecisions: async () => [],
    });

    expect(result.status).toBe('ready');
    expect(getPersonalProductInventoryFullBuildCount()).toBe(1);
    expect(resolveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(db.queryCount).toBeGreaterThanOrEqual(2);

    const key = buildPersonalProductInventoryCacheKey({
      ownerKey: OWNER_A,
      dataGeneration: 0,
      resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
      pipelineVersion: PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
    });
    expect(readPersonalProductEndpointInventoryCache(key)?.status).toBe('ready');
  });

  it('T2 second unchanged load reuses cache without second full build/resolves', async () => {
    const resolveSpy = jest.spyOn(
      productIdentityResolver,
      'resolveReceiptItemIdentity'
    );
    const db = makeDb({
      items: [itemRow()],
      receipts: [receipt('r1', 'owner-a')],
    });
    const deps = { listDecisions: async () => [] };

    const first = await loadPersonalProductEndpointInventoryWithDb(db, stampA, deps);
    const resolvesAfterFirst = resolveSpy.mock.calls.length;
    const queriesAfterFirst = db.queryCount;
    expect(getPersonalProductInventoryFullBuildCount()).toBe(1);

    const second = await loadPersonalProductEndpointInventoryWithDb(db, stampA, deps);
    expect(second.status).toBe('ready');
    expect(first.status).toBe('ready');
    if (first.status === 'ready' && second.status === 'ready') {
      expect(second.inventory).toBe(first.inventory);
      expect(second.inventory.itemsByRowKey.size).toBe(
        first.inventory.itemsByRowKey.size
      );
    }
    expect(getPersonalProductInventoryFullBuildCount()).toBe(1);
    expect(resolveSpy.mock.calls.length).toBe(resolvesAfterFirst);
    expect(db.queryCount).toBe(queriesAfterFirst);
  });

  it('T3 two consumers share the same inventory-layer cache', async () => {
    const db = makeDb({
      items: [itemRow()],
      receipts: [receipt('r1', 'owner-a')],
    });
    const deps = { listDecisions: async () => [] };

    const home = await loadPersonalProductEndpointInventoryWithDb(db, stampA, deps);
    const history = await loadPersonalProductEndpointInventoryWithDb(
      db,
      stampA,
      deps
    );
    expect(getPersonalProductInventoryFullBuildCount()).toBe(1);
    expect(home).toBe(history);
  });

  it('T4 concurrent same-owner loads dedupe to one underlying build', async () => {
    const resolveSpy = jest.spyOn(
      productIdentityResolver,
      'resolveReceiptItemIdentity'
    );
    const db = makeDb({
      items: [itemRow(), itemRow({ receiptId: 'r2', itemId: 'i2' })],
      receipts: [receipt('r1', 'owner-a'), receipt('r2', 'owner-a')],
      delayMs: 40,
    });
    const deps = { listDecisions: async () => [] };

    const [a, b] = await Promise.all([
      loadPersonalProductEndpointInventoryWithDb(db, stampA, deps),
      loadPersonalProductEndpointInventoryWithDb(db, stampA, deps),
    ]);

    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
    expect(a).toBe(b);
    expect(getPersonalProductInventoryFullBuildCount()).toBe(1);
    // One build ⇒ resolve once per product row, not doubled.
    expect(resolveSpy.mock.calls.length).toBe(2);
  });

  it('T5 receipt_saved invalidation forces rebuild including new rows', async () => {
    const items = [itemRow()];
    const receipts = [receipt('r1', 'owner-a')];
    const db = makeDb({ items, receipts });
    const deps = { listDecisions: async () => [] };

    const first = await loadPersonalProductEndpointInventoryWithDb(db, stampA, deps);
    expect(first.status).toBe('ready');
    if (first.status === 'ready') {
      expect(first.inventory.itemsByRowKey.size).toBe(1);
    }

    items.push(
      itemRow({
        receiptId: 'r-new',
        itemId: 'i-new',
        displayName: '天然水 2L',
        rawName: '天然水 2L',
      })
    );
    receipts.push(receipt('r-new', 'owner-a'));
    invalidatePersonalProductEndpointInventory('receipt_saved');

    const second = await loadPersonalProductEndpointInventoryWithDb(db, stampA, deps);
    expect(getPersonalProductInventoryFullBuildCount()).toBe(2);
    expect(second.status).toBe('ready');
    if (second.status === 'ready') {
      expect(second.inventory.itemsByRowKey.size).toBe(2);
      expect(second.inventory.itemsByRowKey.has('r-new:0')).toBe(true);
    }
  });

  it('T6 identity-relevant invalidation does not reuse old inventory', async () => {
    const db = makeDb({
      items: [itemRow()],
      receipts: [receipt('r1', 'owner-a')],
    });
    const deps = { listDecisions: async () => [] };
    const first = await loadPersonalProductEndpointInventoryWithDb(db, stampA, deps);
    invalidatePersonalProductEndpointInventory('identity_decision');
    const second = await loadPersonalProductEndpointInventoryWithDb(db, stampA, deps);
    expect(getPersonalProductInventoryFullBuildCount()).toBe(2);
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    if (first.status === 'ready' && second.status === 'ready') {
      expect(second.inventory).not.toBe(first.inventory);
    }
  });

  it('T7 owner A cache never serves owner B', async () => {
    const dbA = makeDb({
      items: [itemRow({ displayName: 'OwnerA専用', rawName: 'OwnerA専用' })],
      receipts: [receipt('r1', 'owner-a')],
    });
    const dbB = makeDb({
      items: [
        itemRow({
          displayName: 'OwnerB専用',
          rawName: 'OwnerB専用',
          receiptId: 'rb',
          itemId: 'ib',
        }),
      ],
      receipts: [receipt('rb', 'owner-b')],
    });

    const a = await loadPersonalProductEndpointInventoryWithDb(dbA, stampA, {
      listDecisions: async () => [],
    });
    const b = await loadPersonalProductEndpointInventoryWithDb(dbB, stampB, {
      listDecisions: async () => [],
    });
    expect(getPersonalProductInventoryFullBuildCount()).toBe(2);
    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
    if (a.status === 'ready' && b.status === 'ready') {
      expect(a.inventory.ownerKey).toBe(OWNER_A);
      expect(b.inventory.ownerKey).toBe(OWNER_B);
      expect(b.inventory).not.toBe(a.inventory);
      const aName = [...a.inventory.itemsByRowKey.values()][0]?.displayName;
      const bName = [...b.inventory.itemsByRowKey.values()][0]?.displayName;
      expect(aName).toContain('OwnerA');
      expect(bName).toContain('OwnerB');
    }
  });

  it('T8 incompatible resolver semantics key must not reuse inventory', () => {
    const readyInventory = {
      status: 'ready' as const,
      inventory: {
        ownerKey: OWNER_A,
        snapshot: new Map(),
        endpointsById: new Map(),
        merchantProductsById: new Map(),
        itemsByRowKey: new Map(),
        itemKeysByMerchantProductId: new Map(),
        receiptsById: new Map(),
        excludedDuplicateReceiptIds: new Set<string>(),
        highConfidenceDuplicateGroupByReceiptId: new Map(),
        decisionRows: [],
      },
    };
    const staleKey = buildPersonalProductInventoryCacheKey({
      ownerKey: OWNER_A,
      dataGeneration: 0,
      resolverVersion: 'meruno-product-identity-resolver-v1',
      pipelineVersion: PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
    });
    writePersonalProductEndpointInventoryCache({
      key: staleKey,
      ownerKey: OWNER_A,
      dataGeneration: 0,
      resolverVersion: 'meruno-product-identity-resolver-v1',
      pipelineVersion: PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
      result: readyInventory,
      rowCount: 0,
      resolveCount: 0,
    });

    const currentKey = buildPersonalProductInventoryCacheKey({
      ownerKey: OWNER_A,
      dataGeneration: 0,
      resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
      pipelineVersion: PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
    });
    expect(currentKey).not.toBe(staleKey);
    expect(readPersonalProductEndpointInventoryCache(currentKey)).toBeNull();
    expect(
      buildPersonalProductInventoryCacheKey({
        ownerKey: OWNER_A,
        dataGeneration: 0,
        resolverVersion: 'future-resolver-contract',
        pipelineVersion: PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
      })
    ).not.toBe(currentKey);
  });

  it('T9 failed build does not poison cache; next call can retry', async () => {
    let shouldFail = true;
    const db = makeDb({
      items: [itemRow()],
      receipts: [receipt('r1', 'owner-a')],
    });

    const failed = await loadPersonalProductEndpointInventoryWithDb(db, stampA, {
      listDecisions: async () => [],
      buildInventory: () => {
        if (shouldFail) {
          throw new Error('synthetic_inventory_failure');
        }
        return {
          status: 'ready',
          inventory: {
            ownerKey: OWNER_A,
            snapshot: new Map(),
            endpointsById: new Map(),
            merchantProductsById: new Map(),
            itemsByRowKey: new Map(),
            itemKeysByMerchantProductId: new Map(),
            receiptsById: new Map(),
            excludedDuplicateReceiptIds: new Set(),
            highConfidenceDuplicateGroupByReceiptId: new Map(),
            decisionRows: [],
          },
        };
      },
    });
    expect(failed.status).toBe('current_endpoint_context_incomplete');
    expect(getPersonalProductInventoryFullBuildCount()).toBe(0);

    shouldFail = false;
    const recovered = await loadPersonalProductEndpointInventoryWithDb(db, stampA, {
      listDecisions: async () => [],
    });
    expect(recovered.status).toBe('ready');
    expect(getPersonalProductInventoryFullBuildCount()).toBe(1);
  });
});
