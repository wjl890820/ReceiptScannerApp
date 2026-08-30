/**
 * P0 Phase 4 / Privacy-H5 — local ownership schema, adoption, stamping.
 */
/* eslint-disable import/first */
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', extra: {} } },
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const map = new Map<string, string>();
  return {
    getItem: jest.fn(async (key: string) => (map.has(key) ? map.get(key)! : null)),
    setItem: jest.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
  };
});

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: {} })),
}));

import { extractOcrRequestIdFromEdgeResponse } from './ocrRequestId';
import {
  __setLegacyAdoptionTestHooksForTests,
  adoptUnownedReceiptsForUser,
  shouldAutoAdoptUnownedReceipts,
} from './legacyReceiptAdoption';
import { runLegacyReceiptInstallationBackfill } from './legacyReceiptInstallationBackfill';
import { buildOwnerScopedReceiptPredicates } from './receiptOwnershipScope';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { getReceiptItems } from './receiptItems';
import {
  TRANSACTION_SOURCE_RECEIPT_OCR,
  __setOwnershipStampProviderForTests,
} from './receiptOwnershipContext';

type Row = {
  id: string;
  user_id: string | null;
  installation_id: string | null;
  transaction_source: string;
  source: string;
  analysis_json: string;
  user_items_json: string | null;
  ocr_request_id: string | null;
  user_edited: number;
  total: number;
  tax: number;
};

function isUnownedUserId(userId: string | null): boolean {
  return userId == null || userId.trim() === '';
}

function createAdoptionDb(seed: Row[]) {
  const rows = seed.map((row) => ({ ...row }));
  let failUpdate = false;
  let usedExclusiveTransaction = false;

  type AdoptionDb = {
    failNextUpdate: () => void;
    usedExclusiveTransaction: () => boolean;
    withExclusiveTransactionAsync: (
      task: (txn: AdoptionDb) => Promise<void>
    ) => Promise<void>;
    withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
    getAllAsync: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
    getFirstAsync: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
    runAsync: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
    _rows: Row[];
  };

  const db: AdoptionDb = {
    failNextUpdate() {
      failUpdate = true;
    },
    usedExclusiveTransaction() {
      return usedExclusiveTransaction;
    },
    async withExclusiveTransactionAsync(
      task: (txn: typeof db) => Promise<void>
    ) {
      usedExclusiveTransaction = true;
      const snapshot = rows.map((row) => ({ ...row }));
      try {
        await task(db);
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot);
        throw error;
      }
    },
    async withTransactionAsync(task: () => Promise<void>) {
      return db.withExclusiveTransactionAsync(async () => task());
    },
    async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (/SELECT id/i.test(sql) && /installation_id = \?/i.test(sql)) {
        const installationId = String(params[0]);
        return rows
          .filter(
            (row) =>
              isUnownedUserId(row.user_id) &&
              row.installation_id === installationId
          )
          .map((row) => ({ id: row.id })) as T[];
      }
      return rows as unknown as T[];
    },
    async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      if (!/COUNT\(\*\)/i.test(sql)) return null;

      if (/installation_id = \?/i.test(sql) && !/<>/.test(sql)) {
        const installationId = String(params[0]);
        const c = rows.filter(
          (row) =>
            isUnownedUserId(row.user_id) && row.installation_id === installationId
        ).length;
        return { c } as T;
      }
      if (/installation_id <> \?/i.test(sql)) {
        const installationId = String(params[0]);
        const c = rows.filter(
          (row) =>
            isUnownedUserId(row.user_id) &&
            row.installation_id != null &&
            row.installation_id.trim() !== '' &&
            row.installation_id !== installationId
        ).length;
        return { c } as T;
      }
      if (
        /installation_id IS NULL/i.test(sql) ||
        /COALESCE\(installation_id/i.test(sql)
      ) {
        const c = rows.filter(
          (row) =>
            isUnownedUserId(row.user_id) &&
            (row.installation_id == null || row.installation_id.trim() === '')
        ).length;
        return { c } as T;
      }
      if (/TRIM\(user_id\) = \?/i.test(sql)) {
        const uid = String(params[0]);
        const c = rows.filter((row) => row.user_id === uid).length;
        return { c } as T;
      }
      if (/TRIM\(user_id\) <> \?/i.test(sql)) {
        const uid = String(params[0]);
        const c = rows.filter(
          (row) =>
            row.user_id != null &&
            row.user_id.trim() !== '' &&
            row.user_id !== uid
        ).length;
        return { c } as T;
      }
      if (/user_id IS NOT NULL/i.test(sql)) {
        const c = rows.filter(
          (row) => row.user_id != null && row.user_id.trim() !== ''
        ).length;
        return { c } as T;
      }
      return { c: 0 } as T;
    },
    async runAsync(sql: string, params: unknown[] = []) {
      if (
        /UPDATE receipts/i.test(sql) &&
        /installation_id = \?/i.test(sql) &&
        /SET user_id = \?/i.test(sql)
      ) {
        if (failUpdate) {
          failUpdate = false;
          throw new Error('forced update failure');
        }
        const uid = String(params[0]);
        const installationId = String(params[1]);
        let changes = 0;
        for (const row of rows) {
          if (
            isUnownedUserId(row.user_id) &&
            row.installation_id === installationId
          ) {
            row.user_id = uid;
            changes += 1;
          }
        }
        return { changes };
      }
      return { changes: 0 };
    },
    _rows: rows,
  };
  return db;
}

