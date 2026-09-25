/**
 * A1b / A1b.1 — cloud round-trip transaction_time_precision integrity.
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
import type { ReceiptRow } from './db';
import {
  hasExactTransactionTime,
  resolveReceiptTransactionTimePrecision,
} from './receiptExactTransactionTime';
import {
  classifyPersistedPrecisionToken,
  columnPrecisionPresenceOf,
} from './receiptTransactionTimePrecisionAuthority';

const COSTCO_TX_AT = 1_688_611_486_000;
const GYOMU_TX_AT = 1_786_351_380_000;
const USER = 'user-a1b';
const INSTALL = 'install-a1b';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

function localBackupSource(
  overrides: Partial<LocalReceiptBackupSource> &
    Pick<LocalReceiptBackupSource, 'id' | 'analysis_json'>
): LocalReceiptBackupSource {
  return {
    user_id: USER,
    created_at: 1_700_000_000_000,
    total: 0,
    tax: 0,
    currency: 'JPY',
    ...overrides,
  };
}

function cloudFromPayload(
  payload: ReturnType<typeof buildCloudUserReceiptUpsertPayload>,
  extra?: Partial<CloudUserReceiptRow>
): CloudUserReceiptRow {
  return {
    ...payload,
    ...extra,
  };
}

function restore(cloud: CloudUserReceiptRow) {
  return mapCloudReceiptToLocalInsert(cloud, {
    expectedUserId: USER,
    currentInstallationId: INSTALL,
  });
}

function asReceiptRow(local: ReturnType<typeof restore>): ReceiptRow {
  return local as unknown as ReceiptRow;
}

/** Minimal empty restore DB matching phase6 createRestoreDb shape. */
function createEmptyRestoreDb() {
  const receipts = new Map<string, Record<string, unknown>>();
  const outbox = new Map<string, unknown>();
  const appKv = new Map<string, string>();
  const items: unknown[] = [];
  return {
    receipts,
    outbox,
    appKv,
    items,
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
    async runAsync(sql: string, params?: unknown[]) {
      if (/INSERT INTO receipts/i.test(sql)) {
        const id = String(params?.[0]);
        receipts.set(id, { id, ...(params ? { params } : {}) });
      }
      if (/INSERT OR REPLACE INTO app_kv/i.test(sql) || /INSERT INTO app_kv/i.test(sql)) {
        appKv.set(String(params?.[0]), String(params?.[1]));
      }
      if (/DELETE FROM/i.test(sql)) {
        /* ignore */
      }
    },
  };
}

