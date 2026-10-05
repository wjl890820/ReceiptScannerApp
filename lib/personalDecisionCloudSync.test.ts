/**
 * DS1 — personal decision cloud mapping, conflict, and backup scheduling.
 */
/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import { buildProductAttributes } from './productIdentityContract';
import {
  buildPersonalMerchantProductEndpointV1,
  type PersonalMerchantProductEndpointV1,
} from './personalProductIdentityContract';
import {
  createMemoryPersonalProductIdentityDatabase,
  recordPersonalProductIdentityDecisionWithDb,
} from './personalProductIdentityRepository';
import {
  fetchAllActiveCloudPersonalDecisionsForUser,
  isPersonalDecisionTableMissingError,
  localPersonalDecisionToCloudPayload,
  mapCloudPersonalDecisionToLocalInsert,
  PERSONAL_DECISION_CLOUD_TABLE,
  PersonalDecisionTableMissingError,
  personalDecisionBackupBootstrapKvKey,
  personalDecisionBackupDirtyKvKey,
  personalDecisionBackupGenerationKvKey,
  nextPersonalDecisionBackupGeneration,
  parsePersonalDecisionBackupGeneration,
  PersonalDecisionBackupGenerationOverflowError,
  syncPersonalDecisionBackup,
  type CloudPersonalDecisionPayload,
  type LocalPersonalDecisionBackupRow,
} from './personalDecisionCloudSync';

const USER_A = 'user-a';
const USER_B = 'user-b';

function localRow(
  decision: LocalPersonalDecisionBackupRow['decision'],
  overrides: Partial<LocalPersonalDecisionBackupRow> = {}
): LocalPersonalDecisionBackupRow {
  return {
    owner_key: `user:${USER_A}`,
    left_merchant_product_id: 'mp_a',
    right_merchant_product_id: 'mp_b',
    left_merchant_scope_key: 'merchant:a',
    right_merchant_scope_key: 'merchant:b',
    left_comparison_key: 'cmp-a',
    right_comparison_key: 'cmp-b',
    left_structural_signature: 'struct-v1:empty',
    right_structural_signature: 'struct-v1:empty',
    identity_pipeline_version: 'resolver-v1+personal-endpoint-v1',
    decision,
    created_at: 111,
    updated_at: 111,
    ...overrides,
  };
}

function payload(
  decision: CloudPersonalDecisionPayload['decision'],
  overrides: Partial<CloudPersonalDecisionPayload> = {}
): CloudPersonalDecisionPayload {
  const row = localPersonalDecisionToCloudPayload(USER_A, localRow(decision, overrides));
  if (!row) throw new Error('expected user-owned payload');
  return { ...row, ...overrides, user_id: overrides.user_id ?? USER_A };
}

type CloudState = {
  rows: CloudPersonalDecisionPayload[];
  ops: string[];
  insertError?: { code?: string; message: string } | null;
  rangeError?: { code?: string; message: string } | null;
  holdInsert: Promise<void> | null;
  notifyInsertEntered: (() => void) | null;
};

function createCloud(initial: CloudPersonalDecisionPayload[] = []): {
  state: CloudState;
  getClient: () => { from: (table: string) => unknown };
} {
  const state: CloudState = {
    rows: initial.map((row) => ({ ...row })),
    ops: [],
    holdInsert: null,
    notifyInsertEntered: null,
  };
  function from(table: string) {
    if (table !== PERSONAL_DECISION_CLOUD_TABLE) {
      throw new Error(`unexpected table ${table}`);
    }
    const filters: Record<string, string> = {};
    const api = {
      insert: async (row: CloudPersonalDecisionPayload) => {
        state.ops.push('insert');
        if (state.holdInsert) {
          const hold = state.holdInsert;
          state.holdInsert = null;
          state.notifyInsertEntered?.();
          await hold;
        }
        if (state.insertError) return { error: state.insertError };
        const exists = state.rows.some(
          (current) =>
            current.user_id === row.user_id &&
            current.left_merchant_product_id === row.left_merchant_product_id &&
            current.right_merchant_product_id === row.right_merchant_product_id
        );
        if (exists) {
          return {
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint',
            },
          };
        }
        state.rows.push({ ...row });
        return { error: null };
      },
      update: () => {
        state.ops.push('update');
        throw new Error('cloud update is not allowed');
      },
      delete: () => {
        state.ops.push('delete');
        throw new Error('cloud delete is not allowed');
      },
      select: () => api,
      eq: (column: string, value: string) => {
        filters[column] = value;
        return api;
      },
      order: () => api,
      range: async () => {
        state.ops.push('range');
        if (state.rangeError) return { data: null, error: state.rangeError };
        const data = state.rows.filter(
          (row) => !filters.user_id || row.user_id === filters.user_id
        );
        return { data, error: null };
      },
      maybeSingle: async () => {
        state.ops.push('select');
        const found = state.rows.find(
          (row) =>
            row.user_id === filters.user_id &&
            row.left_merchant_product_id === filters.left_merchant_product_id &&
            row.right_merchant_product_id === filters.right_merchant_product_id
        );
        return { data: found ?? null, error: null };
      },
    };
    return api;
  }
  return { state, getClient: () => ({ from }) };
}

