/**
 * DS1 — decision backup failure must not fail an otherwise successful receipt backup.
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '1.0.0', extra: { ENABLE_CLOUD_BACKUP: 'true' } },
  },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
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

jest.mock('./env', () => {
  const actual = jest.requireActual('./env');
  return {
    ...actual,
    isCloudBackupEnabled: jest.fn(() => true),
  };
});

jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({
    status: 'authenticated',
    userId: 'user-a',
    isAnonymous: false,
    hasAppleIdentity: true,
    accessToken: 'tok',
    error: null,
  })),
  subscribeAuthState: jest.fn(() => () => undefined),
}));

jest.mock('./personalDecisionCloudSync', () => ({
  syncPersonalDecisionBackup: jest.fn(async () => {
    throw new Error('decision network down');
  }),
}));

jest.mock('./supabaseClient', () => {
  const receiptUpserts: unknown[] = [];
  return {
    getSupabaseClient: jest.fn(() => ({
      from: jest.fn((table: string) => {
        if (table !== 'user_receipts') throw new Error(`unexpected table ${table}`);
        return {
          upsert: jest.fn(async (payload: unknown) => {
            receiptUpserts.push(payload);
            return { error: null };
          }),
        };
      }),
    })),
    __receiptUpserts: receiptUpserts,
  };
});

import {
  __resetCloudBackupWorkerForTests,
  __runCloudBackupFlushForTests,
} from './cloudBackupWorker';
import { syncPersonalDecisionBackup } from './personalDecisionCloudSync';
import * as supabaseClientModule from './supabaseClient';

const receiptUpserts = (
  supabaseClientModule as unknown as { __receiptUpserts: unknown[] }
).__receiptUpserts;

describe('decision backup isolation', () => {
  beforeEach(() => {
    receiptUpserts.length = 0;
    jest.mocked(syncPersonalDecisionBackup).mockClear();
    __resetCloudBackupWorkerForTests();
  });

  it('keeps a successful receipt upsert when decision sync throws', async () => {
    const receipts = new Map<string, Record<string, unknown>>([
      [
        'r1',
        {
          id: 'r1',
          user_id: 'user-a',
          installation_id: 'inst-1',
          transaction_source: 'receipt_ocr',
          source: 'self',
          created_at: 1_700_000_000_000,
          transaction_at: 1_700_000_100_000,
          transaction_time_precision: 'date',
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
          verified_purchase_occurrence_id: null,
          verified_purchase_occurrence_source: null,
          verified_purchase_occurrence_verified_at: null,
        },
      ],
    ]);
    const outbox = new Map([
      [
        'r1',
        {
          receipt_id: 'r1',
          user_id: 'user-a',
          operation: 'upsert' as const,
          intent_id: 'intent-1',
          deleted_at: null,
          attempt_count: 0,
          last_error: null,
          next_retry_at: 0,
          created_at: 1,
          updated_at: 1,
        },
      ],
    ]);
    const db = {
      async execAsync() {},
      async withTransactionAsync(task: () => Promise<void>) {
        await task();
      },
      async getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null> {
        if (/FROM app_kv WHERE k = \?/i.test(sql)) return null;
        if (/FROM receipts WHERE id = \?/i.test(sql)) {
          const row = receipts.get(String(params?.[0]));
          return (row ? ({ ...row } as T) : null);
        }
        if (/FROM sync_outbox WHERE receipt_id = \?/i.test(sql)) {
          return (outbox.get(String(params?.[0])) as T) ?? null;
        }
        return null;
      },
      async getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (/FROM sync_outbox[\s\S]*user_id = \?/i.test(sql)) {
          return [...outbox.values()] as T[];
        }
        if (/FROM receipts r[\s\S]*user_id = \?/i.test(sql)) return [];
        return [];
      },
      async runAsync(sql: string, params?: unknown[]) {
        if (/DELETE FROM sync_outbox WHERE receipt_id = \? AND intent_id = \?/i.test(sql)) {
          const current = outbox.get(String(params?.[0]));
          if (current && current.intent_id === String(params?.[1])) {
            outbox.delete(String(params?.[0]));
          }
        }
        return { changes: 1 };
      },
    };

    const result = await __runCloudBackupFlushForTests(async () => db as never);
    expect(syncPersonalDecisionBackup).toHaveBeenCalled();
    expect(receiptUpserts).toHaveLength(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.ran).toBe(true);
  });
});
