/**
 * Receipt073 Round 4 — mutation → inventory-cache invalidation ordering.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', extra: {} } },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const map = new Map<string, string>();
  return {
    getItem: jest.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
    setItem: jest.fn(async (k: string, v: string) => {
      map.set(k, v);
    }),
  };
});

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('nanoid/non-secure', () => {
  let nextId = 1;
  return {
    nanoid: jest.fn(() => `mut-ord-${nextId++}`),
  };
});

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
}));

jest.mock('./receiptItemIndex', () => {
  const actual = jest.requireActual('./receiptItemIndex');
  return {
    ...actual,
    ensureReceiptItemsSchema: jest.fn(async () => undefined),
    rebuildReceiptItemIndex: jest.fn(async () => undefined),
    deleteReceiptItemIndex: jest.fn(async () => undefined),
    clearReceiptItemIndex: jest.fn(async () => undefined),
  };
});

const ownershipMock = {
  userId: 'owner-mut' as string | null,
  installationId: 'install-mut' as string | null,
};

jest.mock('./receiptOwnershipContext', () => ({
  TRANSACTION_SOURCE_RECEIPT_OCR: 'receipt_ocr',
  resolveOwnershipStamp: jest.fn(async () => ({
    userId: ownershipMock.userId,
    installationId: ownershipMock.installationId,
    transactionSource: 'receipt_ocr',
  })),
}));

jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({
    status: ownershipMock.userId ? 'authenticated' : 'unavailable',
    userId: ownershipMock.userId,
    isAnonymous: true,
    hasAppleIdentity: false,
    accessToken: ownershipMock.userId ? 'tok' : null,
    error: null,
  })),
  ensureAnonAuth: jest.fn(async () => ({
    status: ownershipMock.userId ? 'authenticated' : 'unavailable',
    userId: ownershipMock.userId,
    isAnonymous: true,
    hasAppleIdentity: false,
    accessToken: ownershipMock.userId ? 'tok' : null,
    error: null,
  })),
  subscribeAuthState: jest.fn(() => () => undefined),
}));

jest.mock('./env', () => ({
  isAnonAuthEnabled: () => true,
  getSupabaseUrl: () => 'https://example.supabase.co',
  getSupabaseAnonKey: () => 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.x',
  isJwtLike: () => true,
}));

jest.mock('./ownershipAdoptionOrchestrator', () => ({
  ensureOwnershipAdoptionSettledForOwnerRead: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: ownershipMock.userId ?? 'owner-mut',
  })),
  settleOwnershipAdoptionForCurrentAuth: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: ownershipMock.userId ?? 'owner-mut',
  })),
  startOwnershipAdoptionOrchestrator: jest.fn(),
}));

jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(async () => ({
    ran: false,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  })),
}));

jest.mock('./syncOutbox', () => ({
  ensureSyncOutboxSchema: jest.fn(async () => undefined),
  generateSyncIntentId: jest.fn(() => 'intent-mut'),
  replaceSyncOutboxIntent: jest.fn(async () => undefined),
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

const mockResolveCurrentLocalReceiptOwnerScope = jest.fn();
jest.mock('./receiptOwnershipScope', () => {
  const actual = jest.requireActual('./receiptOwnershipScope');
  return {
    ...actual,
    resolveCurrentLocalReceiptOwnerScope: (...args: unknown[]) =>
      mockResolveCurrentLocalReceiptOwnerScope(...args),
  };
});

type MutableRow = Record<string, unknown>;

/** Minimal in-memory SQLite stand-in for save/update/delete + restore. */
class MemoryDb {
  rows = new Map<string, MutableRow>();
  kv = new Map<string, string>();
  items: MutableRow[] = [];