function createLocalDb(rows: LocalPersonalDecisionBackupRow[]) {
  const kv = new Map<string, string>();
  const db = {
    kv,
    rows,
    async execAsync() {},
    async getFirstAsync<T>(
      sql: string,
      params?: import('expo-sqlite').SQLiteBindParams
    ): Promise<T | null> {
      if (/FROM app_kv WHERE k = \?/i.test(sql)) {
        const values = Array.isArray(params) ? params : [];
        const key = String(values[0]);
        return kv.has(key) ? ({ v: kv.get(key)! } as T) : null;
      }
      return null;
    },
    async getAllAsync<T>(
      sql: string,
      params?: import('expo-sqlite').SQLiteBindParams
    ): Promise<T[]> {
      if (/FROM personal_product_identity_decisions/i.test(sql)) {
        const values = Array.isArray(params) ? params : [];
        const ownerKey = String(values[0]);
        return rows.filter((row) => row.owner_key === ownerKey) as T[];
      }
      return [];
    },
    async runAsync(sql: string, params?: import('expo-sqlite').SQLiteBindParams) {
      if (/INSERT OR REPLACE INTO app_kv/i.test(sql)) {
        const values = Array.isArray(params) ? params : [];
        kv.set(String(values[0]), String(values[1]));
      }
      return { changes: 1 };
    },
  };
  return Object.assign(db, {
    async withExclusiveTransactionAsync(
      task: (txn: typeof db) => Promise<void>
    ) {
      await task(db);
    },
  });
}

describe('personal decision cloud mapping', () => {
  it.each(['same_product', 'not_same_product', 'unsure'] as const)(
    'round-trips %s without rewriting fields',
    (decision) => {
      const source = localRow(decision, {
        created_at: 1700000000111,
        updated_at: 1700000000222,
        identity_pipeline_version: 'resolver-v9+personal-endpoint-v1',
      });
      const cloud = localPersonalDecisionToCloudPayload(USER_A, source);
      expect(cloud?.user_id).toBe(USER_A);
      expect(cloud).not.toHaveProperty('owner_key');
      const restored = mapCloudPersonalDecisionToLocalInsert(
        {
          ...cloud,
          created_at: String(source.created_at),
          updated_at: String(source.updated_at),
        },
        USER_A
      );
      expect(restored).toEqual(source);
    }
  );

  it('rejects a reversed cloud pair instead of reordering it', () => {
    const cloud = payload('same_product');
    expect(() =>
      mapCloudPersonalDecisionToLocalInsert(
        {
          ...cloud,
          left_merchant_product_id: cloud.right_merchant_product_id,
          right_merchant_product_id: cloud.left_merchant_product_id,
        },
        USER_A
      )
    ).toThrow(/not canonical/);
    expect(() =>
      localPersonalDecisionToCloudPayload(
        USER_A,
        localRow('same_product', {
          left_merchant_product_id: 'mp_b',
          right_merchant_product_id: 'mp_a',
        })
      )
    ).toThrow(/not canonical/);
  });

  it('excludes installation-owned rows and other users from the upload payload', () => {
    expect(
      localPersonalDecisionToCloudPayload(
        USER_A,
        localRow('same_product', { owner_key: 'installation:install-1' })
      )
    ).toBeNull();
    expect(
      localPersonalDecisionToCloudPayload(
        USER_A,
        localRow('same_product', { owner_key: `user:${USER_B}` })
      )
    ).toBeNull();
    expect(() =>
      mapCloudPersonalDecisionToLocalInsert(payload('unsure', { user_id: USER_B }), USER_A)
    ).toThrow(/user_id/);
  });
});

