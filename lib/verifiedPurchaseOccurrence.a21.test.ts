/**
 * A2.1 — verified purchase occurrence provenance + assignment + cloud transport.
 */

/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

import * as fs from 'fs';
import * as path from 'path';

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

import {
  BACKUP_SELECT_COLUMNS,
  buildCloudUserReceiptUpsertPayload,
  type LocalReceiptBackupSource,
} from './cloudBackupPayload';
import { restoreCloudReceiptsForCurrentUser } from './cloudRestore';
import {
  mapCloudReceiptToLocalInsert,
  type CloudUserReceiptRow,
} from './cloudRestorePayload';
import {
  assignVerifiedPurchaseOccurrenceWithDb,
  VerifiedPurchaseOccurrenceAssignError,
} from './verifiedPurchaseOccurrence';
import {
  classifyVerifiedPurchaseOccurrenceBundle,
  generateVerifiedPurchaseOccurrenceId,
  isDurableEpochMs,
  MAX_VERIFIED_PURCHASE_OCCURRENCE_EPOCH_MS,
  parseVerifiedPurchaseOccurrenceCloudTimestamp,
  verifiedAtMsToIso,
} from './verifiedPurchaseOccurrenceProvenance';

const USER = 'user-a21';
const VERIFIED_AT = 1_700_000_100_000;

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

type MemReceipt = {
  id: string;
  user_id: string;
  client_updated_at: number;
  verified_purchase_occurrence_id: string | null;
  verified_purchase_occurrence_source: string | null;
  verified_purchase_occurrence_verified_at: number | null;
  analysis_json: string;
  created_at: number;
  total: number;
  tax: number;
  currency: string;
};

type MemOutbox = {
  receipt_id: string;
  user_id: string;
  operation: string;
  intent_id: string;
};

function createAssignDb(seed: MemReceipt[]) {
  const receipts = new Map(seed.map((r) => [r.id, { ...r }]));
  const outbox = new Map<string, MemOutbox>();
  let exclusiveChain: Promise<void> = Promise.resolve();
  let exclusiveDepth = 0;
  let selectsInsideExclusive = 0;
  let forceNextUpdateChangesZero = false;

  type AssignDb = {
    receipts: Map<string, MemReceipt>;
    outbox: Map<string, MemOutbox>;
    readonly selectsInsideExclusive: number;
    forceNextUpdateChangesZero: () => void;
    getAllAsync: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
    withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
    withExclusiveTransactionAsync: (
      task: (txn: AssignDb) => Promise<void>
    ) => Promise<void>;
    runAsync: (
      sql: string,
      params?: unknown[]
    ) => Promise<{ changes: number }>;
  };

  const db: AssignDb = {
    receipts,
    outbox,
    get selectsInsideExclusive() {
      return selectsInsideExclusive;
    },
    forceNextUpdateChangesZero() {
      forceNextUpdateChangesZero = true;
    },
    async getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (exclusiveDepth > 0) selectsInsideExclusive += 1;
      if (/FROM receipts[\s\S]*WHERE id IN/i.test(sql)) {
        const ids = (params ?? []).slice(0, -1).map(String);
        const uid = String(params?.[params.length - 1]);
        return ids
          .map((id) => receipts.get(id))
          .filter((r): r is MemReceipt => !!r && r.user_id === uid) as T[];
      }
      return [];
    },
    async withTransactionAsync(task: () => Promise<void>) {
      return db.withExclusiveTransactionAsync(async () => {
        await task();
      });
    },
    async withExclusiveTransactionAsync(
      task: (txn: AssignDb) => Promise<void>
    ) {
      const prev = exclusiveChain;
      let release!: () => void;
      exclusiveChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prev;
      exclusiveDepth += 1;
      const snapR = new Map(
        [...receipts.entries()].map(([k, v]) => [k, { ...v }])
      );
      const snapO = new Map(
        [...outbox.entries()].map(([k, v]) => [k, { ...v }])
      );
      try {
        await task(db);
      } catch (e) {
        receipts.clear();
        for (const [k, v] of snapR) receipts.set(k, v);
        outbox.clear();
        for (const [k, v] of snapO) outbox.set(k, v);
        throw e;
      } finally {
        exclusiveDepth -= 1;
        release();
      }
    },
    async runAsync(sql: string, params?: unknown[]) {
      if (/UPDATE receipts/i.test(sql)) {
        const [
          occurrenceId,
          source,
          verifiedAt,
          clientUpdatedAt,
          id,
          userId,
        ] = params as unknown[];
        const row = receipts.get(String(id));
        const requireUnassigned = /verified_purchase_occurrence_id IS NULL/i.test(
          sql
        );
        if (
          !row ||
          row.user_id !== String(userId) ||
          (requireUnassigned &&
            (row.verified_purchase_occurrence_id != null ||
              row.verified_purchase_occurrence_source != null ||
              row.verified_purchase_occurrence_verified_at != null))
        ) {
          return { changes: 0 };
        }
        if (forceNextUpdateChangesZero) {
          forceNextUpdateChangesZero = false;
          return { changes: 0 };
        }
        row.verified_purchase_occurrence_id = String(occurrenceId);
        row.verified_purchase_occurrence_source = String(source);
        row.verified_purchase_occurrence_verified_at = Number(verifiedAt);
        row.client_updated_at = Number(clientUpdatedAt);
        return { changes: 1 };
      }
      if (/INSERT OR REPLACE INTO sync_outbox/i.test(sql)) {
        const [receiptId, userId, operation, intentId] = params as unknown[];
        outbox.set(String(receiptId), {
          receipt_id: String(receiptId),
          user_id: String(userId),
          operation: String(operation),
          intent_id: String(intentId),
        });
        return { changes: 1 };
      }
      return { changes: 0 };
    },
  };
  return db;
}