  async execAsync(_sql: string): Promise<void> {
    return;
  }

  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    if (/FROM app_kv/i.test(sql)) {
      const k = String(params[0] ?? '');
      if (!this.kv.has(k)) return null;
      return { v: this.kv.get(k) } as T;
    }
    if (/COUNT\(\*\)/i.test(sql) && /FROM receipts/i.test(sql)) {
      return { c: this.rows.size, count: this.rows.size } as T;
    }
    if (/COUNT\(\*\)/i.test(sql) && /sync_outbox/i.test(sql)) {
      return { c: 0, count: 0 } as T;
    }
    if (/FROM receipts WHERE id = \?/i.test(sql)) {
      const id = String(params[0]);
      return ((this.rows.get(id) as T) ?? null) as T | null;
    }
    return null;
  }

  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (/FROM receipts/i.test(sql)) {
      if (/WHERE id IN/i.test(sql)) {
        return params
          .filter((p): p is string => typeof p === 'string' && this.rows.has(p))
          .map((id) => this.rows.get(id)!) as unknown as T[];
      }
      return [...this.rows.values()] as unknown as T[];
    }
    return [];
  }

  async runAsync(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    if (/INSERT OR REPLACE INTO app_kv/i.test(sql)) {
      this.kv.set(String(params[0]), String(params[1]));
      return { changes: 1 };
    }
    if (/INSERT INTO receipts/i.test(sql)) {
      const id = String(params[0]);
      this.rows.set(id, {
        id,
        user_id: ownershipMock.userId,
        installation_id: ownershipMock.installationId,
        transaction_source: 'receipt_ocr',
        analysis_json: '{}',
        user_items_json: null,
        user_edited: 0,
        note: null,
      });
      return { changes: 1 };
    }
    if (/UPDATE receipts/i.test(sql)) {
      let id: string | null = null;
      for (const p of params) {
        if (typeof p === 'string' && this.rows.has(p)) id = p;
      }
      if (!id) return { changes: 0 };
      const row = this.rows.get(id)!;
      if (/user_edited/i.test(sql)) row.user_edited = 1;
      if (/user_items_json/i.test(sql)) {
        const json = params.find(
          (p) => typeof p === 'string' && (p.startsWith('[') || p === '')
        );
        if (typeof json === 'string') row.user_items_json = json || null;
      }
      if (/note\s*=/i.test(sql)) {
        const note = params.find((p) => p === 'n');
        if (note === 'n') row.note = 'n';
      }
      return { changes: 1 };
    }
    if (/DELETE FROM receipts/i.test(sql)) {
      if (/WHERE id/i.test(sql)) {
        let deleted = 0;
        for (const p of params) {
          if (typeof p === 'string' && this.rows.has(p)) {
            this.rows.delete(p);
            deleted += 1;
          }
        }
        return { changes: deleted };
      }
      this.rows.clear();
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  async withExclusiveTransactionAsync(
    fn: (txn: MemoryDb) => Promise<void>
  ): Promise<void> {
    await fn(this);
  }

  async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
    await fn();
  }
}

const mockDatabase = new MemoryDb();