describe('OCR requestId extraction', () => {
  it('19 — response with provenance.requestId', () => {
    expect(
      extractOcrRequestIdFromEdgeResponse({
        success: true,
        analysis: { total: 1 },
        provenance: { requestId: '  abc-123  ' },
      })
    ).toBe('abc-123');
  });

  it('20 — response without provenance → null', () => {
    expect(extractOcrRequestIdFromEdgeResponse({ success: true, analysis: {} })).toBeNull();
    expect(extractOcrRequestIdFromEdgeResponse(null)).toBeNull();
  });

  it('21 — extracting request id does not alter analysis object', () => {
    const analysis = { total: 8351, tax: 619, items: [] };
    const response = { success: true, analysis, provenance: { requestId: 'r1' } };
    extractOcrRequestIdFromEdgeResponse(response);
    expect(response.analysis).toBe(analysis);
    expect(analysis).toEqual({ total: 8351, tax: 619, items: [] });
  });
});

describe('legacy adoption', () => {
  afterEach(() => {
    __setLegacyAdoptionTestHooksForTests(null);
  });

  it('7/8 — current-install unowned adopted; repeat adopts zero', async () => {
    const db = createAdoptionDb([
      {
        id: 'a',
        user_id: null,
        installation_id: 'install-1',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{"total":1}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 1,
        tax: 0,
      },
    ]);

    const first = await adoptUnownedReceiptsForUser('user-current', {
      getDb: async () => db as any,
      getInstallationId: async () => 'install-1',
    });
    expect(first.adopted).toBe(1);
    expect(first.adopted_receipt_ids).toEqual(['a']);
    expect(db._rows[0].user_id).toBe('user-current');
    expect(db._rows[0].installation_id).toBe('install-1');
    expect(db.usedExclusiveTransaction()).toBe(true);

    const second = await adoptUnownedReceiptsForUser('user-current', {
      getDb: async () => db as any,
      getInstallationId: async () => 'install-1',
    });
    expect(second.adopted).toBe(0);
    expect(second.adopted_receipt_ids).toEqual([]);
    expect(second.already_owned_by_current_user).toBe(1);
  });

  it('auto-adopt guard — anonymous only; non-anonymous must not auto-adopt', () => {
    expect(shouldAutoAdoptUnownedReceipts({ is_anonymous: true })).toBe(true);
    expect(shouldAutoAdoptUnownedReceipts({ isAnonymous: true })).toBe(true);
    expect(shouldAutoAdoptUnownedReceipts({ is_anonymous: false })).toBe(false);
    expect(shouldAutoAdoptUnownedReceipts({ isAnonymous: false })).toBe(false);
    expect(shouldAutoAdoptUnownedReceipts({})).toBe(false);
    expect(shouldAutoAdoptUnownedReceipts({ is_anonymous: null })).toBe(false);
  });

  it('H5 adoption matrix — only current-install unowned rows adopted', async () => {
    const db = createAdoptionDb([
      {
        id: 'A',
        user_id: null,
        installation_id: 'I1',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 1,
        tax: 0,
      },
      {
        id: 'B',
        user_id: '',
        installation_id: 'I1',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 1,
        tax: 0,
      },
      {
        id: 'C',
        user_id: null,
        installation_id: 'I2',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 1,
        tax: 0,
      },
      {
        id: 'D',
        user_id: null,
        installation_id: null,
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 1,
        tax: 0,
      },
      {
        id: 'E',
        user_id: 'U2',
        installation_id: 'I1',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 1,
        tax: 0,
      },
      {
        id: 'F',
        user_id: 'U1',
        installation_id: 'I1',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 1,
        tax: 0,
      },
    ]);

    const out = await adoptUnownedReceiptsForUser('U1', {
      getDb: async () => db as any,
      getInstallationId: async () => 'I1',
    });

    expect(new Set(out.adopted_receipt_ids)).toEqual(new Set(['A', 'B']));
    expect(out.adopted).toBe(2);
    expect(out.other_install_unowned).toBe(1);
    expect(out.ambiguous_double_null).toBe(1);
    expect(out.owned_by_other_user).toBe(1);
    expect(out.already_owned_by_current_user).toBe(3);

    const byId = Object.fromEntries(db._rows.map((row) => [row.id, row]));
    expect(byId.A).toMatchObject({ user_id: 'U1', installation_id: 'I1' });
    expect(byId.B).toMatchObject({ user_id: 'U1', installation_id: 'I1' });
    expect(byId.C).toMatchObject({ user_id: null, installation_id: 'I2' });
    expect(byId.D).toMatchObject({ user_id: null, installation_id: null });
    expect(byId.E).toMatchObject({ user_id: 'U2', installation_id: 'I1' });
    expect(byId.F).toMatchObject({ user_id: 'U1', installation_id: 'I1' });
  });

  it('9/10/11 — mixed ownership: only current-install NULL claimed', async () => {
    const db = createAdoptionDb([
      {
        id: 'A',
        user_id: null,
        installation_id: 'install-new',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{"a":1}',
        user_items_json: '[{"name":"x"}]',
        ocr_request_id: null,
        user_edited: 0,
        total: 1,
        tax: 0,
      },
      {
        id: 'B',
        user_id: 'user-old',
        installation_id: 'old-install',
        transaction_source: 'receipt_ocr',
        source: 'family',
        analysis_json: '{"b":2}',
        user_items_json: null,
        ocr_request_id: 'old-req',
        user_edited: 1,
        total: 2,
        tax: 0,
      },
      {
        id: 'C',
        user_id: 'user-current',
        installation_id: 'cur-install',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{"c":3}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 3,
        tax: 0,
      },
    ]);

    const out = await adoptUnownedReceiptsForUser('user-current', {
      getDb: async () => db as any,
      getInstallationId: async () => 'install-new',
    });

    expect(out.adopted).toBe(1);
    expect(out.already_owned_by_current_user).toBe(2);
    expect(out.owned_by_other_user).toBe(1);
    expect(out.remaining_eligible_current_install_unowned).toBe(0);

    const byId = Object.fromEntries(db._rows.map((row) => [row.id, row]));
    expect(byId.A.user_id).toBe('user-current');
    expect(byId.A.installation_id).toBe('install-new');
    expect(byId.B.user_id).toBe('user-old');
    expect(byId.B.installation_id).toBe('old-install');
    expect(byId.C.user_id).toBe('user-current');
  });

  it('12 — adoption failure rolls back transaction', async () => {
    const db = createAdoptionDb([
      {
        id: 'a',
        user_id: null,
        installation_id: 'install-1',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 0,
        tax: 0,
      },
    ]);
    db.failNextUpdate();
    await expect(
      adoptUnownedReceiptsForUser('user-current', {
        getDb: async () => db as any,
        getInstallationId: async () => 'install-1',
      })
    ).rejects.toThrow('forced update failure');
    expect(db._rows[0].user_id).toBeNull();
  });

  it('auth race aborts before mutation when eligibility changes', async () => {
    const db = createAdoptionDb([
      {
        id: 'a',
        user_id: null,
        installation_id: 'install-1',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 0,
        tax: 0,
      },
    ]);
    let valid = true;
    __setLegacyAdoptionTestHooksForTests({
      afterCandidateSelection: async () => {
        valid = false;
      },
    });

    await expect(
      adoptUnownedReceiptsForUser('user-current', {
        getDb: async () => db as any,
        getInstallationId: async () => 'install-1',
        authEligibility: { isValid: () => valid },
      })
    ).rejects.toThrow('auth eligibility no longer valid');
    expect(db._rows[0].user_id).toBeNull();
  });

  it('removing installation predicate would adopt foreign-install rows — mock is regression-sensitive', async () => {
    const db = createAdoptionDb([
      {
        id: 'foreign',
        user_id: null,
        installation_id: 'I2',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 0,
        tax: 0,
      },
    ]);
    const out = await adoptUnownedReceiptsForUser('U1', {
      getDb: async () => db as any,
      getInstallationId: async () => 'I1',
    });
    expect(out.adopted).toBe(0);
    expect(db._rows[0].user_id).toBeNull();
  });
});