function seedReceipt(
  id: string,
  overrides: Partial<MemReceipt> = {}
): MemReceipt {
  return {
    id,
    user_id: USER,
    client_updated_at: 1,
    verified_purchase_occurrence_id: null,
    verified_purchase_occurrence_source: null,
    verified_purchase_occurrence_verified_at: null,
    analysis_json: '{"total":1}',
    created_at: 1,
    total: 1,
    tax: 0,
    currency: 'JPY',
    ...overrides,
  };
}

function localBackup(
  overrides: Partial<LocalReceiptBackupSource> & { id: string }
): LocalReceiptBackupSource {
  return {
    user_id: USER,
    created_at: 1,
    total: 1,
    tax: 0,
    currency: 'JPY',
    analysis_json: '{"total":1}',
    verified_purchase_occurrence_id: null,
    verified_purchase_occurrence_source: null,
    verified_purchase_occurrence_verified_at: null,
    ...overrides,
  };
}

function restoreCloud(cloud: CloudUserReceiptRow) {
  return mapCloudReceiptToLocalInsert(cloud, {
    expectedUserId: USER,
    currentInstallationId: 'install-a21',
  });
}

describe('A2.1 verified purchase occurrence provenance', () => {
  it('5–12 — classify unassigned / assigned / invalid variants', () => {
    expect(classifyVerifiedPurchaseOccurrenceBundle({})).toEqual({
      state: 'unassigned',
    });
    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        occurrenceId: null,
        source: null,
        verifiedAt: null,
      })
    ).toEqual({ state: 'unassigned' });

    const assigned = classifyVerifiedPurchaseOccurrenceBundle({
      occurrenceId: 'vpo_abc',
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
    });
    expect(assigned.state).toBe('assigned');
    if (assigned.state === 'assigned') {
      expect(assigned.value.occurrenceId).toBe('vpo_abc');
      expect(assigned.value.source).toBe('research_verified');
      expect(assigned.value.verifiedAt).toBe(VERIFIED_AT);
    }

    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        occurrenceId: 'vpo_only',
      }).state
    ).toBe('invalid');
    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        source: 'research_verified',
      }).state
    ).toBe('invalid');
    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        verifiedAt: VERIFIED_AT,
      }).state
    ).toBe('invalid');
    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        occurrenceId: '',
        source: 'research_verified',
        verifiedAt: VERIFIED_AT,
      }).state
    ).toBe('invalid');
    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        occurrenceId: 'vpo_x',
        source: 'not_a_source',
        verifiedAt: VERIFIED_AT,
      }).state
    ).toBe('invalid');
    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        occurrenceId: 'vpo_x',
        source: 'research_verified',
        verifiedAt: 0,
      }).state
    ).toBe('invalid');
    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        occurrenceId: 'vpo_x',
        source: 'research_verified',
        verifiedAt: Number.NaN,
      }).state
    ).toBe('invalid');
  });

  it('generates opaque vpo_ ids', () => {
    const a = generateVerifiedPurchaseOccurrenceId();
    const b = generateVerifiedPurchaseOccurrenceId();
    expect(a.startsWith('vpo_')).toBe(true);
    expect(b.startsWith('vpo_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('A2.1 local schema migration source', () => {
  it('1–4 — db.ts adds nullable triple; no backfill; save omits assignment', () => {
    const dbSrc = read('lib/db.ts');
    expect(dbSrc).toContain(
      'ALTER TABLE receipts ADD COLUMN verified_purchase_occurrence_id TEXT'
    );
    expect(dbSrc).toContain(
      'ALTER TABLE receipts ADD COLUMN verified_purchase_occurrence_source TEXT'
    );
    expect(dbSrc).toContain(
      'ALTER TABLE receipts ADD COLUMN verified_purchase_occurrence_verified_at INTEGER'
    );
    expect(dbSrc).toContain('verified_purchase_occurrence_id?: string | null');
    // New saves do not stamp verified fields in INSERT.
    const insertIdx = dbSrc.indexOf('INSERT INTO receipts (');
    const insertSlice = dbSrc.slice(insertIdx, insertIdx + 900);
    expect(insertSlice).not.toContain('verified_purchase_occurrence');
    expect(read('supabase/migrations/009_verified_purchase_occurrence.sql')).toContain(
      'verified_purchase_occurrence_id'
    );
  });
});

describe('A2.1 backup / restore transport', () => {
  it('13–17 — backup SELECT + unassigned/assigned/malformed', () => {
    expect(BACKUP_SELECT_COLUMNS).toContain('verified_purchase_occurrence_id');
    expect(BACKUP_SELECT_COLUMNS).toContain(
      'verified_purchase_occurrence_source'
    );
    expect(BACKUP_SELECT_COLUMNS).toContain(
      'verified_purchase_occurrence_verified_at'
    );

    const unassigned = buildCloudUserReceiptUpsertPayload(localBackup({ id: 'u1' }));
    expect(unassigned.verified_purchase_occurrence_id).toBeNull();
    expect(unassigned.verified_purchase_occurrence_source).toBeNull();
    expect(unassigned.verified_purchase_occurrence_verified_at).toBeNull();

    const assigned = buildCloudUserReceiptUpsertPayload(
      localBackup({
        id: 'a1',
        verified_purchase_occurrence_id: 'vpo_round',
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: VERIFIED_AT,
      })
    );
    expect(assigned.verified_purchase_occurrence_id).toBe('vpo_round');
    expect(assigned.verified_purchase_occurrence_source).toBe(
      'research_verified'
    );
    expect(assigned.verified_purchase_occurrence_verified_at).toBe(
      verifiedAtMsToIso(VERIFIED_AT)
    );

    expect(() =>
      buildCloudUserReceiptUpsertPayload(
        localBackup({
          id: 'partial',
          verified_purchase_occurrence_id: 'vpo_x',
        })
      )
    ).toThrow(/malformed verified purchase occurrence/);

    expect(() =>
      buildCloudUserReceiptUpsertPayload(
        localBackup({
          id: 'bad-source',
          verified_purchase_occurrence_id: 'vpo_x',
          verified_purchase_occurrence_source: 'nope' as never,
          verified_purchase_occurrence_verified_at: VERIFIED_AT,
        })
      )
    ).toThrow(/malformed verified purchase occurrence/);
  });

  it('18–24 — restore unassigned / assigned / malformed + orchestration', async () => {
    const legacy = restoreCloud({
      id: 'legacy',
      user_id: USER,
      created_at: '2024-01-01T00:00:00.000Z',
      analysis_json: '{"total":1}',
      total: 1,
      tax: 0,
      deleted_at: null,
    });
    expect(legacy.verified_purchase_occurrence_id).toBeNull();
    expect(legacy.verified_purchase_occurrence_source).toBeNull();
    expect(legacy.verified_purchase_occurrence_verified_at).toBeNull();

    const restored = restoreCloud({
      id: 'restored',
      user_id: USER,
      created_at: '2024-01-01T00:00:00.000Z',
      analysis_json: '{"total":1}',
      total: 1,
      tax: 0,
      deleted_at: null,
      verified_purchase_occurrence_id: 'vpo_cloud',
      verified_purchase_occurrence_source: 'user_verified',
      verified_purchase_occurrence_verified_at: verifiedAtMsToIso(VERIFIED_AT),
    });
    expect(restored.verified_purchase_occurrence_id).toBe('vpo_cloud');
    expect(restored.verified_purchase_occurrence_source).toBe('user_verified');
    expect(restored.verified_purchase_occurrence_verified_at).toBe(VERIFIED_AT);

    expect(() =>
      restoreCloud({
        id: 'partial-cloud',
        user_id: USER,
        created_at: '2024-01-01T00:00:00.000Z',
        analysis_json: '{"total":1}',
        total: 1,
        tax: 0,
        deleted_at: null,
        verified_purchase_occurrence_id: 'vpo_only',
      })
    ).toThrow(/malformed verified purchase occurrence/);

    expect(() =>
      restoreCloud({
        id: 'bad-source-cloud',
        user_id: USER,
        created_at: '2024-01-01T00:00:00.000Z',
        analysis_json: '{"total":1}',
        total: 1,
        tax: 0,
        deleted_at: null,
        verified_purchase_occurrence_id: 'vpo_x',
        verified_purchase_occurrence_source: 'weird',
        verified_purchase_occurrence_verified_at: verifiedAtMsToIso(VERIFIED_AT),
      })
    ).toThrow(/malformed verified purchase occurrence/);

    expect(() =>
      restoreCloud({
        id: 'bad-ts',
        user_id: USER,
        created_at: '2024-01-01T00:00:00.000Z',
        analysis_json: '{"total":1}',
        total: 1,
        tax: 0,
        deleted_at: null,
        verified_purchase_occurrence_id: 'vpo_x',
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 'not-a-timestamp',
      })
    ).toThrow(/malformed verified_purchase_occurrence_verified_at/);

    const receipts = new Map<string, unknown>();
    const outbox = new Map();
    const db = {
      receipts,
      outbox,
      async execAsync() {},
      async withTransactionAsync(task: () => Promise<void>) {
        await task();
      },
      async getFirstAsync<T>(sql: string): Promise<T | null> {
        if (/COUNT\(\*\) as c FROM receipts/i.test(sql)) {
          return { c: receipts.size } as T;
        }
        if (/COUNT\(\*\) as c FROM sync_outbox/i.test(sql)) {
          return { c: outbox.size } as T;
        }
        return null;
      },
      async getAllAsync<T>(): Promise<T[]> {
        return [];
      },
      async runAsync() {
        throw new Error('should not write');
      },
    };
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => ({
        status: 'authenticated',
        userId: USER,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tok',
        error: null,
      }),
      getClient: () => ({}) as never,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => [
        {
          id: 'bad',
          user_id: USER,
          created_at: '2024-01-01T00:00:00.000Z',
          analysis_json: '{"total":1}',
          total: 1,
          tax: 0,
          deleted_at: null,
          verified_purchase_occurrence_id: 'vpo_only',
        },
      ],
    });
    expect(r.status).toBe('validation_failed');
    expect(r.restored).toBe(0);
    expect(receipts.size).toBe(0);
  });

  it('37–38 — cloud round-trip preserves assigned and unassigned', () => {
    const payload = buildCloudUserReceiptUpsertPayload(
      localBackup({
        id: 'rt',
        verified_purchase_occurrence_id: 'vpo_rt',
        verified_purchase_occurrence_source: 'support_verified',
        verified_purchase_occurrence_verified_at: VERIFIED_AT,
      })
    );
    const back = restoreCloud({ ...payload, deleted_at: null });
    expect(back.verified_purchase_occurrence_id).toBe('vpo_rt');
    expect(back.verified_purchase_occurrence_source).toBe('support_verified');
    expect(back.verified_purchase_occurrence_verified_at).toBe(VERIFIED_AT);

    const emptyPayload = buildCloudUserReceiptUpsertPayload(
      localBackup({ id: 'empty-rt' })
    );
    const emptyBack = restoreCloud({ ...emptyPayload, deleted_at: null });
    expect(emptyBack.verified_purchase_occurrence_id).toBeNull();
    expect(emptyBack.verified_purchase_occurrence_source).toBeNull();
    expect(emptyBack.verified_purchase_occurrence_verified_at).toBeNull();
  });

  it('Apple restore inherits Phase 6 cloudRestore mapper', () => {
    const apple = read('lib/appleAccountRestore.ts');
    expect(apple).toContain('restoreCloudReceiptsForCurrentUser');
    expect(apple).not.toContain('mapCloudReceiptToLocalInsert');
  });

  it('analytics occurrence modules: verified truth is selection + canonical, not duplicate evidence', () => {
    expect(read('lib/canonicalPurchaseOccurrence.ts')).toContain(
      'verified_purchase_occurrence'
    );
    expect(read('lib/analyticsReceiptSelection.ts')).toContain(
      'verified_purchase_occurrence'
    );
    expect(read('lib/analysisDDuplicateAudit.ts')).not.toContain(
      'verified_purchase_occurrence'
    );
  });
});

