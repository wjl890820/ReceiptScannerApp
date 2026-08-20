/**
 * P0 Phase 6 — safe cloud → local restore.
 */
/* eslint-disable import/first */
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

import { cloudBackupBootstrapKvKey } from './cloudBackupBootstrap';
import {
  CLOUD_RESTORE_PAGE_SIZE,
  fetchAllActiveCloudReceiptsForUser,
  restoreCloudReceiptsForCurrentUser,
  RESTORE_KV_LAST_AT,
  RESTORE_KV_LAST_USER,
} from './cloudRestore';
import {
  mapCloudReceiptToLocalInsert,
  type CloudUserReceiptRow,
} from './cloudRestorePayload';
import { getReceiptItems } from './receiptItems';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { buildReceiptItemIndexRows } from './receiptItemIndex';

type ReceiptRow = Record<string, unknown>;
type OutboxRow = { receipt_id: string; intent_id: string; operation: string };
type ItemRow = { receipt_id: string; normalized_name: string };

function cloudRow(
  partial: Partial<CloudUserReceiptRow> & { id: string; user_id: string }
): CloudUserReceiptRow {
  return {
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
    analysis_json: '{"total":100,"items":[{"name":"ocr","quantity":1,"unitPrice":100,"lineTotal":100}]}',
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
    ...partial,
  };
}