describe('personal decision backup sync', () => {
  it('inserts a missing row once and preserves created_at on a repeated upload', async () => {
    const cloud = createCloud();
    const db = createLocalDb([localRow('same_product', { created_at: 111, updated_at: 111 })]);
    const first = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(first).toMatchObject({ status: 'ok', uploaded: 1, idempotent: 0, conflicts: 0 });
    expect(cloud.state.rows).toHaveLength(1);
    expect(cloud.state.rows[0]?.created_at).toBe(111);

    db.kv.set(personalDecisionBackupDirtyKvKey(USER_A), '1');
    const second = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(second).toMatchObject({ status: 'ok', uploaded: 0, idempotent: 1, conflicts: 0 });
    expect(cloud.state.rows).toHaveLength(1);
    expect(cloud.state.rows[0]?.created_at).toBe(111);
    expect(cloud.state.ops).not.toContain('update');
    expect(cloud.state.ops).not.toContain('delete');
    expect(db.kv.get(personalDecisionBackupBootstrapKvKey(USER_A))).toBe('1');
    expect(db.kv.get(personalDecisionBackupDirtyKvKey(USER_A))).toBe('0');
  });

  it('keeps the cloud decision when the local decision differs', async () => {
    const cloud = createCloud([payload('same_product', { created_at: 10, updated_at: 10 })]);
    const db = createLocalDb([
      localRow('not_same_product', { created_at: 99, updated_at: 99 }),
    ]);
    db.kv.set(personalDecisionBackupDirtyKvKey(USER_A), '1');
    const result = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(result).toMatchObject({ status: 'incomplete', conflicts: 1, uploaded: 0 });
    expect(cloud.state.rows[0]?.decision).toBe('same_product');
    expect(cloud.state.rows[0]?.created_at).toBe(10);
    expect(cloud.state.ops).not.toContain('update');
    expect(db.kv.get(personalDecisionBackupDirtyKvKey(USER_A))).toBe('1');
  });

  it('keeps the cloud descriptor payload when the decision matches but the signature differs', async () => {
    const cloud = createCloud([
      payload('unsure', { left_structural_signature: 'struct-v1:old', created_at: 10 }),
    ]);
    const db = createLocalDb([
      localRow('unsure', { left_structural_signature: 'struct-v1:new', created_at: 99 }),
    ]);
    const result = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(result.conflicts).toBe(1);
    expect(cloud.state.rows[0]?.left_structural_signature).toBe('struct-v1:old');
    expect(cloud.state.rows).toHaveLength(1);
    expect(cloud.state.ops).not.toContain('update');
    expect(cloud.state.ops).not.toContain('delete');
  });

  it('uploads only the authenticated user rows and does not delete a cloud-only pair', async () => {
    const extra = payload('not_same_product', {
      left_merchant_product_id: 'mp_c',
      right_merchant_product_id: 'mp_d',
    });
    const cloud = createCloud([extra]);
    const db = createLocalDb([
      localRow('same_product'),
      localRow('unsure', {
        owner_key: 'installation:install-1',
        left_merchant_product_id: 'mp_e',
        right_merchant_product_id: 'mp_f',
      }),
      localRow('not_same_product', {
        owner_key: `user:${USER_B}`,
        left_merchant_product_id: 'mp_g',
        right_merchant_product_id: 'mp_h',
      }),
    ]);
    const result = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(result).toMatchObject({ status: 'ok', uploaded: 1 });
    expect(cloud.state.rows.map((row) => row.left_merchant_product_id).sort()).toEqual([
      'mp_a',
      'mp_c',
    ]);
    expect(cloud.state.ops).not.toContain('delete');
  });

  it('bootstraps already-stored user decisions when no dirty flag exists', async () => {
    const cloud = createCloud();
    const db = createLocalDb([
      localRow('same_product'),
      localRow('unsure', {
        left_merchant_product_id: 'mp_c',
        right_merchant_product_id: 'mp_d',
      }),
    ]);
    const result = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(result).toMatchObject({ status: 'ok', uploaded: 2 });
    expect(db.kv.get(personalDecisionBackupBootstrapKvKey(USER_A))).toBe('1');
    const again = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(again.status).toBe('skipped');
  });

  it('does not treat a missing decision table as success and does not clear dirty', async () => {
    const cloud = createCloud();
    cloud.state.insertError = {
      code: '42P01',
      message: 'relation "public.user_personal_product_identity_decisions" does not exist',
    };
    const db = createLocalDb([localRow('same_product')]);
    db.kv.set(personalDecisionBackupDirtyKvKey(USER_A), '1');
    const result = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(result.status).toBe('table_missing');
    expect(db.kv.get(personalDecisionBackupDirtyKvKey(USER_A))).toBe('1');
    expect(db.kv.get(personalDecisionBackupBootstrapKvKey(USER_A))).toBeUndefined();
    expect(cloud.state.rows).toHaveLength(0);
  });
});