describe('A2.1 assignment API', () => {
  it('25–27 — two unassigned owned receipts → same group + outbox + client_updated_at', async () => {
    const db = createAssignDb([seedReceipt('r1'), seedReceipt('r2')]);
    const result = await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: USER,
      receiptIds: ['r1', 'r2'],
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
      nowMs: VERIFIED_AT + 5,
    });
    expect(result.changedReceiptIds.sort()).toEqual(['r1', 'r2']);
    expect(result.occurrenceId.startsWith('vpo_')).toBe(true);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_id).toBe(
      result.occurrenceId
    );
    expect(db.receipts.get('r2')!.verified_purchase_occurrence_id).toBe(
      result.occurrenceId
    );
    expect(db.receipts.get('r1')!.client_updated_at).toBe(VERIFIED_AT + 5);
    expect(db.outbox.size).toBe(2);
    expect(db.outbox.get('r1')!.operation).toBe('upsert');
  });

  it('28 — all already in same group → idempotent no writes', async () => {
    const gid = 'vpo_same';
    const db = createAssignDb([
      seedReceipt('r1', {
        verified_purchase_occurrence_id: gid,
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 111,
        client_updated_at: 10,
      }),
      seedReceipt('r2', {
        verified_purchase_occurrence_id: gid,
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 111,
        client_updated_at: 10,
      }),
    ]);
    const result = await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: USER,
      receiptIds: ['r1', 'r2'],
      occurrenceId: gid,
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
      nowMs: 999,
    });
    expect(result.changedReceiptIds).toEqual([]);
    expect(db.outbox.size).toBe(0);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_verified_at).toBe(
      111
    );
    expect(db.receipts.get('r1')!.client_updated_at).toBe(10);
  });

  it('29 — one in G + one unassigned → fills unassigned; preserves existing verified_at', async () => {
    const gid = 'vpo_fill';
    const db = createAssignDb([
      seedReceipt('r1', {
        verified_purchase_occurrence_id: gid,
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 50,
        client_updated_at: 1,
      }),
      seedReceipt('r2'),
    ]);
    const result = await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: USER,
      receiptIds: ['r1', 'r2'],
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
      nowMs: 200,
    });
    expect(result.occurrenceId).toBe(gid);
    expect(result.changedReceiptIds).toEqual(['r2']);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_verified_at).toBe(
      50
    );
    expect(db.receipts.get('r2')!.verified_purchase_occurrence_id).toBe(gid);
    expect(db.receipts.get('r2')!.verified_purchase_occurrence_verified_at).toBe(
      VERIFIED_AT
    );
    expect(db.outbox.size).toBe(1);
  });

  it('30–31 — different / conflicting groups reject entirely', async () => {
    const db = createAssignDb([
      seedReceipt('r1', {
        verified_purchase_occurrence_id: 'vpo_a',
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 1,
      }),
      seedReceipt('r2', {
        verified_purchase_occurrence_id: 'vpo_b',
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 1,
      }),
    ]);
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'r2'],
        occurrenceId: 'vpo_a',
        source: 'research_verified',
      })
    ).rejects.toBeInstanceOf(VerifiedPurchaseOccurrenceAssignError);
    expect(db.outbox.size).toBe(0);
    expect(db.receipts.get('r2')!.verified_purchase_occurrence_id).toBe('vpo_b');

    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'r2'],
        source: 'research_verified',
      })
    ).rejects.toThrow(/conflicting/);
  });

  it('32–33 — missing / wrong-owner reject; no partial mutation', async () => {
    const db = createAssignDb([
      seedReceipt('r1'),
      seedReceipt('other', { user_id: 'someone-else' }),
    ]);
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'missing'],
        source: 'research_verified',
      })
    ).rejects.toThrow(/missing or wrong-owner/);
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'other'],
        source: 'research_verified',
      })
    ).rejects.toThrow(/missing or wrong-owner/);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_id).toBeNull();
    expect(db.outbox.size).toBe(0);
  });

  it('34 — duplicate input ids normalize; still requires ≥2 distinct', async () => {
    const db = createAssignDb([seedReceipt('r1'), seedReceipt('r2')]);
    const result = await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: USER,
      receiptIds: ['r1', 'r1', 'r2'],
      source: 'user_verified',
      verifiedAt: VERIFIED_AT,
    });
    expect(result.changedReceiptIds.sort()).toEqual(['r1', 'r2']);

    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'r1'],
        source: 'user_verified',
      })
    ).rejects.toThrow(/at least two distinct/);
  });

  it('35–36 — mid-write failure rolls back receipts and outbox', async () => {
    const db = createAssignDb([seedReceipt('r1'), seedReceipt('r2')]);
    let updates = 0;
    const origRun = db.runAsync.bind(db);
    db.runAsync = async (sql: string, params?: unknown[]) => {
      if (/UPDATE receipts/i.test(sql)) {
        updates += 1;
        if (updates === 2) throw new Error('forced update failure');
      }
      return origRun(sql, params);
    };
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'r2'],
        source: 'research_verified',
        verifiedAt: VERIFIED_AT,
      })
    ).rejects.toThrow(/forced update failure/);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_id).toBeNull();
    expect(db.receipts.get('r2')!.verified_purchase_occurrence_id).toBeNull();
    expect(db.outbox.size).toBe(0);
  });

  it('malformed existing provenance rejects assignment', async () => {
    const db = createAssignDb([
      seedReceipt('r1', {
        verified_purchase_occurrence_id: 'vpo_only',
      }),
      seedReceipt('r2'),
    ]);
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'r2'],
        source: 'research_verified',
      })
    ).rejects.toThrow(/malformed verified provenance/);
  });
});