function createRestoreDb(opts?: {
  receipts?: ReceiptRow[];
  outbox?: OutboxRow[];
  failInsert?: boolean;
  failRebuild?: boolean;
}) {
  const receipts = new Map<string, ReceiptRow>(
    (opts?.receipts ?? []).map((r) => [String(r.id), { ...r }])
  );
  const outbox = new Map<string, OutboxRow>(
    (opts?.outbox ?? []).map((o) => [o.receipt_id, { ...o }])
  );
  const items: ItemRow[] = [];
  const appKv = new Map<string, string>();
  let failInsert = !!opts?.failInsert;
  let failRebuild = !!opts?.failRebuild;

  const db = {
    receipts,
    outbox,
    items,
    appKv,
    setFailInsert(v: boolean) {
      failInsert = v;
    },
    setFailRebuild(v: boolean) {
      failRebuild = v;
    },
    async execAsync() {},
    async withTransactionAsync(task: () => Promise<void>) {
      const snapR = new Map([...receipts.entries()].map(([k, v]) => [k, { ...v }]));
      const snapO = new Map([...outbox.entries()].map(([k, v]) => [k, { ...v }]));
      const snapI = items.map((x) => ({ ...x }));
      const snapK = new Map(appKv);
      try {
        await task();
      } catch (e) {
        receipts.clear();
        for (const [k, v] of snapR) receipts.set(k, v);
        outbox.clear();
        for (const [k, v] of snapO) outbox.set(k, v);
        items.splice(0, items.length, ...snapI);
        appKv.clear();
        for (const [k, v] of snapK) appKv.set(k, v);
        throw e;
      }
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
    async runAsync(sql: string, params?: unknown[]) {
      if (/INSERT INTO receipts/i.test(sql)) {
        if (failInsert) throw new Error('forced insert failure');
        const [
          id,
          created_at,
          transaction_at,
          scanned_at,
          image_uri,
          source,
          merchant_raw,
          merchant_normalized,
          merchant_type,
          store_raw,
          store_normalized,
          total,
          tax,
          tax_is_known,
          currency,
          analysis_json,
          recognition_snapshot_json,
          user_edited,
          final_total,
          final_category,
          note,
          user_items_json,
          user_id,
          installation_id,
          transaction_source,
          ocr_request_id,
          client_updated_at,
        ] = params as unknown[];
        receipts.set(String(id), {
          id,
          created_at,
          transaction_at,
          scanned_at,
          image_uri,
          source,
          merchant_raw,
          merchant_normalized,
          merchant_type,
          store_raw,
          store_normalized,
          total,
          tax,
          tax_is_known,
          currency,
          analysis_json,
          recognition_snapshot_json,
          user_edited,
          final_total,
          final_category,
          note,
          user_items_json,
          user_id,
          installation_id,
          transaction_source,
          ocr_request_id,
          client_updated_at,
        });
        return { changes: 1 };
      }
      if (/DELETE FROM receipt_items WHERE receipt_id/i.test(sql)) {
        if (failRebuild) throw new Error('forced rebuild failure');
        const rid = String(params?.[0]);
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].receipt_id === rid) items.splice(i, 1);
        }
        return { changes: 1 };
      }
      if (/INSERT INTO receipt_items/i.test(sql)) {
        items.push({
          receipt_id: String(params?.[1]),
          normalized_name: String(params?.[6] ?? ''),
        });
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

describe('Preflight Phase 6 cleanup', () => {
  it('client_updated_at legacy backfill uses migration_now, not purchase date', () => {
    const dbSource = fs.readFileSync(path.resolve(__dirname, './db.ts'), 'utf8');
    expect(dbSource).toMatch(
      /SET client_updated_at = \?\s*WHERE client_updated_at IS NULL/
    );
    expect(dbSource).not.toMatch(
      /SET client_updated_at = COALESCE\(transaction_at/
    );
    expect(dbSource).toMatch(/migrationNow|migration_now|Phase 5\/6/);
  });

  it('clearReceipts is test-only and requires allowTestOnly', () => {
    const dbSource = fs.readFileSync(path.resolve(__dirname, './db.ts'), 'utf8');
    expect(dbSource).toContain('allowTestOnly: true');
    expect(dbSource).toContain('TEST/DEV ONLY');
    expect(dbSource).toContain('deleteReceipts for durable cloud deletion');
    // Production UI uses deleteReceipt(s), not clearReceipts
    const historyId = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/history/[id].tsx'),
      'utf8'
    );
    const historyIndex = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/history/index.tsx'),
      'utf8'
    );
    expect(historyId).toContain('deleteReceipt');
    expect(historyId).not.toContain('clearReceipts');
    expect(historyIndex).toContain('deleteReceipts');
    expect(historyIndex).not.toContain('clearReceipts');
  });
});

describe('cloud → local mapping', () => {
  it('maps required fields; social_source→source; distinct transaction_source; ocr; empty image', () => {
    const analysis =
      '{ "total" : 100, "z":1, "a":2, "note":"\\u3042 space" }';
    const userItems =
      '[{"b":2, "a":1, "name":"  user  ", "u":"\\u30B3"}]';
    const snap = '{"keys":{"z":9,"a":1}," spaced ": true}';

    const local = mapCloudReceiptToLocalInsert(
      cloudRow({
        id: 'rid-1',
        user_id: 'user-a',
        social_source: 'family',
        transaction_source: 'receipt_ocr',
        analysis_json: analysis,
        user_items_json: userItems,
        recognition_snapshot_json: snap,
        ocr_request_id: 'req-exact',
        user_edited: true,
        note: 'n1',
        final_total: 99,
        final_category: 'food',
      }),
      {
        expectedUserId: 'user-a',
        currentInstallationId: 'install-now',
      }
    );

    expect(local.id).toBe('rid-1');
    expect(local.user_id).toBe('user-a');
    expect(local.source).toBe('family');
    expect(local.transaction_source).toBe('receipt_ocr');
    expect(local.installation_id).toBe('install-now');
    expect(local.image_uri).toBe('');
    expect(local.ocr_request_id).toBe('req-exact');
    expect(local.analysis_json).toBe(analysis);
    expect(local.user_items_json).toBe(userItems);
    expect(local.recognition_snapshot_json).toBe(snap);
    expect(local.user_edited).toBe(1);
    expect(local.note).toBe('n1');
    expect(local.final_total).toBe(99);
    expect(local.final_category).toBe('food');
    expect(local.created_at).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
    expect(local.transaction_at).toBe(Date.parse('2024-01-02T00:00:00.000Z'));
  });

  it('user_items_json priority preserved for derived index', () => {
    const local = mapCloudReceiptToLocalInsert(
      cloudRow({
        id: 'u1',
        user_id: 'user-a',
        analysis_json: JSON.stringify({
          items: [{ name: 'ocr', quantity: 1, unitPrice: 1, lineTotal: 1 }],
        }),
        user_items_json: JSON.stringify([
          { name: 'user', quantity: 2, unitPrice: 50, lineTotal: 100 },
        ]),
        user_edited: true,
      }),
      { expectedUserId: 'user-a', currentInstallationId: 'i' }
    );
    const items = getReceiptItems(local);
    expect((items[0] as { name: string }).name).toBe('user');
    const rows = buildReceiptItemIndexRows({
      id: local.id,
      analysis_json: local.analysis_json,
      user_items_json: local.user_items_json,
    });
    expect(rows[0]?.raw_name ?? rows[0]?.normalized_name).toBeTruthy();
    expect(rows.some((r) => r.normalized_name.includes('user') || r.raw_name === 'user')).toBe(
      true
    );
  });

  it('rejects tombstone and cross-user mapping', () => {
    expect(() =>
      mapCloudReceiptToLocalInsert(
        cloudRow({ id: 'x', user_id: 'user-a', deleted_at: '2024-01-05T00:00:00.000Z' }),
        { expectedUserId: 'user-a', currentInstallationId: 'i' }
      )
    ).toThrow(/tombston/);
    expect(() =>
      mapCloudReceiptToLocalInsert(cloudRow({ id: 'x', user_id: 'other' }), {
        expectedUserId: 'user-a',
        currentInstallationId: 'i',
      })
    ).toThrow(/user_id/);
  });
});

describe('restore preconditions + materialization', () => {
  const auth = {
    status: 'authenticated' as const,
    userId: 'user-a',
    isAnonymous: true,
    hasAppleIdentity: false,
    accessToken: 'tok',
    error: null as string | null,
  };

  it('no auth → auth_unavailable', async () => {
    const db = createRestoreDb();
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({
        status: 'unavailable',
        userId: null,
        isAnonymous: null,
        hasAppleIdentity: null,
        accessToken: null,
        error: 'x',
      }),
      getClient: () => ({}) as any,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => [],
    });
    expect(r.status).toBe('auth_unavailable');
    expect(db.receipts.size).toBe(0);
  });

  it('local receipt exists → blocked_local_data_present', async () => {
    const db = createRestoreDb({
      receipts: [{ id: 'local-1', user_id: 'user-a' }],
    });
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({ ...auth }),
      getClient: () => ({}) as any,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => [
        cloudRow({ id: 'c1', user_id: 'user-a' }),
      ],
    });
    expect(r.status).toBe('blocked_local_data_present');
    expect(db.receipts.has('c1')).toBe(false);
  });

  it('pending outbox → blocked_pending_local_changes', async () => {
    const db = createRestoreDb({
      outbox: [{ receipt_id: 'p1', intent_id: 'i1', operation: 'upsert' }],
    });
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({ ...auth }),
      getClient: () => ({}) as any,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => [
        cloudRow({ id: 'c1', user_id: 'user-a' }),
      ],
    });
    expect(r.status).toBe('blocked_pending_local_changes');
    expect(db.receipts.size).toBe(0);
  });

  it('empty DB + auth restores facts; no outbox; bootstrap marker; second blocked', async () => {
    const analysis = '{ "z": 1, "a": 2 }';
    const userItems = '[{"name":"edited","quantity":1}]';
    const db = createRestoreDb();
    const cloud = [
      cloudRow({
        id: 'A',
        user_id: 'user-a',
        analysis_json: analysis,
        user_items_json: userItems,
        user_edited: true,
        note: 'hello',
        final_total: 12,
        final_category: 'food_ingredients',
        ocr_request_id: 'ocr-1',
        social_source: 'friend',
      }),
      cloudRow({
        id: 'B-del',
        user_id: 'user-a',
        deleted_at: '2024-06-01T00:00:00.000Z',
      }),
    ];

    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({ ...auth }),
      getClient: () => ({}) as any,
      getInstallationId: async () => 'install-cur',
      fetchActiveCloudReceipts: async () =>
        cloud.filter((c) => !c.deleted_at),
      nowMs: () => 1_700_000_000_000,
    });

    expect(r.status).toBe('ok');
    expect(r.restored).toBe(1);
    expect(db.receipts.has('A')).toBe(true);
    expect(db.receipts.has('B-del')).toBe(false);
    const row = db.receipts.get('A')!;
    expect(row.analysis_json).toBe(analysis);
    expect(row.user_items_json).toBe(userItems);
    expect(row.image_uri).toBe('');
    expect(row.source).toBe('friend');
    expect(row.transaction_source).toBe('receipt_ocr');
    expect(row.installation_id).toBe('install-cur');
    expect(row.ocr_request_id).toBe('ocr-1');
    expect(row.user_edited).toBe(1);
    expect(row.note).toBe('hello');
    expect(row.final_total).toBe(12);
    expect(db.outbox.size).toBe(0);
    expect(db.appKv.get(cloudBackupBootstrapKvKey('user-a'))).toBe('1');
    expect(db.appKv.get(RESTORE_KV_LAST_USER)).toBe('user-a');
    expect(db.appKv.get(RESTORE_KV_LAST_AT)).toBe('1700000000000');
    expect(db.items.length).toBeGreaterThan(0);

    const second = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({ ...auth }),
      getClient: () => ({}) as any,
      getInstallationId: async () => 'install-cur',
      fetchActiveCloudReceipts: async () => cloud.filter((c) => !c.deleted_at),
    });
    expect(second.status).toBe('blocked_local_data_present');
  });

  it('insert failure rolls back — DB unchanged, no false bootstrap marker', async () => {
    const db = createRestoreDb({ failInsert: true });
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({ ...auth }),
      getClient: () => ({}) as any,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => [
        cloudRow({ id: 'c1', user_id: 'user-a' }),
      ],
    });
    expect(r.status).toBe('write_failed');
    expect(db.receipts.size).toBe(0);
    expect(db.appKv.has(cloudBackupBootstrapKvKey('user-a'))).toBe(false);
  });

  it('rebuild failure rolls back receipts + marker', async () => {
    const db = createRestoreDb({ failRebuild: true });
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({ ...auth }),
      getClient: () => ({}) as any,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => [
        cloudRow({ id: 'c1', user_id: 'user-a' }),
      ],
    });
    expect(r.status).toBe('write_failed');
    expect(db.receipts.size).toBe(0);
    expect(db.appKv.has(cloudBackupBootstrapKvKey('user-a'))).toBe(false);
  });

  it('fetch failure before write leaves DB unchanged', async () => {
    const db = createRestoreDb();
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({ ...auth }),
      getClient: () => ({}) as any,
      getInstallationId: async () => 'i',
      fetchActiveCloudReceipts: async () => {
        throw new Error('network boom');
      },
    });
    expect(r.status).toBe('fetch_failed');
    expect(db.receipts.size).toBe(0);
  });
});

