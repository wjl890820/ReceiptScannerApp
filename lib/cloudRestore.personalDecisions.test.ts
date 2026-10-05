/**
 * DS1 — restore personal product identity decisions with receipts.
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

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

import type { SQLiteBindParams } from 'expo-sqlite';

import { restoreCloudReceiptsForCurrentUser } from './cloudRestore';
import { buildProductAttributes } from './productIdentityContract';
import { buildPersonalMerchantProductEndpointV1 } from './personalProductIdentityContract';
import {
  createMemoryPersonalProductIdentityDatabase,
  recordPersonalProductIdentityDecisionWithDb,
} from './personalProductIdentityRepository';
import {
  PersonalDecisionTableMissingError,
  personalDecisionBackupBootstrapKvKey,
  personalDecisionBackupDirtyKvKey,
  personalDecisionBackupGenerationKvKey,
} from './personalDecisionCloudSync';
import { withPersonalDecisionLocalMutationGate } from './personalDecisionLocalMutationGate';
import type { CloudUserReceiptRow } from './cloudRestorePayload';

type DecisionInsert = {
  owner_key: string;
  left_merchant_product_id: string;
  right_merchant_product_id: string;
  decision: string;
  created_at: number;
  updated_at: number;
  identity_pipeline_version: string;
  left_structural_signature: string;
};

function cloudReceipt(id = 'r1'): CloudUserReceiptRow {
  return {
    id,
    user_id: 'user-a',
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
  };
}

function cloudDecision(
  decision: 'same_product' | 'not_same_product' | 'unsure',
  overrides: Record<string, unknown> = {}
) {
  return {
    user_id: 'user-a',
    left_merchant_product_id: 'mp_a',
    right_merchant_product_id: 'mp_b',
    left_merchant_scope_key: 'merchant:a',
    right_merchant_scope_key: 'merchant:b',
    left_comparison_key: 'cmp-a',
    right_comparison_key: 'cmp-b',
    left_structural_signature: 'struct-v1:old',
    right_structural_signature: 'struct-v1:empty',
    identity_pipeline_version: 'resolver-v1+personal-endpoint-v1',
    decision,
    created_at: 1700000000111,
    updated_at: 1700000000222,
    ...overrides,
  };
}

function createRestoreDb(options?: { failDecisionInsert?: boolean }) {
  const receipts = new Map<string, { id: string }>();
  const decisions: DecisionInsert[] = [];
  const appKv = new Map<string, string>();
  const db = {
    receipts,
    decisions,
    appKv,
    async execAsync() {},
    async withTransactionAsync(task: () => Promise<void>) {
      const snapR = new Map(receipts);
      const snapD = decisions.map((row) => ({ ...row }));
      const snapK = new Map(appKv);
      try {
        await task();
      } catch (error) {
        receipts.clear();
        for (const [key, value] of snapR) receipts.set(key, value);
        decisions.splice(0, decisions.length, ...snapD);
        appKv.clear();
        for (const [key, value] of snapK) appKv.set(key, value);
        throw error;
      }
    },
    async withExclusiveTransactionAsync(
      task: (txn: {
        execAsync: () => Promise<void>;
        getFirstAsync: <T>(sql: string) => Promise<T | null>;
        getAllAsync: <T>() => Promise<T[]>;
        runAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
      }) => Promise<void>
    ) {
      await db.withTransactionAsync(async () => {
        await task(db);
      });
    },
    async getFirstAsync<T>(sql: string): Promise<T | null> {
      if (/COUNT\(\*\) as c FROM receipts/i.test(sql)) {
        return { c: receipts.size } as T;
      }
      if (/COUNT\(\*\) as c FROM sync_outbox/i.test(sql)) {
        return { c: 0 } as T;
      }
      return null;
    },
    async getAllAsync<T>(): Promise<T[]> {
      return [];
    },
    async runAsync(sql: string, params?: unknown[]) {
      if (/INSERT INTO personal_product_identity_decisions/i.test(sql)) {
        if (options?.failDecisionInsert) throw new Error('forced decision insert failure');
        const values = params ?? [];
        decisions.push({
          owner_key: String(values[0]),
          left_merchant_product_id: String(values[1]),
          right_merchant_product_id: String(values[2]),
          left_structural_signature: String(values[7]),
          identity_pipeline_version: String(values[9]),
          decision: String(values[10]),
          created_at: Number(values[11]),
          updated_at: Number(values[12]),
        });
        return { changes: 1 };
      }
      if (/INSERT INTO receipts/i.test(sql)) {
        receipts.set(String(params?.[0]), { id: String(params?.[0]) });
        return { changes: 1 };
      }
      if (/INSERT INTO receipt_items/i.test(sql) || /DELETE FROM receipt_items/i.test(sql)) {
        return { changes: 1 };
      }
      if (/INSERT OR REPLACE INTO app_kv/i.test(sql)) {
        appKv.set(String(params?.[0]), String(params?.[1]));
        return { changes: 1 };
      }
      return { changes: 0 };
    },
  };
  return db;
}

const auth = {
  status: 'authenticated' as const,
  userId: 'user-a',
  isAnonymous: false,
  hasAppleIdentity: true,
  accessToken: 'tok',
  error: null as string | null,
};

function restoreWith(
  db: ReturnType<typeof createRestoreDb>,
  decisions: Record<string, unknown>[],
  receipts: CloudUserReceiptRow[] = [cloudReceipt()]
) {
  return restoreCloudReceiptsForCurrentUser({
    getDb: async () => db as never,
    getAuth: () => auth,
    getClient: () => ({}) as never,
    getInstallationId: async () => 'install-now',
    fetchActiveCloudReceipts: async () => receipts,
    fetchActiveCloudDecisions: async () => decisions,
  });
}

describe('restore personal product identity decisions', () => {
  it('restores receipt rows and the exact decision, including an inactive descriptor', async () => {
    const db = createRestoreDb();
    const decision = cloudDecision('same_product');
    const result = await restoreWith(db, [decision]);
    expect(result.status).toBe('ok');
    expect(result.restored).toBe(1);
    expect(db.decisions).toEqual([
      {
        owner_key: 'user:user-a',
        left_merchant_product_id: 'mp_a',
        right_merchant_product_id: 'mp_b',
        left_structural_signature: 'struct-v1:old',
        identity_pipeline_version: 'resolver-v1+personal-endpoint-v1',
        decision: 'same_product',
        created_at: 1700000000111,
        updated_at: 1700000000222,
      },
    ]);
    expect(db.appKv.get(personalDecisionBackupBootstrapKvKey('user-a'))).toBe('1');
    expect(db.appKv.get(personalDecisionBackupDirtyKvKey('user-a'))).toBe('0');
    expect(db.appKv.get(personalDecisionBackupGenerationKvKey('user-a'))).toBe('0');
  });

  it('restores not_same_product and unsure exactly', async () => {
    const db = createRestoreDb();
    const result = await restoreWith(db, [
      cloudDecision('not_same_product'),
      cloudDecision('unsure', {
        left_merchant_product_id: 'mp_c',
        right_merchant_product_id: 'mp_d',
      }),
    ]);
    expect(result.status).toBe('ok');
    expect(db.decisions.map((row) => row.decision)).toEqual([
      'not_same_product',
      'unsure',
    ]);
    expect(db.decisions[0]?.left_merchant_product_id).toBe('mp_a');
    expect(db.decisions[1]?.left_merchant_product_id).toBe('mp_c');
  });

  it('restores receipts when the decision collection is empty', async () => {
    const db = createRestoreDb();
    const result = await restoreWith(db, []);
    expect(result).toMatchObject({ status: 'ok', restored: 1 });
    expect(db.receipts.has('r1')).toBe(true);
    expect(db.decisions).toEqual([]);
  });

  it('restores an empty receipt set when only decisions exist', async () => {
    const db = createRestoreDb();
    const result = await restoreWith(db, [cloudDecision('unsure')], []);
    expect(result).toMatchObject({ status: 'ok', restored: 0 });
    expect(db.receipts.size).toBe(0);
    expect(db.decisions).toHaveLength(1);
    expect(db.decisions[0]?.decision).toBe('unsure');
  });

  it('fails the whole restore before writing when one decision is malformed', async () => {
    const db = createRestoreDb();
    const result = await restoreWith(db, [
      cloudDecision('same_product'),
      cloudDecision('unsure', { decision: 'maybe' }),
    ]);
    expect(result.status).toBe('validation_failed');
    expect(db.receipts.size).toBe(0);
    expect(db.decisions).toEqual([]);
  });

  it('rolls back receipts when the decision insert fails', async () => {
    const db = createRestoreDb({ failDecisionInsert: true });
    const result = await restoreWith(db, [cloudDecision('same_product')]);
    expect(result.status).toBe('write_failed');
    expect(db.receipts.size).toBe(0);
    expect(db.decisions).toEqual([]);
  });

  it('still restores receipts when the decision table is absent on the server', async () => {
    const db = createRestoreDb();
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => [cloudReceipt()],
      fetchActiveCloudDecisions: async () => {
        throw new PersonalDecisionTableMissingError();
      },
    });
    expect(result).toMatchObject({ status: 'ok', restored: 1 });
    expect(db.decisions).toEqual([]);
    expect(db.appKv.has(personalDecisionBackupBootstrapKvKey('user-a'))).toBe(false);
    expect(db.appKv.has(personalDecisionBackupDirtyKvKey('user-a'))).toBe(false);
    expect(db.appKv.has(personalDecisionBackupGenerationKvKey('user-a'))).toBe(false);
  });

  it('does not treat a decision fetch network error as a missing table', async () => {
    const db = createRestoreDb();
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => [cloudReceipt()],
      fetchActiveCloudDecisions: async () => {
        throw new Error('Internal Server Error');
      },
    });
    expect(result.status).toBe('fetch_failed');
    expect(result.error).toMatch(/Internal Server Error/);
    expect(db.receipts.size).toBe(0);
    expect(db.decisions).toEqual([]);
  });

  it('rejects a second restore before inserting a duplicate decision', async () => {
    const db = createRestoreDb();
    const first = await restoreWith(db, [cloudDecision('same_product')]);
    expect(first.status).toBe('ok');
    const second = await restoreWith(db, [cloudDecision('same_product')]);
    expect(second.status).toBe('blocked_local_data_present');
    expect(db.decisions).toHaveLength(1);
  });
});

async function flushQueuedWork(): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    await Promise.resolve();
  }
}

function restoreEndpoint(id: string) {
  return buildPersonalMerchantProductEndpointV1({
    merchantProductId: id,
    merchantScopeKey: 'lawson',
    comparisonKey: `cmp-${id}`,
    attributes: buildProductAttributes([]),
  });
}

describe('restore refuses nonempty personal decision state', () => {
  it('refuses when the current user already has a local decision', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    const left = restoreEndpoint('mp_a');
    const right = restoreEndpoint('mp_b');
    await recordPersonalProductIdentityDecisionWithDb(
      db,
      'user:user-a',
      left,
      right,
      'same_product',
      { nowMs: 10, currentEndpoints: new Map([['mp_a', left], ['mp_b', right]]) }
    );
    const dirtyBefore = db.kv.get(personalDecisionBackupDirtyKvKey('user-a'));
    const generationBefore = db.kv.get(personalDecisionBackupGenerationKvKey('user-a'));
    let fetched = false;
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => {
        fetched = true;
        return [cloudReceipt()];
      },
      fetchActiveCloudDecisions: async () => [cloudDecision('not_same_product')],
    });
    expect(result.status).toBe('blocked_local_data_present');
    expect(fetched).toBe(false);
    expect(db.rows.size).toBe(1);
    expect([...db.rows.values()][0]?.decision).toBe('same_product');
    expect(db.kv.get(personalDecisionBackupDirtyKvKey('user-a'))).toBe(dirtyBefore);
    expect(db.kv.get(personalDecisionBackupGenerationKvKey('user-a'))).toBe(generationBefore);
  });

  it('refuses dirty state even when no decision rows exist and does not clear it', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    db.kv.set(personalDecisionBackupDirtyKvKey('user-a'), '1');
    db.kv.set(personalDecisionBackupGenerationKvKey('user-a'), '3');
    let fetched = false;
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => {
        fetched = true;
        return [cloudReceipt()];
      },
      fetchActiveCloudDecisions: async () => [],
    });
    expect(result.status).toBe('blocked_local_data_present');
    expect(fetched).toBe(false);
    expect(db.rows.size).toBe(0);
    expect(db.kv.get(personalDecisionBackupDirtyKvKey('user-a'))).toBe('1');
    expect(db.kv.get(personalDecisionBackupGenerationKvKey('user-a'))).toBe('3');
  });

  it('refuses when a decision is created while the remote fetch is in flight', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    let releaseFetch!: () => void;
    const holdFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const restorePromise = restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => {
        markEntered();
        await holdFetch;
        return [cloudReceipt()];
      },
      fetchActiveCloudDecisions: async () => [cloudDecision('same_product')],
    });
    await entered;
    const left = restoreEndpoint('mp_a');
    const right = restoreEndpoint('mp_b');
    await recordPersonalProductIdentityDecisionWithDb(
      db,
      'user:user-a',
      left,
      right,
      'unsure',
      { nowMs: 44, currentEndpoints: new Map([['mp_a', left], ['mp_b', right]]) }
    );
    releaseFetch();
    const result = await restorePromise;
    expect(result.status).toBe('blocked_local_data_present');
    expect(db.rows.size).toBe(1);
    expect([...db.rows.values()][0]?.decision).toBe('unsure');
    expect([...db.rows.values()][0]?.created_at).toBe(44);
    expect(db.kv.get(personalDecisionBackupDirtyKvKey('user-a'))).toBe('1');
  });

  it('still restores the current account when only an installation decision exists', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    const left = restoreEndpoint('mp_a');
    const right = restoreEndpoint('mp_b');
    await recordPersonalProductIdentityDecisionWithDb(
      db,
      'installation:install-old',
      left,
      right,
      'not_same_product',
      { nowMs: 7, currentEndpoints: new Map([['mp_a', left], ['mp_b', right]]) }
    );
    expect(db.kv.size).toBe(0);
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => [cloudReceipt()],
      fetchActiveCloudDecisions: async () => [cloudDecision('same_product')],
    });
    expect(result).toMatchObject({ status: 'ok', restored: 1 });
    const owners = [...db.rows.values()].map((row) => ({
      owner: row.owner_key,
      decision: row.decision,
    }));
    expect(owners).toEqual(
      expect.arrayContaining([
        { owner: 'installation:install-old', decision: 'not_same_product' },
        { owner: 'user:user-a', decision: 'same_product' },
      ])
    );
    expect(db.rows.size).toBe(2);
    expect(db.kv.get(personalDecisionBackupDirtyKvKey('user-a'))).toBe('0');
    expect(db.kv.get(personalDecisionBackupGenerationKvKey('user-a'))).toBe('0');
  });

  it('blocks restore when a decision already holds the production gate', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    let releaseDecision!: () => void;
    const holdDecision = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    let markDecisionEntered!: () => void;
    const decisionEntered = new Promise<void>((resolve) => {
      markDecisionEntered = resolve;
    });
    db.execAsync = async () => undefined;
    db.getAllAsync = async () => [];
    db.runAsync = async () => ({ changes: 0 });
    db.getFirstAsync = (async (source: string, params?: SQLiteBindParams) => {
      const values = Array.isArray(params) ? params : [];
      if (/COUNT\(\*\) as c FROM receipts/i.test(source)) return { c: 0 };
      if (/COUNT\(\*\) as c FROM sync_outbox/i.test(source)) return { c: 0 };
      if (/COUNT\(\*\) AS c FROM personal_product_identity_decisions/i.test(source)) {
        const ownerKey = String(values[0]);
        return {
          c: [...db.rows.values()].filter((row) => row.owner_key === ownerKey).length,
        };
      }
      if (/FROM app_kv WHERE k = \?/i.test(source)) {
        const key = String(values[0]);
        return db.kv.has(key) ? { v: db.kv.get(key) } : null;
      }
      return null;
    }) as typeof db.getFirstAsync;
    const originalExclusive = db.withExclusiveTransactionAsync.bind(db);
    let sawDecision = false;
    let receiptInserts = 0;
    let remoteDecisionInserts = 0;
    db.withExclusiveTransactionAsync = async (task) => {
      if (!sawDecision) {
        sawDecision = true;
        return originalExclusive(async (txn) => {
          const run = txn.runAsync.bind(txn);
          let paused = false;
          txn.runAsync = async (source: string, params?: SQLiteBindParams) => {
            if (!paused) {
              paused = true;
              markDecisionEntered();
              await holdDecision;
            }
            return run(source, params);
          };
          await task(txn);
        });
      }
      return originalExclusive(async (txn) => {
        const run = txn.runAsync.bind(txn);
        txn.runAsync = async (source: string, params?: SQLiteBindParams) => {
          if (/INSERT INTO receipts/i.test(source)) receiptInserts += 1;
          if (/INSERT INTO personal_product_identity_decisions/i.test(source)) {
            remoteDecisionInserts += 1;
          }
          return run(source, params);
        };
        await task(txn);
      });
    };

    const left = restoreEndpoint('mp_a');
    const right = restoreEndpoint('mp_b');
    const decisionPromise = recordPersonalProductIdentityDecisionWithDb(
      db,
      'user:user-a',
      left,
      right,
      'unsure',
      { nowMs: 55, currentEndpoints: new Map([['mp_a', left], ['mp_b', right]]) }
    );
    try {
      await decisionEntered;
      expect(db.exclusiveTransactionCalls).toBe(1);
      let restoreSettled = false;
      const restorePromise = restoreCloudReceiptsForCurrentUser({
        getDb: async () => db as never,
        getAuth: () => auth,
        getClient: () => ({}) as never,
        getInstallationId: async () => 'install-now',
        fetchActiveCloudReceipts: async () => [cloudReceipt()],
        fetchActiveCloudDecisions: async () => [cloudDecision('not_same_product')],
      }).then((result) => {
        restoreSettled = true;
        return result;
      });
      await flushQueuedWork();
      expect(restoreSettled).toBe(false);
      expect(db.exclusiveTransactionCalls).toBe(1);
      releaseDecision();
      const recorded = await decisionPromise;
      const result = await restorePromise;
      expect(recorded).toEqual({ ok: true, outcome: 'created' });
      expect(result.status).toBe('blocked_local_data_present');
      expect(receiptInserts).toBe(0);
      expect(remoteDecisionInserts).toBe(0);
      expect(db.rows.size).toBe(1);
      expect([...db.rows.values()][0]).toMatchObject({
        owner_key: 'user:user-a',
        decision: 'unsure',
        created_at: 55,
        updated_at: 55,
      });
      expect(db.kv.get(personalDecisionBackupDirtyKvKey('user-a'))).toBe('1');
      expect(db.kv.get(personalDecisionBackupGenerationKvKey('user-a'))).toBe('1');
      expect(db.kv.get(personalDecisionBackupBootstrapKvKey('user-a'))).toBeUndefined();
    } finally {
      releaseDecision();
    }
  });

  it('refuses a decision committed after the pre-transaction guard', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    const left = restoreEndpoint('mp_a');
    const right = restoreEndpoint('mp_b');
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => [cloudReceipt()],
      fetchActiveCloudDecisions: async () => [cloudDecision('not_same_product')],
      beforeLocalMutationGate: async () => {
        await recordPersonalProductIdentityDecisionWithDb(
          db,
          'user:user-a',
          left,
          right,
          'unsure',
          { nowMs: 55, currentEndpoints: new Map([['mp_a', left], ['mp_b', right]]) }
        );
      },
    });
    expect(result.status).toBe('blocked_local_data_present');
    expect(db.rows.size).toBe(1);
    expect([...db.rows.values()][0]).toMatchObject({
      owner_key: 'user:user-a',
      decision: 'unsure',
      created_at: 55,
      updated_at: 55,
    });
    expect(db.kv.get(personalDecisionBackupDirtyKvKey('user-a'))).toBe('1');
    expect(db.kv.get(personalDecisionBackupGenerationKvKey('user-a'))).toBe('1');
    expect(db.kv.get(personalDecisionBackupBootstrapKvKey('user-a'))).toBeUndefined();
  });

  it('keeps a decision pending on the production gate until restore finishes', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const originalExclusive = db.withExclusiveTransactionAsync.bind(db);
    let wrappedRestore = false;
    db.withExclusiveTransactionAsync = async (task) => {
      if (!wrappedRestore) {
        wrappedRestore = true;
        return originalExclusive(async (txn) => {
          const run = txn.runAsync.bind(txn);
          let paused = false;
          txn.runAsync = async (source: string, params?: SQLiteBindParams) => {
            if (!paused) {
              paused = true;
              markEntered();
              await hold;
            }
            return run(source, params);
          };
          await task(txn);
        });
      }
      return originalExclusive(task);
    };

    const restorePromise = restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => [cloudReceipt()],
      fetchActiveCloudDecisions: async () => [cloudDecision('same_product')],
    });
    await entered;
    const restoredLeft = restoreEndpoint('mp_a');
    const restoredRight = restoreEndpoint('mp_b');
    const left = restoreEndpoint('mp_c');
    const right = restoreEndpoint('mp_d');
    let decisionSettled = false;
    const decisionPromise = recordPersonalProductIdentityDecisionWithDb(
      db,
      'user:user-a',
      left,
      right,
      'not_same_product',
      {
        nowMs: 77,
        currentEndpoints: new Map([
          ['mp_a', restoredLeft],
          ['mp_b', restoredRight],
          ['mp_c', left],
          ['mp_d', right],
        ]),
      }
    ).then((result) => {
      decisionSettled = true;
      return result;
    });
    try {
      await flushQueuedWork();
      expect(decisionSettled).toBe(false);
      expect(db.exclusiveTransactionCalls).toBe(1);
      release();
      const result = await restorePromise;
      const recorded = await decisionPromise;
    expect(result).toMatchObject({ status: 'ok', restored: 1 });
    expect(recorded).toEqual({ ok: true, outcome: 'created' });
    expect(db.rows.size).toBe(2);
    expect([...db.rows.values()].map((row) => row.decision).sort()).toEqual([
      'not_same_product',
      'same_product',
    ]);
    expect([...db.rows.values()].find((row) => row.decision === 'not_same_product')).toMatchObject({
      created_at: 77,
      updated_at: 77,
    });
    expect(db.kv.get(personalDecisionBackupBootstrapKvKey('user-a'))).toBe('1');
    expect(db.kv.get(personalDecisionBackupDirtyKvKey('user-a'))).toBe('1');
    expect(db.kv.get(personalDecisionBackupGenerationKvKey('user-a'))).toBe('1');
    } finally {
      release();
    }
  });

  it('finishes remote fetch before acquiring the production gate', async () => {
    const events: string[] = [];
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => createRestoreDb() as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => {
        events.push('fetch-receipts');
        const probe = withPersonalDecisionLocalMutationGate(async () => {
          events.push('gate-free-during-receipt-fetch');
        });
        await probe;
        return [cloudReceipt()];
      },
      fetchActiveCloudDecisions: async () => {
        events.push('fetch-decisions');
        await withPersonalDecisionLocalMutationGate(async () => {
          events.push('gate-free-during-decision-fetch');
        });
        return [];
      },
      beforeLocalMutationGate: async () => {
        events.push('before-gate');
      },
    });
    expect(result.status).toBe('ok');
    expect(events).toEqual([
      'fetch-receipts',
      'gate-free-during-receipt-fetch',
      'fetch-decisions',
      'gate-free-during-decision-fetch',
      'before-gate',
    ]);
  });
});

describe('restore schema preparation failures', () => {
  it.each([
    'receipt_items',
    'personal_product_identity_decisions',
    'app_kv',
  ])('maps %s schema failure to write_failed', async (table) => {
    let materialized = false;
    const writes: string[] = [];
    const db = {
      async execAsync(sql: string) {
        if (sql.includes(table)) throw new Error(`schema failed: ${table}`);
      },
      async getFirstAsync() {
        return { c: 0 };
      },
      async getAllAsync() {
        return [];
      },
      async runAsync(sql: string) {
        writes.push(sql);
        return { changes: 0 };
      },
      async withTransactionAsync() {
        materialized = true;
      },
      async withExclusiveTransactionAsync() {
        materialized = true;
      },
    };
    const result = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => auth,
      getClient: () => ({}) as never,
      getInstallationId: async () => 'install-now',
      fetchActiveCloudReceipts: async () => [cloudReceipt()],
      fetchActiveCloudDecisions: async () => [cloudDecision('same_product')],
    });
    expect(result.status).toBe('write_failed');
    expect(result.error).toContain(`schema failed: ${table}`);
    expect(materialized).toBe(false);
    expect(writes.some((sql) => /personal_decision_backup_/i.test(sql))).toBe(false);
    expect(writes.some((sql) => /INSERT INTO receipts/i.test(sql))).toBe(false);
  });
});