describe('A2.1a exclusive transaction + input validation', () => {
  it('1 — authoritative SELECT runs inside exclusive transaction', async () => {
    const src = read('lib/verifiedPurchaseOccurrence.ts');
    expect(src).toContain('withExclusiveTransactionAsync');
    expect(src.indexOf('withExclusiveTransactionAsync')).toBeLessThan(
      src.indexOf('FROM receipts')
    );
    const db = createAssignDb([seedReceipt('r1'), seedReceipt('r2')]);
    await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: USER,
      receiptIds: ['r1', 'r2'],
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
    });
    expect(db.selectsInsideExclusive).toBeGreaterThan(0);
  });

  it('2 — concurrent assignments: only one commits; other rejects', async () => {
    const db = createAssignDb([seedReceipt('r1'), seedReceipt('r2')]);
    const p1 = assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: USER,
      receiptIds: ['r1', 'r2'],
      occurrenceId: 'vpo_g1',
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
      nowMs: VERIFIED_AT,
    });
    const p2 = assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: USER,
      receiptIds: ['r1', 'r2'],
      occurrenceId: 'vpo_g2',
      source: 'user_verified',
      verifiedAt: VERIFIED_AT + 1,
      nowMs: VERIFIED_AT + 1,
    });
    const settled = await Promise.allSettled([p1, p2]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{
      occurrenceId: string;
    }>).value.occurrenceId;
    expect(['vpo_g1', 'vpo_g2']).toContain(winner);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_id).toBe(winner);
    expect(db.receipts.get('r2')!.verified_purchase_occurrence_id).toBe(winner);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_id).toBe(
      db.receipts.get('r2')!.verified_purchase_occurrence_id
    );
  });

  it('3 — expected-state UPDATE changes=0 throws and rolls back', async () => {
    const db = createAssignDb([
      seedReceipt('r1'),
      seedReceipt('r2'),
      seedReceipt('r3'),
    ]);
    db.forceNextUpdateChangesZero();
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'r2', 'r3'],
        source: 'research_verified',
        verifiedAt: VERIFIED_AT,
      })
    ).rejects.toThrow(/stale verified membership/);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_id).toBeNull();
    expect(db.receipts.get('r2')!.verified_purchase_occurrence_id).toBeNull();
    expect(db.receipts.get('r3')!.verified_purchase_occurrence_id).toBeNull();
    expect(db.outbox.size).toBe(0);
  });

  it('4 — later member failure rolls back prior outbox writes', async () => {
    const db = createAssignDb([seedReceipt('r1'), seedReceipt('r2')]);
    let updates = 0;
    const origRun = db.runAsync.bind(db);
    db.runAsync = async (sql: string, params?: unknown[]) => {
      if (/UPDATE receipts/i.test(sql)) {
        updates += 1;
        if (updates === 2) throw new Error('forced later member failure');
      }
      return origRun(sql, params);
    };
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: USER,
        receiptIds: ['r1', 'r2'],
        source: 'research_verified',
        verifiedAt: VERIFIED_AT,
      })
    ).rejects.toThrow(/forced later member failure/);
    expect(db.outbox.size).toBe(0);
    expect(db.receipts.get('r1')!.verified_purchase_occurrence_id).toBeNull();
  });

  it('5–8 — target selection: generate / adopt G / idempotent / conflict', async () => {
    const dbGen = createAssignDb([seedReceipt('a'), seedReceipt('b')]);
    const gen = await assignVerifiedPurchaseOccurrenceWithDb(dbGen as never, {
      userId: USER,
      receiptIds: ['a', 'b'],
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
    });
    expect(gen.occurrenceId.startsWith('vpo_')).toBe(true);

    const gid = 'vpo_adopt';
    const dbAdopt = createAssignDb([
      seedReceipt('a', {
        verified_purchase_occurrence_id: gid,
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 50,
      }),
      seedReceipt('b'),
    ]);
    const adopt = await assignVerifiedPurchaseOccurrenceWithDb(
      dbAdopt as never,
      {
        userId: USER,
        receiptIds: ['a', 'b'],
        source: 'user_verified',
        verifiedAt: VERIFIED_AT,
      }
    );
    expect(adopt.occurrenceId).toBe(gid);

    const dbIdem = createAssignDb([
      seedReceipt('a', {
        verified_purchase_occurrence_id: gid,
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 50,
        client_updated_at: 7,
      }),
      seedReceipt('b', {
        verified_purchase_occurrence_id: gid,
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 50,
        client_updated_at: 7,
      }),
    ]);
    const idem = await assignVerifiedPurchaseOccurrenceWithDb(dbIdem as never, {
      userId: USER,
      receiptIds: ['a', 'b'],
      source: 'support_verified',
      verifiedAt: VERIFIED_AT,
      nowMs: 999,
    });
    expect(idem.occurrenceId).toBe(gid);
    expect(idem.changedReceiptIds).toEqual([]);
    expect(idem.source).toBe('research_verified');
    expect(dbIdem.outbox.size).toBe(0);
    expect(dbIdem.receipts.get('a')!.client_updated_at).toBe(7);

    const dbConflict = createAssignDb([
      seedReceipt('a', {
        verified_purchase_occurrence_id: 'vpo_g',
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 1,
      }),
      seedReceipt('b', {
        verified_purchase_occurrence_id: 'vpo_h',
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: 1,
      }),
    ]);
    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(dbConflict as never, {
        userId: USER,
        receiptIds: ['a', 'b'],
        source: 'research_verified',
      })
    ).rejects.toThrow(/conflicting/);
  });

  it('9–12 — explicit occurrenceId validation', async () => {
    const db = createAssignDb([seedReceipt('r1'), seedReceipt('r2')]);
    const ok = await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: USER,
      receiptIds: ['r1', 'r2'],
      occurrenceId: 'vpo_explicit_ok',
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
    });
    expect(ok.occurrenceId).toBe('vpo_explicit_ok');

    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(
        createAssignDb([seedReceipt('r1'), seedReceipt('r2')]) as never,
        {
          userId: USER,
          receiptIds: ['r1', 'r2'],
          occurrenceId: '',
          source: 'research_verified',
          verifiedAt: VERIFIED_AT,
        }
      )
    ).rejects.toThrow(/invalid verified_purchase_occurrence_id/);

    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(
        createAssignDb([seedReceipt('r1'), seedReceipt('r2')]) as never,
        {
          userId: USER,
          receiptIds: ['r1', 'r2'],
          occurrenceId: '  vpo_ws  ',
          source: 'research_verified',
          verifiedAt: VERIFIED_AT,
        }
      )
    ).rejects.toThrow(/invalid verified_purchase_occurrence_id/);

    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(
        createAssignDb([seedReceipt('r1'), seedReceipt('r2')]) as never,
        {
          userId: USER,
          receiptIds: ['r1', 'r2'],
          occurrenceId: 'x'.repeat(129),
          source: 'research_verified',
          verifiedAt: VERIFIED_AT,
        }
      )
    ).rejects.toThrow(/invalid verified_purchase_occurrence_id/);
  });

  it('13–18 — verifiedAt / nowMs validation', async () => {
    expect(isDurableEpochMs(VERIFIED_AT)).toBe(true);
    expect(isDurableEpochMs(-1)).toBe(false);
    expect(isDurableEpochMs(NaN)).toBe(false);
    expect(isDurableEpochMs(Infinity)).toBe(false);
    expect(isDurableEpochMs(MAX_VERIFIED_PURCHASE_OCCURRENCE_EPOCH_MS + 1)).toBe(
      false
    );

    const dbDefault = createAssignDb([seedReceipt('r1'), seedReceipt('r2')]);
    const before = Date.now();
    const r = await assignVerifiedPurchaseOccurrenceWithDb(dbDefault as never, {
      userId: USER,
      receiptIds: ['r1', 'r2'],
      source: 'research_verified',
      nowMs: VERIFIED_AT,
    });
    expect(r.changedReceiptIds).toHaveLength(2);
    expect(
      dbDefault.receipts.get('r1')!.verified_purchase_occurrence_verified_at
    ).toBe(VERIFIED_AT);
    expect(Date.now()).toBeGreaterThanOrEqual(before);

    for (const bad of [
      -1,
      NaN,
      Infinity,
      MAX_VERIFIED_PURCHASE_OCCURRENCE_EPOCH_MS + 1,
    ] as const) {
      await expect(
        assignVerifiedPurchaseOccurrenceWithDb(
          createAssignDb([seedReceipt('r1'), seedReceipt('r2')]) as never,
          {
            userId: USER,
            receiptIds: ['r1', 'r2'],
            source: 'research_verified',
            verifiedAt: bad,
          }
        )
      ).rejects.toThrow(/invalid verifiedAt/);
    }

    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(
        createAssignDb([seedReceipt('r1'), seedReceipt('r2')]) as never,
        {
          userId: USER,
          receiptIds: ['r1', 'r2'],
          source: 'research_verified',
          nowMs: -5,
        }
      )
    ).rejects.toThrow(/invalid nowMs/);
  });
});

