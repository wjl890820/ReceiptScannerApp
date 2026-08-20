/**
 * P0 Phase 4 — local ownership schema, adoption, stamping, OCR request linkage.
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
  adoptUnownedReceiptsForUser,
  shouldAutoAdoptUnownedReceipts,
} from './legacyReceiptAdoption';
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

function createAdoptionDb(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  let failUpdate = false;
  const db = {
    failNextUpdate() {
      failUpdate = true;
    },
    async withTransactionAsync(task: () => Promise<void>) {
      const snapshot = rows.map((r) => ({ ...r }));
      try {
        await task();
      } catch (e) {
        rows.splice(0, rows.length, ...snapshot);
        throw e;
      }
    },
    async getAllAsync<T>(sql: string): Promise<T[]> {
      if (/SELECT id, user_id FROM receipts/i.test(sql)) {
        return rows.map((r) => ({ id: r.id, user_id: r.user_id })) as T[];
      }
      return rows as unknown as T[];
    },
    async getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null> {
      if (/COUNT\(\*\)/.test(sql) && /user_id IS NULL OR user_id = ''/.test(sql)) {
        const c = rows.filter((r) => r.user_id == null || r.user_id === '').length;
        return { c } as T;
      }
      if (/COUNT\(\*\)/.test(sql) && /user_id = \?/.test(sql) && !/!=/.test(sql)) {
        const uid = String(params?.[0]);
        const c = rows.filter((r) => r.user_id === uid).length;
        return { c } as T;
      }
      if (/COUNT\(\*\)/.test(sql) && /user_id != \?/.test(sql)) {
        const uid = String(params?.[0]);
        const c = rows.filter(
          (r) => r.user_id != null && r.user_id !== '' && r.user_id !== uid
        ).length;
        return { c } as T;
      }
      return null;
    },
    async runAsync(sql: string, params?: unknown[]) {
      if (/UPDATE receipts/i.test(sql) && /user_id IS NULL OR user_id = ''/.test(sql)) {
        if (failUpdate) {
          failUpdate = false;
          throw new Error('forced update failure');
        }
        const uid = String(params?.[0]);
        const installationId = String(params?.[1]);
        let changes = 0;
        for (const row of rows) {
          if (row.user_id == null || row.user_id === '') {
            row.user_id = uid;
            row.installation_id = installationId;
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
  it('7/8 — NULL user adopted; repeat adopts zero', async () => {
    const db = createAdoptionDb([
      {
        id: 'a',
        user_id: null,
        installation_id: null,
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
    expect(db._rows[0].analysis_json).toBe('{"total":1}');
    expect(db._rows[0].source).toBe('self');
    expect(db._rows[0].transaction_source).toBe('receipt_ocr');

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
    // Future Apple restore target (authenticated, not anonymous)
    expect(shouldAutoAdoptUnownedReceipts({ is_anonymous: false })).toBe(false);
    expect(shouldAutoAdoptUnownedReceipts({ isAnonymous: false })).toBe(false);
    expect(shouldAutoAdoptUnownedReceipts({})).toBe(false);
    expect(shouldAutoAdoptUnownedReceipts({ is_anonymous: null })).toBe(false);
  });

  it('9/10/11 — mixed ownership: only NULL claimed; others untouched', async () => {
    const db = createAdoptionDb([
      {
        id: 'A',
        user_id: null,
        installation_id: null,
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
    expect(out.already_owned_by_current_user).toBe(1);
    expect(out.owned_by_other_user).toBe(1);
    expect(out.remaining_unowned).toBe(0);

    const byId = Object.fromEntries(db._rows.map((r) => [r.id, r]));
    expect(byId.A.user_id).toBe('user-current');
    expect(byId.A.installation_id).toBe('install-new');
    expect(byId.B.user_id).toBe('user-old');
    expect(byId.B.installation_id).toBe('old-install');
    expect(byId.B.analysis_json).toBe('{"b":2}');
    expect(byId.B.ocr_request_id).toBe('old-req');
    expect(byId.C.user_id).toBe('user-current');
    expect(byId.C.installation_id).toBe('cur-install');
  });

  it('12 — adoption failure rolls back transaction', async () => {
    const db = createAdoptionDb([
      {
        id: 'a',
        user_id: null,
        installation_id: null,
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
    // social source remains distinct
    expect(dbSource).toMatch(/params\.source \|\| 'self'/);
  });
});

describe('empty user_id treated as unowned', () => {
  it('empty string user_id is adopt-able', async () => {
    const db = createAdoptionDb([
      {
        id: 'e',
        user_id: '',
        installation_id: null,
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
  });
});