import { deleteReceipts, saveReceipt, updateReceipt } from './db';
import {
  buildPersonalProductInventoryCacheKey,
  currentPersonalProductInventoryCacheKeyParts,
  getPersonalProductInventoryDataGeneration,
  getPersonalProductInventoryFullBuildCount,
  invalidatePersonalProductEndpointInventory,
  readPersonalProductEndpointInventoryCache,
  writePersonalProductEndpointInventoryCache,
  __resetPersonalProductEndpointInventoryCacheForTests,
} from './personalProductEndpointInventoryCache';
import {
  loadPersonalProductEndpointInventoryWithDb,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import {
  buildPersonalMerchantProductEndpointV1,
} from './personalProductIdentityContract';
import { buildProductAttributes } from './productIdentityContract';
import {
  createMemoryPersonalProductIdentityDatabase,
  recordPersonalProductIdentityDecisionWithDb,
} from './personalProductIdentityRepository';
import { restoreCloudReceiptsForCurrentUser } from './cloudRestore';
import type { ReceiptRow } from './db';

function seedReadyCache(ownerKey: string, label: string) {
  const parts = currentPersonalProductInventoryCacheKeyParts(ownerKey);
  const key = buildPersonalProductInventoryCacheKey(parts);
  writePersonalProductEndpointInventoryCache({
    key,
    ownerKey,
    dataGeneration: parts.dataGeneration,
    resolverVersion: parts.resolverVersion,
    pipelineVersion: parts.pipelineVersion,
    result: {
      status: 'ready',
      inventory: {
        ownerKey,
        snapshot: new Map(),
        endpointsById: new Map(),
        merchantProductsById: new Map(),
        itemsByRowKey: new Map([
          [
            'seed:0',
            {
              receiptId: 'seed',
              itemId: 'seed-i',
              sourceIndex: 0,
              occurredAt: 1,
              merchantProductId: 'mp-seed',
              identityLevel: 'merchant_product',
              displayName: label,
              merchantName: 'Lawson',
              rawName: label,
              merchantScopeKey: 'lawson',
              skuKey: null,
              brand: null,
              attributes: null,
            },
          ],
        ]),
        itemKeysByMerchantProductId: new Map([['mp-seed', ['seed:0']]]),
        receiptsById: new Map(),
        excludedDuplicateReceiptIds: new Set(),
        highConfidenceDuplicateGroupByReceiptId: new Map(),
        decisionRows: [],
      },
    },
    rowCount: 1,
    resolveCount: 1,
  });
  return { key, parts };
}

describe('Receipt073 Round 4 mutation → inventory invalidation ordering', () => {
  beforeEach(() => {
    __resetPersonalProductEndpointInventoryCacheForTests();
    mockDatabase.rows.clear();
    mockDatabase.kv.clear();
    ownershipMock.userId = 'owner-mut';
    ownershipMock.installationId = 'install-mut';
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
      status: 'ready',
      receiptWhereSql: 'user_id = ?',
      params: ['owner-mut'],
      userId: 'owner-mut',
      installationId: 'install-mut',
    });
  });

  it('production mutation modules must not defer inventory invalidation via void import', () => {
    const roots = [
      'db.ts',
      'personalProductIdentityRepository.ts',
      'cloudRestore.ts',
      'ownershipAdoptionOrchestrator.ts',
      'categoryBackfill.ts',
    ];
    for (const file of roots) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).not.toMatch(
        /void\s+import\(\s*['"]\.\/personalProductEndpointInventoryCache['"]\s*\)/
      );
      expect(source).toMatch(
        /import\s*\{\s*invalidatePersonalProductEndpointInventory\s*\}\s*from\s*['"]\.\/personalProductEndpointInventoryCache['"]/
      );
    }
  });

  it('T1/T7 saveReceipt: Promise resolve implies generation already advanced', async () => {
    const ownerKey = 'user:owner-mut';
    const seeded = seedReadyCache(ownerKey, 'stale-before-save');
    const genBefore = getPersonalProductInventoryDataGeneration();

    const id = await saveReceipt({
      imageUri: 'file://save-ord.jpg',
      analysis: {
        total: 100,
        tax: 0,
        currency: 'JPY',
        items: [
          {
            name: 'コカ・コーラ 500ml',
            quantity: 1,
            unitPrice: 100,
            lineTotal: 100,
          },
        ],
      },
    });

    expect(getPersonalProductInventoryDataGeneration()).toBe(genBefore + 1);
    expect(readPersonalProductEndpointInventoryCache(seeded.key)).toBeNull();
    expect(id).toBeTruthy();
  });

  it('T2 updateReceipt: after await, pre-mutation generation unavailable', async () => {
    const ownerKey = 'user:owner-mut';
    const id = await saveReceipt({
      imageUri: 'file://upd.jpg',
      analysis: { total: 50, tax: 0, currency: 'JPY', items: [] },
    });
    const seeded = seedReadyCache(ownerKey, 'stale-before-update');
    const genBefore = getPersonalProductInventoryDataGeneration();

    await updateReceipt({
      id,
      user_edited: 1,
      user_items_json: JSON.stringify([
        { name: 'edited-item', quantity: 1, unitPrice: 50, lineTotal: 50 },
      ]),
      note: 'n',
    });

    expect(getPersonalProductInventoryDataGeneration()).toBe(genBefore + 1);
    expect(readPersonalProductEndpointInventoryCache(seeded.key)).toBeNull();
  });

  it('T3 deleteReceipts: after await, pre-delete generation unavailable', async () => {
    const ownerKey = 'user:owner-mut';
    const id = await saveReceipt({
      imageUri: 'file://del.jpg',
      analysis: { total: 10, tax: 0, currency: 'JPY', items: [] },
    });
    __resetPersonalProductEndpointInventoryCacheForTests();
    const seeded = seedReadyCache(ownerKey, 'stale-before-delete');
    const genBefore = getPersonalProductInventoryDataGeneration();

    await deleteReceipts([id]);

    expect(getPersonalProductInventoryDataGeneration()).toBe(genBefore + 1);
    expect(readPersonalProductEndpointInventoryCache(seeded.key)).toBeNull();
  });

  it('T4 identity decision: after await, old generation unavailable', async () => {
    const ownerKey = 'user:test-owner';
    const seeded = seedReadyCache(ownerKey, 'stale-before-decision');
    const genBefore = getPersonalProductInventoryDataGeneration();
    const left = buildPersonalMerchantProductEndpointV1({
      merchantProductId: 'mp-left',
      merchantScopeKey: 'lawson',
      comparisonKey: 'cmp-left',
      attributes: buildProductAttributes([
        { dimension: 'volume', value: 500, unit: 'ml' },
      ]),
    });
    const right = buildPersonalMerchantProductEndpointV1({
      merchantProductId: 'mp-right',
      merchantScopeKey: 'seven',
      comparisonKey: 'cmp-right',
      attributes: buildProductAttributes([
        { dimension: 'volume', value: 500, unit: 'ml' },
      ]),
    });
    const db = createMemoryPersonalProductIdentityDatabase();
    const result = await recordPersonalProductIdentityDecisionWithDb(
      db,
      ownerKey,
      left,
      right,
      'same_product',
      {
        nowMs: 1_700_000_000_000,
        currentEndpoints: new Map([
          [left.merchantProductId, left],
          [right.merchantProductId, right],
        ]),
      }
    );
    expect(result.ok).toBe(true);
    expect(getPersonalProductInventoryDataGeneration()).toBe(genBefore + 1);
    expect(readPersonalProductEndpointInventoryCache(seeded.key)).toBeNull();
  });

  it('T9 cloud restore: final invalidation observable when Promise resolves', async () => {
    const ownerKey = 'user:owner-mut';
    const seeded = seedReadyCache(ownerKey, 'stale-before-restore');
    const genBefore = getPersonalProductInventoryDataGeneration();
    mockDatabase.rows.clear();

    const restoreDb = {
      async execAsync(_sql: string) {
        return;
      },
      async getFirstAsync(sql: string, params: unknown[] = []) {
        if (/COUNT/i.test(sql)) return { c: 0, count: 0 };
        return mockDatabase.getFirstAsync(sql, params);
      },
      async getAllAsync(sql: string, params: unknown[] = []) {
        return mockDatabase.getAllAsync(sql, params);
      },
      async runAsync(sql: string, params: unknown[] = []) {
        if (/INSERT INTO receipts/i.test(sql) || /INSERT OR REPLACE INTO app_kv/i.test(sql)) {
          if (/app_kv/i.test(sql)) {
            mockDatabase.kv.set(String(params[0]), String(params[1]));
          } else {
            const id = String(params[0] ?? 'cloud-r1');
            mockDatabase.rows.set(id, { id, user_id: 'owner-mut' });
          }
          return { changes: 1 };
        }
        return mockDatabase.runAsync(sql, params);
      },
      async withTransactionAsync(fn: () => Promise<void>) {
        await fn();
      },
    };

    const result = await restoreCloudReceiptsForCurrentUser({
      getAuth: () =>
        ({
          status: 'authenticated',
          userId: 'owner-mut',
          isAnonymous: true,
          hasAppleIdentity: false,
          accessToken: 'tok',
          error: null,
        }) as any,
      getDb: async () => restoreDb as any,
      getInstallationId: async () => 'install-mut',
      fetchActiveCloudReceipts: async () => [
        {
          id: 'cloud-r1',
          user_id: 'owner-mut',
          transaction_source: 'receipt_ocr',
          social_source: 'self',
          created_at: '2024-01-01T00:00:00.000Z',
          transaction_at: '2024-01-02T00:00:00.000Z',
          scanned_at: '2024-01-03T00:00:00.000Z',
          merchant_raw: '店',
          merchant_normalized: '店',
          merchant_type: 'supermarket',
          store_raw: null,
          store_normalized: null,
          total: 100,
          tax: 10,
          tax_is_known: true,
          currency: 'JPY',
          analysis_json:
            '{"total":100,"items":[{"name":"ocr","quantity":1,"unitPrice":100,"lineTotal":100}]}',
          recognition_snapshot_json: null,
          user_items_json: null,
          user_edited: false,
          final_total: null,
          final_category: null,
          note: null,
          ocr_request_id: null,
          client_updated_at: '2024-01-04T00:00:00.000Z',
          deleted_at: null,
          installation_id: 'cloud-install',
        },
      ],
    });

    expect(result.status).toBe('ok');
    expect(getPersonalProductInventoryDataGeneration()).toBe(genBefore + 1);
    expect(readPersonalProductEndpointInventoryCache(seeded.key)).toBeNull();
  });
});