describe('A2.1a cloud timestamp parser + restore orchestration', () => {
  it('19–26 — strict cloud timestamptz runtime types', () => {
    expect(
      parseVerifiedPurchaseOccurrenceCloudTimestamp(
        '2023-11-14T22:13:20.000Z'
      )
    ).toBe(Date.parse('2023-11-14T22:13:20.000Z'));
    expect(
      parseVerifiedPurchaseOccurrenceCloudTimestamp(
        '2023-11-14 22:13:20.000+00:00'
      )
    ).toBe(Date.parse('2023-11-14 22:13:20.000+00:00'));

    expect(() => parseVerifiedPurchaseOccurrenceCloudTimestamp(1)).toThrow();
    expect(() => parseVerifiedPurchaseOccurrenceCloudTimestamp(true)).toThrow();
    expect(() => parseVerifiedPurchaseOccurrenceCloudTimestamp({})).toThrow();
    expect(() => parseVerifiedPurchaseOccurrenceCloudTimestamp('1')).toThrow();
    expect(() =>
      parseVerifiedPurchaseOccurrenceCloudTimestamp('01/01/2026')
    ).toThrow();
    expect(() =>
      parseVerifiedPurchaseOccurrenceCloudTimestamp('Infinity')
    ).toThrow();
    expect(() =>
      parseVerifiedPurchaseOccurrenceCloudTimestamp('1969-12-31T23:59:59.000Z')
    ).toThrow();
  });

  it('27 — mixed valid + malformed verified_at → validation_failed / restored 0', async () => {
    const receipts = new Map<string, unknown>();
    const outbox = new Map();
    const db = {
      receipts,
      outbox,
      async execAsync() {},
      async withTransactionAsync(task: () => Promise<void>) {
        await task();
      },
      async getFirstAsync<T>(sql: string): Promise<T | null> {
        if (/COUNT\(\*\) as c FROM receipts/i.test(sql)) {
          return { c: receipts.size } as T;
        }
        if (/COUNT\(\*\) as c FROM sync_outbox/i.test(sql)) {
          return { c: outbox.size } as T;
        }
        return null;
      },
      async getAllAsync<T>(): Promise<T[]> {
        return [];
      },
      async runAsync() {
        throw new Error('should not write');
      },
    };
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => ({
        status: 'authenticated',
        userId: USER,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tok',
        error: null,
      }),
      getClient: () => ({}) as never,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => [
        {
          id: 'good',
          user_id: USER,
          created_at: '2024-01-01T00:00:00.000Z',
          analysis_json: '{"total":1}',
          total: 1,
          tax: 0,
          deleted_at: null,
          verified_purchase_occurrence_id: 'vpo_good',
          verified_purchase_occurrence_source: 'user_verified',
          verified_purchase_occurrence_verified_at: verifiedAtMsToIso(VERIFIED_AT),
        },
        {
          id: 'bad',
          user_id: USER,
          created_at: '2024-01-01T00:00:00.000Z',
          analysis_json: '{"total":1}',
          total: 1,
          tax: 0,
          deleted_at: null,
          verified_purchase_occurrence_id: 'vpo_bad',
          verified_purchase_occurrence_source: 'user_verified',
          // number must not coerce through String(1)
          verified_purchase_occurrence_verified_at: 1 as unknown as string,
        },
      ],
    });
    expect(r.status).toBe('validation_failed');
    expect(r.restored).toBe(0);
    expect(receipts.size).toBe(0);
  });

  it('migration 009 timestamp CHECK contract', () => {
    const sql = read(
      'supabase/migrations/009_verified_purchase_occurrence.sql'
    );
    expect(sql).toContain('isfinite(verified_purchase_occurrence_verified_at)');
    expect(sql).toContain(
      ">=\n        TIMESTAMPTZ '1970-01-01 00:00:00.001+00'"
    );
    expect(sql).not.toContain(
      "> TIMESTAMPTZ '1970-01-01 00:00:00+00'"
    );
    expect(sql).toContain("TIMESTAMPTZ '10000-01-01 00:00:00+00'");
    expect(sql).toContain(
      'verified_purchase_occurrence_source IS NOT NULL'
    );
    expect(sql).toMatch(
      /verified_purchase_occurrence_id IS NULL[\s\S]*verified_purchase_occurrence_source IS NULL[\s\S]*verified_purchase_occurrence_verified_at IS NULL/
    );
    expect(sql).toMatch(
      /verified_purchase_occurrence_id IS NOT NULL[\s\S]*verified_purchase_occurrence_source IS NOT NULL[\s\S]*verified_purchase_occurrence_verified_at IS NOT NULL/
    );
  });
});

