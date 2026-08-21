/**
 * P0 Phase 5 — durable local → cloud receipt backup (no restore / Apple).
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      version: '1.0.0',
      extra: { ENABLE_CLOUD_BACKUP: 'true' },
    },
  },
}));

jest.mock('react-native', () => {
  const listeners: Array<(s: string) => void> = [];
  return {
    Platform: { OS: 'ios' },
    AppState: {
      currentState: 'active',
      addEventListener: jest.fn((_type: string, cb: (s: string) => void) => {
        listeners.push(cb);
        return {
          remove: jest.fn(() => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          }),
        };
      }),
      __listeners: listeners,
      __emit(state: string) {
        for (const cb of [...listeners]) cb(state);
      },
    },
  };
});

const authState = {
  status: 'authenticated' as 'authenticated' | 'unauthenticated' | 'unknown' | 'initializing',
  userId: 'user-a' as string | null,
  isAnonymous: true as boolean | null,
  hasAppleIdentity: null as boolean | null,
  accessToken: 'tok' as string | null,
  error: null as string | null,
};

const authListeners = new Set<(s: typeof authState) => void>();

jest.mock('./env', () => {
  const actual = jest.requireActual('./env');
  return {
    ...actual,
    isCloudBackupEnabled: jest.fn(() => true),
  };
});

jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({ ...authState })),
  subscribeAuthState: jest.fn((listener: (s: typeof authState) => void) => {
    authListeners.add(listener);
    try {
      listener({ ...authState });
    } catch {
      // ignore
    }
    return () => {
      authListeners.delete(listener);
    };
  }),
}));

function emitAuthState(): void {
  for (const l of [...authListeners]) {
    try {
      l({ ...authState });
    } catch {
      // ignore
    }
  }
}

const upsertMock = jest.fn(async (): Promise<{ error: unknown }> => ({ error: null }));
const updateSecondEq = jest.fn(async (): Promise<{ error: unknown; count: number }> => ({
  error: null,
  count: 0,
}));
const updateEqMock = jest.fn(() => ({
  eq: updateSecondEq,
}));
const updateMock = jest.fn(() => ({ eq: updateEqMock }));

jest.mock('./supabaseClient', () => ({
  getSupabaseClient: jest.fn(() => ({
    from: jest.fn((table: string) => {
      if (table !== 'user_receipts') throw new Error(`unexpected table ${table}`);
      return {
        upsert: upsertMock,
        update: updateMock,
      };
    }),
  })),
}));

import {
  bootstrapOwnedReceiptBackupIntents,
  cloudBackupBootstrapKvKey,
  enqueueUpsertIntentsForReceiptIds,
} from './cloudBackupBootstrap';
import {
  assertNoImageUriInPayload,
  buildCloudUserReceiptUpsertPayload,
} from './cloudBackupPayload';
import {
  __getRetryTimerPendingForTests,
  __handleAppStateForTests,
  __resetCloudBackupWorkerForTests,
  __runCloudBackupFlushForTests,
  requestCloudBackupFlush,
  startCloudBackupWorker,
} from './cloudBackupWorker';
import { isCloudBackupEnabled } from './env';
import { shouldAutoAdoptUnownedReceipts } from './legacyReceiptAdoption';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import {
  clearSyncOutboxIntentIfCurrent,
  computeBackoffMs,
  generateSyncIntentId,
  getSyncOutboxRow,
  listDueSyncOutboxForUser,
  replaceSyncOutboxIntent,
  updateSyncOutboxRetryIfCurrent,
  type SyncOutboxRow,
} from './syncOutbox';

type OutboxMap = Map<string, SyncOutboxRow>;
type ReceiptSeed = {
  id: string;
  user_id: string | null;
  installation_id?: string | null;
  transaction_source?: string | null;
  source?: string | null;
  created_at: number;
  transaction_at?: number | null;
  scanned_at?: number | null;
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
  merchant_type?: string | null;
  store_raw?: string | null;
  store_normalized?: string | null;
  total: number;
  tax: number;
  tax_is_known?: number;
  currency: string;
  analysis_json: string;
  recognition_snapshot_json?: string | null;
  user_items_json?: string | null;
  user_edited?: number;
  final_total?: number | null;
  final_category?: string | null;
  note?: string | null;
  ocr_request_id?: string | null;
  client_updated_at?: number | null;
  image_uri?: string;
};

function createPhase5Db(seed: ReceiptSeed[] = []) {
  const receipts = new Map(seed.map((r) => [r.id, { ...r }]));
  const outbox: OutboxMap = new Map();
  const appKv = new Map<string, string>();
  let failReplace = false;

  const db = {
    outbox,
    receipts,
    appKv,
    failNextOutboxReplace() {
      failReplace = true;
    },
    async execAsync() {},
    async withTransactionAsync(task: () => Promise<void>) {
      const snapReceipts = new Map(
        [...receipts.entries()].map(([k, v]) => [k, { ...v }])
      );
      const snapOutbox = new Map(
        [...outbox.entries()].map(([k, v]) => [k, { ...v }])
      );
      const snapKv = new Map(appKv);
      try {
        await task();
      } catch (e) {
        receipts.clear();
        for (const [k, v] of snapReceipts) receipts.set(k, v);
        outbox.clear();
        for (const [k, v] of snapOutbox) outbox.set(k, v);
        appKv.clear();
        for (const [k, v] of snapKv) appKv.set(k, v);
        throw e;
      }
    },
    async getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null> {
      if (/FROM app_kv WHERE k = \?/i.test(sql)) {
        const k = String(params?.[0]);
        return appKv.has(k) ? ({ v: appKv.get(k)! } as T) : null;
      }
      if (/FROM sync_outbox WHERE receipt_id = \?/i.test(sql)) {
        const id = String(params?.[0]);
        return (outbox.get(id) as T) ?? null;
      }
      if (
        /SELECT next_retry_at[\s\S]*FROM sync_outbox[\s\S]*next_retry_at > \?/i.test(
          sql
        )
      ) {
        const uid = String(params?.[0]);
        const now = Number(params?.[1]);
        const future = [...outbox.values()]
          .filter((r) => r.user_id === uid && r.next_retry_at > now)
          .sort((a, b) => a.next_retry_at - b.next_retry_at);
        return future.length
          ? ({ next_retry_at: future[0].next_retry_at } as T)
          : null;
      }
      if (/FROM receipts WHERE id = \?/i.test(sql)) {
        const id = String(params?.[0]);
        const row = receipts.get(id);
        return (row ? ({ ...row } as T) : null);
      }
      return null;
    },
    async getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (/FROM receipts r[\s\S]*user_id = \?/i.test(sql)) {
        const uid = String(params?.[0]);
        return [...receipts.values()]
          .filter((r) => r.user_id === uid && !outbox.has(r.id))
          .map((r) => ({ id: r.id })) as T[];
      }
      if (/FROM sync_outbox[\s\S]*user_id = \?/i.test(sql)) {
        const uid = String(params?.[0]);
        const now = Number(params?.[1]);
        const limit = Number(params?.[2] ?? 20);
        return [...outbox.values()]
          .filter((r) => r.user_id === uid && r.next_retry_at <= now)
          .sort((a, b) => a.updated_at - b.updated_at)
          .slice(0, limit) as T[];
      }
      return [];
    },
    async runAsync(sql: string, params?: unknown[]) {
      if (/INSERT OR REPLACE INTO sync_outbox/i.test(sql)) {
        if (failReplace) {
          failReplace = false;
          throw new Error('forced outbox failure');
        }
        const [
          receiptId,
          userId,
          operation,
          intentId,
          deletedAt,
          nextRetryAt,
          createdAt,
          updatedAt,
        ] = params as unknown[];
        outbox.set(String(receiptId), {
          receipt_id: String(receiptId),
          user_id: String(userId),
          operation: operation as 'upsert' | 'delete',
          intent_id: String(intentId),
          deleted_at: deletedAt == null ? null : Number(deletedAt),
          attempt_count: 0,
          last_error: null,
          next_retry_at: Number(nextRetryAt),
          created_at: Number(createdAt),
          updated_at: Number(updatedAt),
        });
        return { changes: 1 };
      }
      if (/DELETE FROM sync_outbox WHERE receipt_id = \? AND intent_id = \?/i.test(sql)) {
        const [receiptId, intentId] = params as unknown[];
        const cur = outbox.get(String(receiptId));
        if (cur && cur.intent_id === String(intentId)) {
          outbox.delete(String(receiptId));
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (/UPDATE sync_outbox/i.test(sql)) {
        const [
          attemptCount,
          lastError,
          nextRetryAt,
          updatedAt,
          receiptId,
          intentId,
        ] = params as unknown[];
        const cur = outbox.get(String(receiptId));
        if (!cur || cur.intent_id !== String(intentId)) return { changes: 0 };
        cur.attempt_count = Number(attemptCount);
        cur.last_error = lastError == null ? null : String(lastError);
        cur.next_retry_at = Number(nextRetryAt);
        cur.updated_at = Number(updatedAt);
        return { changes: 1 };
      }
      if (/INSERT OR REPLACE INTO app_kv/i.test(sql)) {
        const [k, v] = params as unknown[];
        appKv.set(String(k), String(v));
        return { changes: 1 };
      }
      if (/DELETE FROM receipts/i.test(sql)) {
        for (const id of params as unknown[]) receipts.delete(String(id));
        return { changes: 1 };
      }
      return { changes: 0 };
    },
  };

  return db;
}

function sampleReceipt(partial: Partial<ReceiptSeed> & { id: string }): ReceiptSeed {
  return {
    user_id: 'user-a',
    installation_id: 'inst-1',
    transaction_source: 'receipt_ocr',
    source: 'self',
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_100_000,
    scanned_at: 1_700_000_200_000,
    merchant_raw: 'Store',
    merchant_normalized: 'Store',
    merchant_type: null,
    store_raw: null,
    store_normalized: null,
    total: 100,
    tax: 10,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: '{"total":100}',
    recognition_snapshot_json: null,
    user_items_json: null,
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    ocr_request_id: null,
    client_updated_at: 1_700_000_000_000,
    image_uri: 'file://local.jpg',
    ...partial,
  };
}

describe('A. preflight amendments', () => {
  it('1/2 — draft persistence SQL preserves nullable ocr_request_id; old drafts valid', () => {
    const persist = fs.readFileSync(
      path.resolve(__dirname, './scanReviewPersistence.ts'),
      'utf8'
    );
    const store = fs.readFileSync(
      path.resolve(__dirname, './scanReviewDraftStore.ts'),
      'utf8'
    );
    expect(persist).toContain('ocr_request_id');
    expect(persist).toContain('ocrRequestId');
    expect(persist).toMatch(/ADD COLUMN ocr_request_id TEXT/);
    expect(store).toContain('ocrRequestId');
    // Queue stores draft IDs only; request id lives on draft row
    expect(persist).toMatch(/scan_review_queue[\s\S]*queue_json/);
    expect(persist).not.toMatch(/INSERT INTO scan_review_queue[\s\S]*ocr_request_id/);
  });

  it('3 — arbitrary non-anonymous account must not auto-adopt', () => {
    expect(shouldAutoAdoptUnownedReceipts({ is_anonymous: true })).toBe(true);
    expect(shouldAutoAdoptUnownedReceipts({ is_anonymous: false })).toBe(false);
    expect(shouldAutoAdoptUnownedReceipts({ isAnonymous: false })).toBe(false);
    const orchestrator = fs.readFileSync(
      path.resolve(__dirname, './ownershipAdoptionOrchestrator.ts'),
      'utf8'
    );
    expect(orchestrator).toContain('shouldAutoAdoptUnownedReceipts');
  });

  it('4 — user_receipts cloud key is account-scoped composite PK', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../supabase/migrations/004_p0_user_data.sql'),
      'utf8'
    );
    expect(sql).toContain('PRIMARY KEY (user_id, id)');
    expect(sql).not.toMatch(/CONSTRAINT\s+\w+\s+PRIMARY KEY\s*\(\s*id\s*\)/i);
    expect(sql).not.toContain('ux_user_receipts_user_id_id');
  });
});

describe('B. outbox latest-intent semantics', () => {
  it('5/6/8 — one receipt one latest intent; upsert replaces; new intent_id each time', async () => {
    const db = createPhase5Db();
    const a = generateSyncIntentId();
    const b = generateSyncIntentId();
    expect(a).not.toBe(b);

    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'upsert',
      intentId: a,
      nowMs: 1000,
    });
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'upsert',
      intentId: b,
      nowMs: 2000,
    });

    expect(db.outbox.size).toBe(1);
    const row = await getSyncOutboxRow(db as any, 'r1');
    expect(row?.intent_id).toBe(b);
    expect(row?.operation).toBe('upsert');
  });

  it('7/9 — upsert → delete leaves delete tombstone only; survives without receipt row', async () => {
    const db = createPhase5Db([sampleReceipt({ id: 'r1' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'intent-up',
      nowMs: 1,
    });
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'delete',
      intentId: 'intent-del',
      deletedAt: 99,
      nowMs: 2,
    });
    db.receipts.delete('r1');

    const row = await getSyncOutboxRow(db as any, 'r1');
    expect(row?.operation).toBe('delete');
    expect(row?.intent_id).toBe('intent-del');
    expect(row?.deleted_at).toBe(99);
    expect(row?.user_id).toBe('user-a');
    expect(db.receipts.has('r1')).toBe(false);
  });
});

describe('C. atomic behavior', () => {
  it('10/11/12 — receipt+outbox same transaction; failure leaves no half-state', async () => {
    const db = createPhase5Db([sampleReceipt({ id: 'r1', user_id: 'user-a' })]);

    await db.withTransactionAsync(async () => {
      await replaceSyncOutboxIntent(db as any, {
        receiptId: 'r1',
        userId: 'user-a',
        operation: 'delete',
        intentId: 'del-1',
        deletedAt: 50,
        nowMs: 50,
      });
      await db.runAsync(`DELETE FROM receipts WHERE id IN (?)`, ['r1']);
    });
    expect(db.receipts.has('r1')).toBe(false);
    expect(db.outbox.get('r1')?.operation).toBe('delete');

    const db2 = createPhase5Db([sampleReceipt({ id: 'r2' })]);
    db2.failNextOutboxReplace();
    await expect(
      db2.withTransactionAsync(async () => {
        await replaceSyncOutboxIntent(db2 as any, {
          receiptId: 'r2',
          userId: 'user-a',
          operation: 'delete',
          intentId: 'x',
          nowMs: 1,
        });
        await db2.runAsync(`DELETE FROM receipts WHERE id IN (?)`, ['r2']);
      })
    ).rejects.toThrow('forced outbox failure');
    expect(db2.receipts.has('r2')).toBe(true);
    expect(db2.outbox.has('r2')).toBe(false);
  });
});

describe('D. ownership gates', () => {
  it('13/14/15 — only current-user due rows; other user pending; NULL never listed', async () => {
    const db = createPhase5Db();
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'mine',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i1',
      nowMs: 1,
    });
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'theirs',
      userId: 'user-b',
      operation: 'upsert',
      intentId: 'i2',
      nowMs: 1,
    });
    // Unowned receipts never get outbox rows in save path — assert gate helper
    expect(() =>
      buildCloudUserReceiptUpsertPayload(
        sampleReceipt({ id: 'n', user_id: null }) as any
      )
    ).toThrow(/user_id/);

    const due = await listDueSyncOutboxForUser(db as any, 'user-a', 10_000);
    expect(due.map((r) => r.receipt_id)).toEqual(['mine']);
    expect(db.outbox.get('theirs')?.intent_id).toBe('i2');
  });
});

describe('E. cloud payload', () => {
  it('16-21 — maps facts; no image_uri; exact JSON strings; source vs transaction_source; ocr_request_id', () => {
    const analysis =
      '{ "total" : 100, "z":1, "a":2, "note":"\\u3042 space" }';
    const userItems =
      '[{"b":2, "a":1, "name":"  spaced  ", "u":"\\u30B3"}]';
    const snap = '{"keys":{"z":9,"a":1}," spaced ": true}';

    const payload = buildCloudUserReceiptUpsertPayload(
      sampleReceipt({
        id: 'r-pay',
        source: 'family',
        transaction_source: 'receipt_ocr',
        analysis_json: analysis,
        user_items_json: userItems,
        recognition_snapshot_json: snap,
        ocr_request_id: 'req-exact',
        image_uri: 'file://must-not-upload.jpg',
      })
    );

    expect(payload.analysis_json).toBe(analysis);
    expect(payload.user_items_json).toBe(userItems);
    expect(payload.recognition_snapshot_json).toBe(snap);
    expect(payload.social_source).toBe('family');
    expect(payload.transaction_source).toBe('receipt_ocr');
    expect(payload.ocr_request_id).toBe('req-exact');
    expect(payload.deleted_at).toBeNull();
    expect(payload).not.toHaveProperty('image_uri');
    assertNoImageUriInPayload(payload as unknown as Record<string, unknown>);
  });
});

describe('F/G. worker single-flight + race + retry', () => {
  beforeEach(() => {
    __resetCloudBackupWorkerForTests();
    upsertMock.mockReset();
    upsertMock.mockResolvedValue({ error: null });
    updateMock.mockReset();
    updateSecondEq.mockReset();
    updateSecondEq.mockResolvedValue({ error: null, count: 0 });
    updateEqMock.mockReset();
    updateEqMock.mockReturnValue({ eq: updateSecondEq });
    updateMock.mockReturnValue({ eq: updateEqMock });
    authState.status = 'authenticated';
    authState.userId = 'user-a';
    authState.accessToken = 'tok';
  });

  afterEach(() => {
    __resetCloudBackupWorkerForTests();
  });

  it('22 — only one flush in flight', async () => {
    const db = createPhase5Db([sampleReceipt({ id: 'r1' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i-a',
      nowMs: 1,
    });

    let resolveUpsert!: (v: { error: null }) => void;
    let signalStarted!: () => void;
    const upsertStarted = new Promise<void>((r) => {
      signalStarted = r;
    });
    upsertMock.mockImplementationOnce(
      () =>
        new Promise<{ error: null }>((resolve) => {
          resolveUpsert = resolve;
          signalStarted();
        })
    );

    const p1 = __runCloudBackupFlushForTests(async () => db as any);
    const p2 = requestCloudBackupFlush();
    expect(p1).toBe(p2);
    await upsertStarted;
    resolveUpsert!({ error: null });
    await p1;
  });

  it('23/24/25 — success clears matching intent; failure keeps + backoff', async () => {
    const db = createPhase5Db([sampleReceipt({ id: 'ok' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'ok',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i-ok',
      nowMs: 1,
    });
    await __runCloudBackupFlushForTests(async () => db as any);
    expect(db.outbox.has('ok')).toBe(false);

    const dbFail = createPhase5Db([sampleReceipt({ id: 'bad' })]);
    await replaceSyncOutboxIntent(dbFail as any, {
      receiptId: 'bad',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i-bad',
      nowMs: 1,
    });
    upsertMock.mockImplementationOnce(async () => ({
      error: { message: 'net down' },
    }));
    const result = await __runCloudBackupFlushForTests(async () => dbFail as any);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const row = dbFail.outbox.get('bad');
    expect(row).toBeTruthy();
    expect(row!.attempt_count).toBeGreaterThanOrEqual(1);
    expect(row!.next_retry_at).toBeGreaterThan(Date.now());
    expect(computeBackoffMs(1)).toBe(5_000);
    expect(computeBackoffMs(20)).toBe(60 * 60 * 1000);
  });

  it('26 — auth unavailable does not hammer / clear intents', async () => {
    authState.status = 'unauthenticated';
    authState.userId = null;
    authState.accessToken = null;
    const db = createPhase5Db([sampleReceipt({ id: 'r1' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i1',
      nowMs: 1,
    });
    const r = await __runCloudBackupFlushForTests(async () => db as any);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('auth_unavailable');
    expect(upsertMock).not.toHaveBeenCalled();
    expect(db.outbox.get('r1')?.intent_id).toBe('i1');
  });

  it('27 — duplicate retry clear is idempotent (intent already gone)', async () => {
    const db = createPhase5Db();
    const cleared = await clearSyncOutboxIntentIfCurrent(db as any, 'gone', 'x');
    expect(cleared).toBe(false);
  });

  it('28-31 — race: intent A in flight, B replaces; A success must not clear B', async () => {
    const db = createPhase5Db([sampleReceipt({ id: 'r1' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'intent-A',
      nowMs: 1,
    });

    let resolveUpsert!: (v: { error: null }) => void;
    let signalStarted!: () => void;
    const upsertStarted = new Promise<void>((r) => {
      signalStarted = r;
    });
    upsertMock.mockImplementationOnce(
      () =>
        new Promise<{ error: null }>((resolve) => {
          resolveUpsert = resolve;
          signalStarted();
        })
    );

    const flushP = __runCloudBackupFlushForTests(async () => db as any);
    await upsertStarted;
    // While A in flight, local edit creates B
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'intent-B',
      nowMs: 2,
    });
    resolveUpsert!({ error: null });
    await flushP;

    expect(db.outbox.get('r1')?.intent_id).toBe('intent-B');
    expect(db.outbox.get('r1')?.operation).toBe('upsert');

    // Same race for delete superseding upsert
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'r1',
      userId: 'user-a',
      operation: 'delete',
      intentId: 'intent-C',
      deletedAt: 9,
      nowMs: 3,
    });
    const staleClear = await clearSyncOutboxIntentIfCurrent(
      db as any,
      'r1',
      'intent-B'
    );
    expect(staleClear).toBe(false);
    expect(db.outbox.get('r1')?.intent_id).toBe('intent-C');

    const staleRetry = await updateSyncOutboxRetryIfCurrent(db as any, {
      receiptId: 'r1',
      intentId: 'intent-B',
      attemptCount: 99,
      lastError: 'stale',
      nextRetryAt: 999,
    });
    expect(staleRetry).toBe(false);
    expect(db.outbox.get('r1')?.attempt_count).toBe(0);
  });

  it('14 worker — other-user intent is skipped and left pending', async () => {
    const db = createPhase5Db([
      sampleReceipt({ id: 'theirs', user_id: 'user-b' }),
    ]);
    // Manually seed other-user outbox (listDue filters by current user, so inject after)
    db.outbox.set('theirs', {
      receipt_id: 'theirs',
      user_id: 'user-b',
      operation: 'upsert',
      intent_id: 'other',
      deleted_at: null,
      attempt_count: 0,
      last_error: null,
      next_retry_at: 0,
      created_at: 1,
      updated_at: 1,
    });
    // Also current-user empty due list — force list to somehow include? Worker lists by user-a only.
    await __runCloudBackupFlushForTests(async () => db as any);
    expect(db.outbox.get('theirs')?.intent_id).toBe('other');
  });
});

describe('H. bootstrap / adoption handoff', () => {
  it('32/33/35 — owned receipts queue once; crash before marker reruns; other owner skipped', async () => {
    const db = createPhase5Db([
      sampleReceipt({ id: 'own1', user_id: 'user-a' }),
      sampleReceipt({ id: 'own2', user_id: 'user-a' }),
      sampleReceipt({ id: 'other', user_id: 'user-b' }),
    ]);

    const first = await bootstrapOwnedReceiptBackupIntents(db as any, 'user-a', 10);
    expect(first.queued).toBe(2);
    expect(db.outbox.has('own1')).toBe(true);
    expect(db.outbox.has('own2')).toBe(true);
    expect(db.outbox.has('other')).toBe(false);
    expect(db.appKv.get(cloudBackupBootstrapKvKey('user-a'))).toBe('1');

    const second = await bootstrapOwnedReceiptBackupIntents(db as any, 'user-a', 20);
    expect(second.alreadyMarked).toBe(true);
    expect(second.queued).toBe(0);

    // Crash simulation: marker absent, outbox partially filled
    const dbCrash = createPhase5Db([
      sampleReceipt({ id: 'a', user_id: 'user-a' }),
      sampleReceipt({ id: 'b', user_id: 'user-a' }),
    ]);
    await replaceSyncOutboxIntent(dbCrash as any, {
      receiptId: 'a',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'partial',
      nowMs: 1,
    });
    const rerun = await bootstrapOwnedReceiptBackupIntents(dbCrash as any, 'user-a', 5);
    expect(rerun.queued).toBe(1); // only b missing
    expect(dbCrash.outbox.has('b')).toBe(true);
  });

  it('34 — newly adopted offline receipts become queued via handoff', async () => {
    const db = createPhase5Db([
      sampleReceipt({ id: 'new1', user_id: 'user-a' }),
      sampleReceipt({ id: 'new2', user_id: 'user-a' }),
    ]);
    const n = await enqueueUpsertIntentsForReceiptIds(db as any, 'user-a', [
      'new1',
      'new2',
    ]);
    expect(n).toBe(2);
    expect(db.outbox.get('new1')?.operation).toBe('upsert');
    expect(db.outbox.get('new2')?.operation).toBe('upsert');
  });
});

describe('I. cloud RLS contract (migration source)', () => {
  it('36/37 — own CRUD allowed; cross-user denied via auth.uid()', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../supabase/migrations/004_p0_user_data.sql'),
      'utf8'
    );
    expect(sql).toMatch(/user_receipts[\s\S]*user_id = auth\.uid\(\)/);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toMatch(/FOR SELECT[\s\S]*user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/FOR INSERT[\s\S]*user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/FOR UPDATE[\s\S]*user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/FOR DELETE[\s\S]*user_id = auth\.uid\(\)/);
    const lockdown = fs.readFileSync(
      path.resolve(__dirname, '../supabase/migrations/005_ocr_operational_rls_lockdown.sql'),
      'utf8'
    );
    expect(lockdown).toMatch(/ocr_cache/);
  });
});

describe('J. regression', () => {
  it('38/39 — update path preserves ownership fields in db.ts; receipt_items semantics via normalize', () => {
    const dbSource = fs.readFileSync(path.resolve(__dirname, './db.ts'), 'utf8');
    expect(dbSource).toContain('client_updated_at');
    expect(dbSource).toContain('replaceSyncOutboxIntent');
    expect(dbSource).toContain('operation: \'delete\'');
    // Phase 6: legacy client_updated_at backfill uses migration_now, not purchase date
    expect(dbSource).toMatch(
      /SET client_updated_at = \?\s*WHERE client_updated_at IS NULL/
    );
    expect(dbSource).not.toMatch(
      /SET client_updated_at = COALESCE\(transaction_at/
    );
  });

  it('40 — Build 34 sample contracts 007/029/076/081 unchanged', () => {
    const costco007 = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 8351,
      tax: 619,
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
      items: [
        { name: 'A', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'ROCHER ORIGINS CPN', quantity: 1, unitPrice: -600, lineTotal: -600 },
      ],
    } as any);
    expect(costco007.total).toBe(8351);
    expect(costco007.tax).toBe(619);

    const aeon029 = normalizeOcrAnalysis({
      merchant: 'イオン',
      currency: 'JPY',
      total: 1000,
      tax: 91,
      transactionDate: '2024年1月15日(月)',
      items: [{ name: '牛乳', quantity: 1, unitPrice: 200, lineTotal: 200 }],
    } as any);
    expect(aeon029.total).toBe(1000);

    const sample076 = normalizeOcrAnalysis({
      merchant: '店',
      currency: 'JPY',
      total: 674,
      tax: 0,
      items: [
        { name: 'A', quantity: 1, unitPrice: 372, lineTotal: 372 },
        { name: '10%割引', quantity: 1, unitPrice: -38, lineTotal: -38 },
        { name: 'B', quantity: 1, unitPrice: 378, lineTotal: 378 },
        { name: '10%割引', quantity: 1, unitPrice: -38, lineTotal: -38 },
      ],
    } as any);
    expect(sample076.total).toBe(674);

    const sample081 = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 9534,
      tax: 0,
      items: [
        { name: '豪州産モモカツリ', quantity: 1, unitPrice: 3484, lineTotal: 3484 },
      ],
    } as any);
    expect(sample081.total).toBe(9534);
  });
});

describe('worker upsert onConflict target', () => {
  it('uses user_id,id conflict target', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, './cloudBackupWorker.ts'),
      'utf8'
    );
    expect(src).toContain("onConflict: 'user_id,id'");
    expect(src).toContain('isCloudBackupEnabled');
    expect(src).toContain('CLOUD_BACKUP_MAX_BATCHES_PER_FLUSH');
    expect(src).toContain('scheduleRetryWakeup');
  });

  it('flag gates flush only; outbox still written in db mutations', () => {
    const env = fs.readFileSync(path.resolve(__dirname, './env.ts'), 'utf8');
    const db = fs.readFileSync(path.resolve(__dirname, './db.ts'), 'utf8');
    expect(env).toContain('isCloudBackupEnabled');
    expect(db).toContain('replaceSyncOutboxIntent');
    expect(db).toContain('requestCloudBackupFlush');
  });
});

describe('K. sync reliability — drain / cold-start / foreground / retry', () => {
  beforeEach(() => {
    jest.useRealTimers();
    __resetCloudBackupWorkerForTests();
    upsertMock.mockReset();
    upsertMock.mockResolvedValue({ error: null });
    authListeners.clear();
    authState.status = 'authenticated';
    authState.userId = 'user-a';
    authState.accessToken = 'tok';
    (isCloudBackupEnabled as jest.Mock).mockReturnValue(true);
    const RN = require('react-native') as {
      AppState: { __listeners: Array<(s: string) => void>; currentState: string };
    };
    RN.AppState.__listeners.length = 0;
    RN.AppState.currentState = 'active';
  });

  afterEach(() => {
    jest.useRealTimers();
    __resetCloudBackupWorkerForTests();
  });

  it('A — backlog >20: one flush drains all 41 due intents', async () => {
    const seeds = Array.from({ length: 41 }, (_, i) =>
      sampleReceipt({ id: `r${i}`, user_id: 'user-a' })
    );
    const db = createPhase5Db(seeds);
    for (let i = 0; i < 41; i++) {
      await replaceSyncOutboxIntent(db as any, {
        receiptId: `r${i}`,
        userId: 'user-a',
        operation: 'upsert',
        intentId: `intent-${i}`,
        nowMs: i + 1,
      });
    }
    const result = await __runCloudBackupFlushForTests(async () => db as any);
    expect(result.ran).toBe(true);
    expect(result.succeeded).toBe(41);
    expect(result.batches).toBeGreaterThanOrEqual(3);
    expect(db.outbox.size).toBe(0);
    expect(upsertMock).toHaveBeenCalledTimes(41);
  });

  it('B — new receipt behind 40 older due rows is eventually uploaded', async () => {
    const seeds = [
      ...Array.from({ length: 40 }, (_, i) =>
        sampleReceipt({ id: `old${i}`, user_id: 'user-a' })
      ),
      sampleReceipt({
        id: 'new-york',
        user_id: 'user-a',
        merchant_raw: 'ヨークベニマル',
        total: 1382,
      }),
    ];
    const db = createPhase5Db(seeds);
    for (let i = 0; i < 40; i++) {
      await replaceSyncOutboxIntent(db as any, {
        receiptId: `old${i}`,
        userId: 'user-a',
        operation: 'upsert',
        intentId: `old-intent-${i}`,
        nowMs: i + 1,
      });
    }
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'new-york',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'new-intent',
      nowMs: 10_000,
    });

    const result = await __runCloudBackupFlushForTests(async () => db as any);
    expect(result.succeeded).toBe(41);
    expect(db.outbox.has('new-york')).toBe(false);
    const payloads = upsertMock.mock.calls.map((c) => (c as unknown[])[0]);
    expect(payloads.some((p: any) => p?.id === 'new-york')).toBe(true);
  });

  it('C — restored authenticated session on worker start requests flush', async () => {
    const db = createPhase5Db([sampleReceipt({ id: 'restored' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'restored',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i-restored',
      nowMs: 1,
    });
    // Simulate cold start: auth already authenticated before worker starts.
    authState.status = 'authenticated';
    authState.userId = 'user-a';
    authState.accessToken = 'tok';

    startCloudBackupWorker(async () => db as any);
    // Allow single-flight flush started by subscribe sync-notify / onAuthState.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // If still inflight, await a flush request.
    await requestCloudBackupFlush();

    expect(db.outbox.has('restored')).toBe(false);
    expect(upsertMock).toHaveBeenCalled();
  });

  it('D — foreground active transition requests flush once; listener not multiplied', async () => {
    const RN = require('react-native') as {
      AppState: {
        addEventListener: jest.Mock;
        __listeners: Array<(s: string) => void>;
        __emit: (s: string) => void;
      };
    };
    const db = createPhase5Db([sampleReceipt({ id: 'fg1' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'fg1',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i-fg',
      nowMs: 1,
    });

    startCloudBackupWorker(async () => db as any);
    await requestCloudBackupFlush();
    expect(db.outbox.has('fg1')).toBe(false);

    // Remount should not add a second AppState listener.
    const listenerCount = RN.AppState.__listeners.length;
    startCloudBackupWorker(async () => db as any);
    expect(RN.AppState.__listeners.length).toBe(listenerCount);

    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'fg2',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i-fg2',
      nowMs: 2,
    });
    db.receipts.set('fg2', sampleReceipt({ id: 'fg2' }));

    __handleAppStateForTests('background');
    __handleAppStateForTests('active');
    await requestCloudBackupFlush();
    expect(db.outbox.has('fg2')).toBe(false);
  });

  it('E — failed intent retries after next_retry_at via scheduled wakeup', async () => {
    jest.useFakeTimers();
    const db = createPhase5Db([sampleReceipt({ id: 'retry-me' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'retry-me',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i-retry',
      nowMs: 1,
    });
    upsertMock.mockImplementationOnce(async () => ({
      error: { message: 'temp fail' },
    }));

    const first = await __runCloudBackupFlushForTests(async () => db as any);
    expect(first.failed).toBe(1);
    expect(db.outbox.has('retry-me')).toBe(true);
    expect(__getRetryTimerPendingForTests()).toBe(true);

    upsertMock.mockResolvedValue({ error: null });
    await jest.advanceTimersByTimeAsync(6_000);
    await Promise.resolve();
    await requestCloudBackupFlush();

    expect(db.outbox.has('retry-me')).toBe(false);
  });

  it('H — feature flag OFF: no cloud writes and no retry timer', async () => {
    (isCloudBackupEnabled as jest.Mock).mockReturnValue(false);
    const db = createPhase5Db([sampleReceipt({ id: 'off' })]);
    await replaceSyncOutboxIntent(db as any, {
      receiptId: 'off',
      userId: 'user-a',
      operation: 'upsert',
      intentId: 'i-off',
      nowMs: 1,
    });
    const r = await __runCloudBackupFlushForTests(async () => db as any);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('flag_off');
    expect(upsertMock).not.toHaveBeenCalled();
    expect(__getRetryTimerPendingForTests()).toBe(false);
    expect(db.outbox.has('off')).toBe(true);

    __handleAppStateForTests('background');
    __handleAppStateForTests('active');
    expect(upsertMock).not.toHaveBeenCalled();
  });
});