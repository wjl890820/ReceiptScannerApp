/**
 * H3-B3 — new receipts persist merchant_scope_generation=2 in the creating INSERT.
 * Edits and cloud restore must not migrate NULL to 2.
 */
/* eslint-disable import/first */
import fs from 'fs';
import path from 'path';

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('nanoid/non-secure', () => {
  let nextId = 1;
  return { nanoid: jest.fn(() => `scope-${nextId++}`) };
});

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
}));

jest.mock('./receiptItemIndex', () => {
  const actual = jest.requireActual('./receiptItemIndex');
  return {
    ...actual,
    ensureReceiptItemsSchema: jest.fn(async () => undefined),
    rebuildReceiptItemIndex: jest.fn(),
    deleteReceiptItemIndex: jest.fn(),
    clearReceiptItemIndex: jest.fn(),
  };
});

const ownershipMock = {
  userId: 'scope-user' as string | null,
  installationId: 'install-scope' as string | null,
};

jest.mock('./receiptOwnershipContext', () => ({
  TRANSACTION_SOURCE_RECEIPT_OCR: 'receipt_ocr',
  resolveOwnershipStamp: jest.fn(async () => ({
    userId: ownershipMock.userId,
    installationId: ownershipMock.installationId,
    transactionSource: 'receipt_ocr',
  })),
}));

jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({
    status: 'authenticated',
    userId: ownershipMock.userId,
    isAnonymous: true,
    hasAppleIdentity: false,
    accessToken: 't',
    error: null,
  })),
  ensureAnonAuth: jest.fn(async () => ({
    status: 'authenticated',
    userId: ownershipMock.userId,
    isAnonymous: true,
    hasAppleIdentity: false,
    accessToken: 't',
    error: null,
  })),
  subscribeAuthState: jest.fn(() => () => undefined),
}));

jest.mock('./env', () => ({
  isAnonAuthEnabled: () => true,
}));

jest.mock('./ownershipAdoptionOrchestrator', () => ({
  ensureOwnershipAdoptionSettledForOwnerRead: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: ownershipMock.userId,
  })),
  settleOwnershipAdoptionForCurrentAuth: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: ownershipMock.userId,
  })),
  startOwnershipAdoptionOrchestrator: jest.fn(),
}));

jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(async () => ({
    ran: false,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  })),
}));

import { getReceipt, saveReceipt, updateReceipt } from './db';
import { mapCloudReceiptToLocalInsert } from './cloudRestorePayload';
import { MERCHANT_SCOPE_GENERATION_V2 } from './merchantScopeGeneration';

type MutableRow = Record<string, unknown>;

function rowMatchesOwnerPredicate(
  row: MutableRow,
  sql: string,
  params: unknown[]
): boolean {
  if (/receipts\.user_id = \?/i.test(sql) && !/IS NULL/i.test(sql)) {
    return row.user_id === params[0];
  }
  if (/receipts\.user_id IS NULL AND receipts\.installation_id = \?/i.test(sql)) {
    return (
      (row.user_id == null || row.user_id === '') &&
      row.installation_id === params[0]
    );
  }
  return true;
}

class MemoryDb {
  rows = new Map<string, MutableRow>();
  statements: { sql: string; inTransaction: boolean }[] = [];
  inTransaction = false;
  failNextOutbox = false;