describe('A2.1b verifiedAt timestamp contract alignment', () => {
  it('1–2 — explicit blank cloud verified_at throws (not absence)', () => {
    expect(() =>
      restoreCloud({
        id: 'blank',
        user_id: USER,
        created_at: '2024-01-01T00:00:00.000Z',
        analysis_json: '{"total":1}',
        total: 1,
        tax: 0,
        deleted_at: null,
        verified_purchase_occurrence_id: null,
        verified_purchase_occurrence_source: null,
        verified_purchase_occurrence_verified_at: '',
      })
    ).toThrow(/malformed verified_purchase_occurrence_verified_at/);

    expect(() =>
      restoreCloud({
        id: 'ws',
        user_id: USER,
        created_at: '2024-01-01T00:00:00.000Z',
        analysis_json: '{"total":1}',
        total: 1,
        tax: 0,
        deleted_at: null,
        verified_purchase_occurrence_verified_at: '   ',
      })
    ).toThrow(/malformed verified_purchase_occurrence_verified_at/);

    expect(() => parseVerifiedPurchaseOccurrenceCloudTimestamp('')).toThrow();
    expect(() =>
      parseVerifiedPurchaseOccurrenceCloudTimestamp('   ')
    ).toThrow();
  });

  it('3 — mixed restore with verified_at="" → validation_failed / restored 0', async () => {
    const receipts = new Map<string, unknown>();
    const outbox = new Map();
    const db = {
      receipts,
      outbox,
      async execAsync() {},
      async withTransactionAsync(task: () => Promise<void>) {
        await task();
      },
      async getFirstAsync<T>(sql: string): Promise<T | null> {
        if (/COUNT\(\*\) as c FROM receipts/i.test(sql)) {
          return { c: receipts.size } as T;
        }
        if (/COUNT\(\*\) as c FROM sync_outbox/i.test(sql)) {
          return { c: outbox.size } as T;
        }
        return null;
      },
      async getAllAsync<T>(): Promise<T[]> {
        return [];
      },
      async runAsync() {
        throw new Error('should not write');
      },
    };
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as never,
      getAuth: () => ({
        status: 'authenticated',
        userId: USER,
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 'tok',
        error: null,
      }),
      getClient: () => ({}) as never,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => [
        {
          id: 'good',
          user_id: USER,
          created_at: '2024-01-01T00:00:00.000Z',
          analysis_json: '{"total":1}',
          total: 1,
          tax: 0,
          deleted_at: null,
        },
        {
          id: 'blank-at',
          user_id: USER,
          created_at: '2024-01-01T00:00:00.000Z',
          analysis_json: '{"total":1}',
          total: 1,
          tax: 0,
          deleted_at: null,
          verified_purchase_occurrence_id: null,
          verified_purchase_occurrence_source: null,
          verified_purchase_occurrence_verified_at: '',
        },
      ],
    });
    expect(r.status).toBe('validation_failed');
    expect(r.restored).toBe(0);
    expect(receipts.size).toBe(0);
  });

  it('4–8 — unified max verifiedAt range + round-trip', () => {
    const max = MAX_VERIFIED_PURCHASE_OCCURRENCE_EPOCH_MS;
    expect(max).toBe(253_402_300_799_999);
    expect(isDurableEpochMs(max)).toBe(true);
    expect(verifiedAtMsToIso(max)).toBe('9999-12-31T23:59:59.999Z');
    expect(isDurableEpochMs(max + 1)).toBe(false);
    expect(isDurableEpochMs(8.64e15)).toBe(false);

    const payload = buildCloudUserReceiptUpsertPayload(
      localBackup({
        id: 'max-rt',
        verified_purchase_occurrence_id: 'vpo_max',
        verified_purchase_occurrence_source: 'research_verified',
        verified_purchase_occurrence_verified_at: max,
      })
    );
    expect(payload.verified_purchase_occurrence_verified_at).toBe(
      '9999-12-31T23:59:59.999Z'
    );
    const back = restoreCloud({ ...payload, deleted_at: null });
    expect(back.verified_purchase_occurrence_verified_at).toBe(max);

    expect(() =>
      parseVerifiedPurchaseOccurrenceCloudTimestamp(
        '10000-01-01T00:00:00.000Z'
      )
    ).toThrow();
    expect(() =>
      parseVerifiedPurchaseOccurrenceCloudTimestamp(
        '+010000-01-01T00:00:00.000Z'
      )
    ).toThrow();
  });

  it('9–15 — ordinary PostgREST fractional / offset forms restore', () => {
    const forms = [
      '2026-09-27T04:42:10Z',
      '2026-09-27T04:42:10.1Z',
      '2026-09-27T04:42:10.12Z',
      '2026-09-27T04:42:10.123Z',
      '2026-09-27T04:42:10.123456Z',
      '2026-09-27T04:42:10+00:00',
      '2026-09-27T04:42:10.123456+00:00',
    ];
    for (const iso of forms) {
      const ms = parseVerifiedPurchaseOccurrenceCloudTimestamp(iso);
      expect(isDurableEpochMs(ms)).toBe(true);
      const local = restoreCloud({
        id: `form-${iso}`,
        user_id: USER,
        created_at: '2024-01-01T00:00:00.000Z',
        analysis_json: '{"total":1}',
        total: 1,
        tax: 0,
        deleted_at: null,
        verified_purchase_occurrence_id: 'vpo_form',
        verified_purchase_occurrence_source: 'user_verified',
        verified_purchase_occurrence_verified_at: iso,
      });
      expect(local.verified_purchase_occurrence_verified_at).toBe(ms);
    }
  });

  it('16–19 — migration 009 assigned CHECK completeness', () => {
    const sql = read(
      'supabase/migrations/009_verified_purchase_occurrence.sql'
    );
    expect(sql).toContain(
      'verified_purchase_occurrence_source IS NOT NULL'
    );
    expect(sql).toContain('isfinite(verified_purchase_occurrence_verified_at)');
    expect(sql).toMatch(
      /verified_purchase_occurrence_verified_at\s*>=\s*TIMESTAMPTZ '1970-01-01 00:00:00\.001\+00'/
    );
    expect(sql).not.toMatch(
      /verified_purchase_occurrence_verified_at\s*>\s*TIMESTAMPTZ '1970-01-01 00:00:00\+00'/
    );
    expect(sql).toContain(
      "verified_purchase_occurrence_verified_at <\n        TIMESTAMPTZ '10000-01-01 00:00:00+00'"
    );
    expect(sql).toMatch(
      /verified_purchase_occurrence_id IS NULL[\s\S]*AND verified_purchase_occurrence_source IS NULL[\s\S]*AND verified_purchase_occurrence_verified_at IS NULL/
    );
  });
});