describe('pagination', () => {
  it('>1 page restores all records without truncation', async () => {
    const pageSize = 5;
    const all = Array.from({ length: 12 }, (_, i) =>
      cloudRow({
        id: `id-${String(i).padStart(3, '0')}`,
        user_id: 'user-a',
        analysis_json: `{"n":${i}}`,
      })
    );

    let calls = 0;
    const client = {
      from: () => ({
        select: () => ({
          is: () => ({
            order: () => ({
              range: async (from: number, to: number) => {
                calls += 1;
                const page = all.slice(from, to + 1);
                return { data: page, error: null };
              },
            }),
          }),
        }),
      }),
    };

    const fetched = await fetchAllActiveCloudReceiptsForUser(
      'user-a',
      pageSize,
      () => client as any
    );
    expect(fetched).toHaveLength(12);
    expect(calls).toBe(3); // 5+5+2
    expect(fetched[0].id).toBe('id-000');
    expect(fetched[11].id).toBe('id-011');

    const db = createRestoreDb();
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'user-a',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 't',
        error: null,
      }),
      getClient: () => client as any,
      getInstallationId: async () => 'i',
      pageSize,
      fetchActiveCloudReceipts: async () => fetched,
    });
    expect(r.status).toBe('ok');
    expect(r.restored).toBe(12);
    expect(db.receipts.size).toBe(12);
  });

  it('page/network failure mid-pagination does not write locally', async () => {
    let calls = 0;
    const client = {
      from: () => ({
        select: () => ({
          is: () => ({
            order: () => ({
              range: async () => {
                calls += 1;
                if (calls === 1) {
                  return {
                    data: [
                      cloudRow({ id: 'a', user_id: 'user-a' }),
                      cloudRow({ id: 'b', user_id: 'user-a' }),
                    ],
                    error: null,
                  };
                }
                return { data: null, error: { message: 'page 2 failed' } };
              },
            }),
          }),
        }),
      }),
    };
    const db = createRestoreDb();
    const r = await restoreCloudReceiptsForCurrentUser({
      getDb: async () => db as any,
      getAuth: () => ({
        status: 'authenticated',
        userId: 'user-a',
        isAnonymous: true,
        hasAppleIdentity: false,
        accessToken: 't',
        error: null,
      }),
      getClient: () => client as any,
      getInstallationId: async () => 'i',
      pageSize: 2,
    });
    expect(r.status).toBe('fetch_failed');
    expect(db.receipts.size).toBe(0);
  });

  it('refuses cross-user cloud rows', async () => {
    await expect(
      fetchAllActiveCloudReceiptsForUser('user-a', 10, () =>
        ({
          from: () => ({
            select: () => ({
              is: () => ({
                order: () => ({
                  range: async () => ({
                    data: [cloudRow({ id: 'x', user_id: 'user-b' })],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }) as any
      )
    ).rejects.toThrow(/cross-user/);
  });
});

describe('ownership / no reupload loop / regression', () => {
  it('page size constant supports >1000 via multiple pages', () => {
    expect(CLOUD_RESTORE_PAGE_SIZE).toBeGreaterThanOrEqual(100);
    expect(CLOUD_RESTORE_PAGE_SIZE).toBeLessThanOrEqual(1000);
  });

  it('restore module does not call saveReceipt/updateReceipt', () => {
    const src = fs.readFileSync(path.resolve(__dirname, './cloudRestore.ts'), 'utf8');
    expect(src).not.toMatch(/saveReceipt\(/);
    expect(src).not.toMatch(/updateReceipt\(/);
    expect(src).toContain('skipTransaction: true');
    expect(src).toContain('cloudBackupBootstrapKvKey');
  });

  it('Build 34 sample contracts unchanged', () => {
    expect(
      normalizeOcrAnalysis({
        merchant: 'コストコ',
        currency: 'JPY',
        total: 8351,
        tax: 619,
        discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
        items: [
          { name: 'A', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
          {
            name: 'ROCHER ORIGINS CPN',
            quantity: 1,
            unitPrice: -600,
            lineTotal: -600,
          },
        ],
      } as any).total
    ).toBe(8351);
    expect(
      normalizeOcrAnalysis({
        merchant: 'イオン',
        currency: 'JPY',
        total: 1000,
        tax: 91,
        transactionDate: '2024年1月15日(月)',
        items: [{ name: '牛乳', quantity: 1, unitPrice: 200, lineTotal: 200 }],
      } as any).total
    ).toBe(1000);
    expect(
      normalizeOcrAnalysis({
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
      } as any).total
    ).toBe(674);
    expect(
      normalizeOcrAnalysis({
        merchant: 'コストコ',
        currency: 'JPY',
        total: 9534,
        tax: 0,
        items: [
          {
            name: '豪州産モモカツリ',
            quantity: 1,
            unitPrice: 3484,
            lineTotal: 3484,
          },
        ],
      } as any).total
    ).toBe(9534);
  });
});