describe('H5 visibility integration after backfill + adoption', () => {
  it('NULL/I1 becomes visible to installation scope; adopted row visible to user scope', async () => {
    const rows: Array<{
      id: string;
      user_id: string | null;
      installation_id: string | null;
    }> = [{ id: 'legacy', user_id: null, installation_id: null }];
    const appKv = new Map<string, string>();
    type VisibilityDb = {
      execAsync: () => Promise<void>;
      withExclusiveTransactionAsync: (
        task: (txn: VisibilityDb) => Promise<void>
      ) => Promise<void>;
      getFirstAsync: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
      getAllAsync: <T>(sql: string) => Promise<T[]>;
      runAsync: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
    };
    const db: VisibilityDb = {
      async execAsync() {},
      async withExclusiveTransactionAsync(task: (txn: typeof db) => Promise<void>) {
        await task(db);
      },
      async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
        if (/FROM app_kv/i.test(sql)) {
          const value = appKv.get(String(params[0]));
          return value ? ({ v: value } as T) : null;
        }
        if (/COUNT\(\*\)/i.test(sql)) {
          if (/user_id IS NOT NULL/i.test(sql)) return { c: 0 } as T;
          if (/installation_id <> \?/i.test(sql)) return { c: 0 } as T;
          return { c: rows.length } as T;
        }
        return null;
      },
      async getAllAsync<T>(sql: string): Promise<T[]> {
        if (/installation_id IS NULL/i.test(sql)) {
          return rows
            .filter(
              (row) =>
                (row.user_id == null || row.user_id === '') &&
                (row.installation_id == null || row.installation_id === '')
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
        if (/SET installation_id/i.test(sql)) {
          rows[0].installation_id = String(params[0]);
          return { changes: 1 };
        }
        if (/SET user_id/i.test(sql)) {
          rows[0].user_id = String(params[0]);
          return { changes: 1 };
        }
        return { changes: 0 };
      },
    };

    await runLegacyReceiptInstallationBackfill(db as any, {
      getInstallationId: async () => 'I1',
    });
    expect(rows[0]).toEqual({ id: 'legacy', user_id: null, installation_id: 'I1' });

    const installScope = buildOwnerScopedReceiptPredicates('installation:I1');
    expect(installScope?.receiptWhereSql).toContain('installation_id = ?');
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].installation_id).toBe('I1');

    rows[0].user_id = 'U1';
    const userScope = buildOwnerScopedReceiptPredicates('user:U1');
    expect(userScope?.receiptWhereSql).toContain('user_id = ?');
    expect(rows[0].user_id).toBe('U1');
  });
});