describe('personal decision table-missing predicate', () => {
  it('accepts only the missing-relation shapes', () => {
    expect(
      isPersonalDecisionTableMissingError({
        code: '42P01',
        message: 'relation "public.user_personal_product_identity_decisions" does not exist',
      })
    ).toBe(true);
    expect(
      isPersonalDecisionTableMissingError({
        code: 'PGRST205',
        message:
          "Could not find the table 'public.user_personal_product_identity_decisions' in the schema cache",
      })
    ).toBe(true);
    expect(isPersonalDecisionTableMissingError(new PersonalDecisionTableMissingError())).toBe(
      true
    );
    expect(
      isPersonalDecisionTableMissingError({ code: 'PGRST301', message: 'JWT expired' })
    ).toBe(false);
    expect(
      isPersonalDecisionTableMissingError({
        code: '42501',
        message: 'permission denied for table user_personal_product_identity_decisions',
      })
    ).toBe(false);
    expect(
      isPersonalDecisionTableMissingError({ message: 'Failed to fetch' })
    ).toBe(false);
    expect(
      isPersonalDecisionTableMissingError({
        code: '500',
        message: 'Internal Server Error',
      })
    ).toBe(false);
    expect(
      isPersonalDecisionTableMissingError({
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      })
    ).toBe(false);
    expect(
      isPersonalDecisionTableMissingError({
        code: 'PGRST116',
        message: 'Cannot coerce the result to a single JSON object',
      })
    ).toBe(false);
  });

  it('fetch classifies a missing table and leaves network errors observable', async () => {
    const missing = createCloud();
    missing.state.rangeError = {
      code: 'PGRST205',
      message:
        "Could not find the table 'public.user_personal_product_identity_decisions' in the schema cache",
    };
    await expect(
      fetchAllActiveCloudPersonalDecisionsForUser(USER_A, missing.getClient as never)
    ).rejects.toBeInstanceOf(PersonalDecisionTableMissingError);

    const network = createCloud();
    network.state.rangeError = { code: '500', message: 'Internal Server Error' };
    await expect(
      fetchAllActiveCloudPersonalDecisionsForUser(USER_A, network.getClient as never)
    ).rejects.toThrow(/Internal Server Error/);
    await expect(
      fetchAllActiveCloudPersonalDecisionsForUser(USER_A, network.getClient as never)
    ).rejects.not.toBeInstanceOf(PersonalDecisionTableMissingError);
  });
});

function decisionEndpoint(id: string): PersonalMerchantProductEndpointV1 {
  return buildPersonalMerchantProductEndpointV1({
    merchantProductId: id,
    merchantScopeKey: 'lawson',
    comparisonKey: `cmp-${id}`,
    attributes: buildProductAttributes([]),
  });
}

