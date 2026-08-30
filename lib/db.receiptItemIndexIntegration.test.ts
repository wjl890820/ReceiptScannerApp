import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('nanoid/non-secure', () => {
  let nextId = 1;
  return {
    nanoid: jest.fn(() => `receipt-${nextId++}`),
  };
});

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
}));

jest.mock('./receiptOwnershipContext', () => ({
  TRANSACTION_SOURCE_RECEIPT_OCR: 'receipt_ocr',
  resolveOwnershipStamp: jest.fn(async () => ({
    userId: null,
    installationId: 'install-test',
    transactionSource: 'receipt_ocr',
  })),
  __setOwnershipStampProviderForTests: jest.fn(),
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

import {
  clearReceipts,
  deleteReceipt,
  deleteReceipts,
  getReceipt,
  saveReceipt,
  updateReceipt,
  type ReceiptRow,
} from './db';
import { logger } from './logger';
import { applyProductIdentityToItem } from './receiptItemIdentity';
import {
  buildReceiptItemIndexRows,
  clearReceiptItemIndex,
  deleteReceiptItemIndex,
  rebuildReceiptItemIndex,
  type ReceiptItemIndexRow,
} from './receiptItemIndex';

type MutableReceiptRow = ReceiptRow & Record<string, unknown>;

const RECEIPT_COLUMNS = [
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
  'merchant_hint',
  'confidence',
  'category_id',
  'updated_at',
  'source_type',
] as const;

function bindValues(params: SQLite.SQLiteBindParams | undefined): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

function rowMatchesOwnerPredicate(
  row: MutableReceiptRow,
  sql: string,
  params: SQLite.SQLiteBindValue[]
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

class MemoryReceiptDb {
  readonly rows = new Map<string, MutableReceiptRow>();
  failNextReceiptInsert = false;
  failNextReceiptUpdate = false;
  failNextReceiptDelete = false;

  reset(): void {
    this.rows.clear();
    this.failNextReceiptInsert = false;
    this.failNextReceiptUpdate = false;
    this.failNextReceiptDelete = false;
  }

  async execAsync(_source: string): Promise<void> {}

  async closeAsync(): Promise<void> {}

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    await task();
  }

  async withExclusiveTransactionAsync(
    task: (txn: MemoryReceiptDb) => Promise<void>
  ): Promise<void> {
    const rowsSnapshot = new Map(
      [...this.rows.entries()].map(([id, row]) => [id, { ...row }])
    );
    try {
      await task(this);
    } catch (error) {
      this.rows.clear();
      for (const [id, row] of rowsSnapshot) {
        this.rows.set(id, { ...row });
      }
      throw error;
    }
  }

  async getAllAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    const values = bindValues(params);
    if (/PRAGMA table_info/i.test(source)) {
      return RECEIPT_COLUMNS.map((name) => ({ name, type: 'TEXT' })) as T[];
    }
    if (/SELECT id, user_id FROM receipts WHERE id IN/i.test(source)) {
      const ownerParam = values[values.length - 1];
      const ids = values.slice(0, values.length - 1).map(String);
      return [...this.rows.values()]
        .filter(
          (row) =>
            ids.includes(String(row.id)) &&
            rowMatchesOwnerPredicate(row as MutableReceiptRow, source, [ownerParam])
        )
        .map((row) => ({ id: row.id, user_id: (row as any).user_id ?? null })) as T[];
    }
    return [];
  }

  async getFirstAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T | null> {
    if (/SELECT user_id FROM receipts/i.test(source)) {
      const [id, ownerParam] = bindValues(params);
      const row = this.rows.get(String(id));
      if (!row) return null;
      return (
        rowMatchesOwnerPredicate(row, source, [ownerParam])
          ? { user_id: (row as any).user_id ?? null }
          : null
      ) as T | null;
    }
    if (/FROM receipts/i.test(source)) {
      const values = bindValues(params);
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

  async runAsync(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<{ changes: number }> {
    const values = bindValues(params);
    if (/INSERT INTO receipts/i.test(source)) {
      if (this.failNextReceiptInsert) {
        this.failNextReceiptInsert = false;
        throw new Error('receipt insert failed');
      }
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
        merchant_normalized:
          merchantNormalized == null ? null : String(merchantNormalized),
        merchant_type: merchantType == null ? null : String(merchantType) as ReceiptRow['merchant_type'],
        store_raw: storeRaw == null ? null : String(storeRaw),
        store_normalized:
          storeNormalized == null ? null : String(storeNormalized),
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
        transaction_source:
          transactionSource == null ? 'receipt_ocr' : String(transactionSource),
        ocr_request_id: ocrRequestId == null ? null : String(ocrRequestId),
        client_updated_at:
          clientUpdatedAt == null ? Number(createdAt) : Number(clientUpdatedAt),
      });
      return { changes: 1 };
    }

    if (/INSERT OR REPLACE INTO sync_outbox/i.test(source)) {
      return { changes: 1 };
    }

    if (/UPDATE receipts/i.test(source)) {
      if (this.failNextReceiptUpdate) {
        this.failNextReceiptUpdate = false;
        throw new Error('receipt update failed');
      }
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

    if (/DELETE FROM receipts/i.test(source)) {
      if (this.failNextReceiptDelete) {
        this.failNextReceiptDelete = false;
        throw new Error('receipt delete failed');
      }
      if (/WHERE id IN/i.test(source)) {
        const ownerParam = values[values.length - 1];
        const ids = values.slice(0, values.length - 1).map(String);
        let changes = 0;
        for (const id of ids) {
          const row = this.rows.get(id);
          if (row && rowMatchesOwnerPredicate(row, source, [ownerParam])) {
            if (this.rows.delete(id)) changes += 1;
          }
        }
        return { changes };
      }
      const changes = this.rows.size;
      this.rows.clear();
      return { changes };
    }

    return { changes: 0 };
  }
}

const mockDatabase = new MemoryReceiptDb() as MemoryReceiptDb & SQLite.SQLiteDatabase;
const mockRebuild = rebuildReceiptItemIndex as jest.MockedFunction<
  typeof rebuildReceiptItemIndex
>;
const mockDelete = deleteReceiptItemIndex as jest.MockedFunction<
  typeof deleteReceiptItemIndex
>;
const mockClear = clearReceiptItemIndex as jest.MockedFunction<
  typeof clearReceiptItemIndex
>;
const indexedRows = new Map<string, ReceiptItemIndexRow[]>();

function persistedItem(
  name: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return applyProductIdentityToItem(
    {
      name,
      category: 'food_ingredients',
      ...extra,
    },
    {
      finalName: name,
      finalCategory:
        typeof extra.category === 'string'
          ? extra.category
          : 'food_ingredients',
    }
  );
}

function saveParams(items: unknown[]) {
  return {
    imageUri: 'file://receipt.jpg',
    analysis: {
      merchant: 'Test Store',
      total: 500,
      tax: 0,
      currency: 'JPY',
      items,
    },
  };
}

describe('receipt mutation derived-index integration', () => {
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    Object.defineProperty(globalThis, '__DEV__', {
      value: false,
      configurable: true,
    });
  });

  beforeEach(() => {
    mockDatabase.reset();
    indexedRows.clear();
    jest.clearAllMocks();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockRebuild.mockImplementation(async (_db, receipt) => {
      expect(mockDatabase.rows.has(receipt.id)).toBe(true);
      indexedRows.set(
        receipt.id,
        buildReceiptItemIndexRows(receipt, { indexedAt: 1 })
      );
    });
    mockDelete.mockImplementation(async (_db, receiptId) => {
      indexedRows.delete(receiptId);
    });
    mockClear.mockImplementation(async () => {
      indexedRows.clear();
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('save persists receipt first and indexes Phase 3B identity', async () => {
    const id = await saveReceipt(
      saveParams([persistedItem('明治 おいしい牛乳 900ml')])
    );

    expect(await getReceipt(id)).not.toBeNull();
    expect(indexedRows.get(id)).toMatchObject([
      {
        canonical_product_name: '明治 おいしい牛乳',
        product_family_key: 'milk',
        volume_base_ml: 900,
      },
    ]);
    expect(mockRebuild).toHaveBeenCalledTimes(1);
  });

  it('save persists tax_is_known for known vs unknown tax evidence', async () => {
    const knownId = await saveReceipt({
      imageUri: 'file://known.jpg',
      analysis: {
        merchant: 'Test',
        total: 4000,
        tax: 305,
        currency: 'JPY',
        items: [],
      },
    });
    const known = await getReceipt(knownId);
    expect(known?.tax).toBe(305);
    expect(known?.tax_is_known).toBe(1);
    expect(JSON.parse(known!.analysis_json).tax_is_known).toBe(true);

    const unknownId = await saveReceipt({
      imageUri: 'file://unknown.jpg',
      analysis: {
        merchant: 'Test',
        total: 1000,
        tax: null,
        currency: 'JPY',
        items: [],
      },
    });
    const unknown = await getReceipt(unknownId);
    expect(unknown?.tax).toBe(0);
    expect(unknown?.tax_is_known).toBe(0);
    expect(JSON.parse(unknown!.analysis_json).tax_is_known).toBe(false);

    const zeroId = await saveReceipt({
      imageUri: 'file://zero.jpg',
      analysis: {
        merchant: 'Test',
        total: 1000,
        tax: 0,
        tax_is_known: true,
        currency: 'JPY',
        items: [],
      },
    });
    const zero = await getReceipt(zeroId);
    expect(zero?.tax).toBe(0);
    expect(zero?.tax_is_known).toBe(1);
  });

  it('save supports a valid empty item list', async () => {
    const id = await saveReceipt(saveParams([]));

    expect(await getReceipt(id)).not.toBeNull();
    expect(indexedRows.get(id)).toEqual([]);
  });

  it('save remains successful when index rebuild fails', async () => {
    mockRebuild.mockRejectedValueOnce(new Error('index unavailable'));

    const id = await saveReceipt(saveParams([{ name: '商品' }]));

    expect(await getReceipt(id)).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ReceiptItemIndex',
      'receipt_item_index_rebuild_failed',
      expect.objectContaining({ operation: 'rebuild', receipt_id: id })
    );
  });

  it('user item update refreshes name/spec, quantity, category, and unit price', async () => {
    const id = await saveReceipt(
      saveParams([persistedItem('明治 おいしい牛乳 900ml')])
    );
    mockRebuild.mockClear();
    const userItems = [
      persistedItem('明治 おいしい牛乳 450ml', {
        quantity: 2,
        lineTotal: 500,
        category: 'snacks_drinks',
      }),
    ];

    await updateReceipt({
      id,
      user_edited: 1,
      user_items_json: JSON.stringify(userItems),
    });

    expect(indexedRows.get(id)).toMatchObject([
      {
        volume_base_ml: 450,
        purchase_quantity: 2,
        purchase_unit_price: 250,
        category: 'snacks_drinks',
      },
    ]);
    expect(mockRebuild).toHaveBeenCalledTimes(1);
  });

  it('metadata-only and analysis aggregate-only updates do not rebuild', async () => {
    const id = await saveReceipt(
      saveParams([persistedItem('明治 おいしい牛乳 900ml')])
    );
    mockRebuild.mockClear();

    await updateReceipt({ id, note: 'memo' });
    const current = await getReceipt(id);
    const analysis = JSON.parse(current?.analysis_json ?? '{}');
    analysis.analysis_outputs_v1 = { aggregate_level: { total: 500 } };
    analysis.analysis_level = 'L2';
    await updateReceipt({ id, analysis });

    expect(mockRebuild).not.toHaveBeenCalled();
    expect((await getReceipt(id))?.note).toBe('memo');
  });

  it('analysis item changes rebuild while preserving analysis as Source of Truth', async () => {
    const id = await saveReceipt(saveParams([{ name: '卵10個', lineTotal: 300 }]));
    mockRebuild.mockClear();
    const current = await getReceipt(id);
    const analysis = JSON.parse(current?.analysis_json ?? '{}');
    analysis.items = [
      persistedItem('卵10個', {
        lineTotal: 300,
        category: 'food_ingredients',
      }),
    ];

    await updateReceipt({ id, analysis });

    expect(mockRebuild).toHaveBeenCalledTimes(1);
    expect(indexedRows.get(id)).toMatchObject([
      {
        product_family_key: 'eggs',
        count_base: 10,
        category: 'food_ingredients',
      },
    ]);
  });

  it('update keeps new Source of Truth when rebuild fails', async () => {
    const id = await saveReceipt(
      saveParams([persistedItem('明治 おいしい牛乳 900ml')])
    );
    mockRebuild.mockRejectedValueOnce(new Error('index unavailable'));
    const userItems = [
      persistedItem('明治 おいしい牛乳 450ml', {
        quantity: 2,
        lineTotal: 500,
      }),
    ];

    await expect(
      updateReceipt({ id, user_items_json: JSON.stringify(userItems) })
    ).resolves.toBeUndefined();

    expect(JSON.parse((await getReceipt(id))?.user_items_json ?? '[]')).toMatchObject([
      { name: '明治 おいしい牛乳 450ml', quantity: 2 },
    ]);
    // Rebuild failed after item edit → drop stale index rows (do not keep 900ml).
    // Consumers must fall back to receipt SoT, not silently read pre-edit index.
    expect(indexedRows.get(id) ?? []).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      'ReceiptItemIndex',
      'receipt_item_index_rebuild_failed',
      expect.objectContaining({ operation: 'rebuild', receipt_id: id })
    );
  });

  it('a failed primary update throws and never attempts indexing', async () => {
    const id = await saveReceipt(saveParams([{ name: 'old' }]));
    mockRebuild.mockClear();
    mockDatabase.failNextReceiptUpdate = true;

    await expect(
      updateReceipt({
        id,
        user_items_json: JSON.stringify([{ name: 'new' }]),
      })
    ).rejects.toThrow('receipt update failed');

    expect(mockRebuild).not.toHaveBeenCalled();
    expect((await getReceipt(id))?.user_items_json).toBeNull();
  });

  it('delete cleans only the deleted receipt index after receipt deletion', async () => {
    const firstId = await saveReceipt(saveParams([{ name: 'A' }]));
    const secondId = await saveReceipt(saveParams([{ name: 'B' }]));

    await deleteReceipt(firstId);

    expect(await getReceipt(firstId)).toBeNull();
    expect(indexedRows.has(firstId)).toBe(false);
    expect(await getReceipt(secondId)).not.toBeNull();
    expect(indexedRows.has(secondId)).toBe(true);
  });

  it('delete remains successful and permits an orphan when index cleanup fails', async () => {
    const id = await saveReceipt(saveParams([{ name: 'A' }]));
    mockDelete.mockRejectedValueOnce(new Error('index unavailable'));

    await expect(deleteReceipt(id)).resolves.toBeUndefined();

    expect(await getReceipt(id)).toBeNull();
    expect(indexedRows.has(id)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'ReceiptItemIndex',
      'receipt_item_index_delete_failed',
      expect.objectContaining({ operation: 'delete', receipt_id: id })
    );
  });

  it('bulk delete cleans selected indexes and keeps all other data', async () => {
    const firstId = await saveReceipt(saveParams([{ name: 'A' }]));
    const secondId = await saveReceipt(saveParams([{ name: 'B' }]));
    const keptId = await saveReceipt(saveParams([{ name: 'C' }]));

    await deleteReceipts([firstId, secondId]);

    expect(await getReceipt(firstId)).toBeNull();
    expect(await getReceipt(secondId)).toBeNull();
    expect(indexedRows.has(firstId)).toBe(false);
    expect(indexedRows.has(secondId)).toBe(false);
    expect(await getReceipt(keptId)).not.toBeNull();
    expect(indexedRows.has(keptId)).toBe(true);
  });

  it('clear removes receipts first and normally clears all index rows', async () => {
    await saveReceipt(saveParams([{ name: 'A' }]));
    await saveReceipt(saveParams([{ name: 'B' }]));

    await clearReceipts({ allowTestOnly: true });

    expect(mockDatabase.rows.size).toBe(0);
    expect(indexedRows.size).toBe(0);
  });

  it('clear remains successful when index cleanup fails', async () => {
    const id = await saveReceipt(saveParams([{ name: 'A' }]));
    mockClear.mockRejectedValueOnce(new Error('index unavailable'));

    await expect(clearReceipts({ allowTestOnly: true })).resolves.toBeUndefined();

    expect(mockDatabase.rows.size).toBe(0);
    expect(indexedRows.has(id)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'ReceiptItemIndex',
      'receipt_item_index_clear_failed',
      expect.objectContaining({ operation: 'clear' })
    );
  });
});