describe('Receipt073 Round 4 inventory cache races', () => {
  beforeEach(() => {
    __resetPersonalProductEndpointInventoryCacheForTests();
  });

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

  function receipt(id: string): ReceiptRow {
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
      user_id: 'owner-a',
      installation_id: null,
    };
  }

  const stamp = {
    userId: 'owner-a',
    installationId: null as string | null,
    transactionSource: 'receipt_ocr' as const,
  };

  it('T5 Race A: G1 finish after invalidate must not become current cache', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const db = {
      async getAllAsync<T>(source: string) {
        if (/receipt_items/i.test(source)) {
          await gate;
          return [itemRow()] as T[];
        }
        if (/FROM receipts/i.test(source)) {
          return [receipt('r1')] as T[];
        }
        return [] as T[];
      },
    };
    const p1 = loadPersonalProductEndpointInventoryWithDb(db, stamp, {
      listDecisions: async () => [],
    });
    invalidatePersonalProductEndpointInventory('receipt_saved');
    release();
    await p1;
    expect(getPersonalProductInventoryFullBuildCount()).toBe(0);
    const key = buildPersonalProductInventoryCacheKey(
      currentPersonalProductInventoryCacheKeyParts('user:owner-a')
    );
    expect(readPersonalProductEndpointInventoryCache(key)).toBeNull();
  });

  it('T6 Race B: late G1 finish must not overwrite authoritative G2', async () => {
    let releaseG1!: () => void;
    const g1Gate = new Promise<void>((r) => {
      releaseG1 = r;
    });
    let phase: 'g1' | 'g2' = 'g1';
    const db = {
      async getAllAsync<T>(source: string) {
        if (/receipt_items/i.test(source)) {
          if (phase === 'g1') await g1Gate;
          return [
            itemRow({
              displayName: phase === 'g1' ? 'G1-item' : 'G2-item',
              rawName: phase === 'g1' ? 'G1-item' : 'G2-item',
            }),
          ] as T[];
        }
        if (/FROM receipts/i.test(source)) {
          return [receipt('r1')] as T[];
        }
        return [] as T[];
      },
    };
    const g1Promise = loadPersonalProductEndpointInventoryWithDb(db, stamp, {
      listDecisions: async () => [],
    });
    invalidatePersonalProductEndpointInventory('receipt_updated');
    phase = 'g2';
    const g2 = await loadPersonalProductEndpointInventoryWithDb(db, stamp, {
      listDecisions: async () => [],
    });
    expect(g2.status).toBe('ready');
    if (g2.status === 'ready') {
      expect([...g2.inventory.itemsByRowKey.values()][0]?.displayName).toBe(
        'G2-item'
      );
    }
    releaseG1();
    await g1Promise;
    const key = buildPersonalProductInventoryCacheKey(
      currentPersonalProductInventoryCacheKeyParts('user:owner-a')
    );
    const cached = readPersonalProductEndpointInventoryCache(key);
    expect(cached?.status).toBe('ready');
    if (cached?.status === 'ready') {
      expect([...cached.inventory.itemsByRowKey.values()][0]?.displayName).toBe(
        'G2-item'
      );
    }
  });

  it('T8 concurrent pre-mutation in-flight must not JOIN into G2 load', async () => {
    let releaseG1!: () => void;
    const g1Gate = new Promise<void>((r) => {
      releaseG1 = r;
    });
    let itemsCalls = 0;
    const db = {
      async getAllAsync<T>(source: string) {
        if (/receipt_items/i.test(source)) {
          itemsCalls += 1;
          if (itemsCalls === 1) await g1Gate;
          return [itemRow({ displayName: `call-${itemsCalls}` })] as T[];
        }
        if (/FROM receipts/i.test(source)) {
          return [receipt('r1')] as T[];
        }
        return [] as T[];
      },
    };
    const g1Promise = loadPersonalProductEndpointInventoryWithDb(db, stamp, {
      listDecisions: async () => [],
    });
    invalidatePersonalProductEndpointInventory('receipt_saved');
    const g2 = await loadPersonalProductEndpointInventoryWithDb(db, stamp, {
      listDecisions: async () => [],
    });
    expect(g2.status).toBe('ready');
    releaseG1();
    await g1Promise;
    expect(itemsCalls).toBe(2);
  });
});