describe('personal decision backup generation bounds', () => {
  it('reads MAX_SAFE_INTEGER and refuses to increment it', () => {
    expect(parsePersonalDecisionBackupGeneration(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(parsePersonalDecisionBackupGeneration('9007199254740993')).toBe(0);
    expect(nextPersonalDecisionBackupGeneration(Number.MAX_SAFE_INTEGER - 1)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(() => nextPersonalDecisionBackupGeneration(Number.MAX_SAFE_INTEGER)).toThrow(
      PersonalDecisionBackupGenerationOverflowError
    );
    expect(() => nextPersonalDecisionBackupGeneration(Number.NaN)).toThrow(
      PersonalDecisionBackupGenerationOverflowError
    );
    expect(Number.isSafeInteger(nextPersonalDecisionBackupGeneration(0))).toBe(true);
  });
});

describe('personal decision backup generation races', () => {
  it('does not clear dirty when a new decision lands during the cloud round-trip', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    const left = decisionEndpoint('mp_a');
    const right = decisionEndpoint('mp_b');
    const created = await recordPersonalProductIdentityDecisionWithDb(
      db,
      `user:${USER_A}`,
      left,
      right,
      'same_product',
      { nowMs: 111, currentEndpoints: new Map([['mp_a', left], ['mp_b', right]]) }
    );
    expect(created).toEqual({ ok: true, outcome: 'created' });
    expect(db.kv.get(personalDecisionBackupGenerationKvKey(USER_A))).toBe('1');
    expect(db.kv.get(personalDecisionBackupDirtyKvKey(USER_A))).toBe('1');

    let releaseInsert!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const cloud = createCloud();
    cloud.state.holdInsert = hold;
    cloud.state.notifyInsertEntered = markEntered;

    const syncing = syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    await entered;

    const extraLeft = decisionEndpoint('mp_c');
    const extraRight = decisionEndpoint('mp_d');
    const during = await recordPersonalProductIdentityDecisionWithDb(
      db,
      `user:${USER_A}`,
      extraLeft,
      extraRight,
      'not_same_product',
      {
        nowMs: 222,
        currentEndpoints: new Map([
          ['mp_a', left],
          ['mp_b', right],
          ['mp_c', extraLeft],
          ['mp_d', extraRight],
        ]),
      }
    );
    expect(during).toEqual({ ok: true, outcome: 'created' });
    expect(db.kv.get(personalDecisionBackupGenerationKvKey(USER_A))).toBe('2');

    releaseInsert();
    const first = await syncing;
    expect(first.status).toBe('ok');
    expect(cloud.state.rows.map((row) => row.left_merchant_product_id)).toEqual(['mp_a']);
    expect(db.kv.get(personalDecisionBackupDirtyKvKey(USER_A))).toBe('1');
    expect(db.kv.get(personalDecisionBackupBootstrapKvKey(USER_A))).toBe('1');

    const second = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(second.uploaded + second.idempotent).toBe(2);
    expect(cloud.state.rows.map((row) => row.left_merchant_product_id).sort()).toEqual([
      'mp_a',
      'mp_c',
    ]);
    expect(db.kv.get(personalDecisionBackupDirtyKvKey(USER_A))).toBe('0');
    expect(db.kv.get(personalDecisionBackupGenerationKvKey(USER_A))).toBe('2');
  });

  it('does not clear dirty when a decision is created during zero-row bootstrap', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    db.kv.set(personalDecisionBackupGenerationKvKey(USER_A), '4');
    const left = decisionEndpoint('mp_c');
    const right = decisionEndpoint('mp_d');
    const first = await syncPersonalDecisionBackup(
      db,
      USER_A,
      createCloud().getClient as never,
      {
        beforeFinalize: async () => {
          await recordPersonalProductIdentityDecisionWithDb(
            db,
            `user:${USER_A}`,
            left,
            right,
            'unsure',
            { nowMs: 333, currentEndpoints: new Map([['mp_c', left], ['mp_d', right]]) }
          );
        },
      }
    );
    expect(first).toMatchObject({ status: 'ok', uploaded: 0 });
    expect(db.kv.get(personalDecisionBackupBootstrapKvKey(USER_A))).toBe('1');
    expect(db.kv.get(personalDecisionBackupDirtyKvKey(USER_A))).toBe('1');
    expect(db.kv.get(personalDecisionBackupGenerationKvKey(USER_A))).toBe('5');
    expect(db.rows.size).toBe(1);

    const cloud = createCloud();
    const second = await syncPersonalDecisionBackup(db, USER_A, cloud.getClient as never);
    expect(second).toMatchObject({ status: 'ok', uploaded: 1 });
    expect(cloud.state.rows[0]?.decision).toBe('unsure');
    expect(db.kv.get(personalDecisionBackupDirtyKvKey(USER_A))).toBe('0');
  });
});
