import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
}));

jest.mock('./receiptItemIndex', () => ({
  ensureReceiptItemsSchema: jest.fn(async () => undefined),
  rebuildReceiptItemIndex: jest.fn(),
  deleteReceiptItemIndex: jest.fn(async () => undefined),
  clearReceiptItemIndex: jest.fn(async () => undefined),
}));

import { backfillReceiptItemCategories } from './categoryBackfill';
import { logger } from './logger';
import { rebuildReceiptItemIndex } from './receiptItemIndex';

type StoredReceipt = {
  id: string;
  analysis_json: string;
  user_items_json: string | null;
};

class CategoryBackfillDb {
  rows: StoredReceipt[] = [];

  async execAsync(_source: string): Promise<void> {}

  reset(): void {
    this.rows = [
      {
        id: 'receipt-1',
        analysis_json: JSON.stringify({
          items: [{ name: '豆腐', category: '', lineTotal: 100 }],
        }),
        user_items_json: null,
      },
    ];
  }

  async getAllAsync<T>(source: string): Promise<T[]> {
    if (/PRAGMA table_info/i.test(source)) {
      return [
        'source',
        'store_raw',
        'store_normalized',
        'scanned_at',
        'user_edited',
        'final_total',
        'final_category',
        'note',
        'user_items_json',
        'merchant_type',
        'recognition_snapshot_json',
        'merchant_hint',
        'confidence',
        'category_id',
        'updated_at',
        'source_type',
      ].map((name) => ({ name, type: 'TEXT' })) as T[];
    }
    return this.rows.map((row) => ({ ...row })) as T[];
  }

  async getFirstAsync<T>(
    _source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T | null> {
    const values = Array.isArray(params) ? params : [];
    const row = this.rows.find((candidate) => candidate.id === String(values[0]));
    return (row ? { ...row } : null) as T | null;
  }

  async runAsync(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<{ changes: number }> {
    const values = Array.isArray(params) ? params : [];
    if (!/UPDATE receipts/i.test(source)) return { changes: 0 };
    const id = String(values[values.length - 1]);
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return { changes: 0 };
    let valueIndex = 0;
    if (/analysis_json = \?/i.test(source)) {
      row.analysis_json = String(values[valueIndex++]);
    }
    if (/user_items_json = \?/i.test(source)) {
      row.user_items_json = String(values[valueIndex]);
    }
    return { changes: 1 };
  }
}

const mockDatabase = new CategoryBackfillDb();
const mockRebuild = rebuildReceiptItemIndex as jest.MockedFunction<
  typeof rebuildReceiptItemIndex
>;

describe('categoryBackfill receipt_items consistency', () => {
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    Object.defineProperty(globalThis, '__DEV__', {
      value: false,
      configurable: true,
    });
  });

  beforeEach(() => {
    mockDatabase.reset();
    jest.clearAllMocks();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockRebuild.mockResolvedValue(undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('rebuilds the derived index after a direct category receipt update', async () => {
    const result = await backfillReceiptItemCategories();

    expect(result).toMatchObject({ fixedReceipts: 1, fixedItems: 1 });
    expect(
      JSON.parse(mockDatabase.rows[0].analysis_json).items[0].category
    ).toBe('food_ingredients');
    expect(mockRebuild).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        id: 'receipt-1',
        analysis_json: mockDatabase.rows[0].analysis_json,
      })
    );
  });

  it('keeps the category mutation successful when index rebuild fails', async () => {
    mockRebuild.mockRejectedValueOnce(new Error('index unavailable'));

    await expect(backfillReceiptItemCategories()).resolves.toMatchObject({
      fixedReceipts: 1,
      fixedItems: 1,
    });

    expect(
      JSON.parse(mockDatabase.rows[0].analysis_json).items[0].category
    ).toBe('food_ingredients');
    expect(warnSpy).toHaveBeenCalledWith(
      'ReceiptItemIndex',
      'receipt_item_index_rebuild_failed',
      expect.objectContaining({
        operation: 'category_backfill_rebuild',
        receipt_id: 'receipt-1',
      })
    );
  });
});
