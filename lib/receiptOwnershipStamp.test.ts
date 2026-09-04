/**
 * P0 Phase 4 — saveReceipt ownership stamping + edit preservation (memory SQLite mock).
 */
/* eslint-disable import/first */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('nanoid/non-secure', () => {
  let nextId = 1;
  return {
    nanoid: jest.fn(() => `own-${nextId++}`),
  };
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
  userId: null as string | null,
  installationId: 'install-stamp' as string | null,
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
    status: ownershipMock.userId ? 'authenticated' : 'unavailable',
    userId: ownershipMock.userId,
    isAnonymous: ownershipMock.userId ? true : null,
    hasAppleIdentity: false,
    accessToken: ownershipMock.userId ? 't' : null,
    error: null,
  })),
  ensureAnonAuth: jest.fn(async () => ({
    status: ownershipMock.userId ? 'authenticated' : 'unavailable',
    userId: ownershipMock.userId,
    isAnonymous: ownershipMock.userId ? true : null,
    hasAppleIdentity: false,
    accessToken: ownershipMock.userId ? 't' : null,
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
    userId: ownershipMock.userId ?? 'user-stamp',
  })),
  settleOwnershipAdoptionForCurrentAuth: jest.fn(async () => ({
    status: 'settled',
    reason: 'noop',
    userId: ownershipMock.userId ?? 'user-stamp',
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
  columns = new Set([
    'id',
    'created_at',
    'transaction_at',
    'scanned_at',
    'image_uri',
    'source',
    'merchant_raw',
    'merchant_normalized',
    'merchant_type',
    'store_raw',
    'store_normalized',
    'total',
    'tax',
    'tax_is_known',
    'currency',
    'analysis_json',
    'recognition_snapshot_json',
    'user_edited',
    'final_total',
    'final_category',
    'note',
    'user_items_json',
    'user_id',
    'installation_id',
    'transaction_source',
    'ocr_request_id',
    'client_updated_at',
  ]);

  async execAsync(): Promise<void> {}
  async closeAsync(): Promise<void> {}
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    await task();
  }
  async withExclusiveTransactionAsync(
    task: (txn: MemoryDb) => Promise<void>
  ): Promise<void> {
    await task(this);
  }
  async getAllAsync<T>(source: string, params?: unknown[]): Promise<T[]> {
    const values = Array.isArray(params) ? params : [];
    if (/PRAGMA table_info/i.test(source)) {
      return [...this.columns].map((name) => ({ name, type: 'TEXT' })) as T[];
    }
    if (/SELECT id, user_id FROM receipts WHERE id IN/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const ids = values.slice(0, values.length - 1).map(String);
      return [...this.rows.values()]
        .filter(
          (row) =>
            ids.includes(String(row.id)) &&
            rowMatchesOwnerPredicate(row, source, [ownerParam])
        )
        .map((row) => ({ id: row.id, user_id: row.user_id ?? null })) as T[];
    }
    return [];
  }
  async getFirstAsync<T>(source: string, params?: unknown[]): Promise<T | null> {
    const values = Array.isArray(params) ? params : [];
    if (/SELECT user_id FROM receipts/i.test(source)) {
      const [id, ownerParam] = values;
      const row = this.rows.get(String(id));
      if (!row) return null;
      return (
        rowMatchesOwnerPredicate(row, source, [ownerParam])
          ? { user_id: row.user_id ?? null }
          : null
      ) as T | null;
    }
    if (/FROM receipts/i.test(source)) {
      const [id, ownerParam] = values;
      const row = this.rows.get(String(id));
      if (!row) return null;
      if (values.length > 1 && /WHERE/i.test(source)) {
        return (
          rowMatchesOwnerPredicate(row, source, [ownerParam]) ? { ...row } : null
        ) as T | null;
      }
      return (row ? { ...row } : null) as T | null;
    }
    return null;
  }
  async runAsync(source: string, params?: unknown[]) {
    const values = Array.isArray(params) ? params : [];
    if (/INSERT INTO receipts/i.test(source)) {
      const [
        id,
        createdAt,
        transactionAt,
        scannedAt,
        imageUri,
        receiptSource,
        merchantRaw,
        merchantNormalized,
        merchantType,
        storeRaw,
        storeNormalized,
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
      ] = values;
      this.rows.set(String(id), {
        id: String(id),
        created_at: Number(createdAt),
        transaction_at: transactionAt == null ? null : Number(transactionAt),
        scanned_at: Number(scannedAt),
        image_uri: String(imageUri),
        source: receiptSource == null ? null : String(receiptSource),
        merchant_raw: merchantRaw == null ? null : String(merchantRaw),
        merchant_normalized: merchantNormalized == null ? null : String(merchantNormalized),
        merchant_type: merchantType == null ? null : String(merchantType),
        store_raw: storeRaw == null ? null : String(storeRaw),
        store_normalized: storeNormalized == null ? null : String(storeNormalized),
        total: Number(total),
        tax: Number(tax),
        tax_is_known: Number(taxIsKnown ?? 0),
        currency: String(currency),
        analysis_json: String(analysisJson),
        recognition_snapshot_json:
          recognitionSnapshotJson == null ? null : String(recognitionSnapshotJson),
        user_edited: 0,
        final_total: null,
        final_category: null,
        note: null,
        user_items_json: null,
        user_id: userId == null ? null : String(userId),
        installation_id: installationId == null ? null : String(installationId),
        transaction_source: String(transactionSource ?? 'receipt_ocr'),
        ocr_request_id: ocrRequestId == null ? null : String(ocrRequestId),
        client_updated_at: clientUpdatedAt == null ? Number(createdAt) : Number(clientUpdatedAt),
      });
      return { changes: 1 };
    }
    if (/INSERT OR REPLACE INTO sync_outbox/i.test(source)) {
      return { changes: 1 };
    }
    if (/UPDATE receipts/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const id = String(values[values.length - 2]);
      const row = this.rows.get(id);
      if (!row || !rowMatchesOwnerPredicate(row, source, [ownerParam])) {
        return { changes: 0 };
      }
      const setClause = source.match(/SET\s+([\s\S]*?)\s+WHERE\s+id\s*=\s*\?/i)?.[1] ?? '';
      let valueIndex = 0;
      for (const assignment of setClause.split(',')) {
        const constantMatch = assignment.trim().match(/^(\w+)\s*=\s*1$/);
        if (constantMatch) {
          row[constantMatch[1]] = 1;
          continue;
        }
        const bindMatch = assignment.trim().match(/^(\w+)\s*=\s*\?$/);
        if (bindMatch) {
          row[bindMatch[1]] = values[valueIndex++];
        }
      }
      return { changes: 1 };
    }
    return { changes: 0 };
  }
}

const mockDatabase = new MemoryDb();

import { getReceipt, saveReceipt, updateReceipt } from './db';

describe('saveReceipt ownership stamping', () => {
  beforeEach(() => {
    mockDatabase.rows.clear();
    ownershipMock.userId = null;
    ownershipMock.installationId = 'install-stamp';
    jest.clearAllMocks();
  });

  it('13/18 — auth unavailable → save works with user_id NULL', async () => {
    ownershipMock.userId = null;
    const id = await saveReceipt({
      imageUri: 'file://a.jpg',
      analysis: { total: 100, tax: 0, currency: 'JPY', items: [] },
      source: 'self',
    });
    const row = mockDatabase.rows.get(id)!;
    expect(row.user_id).toBeNull();
    expect(row.installation_id).toBe('install-stamp');
    expect(row.transaction_source).toBe('receipt_ocr');
    expect(row.source).toBe('self');
  });

  it('15/16/17 — authenticated save stamps user_id + installation_id + transaction_source', async () => {
    ownershipMock.userId = 'auth-user-1';
    const id = await saveReceipt({
      imageUri: 'file://b.jpg',
      analysis: { total: 200, tax: 10, currency: 'JPY', items: [] },
      source: 'family',
      ocrRequestId: 'ocr-req-99',
    });
    const row = mockDatabase.rows.get(id)!;
    expect(row.user_id).toBe('auth-user-1');
    expect(row.installation_id).toBe('install-stamp');
    expect(row.transaction_source).toBe('receipt_ocr');
    expect(row.source).toBe('family');
    expect(row.ocr_request_id).toBe('ocr-req-99');
  });

  it('19/21 — ocrRequestId stored; analysis_json unchanged by provenance field', async () => {
    ownershipMock.userId = 'u';
    const analysis = {
      total: 8351,
      tax: 619,
      currency: 'JPY',
      items: [{ name: 'A', quantity: 1, unitPrice: 1, lineTotal: 1 }],
    };
    const id = await saveReceipt({
      imageUri: 'file://c.jpg',
      analysis,
      ocrRequestId: 'prov-1',
    });
    const row = mockDatabase.rows.get(id)!;
    expect(row.ocr_request_id).toBe('prov-1');
    const parsed = JSON.parse(String(row.analysis_json));
    expect(parsed.total).toBe(8351);
    expect(parsed.ocrRequestId).toBeUndefined();
    expect(parsed.provenance).toBeUndefined();
  });

  it('20 — missing ocrRequestId → null', async () => {
    const id = await saveReceipt({
      imageUri: 'file://d.jpg',
      analysis: { total: 1, tax: null, currency: 'JPY', items: [] },
    });
    expect(mockDatabase.rows.get(id)!.ocr_request_id).toBeNull();
  });

  it('22 — updateReceipt preserves ownership columns', async () => {
    ownershipMock.userId = 'owner';
    const id = await saveReceipt({
      imageUri: 'file://e.jpg',
      analysis: { total: 50, tax: 0, currency: 'JPY', items: [] },
      ocrRequestId: 'keep-me',
    });
    await updateReceipt({
      id,
      user_edited: 1,
      user_items_json: JSON.stringify([{ name: 'edited', quantity: 1, unitPrice: 50, lineTotal: 50 }]),
      note: 'n',
    });
    const row = mockDatabase.rows.get(id)!;
    expect(row.user_id).toBe('owner');
    expect(row.installation_id).toBe('install-stamp');
    expect(row.transaction_source).toBe('receipt_ocr');
    expect(row.ocr_request_id).toBe('keep-me');
    expect(row.user_edited).toBe(1);
    expect(row.note).toBe('n');
  });

  it('14 abstraction — later auth can adopt only unowned (via row state)', async () => {
    // Simulate offline save then "adoption" UPDATE of NULL only
    ownershipMock.userId = null;
    const unownedId = await saveReceipt({
      imageUri: 'file://f.jpg',
      analysis: { total: 1, tax: null, currency: 'JPY', items: [] },
    });
    ownershipMock.userId = 'later-user';
    const ownedId = await saveReceipt({
      imageUri: 'file://g.jpg',
      analysis: { total: 2, tax: null, currency: 'JPY', items: [] },
    });
    // Manual adoption of NULL only
    for (const row of mockDatabase.rows.values()) {
      if (row.user_id == null || row.user_id === '') {
        row.user_id = 'later-user';
        row.installation_id = 'install-after';
      }
    }
    expect(mockDatabase.rows.get(unownedId)!.user_id).toBe('later-user');
    expect(mockDatabase.rows.get(ownedId)!.user_id).toBe('later-user');
  });
});