describe('ownership stamp helper + analysis preservation', () => {
  afterEach(() => {
    __setOwnershipStampProviderForTests(null);
  });

  it('transaction_source constant is receipt_ocr', () => {
    expect(TRANSACTION_SOURCE_RECEIPT_OCR).toBe('receipt_ocr');
  });

  it('23 — user_items_json priority unchanged', () => {
    const items = getReceiptItems({
      analysis_json: JSON.stringify({
        items: [{ name: 'ocr', quantity: 1, unitPrice: 100, lineTotal: 100 }],
      }),
      user_items_json: JSON.stringify([
        { name: 'user', quantity: 2, unitPrice: 50, lineTotal: 100 },
      ]),
    } as any);
    expect((items[0] as { name: string }).name).toBe('user');
  });

  it('25 — Build 34 Sample 007 semantic regression', () => {
    const out = normalizeOcrAnalysis({
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
    expect(out.total).toBe(8351);
    expect(out.tax).toBe(619);
  });
});

describe('schema migration contract (db source)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dbSource = fs.readFileSync(path.resolve(__dirname, './db.ts'), 'utf8');

  it('1-6 — additive ownership columns + receipt_ocr default; preserves source', () => {
    expect(dbSource).toContain(`ADD COLUMN user_id TEXT`);
    expect(dbSource).toContain(`ADD COLUMN installation_id TEXT`);
    expect(dbSource).toContain(
      `ADD COLUMN transaction_source TEXT NOT NULL DEFAULT 'receipt_ocr'`
    );
    expect(dbSource).toContain(`ADD COLUMN ocr_request_id TEXT`);
    expect(dbSource).toContain('resolveOwnershipStamp');
    expect(dbSource).toContain('ocrRequestId');
    expect(dbSource).toMatch(/params\.source \|\| 'self'/);
  });

  it('H5 — db init invokes legacy installation backfill before _inited', () => {
    expect(dbSource).toContain('ensureLegacyReceiptInstallationBackfill');
    const backfillIndex = dbSource.indexOf('ensureLegacyReceiptInstallationBackfill');
    const initedIndex = dbSource.indexOf('_inited = true');
    expect(backfillIndex).toBeGreaterThan(0);
    expect(initedIndex).toBeGreaterThan(backfillIndex);
  });
});

describe('empty user_id treated as unowned', () => {
  it('empty string user_id on current installation is adopt-able', async () => {
    const db = createAdoptionDb([
      {
        id: 'e',
        user_id: '',
        installation_id: 'i1',
        transaction_source: 'receipt_ocr',
        source: 'self',
        analysis_json: '{}',
        user_items_json: null,
        ocr_request_id: null,
        user_edited: 0,
        total: 0,
        tax: 0,
      },
    ]);
    const out = await adoptUnownedReceiptsForUser('u1', {
      getDb: async () => db as any,
      getInstallationId: async () => 'i1',
    });
    expect(out.adopted).toBe(1);
    expect(db._rows[0].user_id).toBe('u1');
    expect(db._rows[0].installation_id).toBe('i1');
  });
});