describe('A2.1c migration lower timestamp bound', () => {
  it('1–2 — SQL lower bound is >= 1ms, not > epoch', () => {
    const sql = read(
      'supabase/migrations/009_verified_purchase_occurrence.sql'
    );
    expect(sql).toContain(
      ">=\n        TIMESTAMPTZ '1970-01-01 00:00:00.001+00'"
    );
    expect(sql).not.toContain("> TIMESTAMPTZ '1970-01-01 00:00:00+00'");
  });

  it('3–6 — local 1ms / 0ms and cloud sub-ms truncation', () => {
    expect(isDurableEpochMs(1)).toBe(true);
    expect(isDurableEpochMs(0)).toBe(false);
    expect(
      parseVerifiedPurchaseOccurrenceCloudTimestamp(
        '1970-01-01T00:00:00.001Z'
      )
    ).toBe(1);
    expect(isDurableEpochMs(1)).toBe(true);
    expect(() =>
      parseVerifiedPurchaseOccurrenceCloudTimestamp(
        '1970-01-01T00:00:00.000001Z'
      )
    ).toThrow(/malformed verified_purchase_occurrence_verified_at/);
    expect(isDurableEpochMs(253_402_300_799_999)).toBe(true);
    expect(isDurableEpochMs(253_402_300_800_000)).toBe(false);
  });
});