describe('A1b.1 cloud precision boundary hardening', () => {
  it('backup SELECT / paths include transaction_time_precision', () => {
    expect(BACKUP_SELECT_COLUMNS).toMatch(/transaction_time_precision/);
    expect(BACKUP_SELECT_COLUMNS).toMatch(
      /transaction_at,\s*transaction_time_precision,\s*scanned_at/
    );
    const worker = read('lib/cloudBackupWorker.ts');
    expect(worker).toContain('BACKUP_SELECT_COLUMNS');
    expect(worker).toContain('SELECT ${BACKUP_SELECT_COLUMNS} FROM receipts');
    const bootstrap = read('lib/cloudBackupBootstrap.ts');
    expect(bootstrap).not.toMatch(
      /SELECT[\s\S]{0,200}FROM receipts[\s\S]{0,80}analysis_json/
    );
    const restoreSrc = read('lib/cloudRestore.ts');
    expect(restoreSrc).toMatch(/CLOUD_SELECT[\s\S]*transaction_time_precision/);
    expect(restoreSrc).toContain('.select(CLOUD_SELECT)');
    expect(restoreSrc).toContain('mapCloudReceiptToLocalInsert');
    expect(restoreSrc).toContain("status: 'validation_failed'");
  });

  it('1 — legacy Costco raw DB unknown → cloud payload second', () => {
    const payload = buildCloudUserReceiptUpsertPayload(
      localBackupSource({
        id: 'costco-backup',
        transaction_at: COSTCO_TX_AT,
        transaction_time_precision: 'unknown',
        merchant_raw: 'Costco',
        analysis_json: JSON.stringify({
          merchant: 'Costco',
          transactionDate: '07/06/2023 11:44:46',
        }),
      })
    );
    expect(payload.transaction_time_precision).toBe('second');
  });

  it('2 — legacy Gyomu raw DB unknown → cloud payload minute', () => {
    const payload = buildCloudUserReceiptUpsertPayload(
      localBackupSource({
        id: 'gyomu-backup',
        transaction_at: GYOMU_TX_AT,
        transaction_time_precision: 'unknown',
        merchant_raw: '業務スーパー',
        analysis_json: JSON.stringify({
          merchant: '業務スーパー',
          transactionDate: '2026/08/10 17:43',
        }),
      })
    );
    expect(payload.transaction_time_precision).toBe('minute');
  });

  it('3 — raw DB unknown + explicit analysis unknown → cloud unknown', () => {
    const payload = buildCloudUserReceiptUpsertPayload(
      localBackupSource({
        id: 'analysis-unknown-backup',
        transaction_at: COSTCO_TX_AT,
        transaction_time_precision: 'unknown',
        merchant_raw: 'Costco',
        analysis_json: JSON.stringify({
          merchant: 'Costco',
          transaction_time_precision: 'unknown',
          transactionDate: '07/06/2023 11:44:46',
        }),
      })
    );
    expect(payload.transaction_time_precision).toBe('unknown');
  });

  it('4 — malformed local "SECOND" throws; no unknown payload', () => {
    expect(() =>
      buildCloudUserReceiptUpsertPayload(
        localBackupSource({
          id: 'malformed-local',
          transaction_at: COSTCO_TX_AT,
          transaction_time_precision: 'SECOND',
          merchant_raw: 'Costco',
          analysis_json: JSON.stringify({
            merchant: 'Costco',
            transactionDate: '07/06/2023 11:44:46',
          }),
        })
      )
    ).toThrow(/malformed transaction_time_precision/);
  });

  it('5 — empty-string / other invalid local tokens reject', () => {
    for (const bad of ['', 'Minute', ' second ', 'foo', 123, true, {}]) {
      expect(() =>
        buildCloudUserReceiptUpsertPayload(
          localBackupSource({
            id: `bad-${String(bad)}`,
            transaction_time_precision: bad as never,
            analysis_json: '{"total":1}',
          })
        )
      ).toThrow(/malformed transaction_time_precision/);
    }
  });

  it('6 — malformed cloud "SECOND" throws at mapper', () => {
    const cloud: CloudUserReceiptRow = {
      id: 'cloud-SECOND',
      user_id: USER,
      created_at: new Date(COSTCO_TX_AT).toISOString(),
      transaction_at: new Date(COSTCO_TX_AT).toISOString(),
      transaction_time_precision: 'SECOND',
      merchant_raw: 'Costco',
      total: 9534,
      tax: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
      deleted_at: null,
    };
    expect(() => restore(cloud)).toThrow(
      /malformed transaction_time_precision/
    );
  });

  it('7 — restore orchestration: malformed cloud → validation_failed, restored=0', async () => {
    const db = createEmptyRestoreDb();
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
      getInstallationId: async () => INSTALL,
      fetchActiveCloudReceipts: async () => [
        {
          id: 'bad-cloud',
          user_id: USER,
          created_at: new Date(COSTCO_TX_AT).toISOString(),
          transaction_at: new Date(COSTCO_TX_AT).toISOString(),
          transaction_time_precision: 'SECOND',
          merchant_raw: 'Costco',
          total: 9534,
          tax: 0,
          currency: 'JPY',
          analysis_json: JSON.stringify({
            merchant: 'Costco',
            transactionDate: '07/06/2023 11:44:46',
          }),
          deleted_at: null,
        },
      ],
    });
    expect(r.status).toBe('validation_failed');
    expect(r.restored).toBe(0);
    expect(db.receipts.size).toBe(0);
  });

  it('8 — no lifecycle: malformed cloud → local unknown → runtime second', () => {
    const cloud: CloudUserReceiptRow = {
      id: 'lifecycle-block',
      user_id: USER,
      created_at: new Date(COSTCO_TX_AT).toISOString(),
      transaction_at: new Date(COSTCO_TX_AT).toISOString(),
      transaction_time_precision: 'SECOND',
      merchant_raw: 'Costco',
      total: 9534,
      tax: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
      deleted_at: null,
    };
    expect(classifyPersistedPrecisionToken(
      cloud.transaction_time_precision,
      columnPrecisionPresenceOf(cloud)
    ).state).toBe('invalid');
    expect(() => restore(cloud)).toThrow(
      /malformed transaction_time_precision/
    );
    // Must fail before any local insert object exists.
  });

  it('9–11 — modern second/minute/date round-trip', () => {
    for (const precision of ['second', 'minute', 'date'] as const) {
      const payload = buildCloudUserReceiptUpsertPayload(
        localBackupSource({
          id: `e2e-${precision}`,
          transaction_at: COSTCO_TX_AT,
          transaction_time_precision: precision,
          merchant_raw: 'Costco',
          analysis_json: JSON.stringify({
            merchant: 'Costco',
            transaction_time_precision: precision,
            transactionDate: '07/06/2023 11:44:46',
          }),
        })
      );
      expect(payload.transaction_time_precision).toBe(precision);
      const restored = restore(cloudFromPayload(payload));
      expect(restored.transaction_time_precision).toBe(precision);
    }
  });

  it('12 — local unknown + explicit analysis unknown remains unknown', () => {
    const payload = buildCloudUserReceiptUpsertPayload(
      localBackupSource({
        id: 'e2e-unknown',
        transaction_at: COSTCO_TX_AT,
        transaction_time_precision: 'unknown',
        merchant_raw: 'Costco',
        analysis_json: JSON.stringify({
          merchant: 'Costco',
          transaction_time_precision: 'unknown',
          transactionDate: '07/06/2023 11:44:46',
        }),
      })
    );
    expect(payload.transaction_time_precision).toBe('unknown');
    expect(restore(cloudFromPayload(payload)).transaction_time_precision).toBe(
      'unknown'
    );
  });

  it('13 — Costco safe reconstruction remains second (restore + runtime)', () => {
    const payload = buildCloudUserReceiptUpsertPayload(
      localBackupSource({
        id: 'costco-rt',
        transaction_at: COSTCO_TX_AT,
        transaction_time_precision: 'unknown',
        merchant_raw: 'Costco',
        analysis_json: JSON.stringify({
          merchant: 'Costco',
          transactionDate: '07/06/2023 11:44:46',
        }),
      })
    );
    expect(payload.transaction_time_precision).toBe('second');
    const local = restore(cloudFromPayload(payload));
    expect(local.transaction_time_precision).toBe('second');
    expect(hasExactTransactionTime(asReceiptRow(local))).toBe(true);
  });

  it('14 — Gyomu remains minute / not exact across backup+restore', () => {
    const payload = buildCloudUserReceiptUpsertPayload(
      localBackupSource({
        id: 'gyomu-rt',
        transaction_at: GYOMU_TX_AT,
        transaction_time_precision: 'unknown',
        merchant_raw: '業務スーパー',
        analysis_json: JSON.stringify({
          merchant: '業務スーパー',
          transactionDate: '2026/08/10 17:43',
        }),
      })
    );
    expect(payload.transaction_time_precision).toBe('minute');
    const local = restore(cloudFromPayload(payload));
    expect(local.transaction_time_precision).toBe('minute');
    expect(hasExactTransactionTime(asReceiptRow(local))).toBe(false);
  });

  it('B2 — cloud unknown + explicit analysis second/minute/date', () => {
    for (const precision of ['second', 'minute', 'date'] as const) {
      const local = restore({
        id: `analysis-${precision}`,
        user_id: USER,
        created_at: new Date(COSTCO_TX_AT).toISOString(),
        transaction_at: new Date(COSTCO_TX_AT).toISOString(),
        transaction_time_precision: 'unknown',
        merchant_raw: 'Costco',
        total: 1,
        tax: 0,
        currency: 'JPY',
        analysis_json: JSON.stringify({
          merchant: 'Costco',
          transaction_time_precision: precision,
          transactionDate: '07/06/2023 11:44:46',
        }),
        deleted_at: null,
      });
      expect(local.transaction_time_precision).toBe(precision);
    }
  });

  it('cloud unknown + malformed analysis precision still blocks (unknown)', () => {
    const local = restore({
      id: 'analysis-malformed',
      user_id: USER,
      created_at: new Date(COSTCO_TX_AT).toISOString(),
      transaction_at: new Date(COSTCO_TX_AT).toISOString(),
      transaction_time_precision: 'unknown',
      merchant_raw: 'Costco',
      total: 1,
      tax: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transaction_time_precision: 'SECOND',
        transactionDate: '07/06/2023 11:44:46',
      }),
      deleted_at: null,
    });
    expect(local.transaction_time_precision).toBe('unknown');
    expect(hasExactTransactionTime(asReceiptRow(local))).toBe(false);
  });

  it('null/missing cloud precision + Costco evidence still reconstructs', () => {
    const withNull: CloudUserReceiptRow = {
      id: 'null-prec',
      user_id: USER,
      created_at: new Date(COSTCO_TX_AT).toISOString(),
      transaction_at: new Date(COSTCO_TX_AT).toISOString(),
      transaction_time_precision: null,
      merchant_raw: 'Costco',
      total: 9534,
      tax: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
      deleted_at: null,
    };
    expect(restore(withNull).transaction_time_precision).toBe('second');

    const absent = { ...withNull, id: 'absent-prec' };
    delete (absent as { transaction_time_precision?: string | null })
      .transaction_time_precision;
    expect(restore(absent).transaction_time_precision).toBe('second');
  });

  it('local runtime still fail-closes malformed DB token (A1)', () => {
    const row = {
      id: 'local-SECOND',
      created_at: 1,
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'SECOND',
      image_uri: '',
      merchant_raw: 'Costco',
      merchant_normalized: null,
      total: 9534,
      tax: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    } as ReceiptRow;
    expect(resolveReceiptTransactionTimePrecision(row)).toBe('unknown');
    expect(hasExactTransactionTime(row)).toBe(false);
  });

  it('restore path does not use inferReceiptTransactionTimePrecision', () => {
    const restoreSource = read('lib/cloudRestorePayload.ts');
    expect(restoreSource).not.toContain('inferReceiptTransactionTimePrecision');
    expect(restoreSource).toContain('classifyPersistedPrecisionToken');
    expect(restoreSource).toContain('resolveTransactionTimePrecisionAuthority');
  });

  it('B1 — backup row with selected precision reaches resolved payload', () => {
    // Simulates worker SELECT result: raw column present on LocalReceiptBackupSource.
    const selectedRow = localBackupSource({
      id: 'selected-second',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'second',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({ merchant: 'Costco', total: 1 }),
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        selectedRow,
        'transaction_time_precision'
      )
    ).toBe(true);
    const payload = buildCloudUserReceiptUpsertPayload(selectedRow);
    expect(payload.transaction_time_precision).toBe('second');

    const legacySelected = localBackupSource({
      id: 'selected-unknown-costco',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(
      buildCloudUserReceiptUpsertPayload(legacySelected)
        .transaction_time_precision
    ).toBe('second');
  });
});