  async execAsync(): Promise<void> {}
  async closeAsync(): Promise<void> {}

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const snapshot = new Map(this.rows);
    this.inTransaction = true;
    try {
      await task();
    } catch (error) {
      this.rows = snapshot;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async withExclusiveTransactionAsync(
    task: (txn: MemoryDb) => Promise<void>
  ): Promise<void> {
    await this.withTransactionAsync(() => task(this));
  }

  async getAllAsync<T>(source: string): Promise<T[]> {
    if (/PRAGMA table_info/i.test(source)) {
      return [
        'id',
        'merchant_scope_generation',
        'client_updated_at',
        'user_id',
        'installation_id',
      ].map((name) => ({ name, type: 'TEXT' })) as T[];
    }
    return [];
  }

  async getFirstAsync<T>(source: string, params?: unknown[]): Promise<T | null> {
    const values = Array.isArray(params) ? params : [];
    if (/FROM receipts/i.test(source)) {
      const [id, ownerParam] = values;
      const row = this.rows.get(String(id));
      if (!row) return null;
      if (values.length > 1 && /WHERE/i.test(source)) {
        return (
          rowMatchesOwnerPredicate(row, source, [ownerParam]) ? { ...row } : null
        ) as T | null;
      }
      return { ...row } as T | null;
    }
    return null;
  }

  async runAsync(source: string, params?: unknown[]) {
    this.statements.push({ sql: source, inTransaction: this.inTransaction });
    const values = Array.isArray(params) ? params : [];
    if (this.failNextOutbox && /sync_outbox/i.test(source)) {
      this.failNextOutbox = false;
      throw new Error('outbox failed');
    }
    if (/INSERT INTO receipts/i.test(source)) {
      const [
        id,
        createdAt,
        transactionAt,
        ,
        scannedAt,
        imageUri,
        receiptSource,
        merchantRaw,
        merchantNormalized,
        merchantType,
        ,
        ,
        total,
        tax,
        taxIsKnown,
        currency,
        analysisJson,
        recognitionSnapshotJson,
        userId,
        installationId,
        transactionSource,
        ocrRequestId,
        clientUpdatedAt,
        merchantScopeGeneration,
      ] = values;
      this.rows.set(String(id), {
        id: String(id),
        created_at: Number(createdAt),
        transaction_at: transactionAt == null ? null : Number(transactionAt),
        transaction_time_precision: 'unknown',
        scanned_at: Number(scannedAt),
        image_uri: String(imageUri),
        source: receiptSource == null ? null : String(receiptSource),
        merchant_raw: merchantRaw == null ? null : String(merchantRaw),
        merchant_normalized:
          merchantNormalized == null ? null : String(merchantNormalized),
        merchant_type: merchantType == null ? null : String(merchantType),
        total: Number(total),
        tax: tax == null ? null : Number(tax),
        tax_is_known: Number(taxIsKnown ?? 0),
        currency: String(currency),
        analysis_json: String(analysisJson),
        recognition_snapshot_json:
          recognitionSnapshotJson == null
            ? null
            : String(recognitionSnapshotJson),
        user_edited: 0,
        final_total: null,
        final_category: null,
        note: null,
        user_items_json: null,
        user_id: userId == null ? null : String(userId),
        installation_id: installationId == null ? null : String(installationId),
        transaction_source: String(transactionSource ?? 'receipt_ocr'),
        ocr_request_id: ocrRequestId == null ? null : String(ocrRequestId),
        client_updated_at:
          clientUpdatedAt == null ? Number(createdAt) : Number(clientUpdatedAt),
        merchant_scope_generation: merchantScopeGeneration,
      });
      return { changes: 1 };
    }
    if (/UPDATE receipts/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const idFromTail = String(values[values.length - 2] ?? values[0]);
      const id = this.rows.has(idFromTail)
        ? idFromTail
        : String(values.find((value) => this.rows.has(String(value))) ?? '');
      const row = this.rows.get(id);
      if (!row) return { changes: 0 };
      if (
        values.length > 1 &&
        /user_id = \?/i.test(source) &&
        !rowMatchesOwnerPredicate(row, source, [ownerParam])
      ) {
        return { changes: 0 };
      }
      const setClause =
        source.match(/SET\s+([\s\S]*?)\s+WHERE\s+id\s*=\s*\?/i)?.[1] ?? '';
      let valueIndex = 0;
      for (const assignment of setClause.split(',')) {
        const bindMatch = assignment.trim().match(/^(\w+)\s*=\s*\?$/);
        if (bindMatch) {
          row[bindMatch[1]] = values[valueIndex++];
        }
      }
      return { changes: 1 };
    }
    return { changes: 1 };
  }
}

const mockDatabase = new MemoryDb();

function saveBody(): string {
  const db = fs.readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
  const start = db.indexOf('export async function saveReceipt');
  const end = db.indexOf('export async function updateReceipt');
  return db.slice(start, end);
}

function updateBodies(): string {
  const db = fs.readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
  return db.slice(db.indexOf('export async function updateReceipt'));
}

describe('H3-B3 new receipt merchant scope activation', () => {
  beforeEach(() => {
    mockDatabase.rows.clear();
    mockDatabase.statements = [];
    mockDatabase.failNextOutbox = false;
    ownershipMock.userId = 'scope-user';
  });

  it('writes generation 2 in the initial INSERT inside the outbox transaction', async () => {
    expect(MERCHANT_SCOPE_GENERATION_V2).toBe(2);
    const id = await saveReceipt({
      imageUri: 'file://new.jpg',
      note: 'hello',
      recognitionSnapshot: { merchant: 'イオン古川店' },
      analysis: {
        merchant: 'イオン古川店',
        total: 100,
        tax: 0,
        currency: 'JPY',
        items: [{ name: '牛乳' }],
      },
    });
    const row = mockDatabase.rows.get(id)!;
    expect(row.merchant_scope_generation).toBe(2);
    const insert = mockDatabase.statements.find((statement) =>
      /INSERT INTO receipts/i.test(statement.sql)
    )!;
    expect(insert.inTransaction).toBe(true);
    expect(insert.sql).toContain('merchant_scope_generation');
    expect(insert.sql).not.toMatch(/merchant_scope_generation\s*=/);
    const outbox = mockDatabase.statements.find((statement) =>
      /sync_outbox/i.test(statement.sql)
    )!;
    expect(outbox.inTransaction).toBe(true);
    expect(
      mockDatabase.statements.some((statement) =>
        /UPDATE receipts[\s\S]*merchant_scope_generation/i.test(statement.sql)
      )
    ).toBe(false);
    expect(JSON.parse(String(row.analysis_json))).not.toHaveProperty(
      'merchant_scope_generation'
    );
    expect(JSON.parse(String(row.recognition_snapshot_json))).not.toHaveProperty(
      'merchant_scope_generation'
    );
    const saved = await getReceipt(id);
    expect(saved?.merchant_scope_generation).toBe(2);
  });

  it('rolls the new receipt back when outbox creation fails', async () => {
    mockDatabase.failNextOutbox = true;
    await expect(
      saveReceipt({
        imageUri: 'file://fail.jpg',
        analysis: { total: 1, tax: 0, currency: 'JPY', items: [] },
      })
    ).rejects.toThrow(/outbox failed/);
    expect(mockDatabase.rows.size).toBe(0);
  });

  it('leaves a legacy NULL row and a v2 row unchanged after edits', async () => {
    mockDatabase.rows.set('legacy-row', {
      id: 'legacy-row',
      user_id: 'scope-user',
      installation_id: 'install-scope',
      merchant_raw: 'イオン',
      merchant_normalized: 'イオン',
      merchant_type: 'supermarket',
      merchant_scope_generation: null,
      analysis_json: JSON.stringify({
        merchant: 'イオン',
        total: 10,
        tax: 0,
        currency: 'JPY',
        items: [],
      }),
      note: null,
      user_edited: 0,
    });
    mockDatabase.rows.set('v2-row', {
      id: 'v2-row',
      user_id: 'scope-user',
      installation_id: 'install-scope',
      merchant_raw: 'ヨークベニマル古川南店',
      merchant_normalized: 'ヨークベニマル古川南店',
      merchant_type: 'supermarket',
      merchant_scope_generation: 2,
      analysis_json: '{}',
      note: null,
      user_edited: 0,
    });

    await updateReceipt({ id: 'legacy-row', note: 'edited note' });
    await updateReceipt({
      id: 'legacy-row',
      analysis: {
        merchant: 'イオン古川店',
        total: 20,
        tax: 0,
        currency: 'JPY',
        items: [{ name: '牛乳', lineTotal: 20 }],
      },
    });
    await updateReceipt({ id: 'v2-row', note: 'still v2' });
    await updateReceipt({
      id: 'v2-row',
      analysis: {
        merchant: 'ヨークベニマル中新田店',
        total: 30,
        tax: 0,
        currency: 'JPY',
        items: [{ name: '卵', lineTotal: 30 }],
      },
    });

    expect(mockDatabase.rows.get('legacy-row')!.merchant_scope_generation).toBe(
      null
    );
    expect(mockDatabase.rows.get('v2-row')!.merchant_scope_generation).toBe(2);
    expect(mockDatabase.rows.get('legacy-row')!.note).toBe('edited note');
    expect(mockDatabase.rows.get('v2-row')!.note).toBe('still v2');
  });

  it('keeps cloud restore from promoting legacy receipts to v2', () => {
    const params = {
      expectedUserId: 'scope-user',
      currentInstallationId: 'install-scope',
    };
    const base = {
      user_id: 'scope-user',
      created_at: '2024-01-01T00:00:00.000Z',
      total: 1,
      tax: 0,
      currency: 'JPY',
      analysis_json: '{}',
    };
    const absent = mapCloudReceiptToLocalInsert(
      { ...base, id: 'cloud-absent' },
      params
    );
    const nulled = mapCloudReceiptToLocalInsert(
      { ...base, id: 'cloud-null', merchant_scope_generation: null },
      params
    );
    const future = mapCloudReceiptToLocalInsert(
      { ...base, id: 'cloud-v2', merchant_scope_generation: 2 },
      params
    );
    expect(absent.merchant_scope_generation).toBeNull();
    expect(nulled.merchant_scope_generation).toBeNull();
    expect(future.merchant_scope_generation).toBe(2);
  });

  it('guards creation, edits, backfill, and schema', () => {
    const db = fs.readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
    const save = saveBody();
    const updates = updateBodies();
    const insertStart = save.indexOf('const insertSql');
    const paramsStart = save.indexOf('const insertParams', insertStart);
    const insertSql = save.slice(insertStart, paramsStart);
    expect(insertSql).toContain('merchant_scope_generation');
    expect(save.slice(paramsStart, save.indexOf('const placeholderCount'))).toContain(
      'MERCHANT_SCOPE_GENERATION_V2'
    );
    expect(save).toContain('withTransactionAsync');
    expect(save).toContain('replaceSyncOutboxIntent');
    expect(save).not.toMatch(/merchant_scope_generation\s*=/);
    expect(updates).not.toContain('merchant_scope_generation');
    expect(db).not.toMatch(
      /UPDATE receipts[\s\S]{0,200}merchant_scope_generation/
    );
    expect(db).not.toMatch(/merchant_scope_generation[^;\n]*DEFAULT/);
    const migration = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/011_merchant_scope_generation.sql'),
      'utf8'
    );
    expect(migration).not.toMatch(/DEFAULT\s+2/);
    expect(migration).not.toMatch(/UPDATE public\.user_receipts/i);
  });
});
