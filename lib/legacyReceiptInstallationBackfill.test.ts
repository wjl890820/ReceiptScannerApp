/**
 * Privacy-H5 — legacy installation backfill tests.
 */
import {
  LEGACY_RECEIPT_INSTALLATION_BACKFILL_V1_KEY,
  assessLegacyInstallationBackfillSafety,
  listDoubleNullReceiptIds,
  runLegacyReceiptInstallationBackfill,
} from './legacyReceiptInstallationBackfill';

type Row = {
  id: string;
  user_id: string | null;
  installation_id: string | null;
};

function createBackfillDb(seed: Row[]) {
  const rows = seed.map((row) => ({ ...row }));
  const appKv = new Map<string, string>();

  type BackfillDb = {
    execAsync: () => Promise<void>;
    withExclusiveTransactionAsync: (
      task: (txn: BackfillDb) => Promise<void>
    ) => Promise<void>;
    getFirstAsync: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
    getAllAsync: <T>(sql: string) => Promise<T[]>;
    runAsync: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
    _rows: Row[];
    _appKv: Map<string, string>;
  };

  const db: BackfillDb = {
    async execAsync() {},
    async withExclusiveTransactionAsync(task: (txn: typeof db) => Promise<void>) {
      const snapshot = rows.map((row) => ({ ...row }));
      const kvSnapshot = new Map(appKv);
      try {
        await task(db);
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot);
        appKv.clear();
        for (const [key, value] of kvSnapshot) {
          appKv.set(key, value);
        }
        throw error;
      }
    },
    async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      if (/FROM app_kv/i.test(sql)) {
        const key = String(params[0]);
        const value = appKv.get(key);
        return value ? ({ v: value } as T) : null;
      }
      if (/COUNT\(\*\)/i.test(sql) && /FROM receipts/i.test(sql)) {
        if (/user_id IS NOT NULL/i.test(sql)) {
          const c = rows.filter(
            (row) => row.user_id != null && String(row.user_id).trim() !== ''
          ).length;
          return { c } as T;
        }
        if (/installation_id <> \?/i.test(sql)) {
          const current = String(params[0]);
          const c = rows.filter(
            (row) =>
              row.installation_id != null &&
              String(row.installation_id).trim() !== '' &&
              row.installation_id !== current
          ).length;
          return { c } as T;
        }
        return { c: rows.length } as T;
      }
      return null;
    },
    async getAllAsync<T>(sql: string): Promise<T[]> {
      if (/SELECT id/i.test(sql) && /installation_id IS NULL/i.test(sql)) {
        return rows
          .filter(
            (row) =>
              (row.user_id == null || String(row.user_id).trim() === '') &&
              (row.installation_id == null ||
                String(row.installation_id).trim() === '')
          )
          .map((row) => ({ id: row.id })) as T[];
      }
      return [] as T[];
    },
    async runAsync(sql: string, params: unknown[] = []) {
      if (/INSERT OR REPLACE INTO app_kv/i.test(sql)) {
        appKv.set(String(params[0]), String(params[1]));
        return { changes: 1 };
      }
      if (/UPDATE receipts/i.test(sql) && /SET installation_id/i.test(sql)) {
        const installationId = String(params[0]);
        const ids = params.slice(1) as string[];
        let changes = 0;
        for (const row of rows) {
          if (!ids.includes(row.id)) continue;
          if (
            (row.user_id == null || String(row.user_id).trim() === '') &&
            (row.installation_id == null ||
              String(row.installation_id).trim() === '')
          ) {
            row.installation_id = installationId;
            changes += 1;
          }
        }
        return { changes };
      }
      return { changes: 0 };
    },
    _rows: rows,
    _appKv: appKv,
  };

  return db;
}

describe('legacyReceiptInstallationBackfill', () => {
  it('pure legacy DB backfills double-null rows to current installation', async () => {
    const db = createBackfillDb([
      { id: 'A', user_id: null, installation_id: null },
      { id: 'B', user_id: '', installation_id: null },
    ]);

    const first = await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => 'I1',
    });

    expect(first).toEqual({ outcome: 'backfilled', backfilledCount: 2 });
    expect(db._rows).toEqual([
      { id: 'A', user_id: null, installation_id: 'I1' },
      { id: 'B', user_id: '', installation_id: 'I1' },
    ]);
    expect(db._appKv.get(LEGACY_RECEIPT_INSTALLATION_BACKFILL_V1_KEY)).toContain(
      '"outcome":"backfilled"'
    );

    const second = await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => 'I1',
    });
    expect(second.outcome).toBe('already_completed');
    expect(second.backfilledCount).toBe(2);
  });

  it('mixed same-install DB backfills only double-null rows', async () => {
    const db = createBackfillDb([
      { id: 'A', user_id: null, installation_id: null },
      { id: 'B', user_id: null, installation_id: 'I1' },
    ]);

    const result = await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => 'I1',
    });

    expect(result).toEqual({ outcome: 'backfilled', backfilledCount: 1 });
    expect(db._rows[0]).toEqual({
      id: 'A',
      user_id: null,
      installation_id: 'I1',
    });
    expect(db._rows[1]).toEqual({
      id: 'B',
      user_id: null,
      installation_id: 'I1',
    });
  });

  it('other-install conflict quarantines without mutating rows', async () => {
    const db = createBackfillDb([
      { id: 'A', user_id: null, installation_id: null },
      { id: 'B', user_id: null, installation_id: 'I2' },
    ]);

    const result = await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => 'I1',
    });

    expect(result).toEqual({ outcome: 'quarantined_conflict', backfilledCount: 0 });
    expect(db._rows).toEqual([
      { id: 'A', user_id: null, installation_id: null },
      { id: 'B', user_id: null, installation_id: 'I2' },
    ]);
    expect(db._appKv.get(LEGACY_RECEIPT_INSTALLATION_BACKFILL_V1_KEY)).toContain(
      '"outcome":"quarantined_conflict"'
    );

    const retry = await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => 'I1',
    });
    expect(retry.outcome).toBe('already_completed');
    expect(db._rows[0].installation_id).toBeNull();
  });

  it('existing user ownership quarantines ambiguous double-null rows', async () => {
    const db = createBackfillDb([
      { id: 'A', user_id: null, installation_id: null },
      { id: 'B', user_id: 'U1', installation_id: 'I1' },
    ]);

    const result = await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => 'I1',
    });

    expect(result.outcome).toBe('quarantined_conflict');
    expect(db._rows[0].installation_id).toBeNull();
  });

  it('empty database marks nothing_to_do', async () => {
    const db = createBackfillDb([]);
    const result = await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => 'I1',
    });
    expect(result).toEqual({ outcome: 'nothing_to_do', backfilledCount: 0 });
  });

  it('installation unavailable fails closed without marker', async () => {
    const db = createBackfillDb([
      { id: 'A', user_id: null, installation_id: null },
    ]);
    const result = await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => '',
    });
    expect(result).toEqual({
      outcome: 'installation_unavailable',
      backfilledCount: 0,
    });
    expect(db._appKv.size).toBe(0);
    expect(db._rows[0].installation_id).toBeNull();
  });

  it('assess safety and list helpers match SQL semantics', async () => {
    const db = createBackfillDb([
      { id: 'A', user_id: null, installation_id: null },
      { id: 'B', user_id: null, installation_id: 'I1' },
    ]);
    expect(await assessLegacyInstallationBackfillSafety(db as any, 'I1')).toBe(
      'safe'
    );
    expect(await listDoubleNullReceiptIds(db as any)).toEqual(['A']);
  });
});
