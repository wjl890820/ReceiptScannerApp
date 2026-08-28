import type * as SQLite from 'expo-sqlite';

import {
  getReceiptItemIndexRows,
  type ReceiptItemIndexDatabase,
  type ReceiptItemIndexRow,
} from './receiptItemIndex';
import {
  RECEIPT_ITEM_INDEX_VERSION,
  getReceiptItemIndexBackfillStatus,
  getReceiptItemIndexJoinReadiness,
  getReceiptItemIndexJoinReadinessSample,
  reconcileReceiptItemIndex,
  resetReceiptItemIndexBackfillProgress,
  runReceiptItemIndexBackfillBatch,
} from './receiptItemIndexBackfill';
import { logger } from './logger';

const ROW_KEYS: readonly (keyof ReceiptItemIndexRow)[] = [
  'id',
  'receipt_id',
  'source_index',
  'review_source_index',
  'raw_name',
  'normalized_name',
  'normalized_full_name',
  'canonical_product_name',
  'legacy_canonical_name',
  'brand',
  'product_family_key',
  'category',
  'purchase_quantity',
  'line_total',
  'purchase_unit_price',
  'spec_size_value',
  'spec_size_unit',
  'spec_pack_count',
  'volume_base_ml',
  'weight_base_g',
  'count_base',
  'sku_key',
  'identity_source',
  'identity_confidence',
  'identity_version',
  'spec_source_text',
  'spec_confidence',
  'item_source',
  'created_at',
  'updated_at',
  'gross_line_amount',
  'effective_line_amount',
  'discount_allocated',
  'amount_provenance',
  'item_amount_evidence_state',
  'promo_markers_json',
  'evidence_capture_version',
  'price_observation_version',
];

type StoredReceipt = {
  id: string;
  created_at: number;
  analysis_json: string;
  user_items_json: string | null;
  transaction_at: number | null;
  merchant_normalized: string | null;
  merchant_type: string | null;
};

function bindValues(params: SQLite.SQLiteBindParams): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

class MemoryBackfillDb implements ReceiptItemIndexDatabase {
  readonly receipts = new Map<string, StoredReceipt>();
  readonly indexRows = new Map<string, ReceiptItemIndexRow>();
  readonly kv = new Map<string, string>();
  readonly tableColumns = new Set<string>(
    ROW_KEYS.filter((key) => key !== 'id' && key !== 'receipt_id').map(String)
  );
  failReceiptIds = new Set<string>();
  failReconcile = false;
  mutateAfterFirstInsert: ((receiptId: string) => void) | null = null;

  addReceipt(
    id: string,
    createdAt: number,
    analysisItems: unknown[],
    userItems: unknown[] | string | null = null
  ): void {
    this.receipts.set(id, {
      id,
      created_at: createdAt,
      analysis_json: JSON.stringify({ items: analysisItems }),
      user_items_json:
        typeof userItems === 'string'
          ? userItems
          : userItems == null
            ? null
            : JSON.stringify(userItems),
      transaction_at: createdAt * 1000,
      merchant_normalized: `merchant-${id}`,
      merchant_type: 'supermarket',
    });
  }

  addOrphan(receiptId = 'missing'): void {
    this.indexRows.set(`${receiptId}:0`, {
      id: `${receiptId}:0`,
      receipt_id: receiptId,
      source_index: 0,
      review_source_index: null,
      raw_name: 'orphan',
      normalized_name: 'orphan',
      normalized_full_name: 'orphan',
      canonical_product_name: null,
      legacy_canonical_name: null,
      brand: null,
      product_family_key: null,
      category: null,
      purchase_quantity: 1,
      line_total: 0,
      purchase_unit_price: null,
      spec_size_value: null,
      spec_size_unit: null,
      spec_pack_count: null,
      volume_base_ml: null,
      weight_base_g: null,
      count_base: null,
      sku_key: null,
      identity_source: 'unknown',
      identity_confidence: 0,
      identity_version: 1,
      spec_source_text: null,
      spec_confidence: 0,
      item_source: 'unknown',
      created_at: 0,
      updated_at: 0,
      gross_line_amount: null,
      effective_line_amount: null,
      discount_allocated: null,
      amount_provenance: null,
      item_amount_evidence_state: null,
      promo_markers_json: null,
      evidence_capture_version: null,
      price_observation_version: null,
    });
  }

  async execAsync(_source: string): Promise<void> {}

  async runAsync(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<{ changes: number }> {
    const values = bindValues(params);
    if (/ALTER TABLE receipt_items ADD COLUMN/i.test(source)) {
      const match = source.match(/ADD COLUMN ([a-z_]+)/i);
      if (match?.[1]) this.tableColumns.add(match[1]);
      return { changes: 1 };
    }
    if (/INSERT OR REPLACE INTO app_kv/i.test(source)) {
      this.kv.set(String(values[0]), String(values[1]));
      return { changes: 1 };
    }
    if (/DELETE FROM app_kv/i.test(source)) {
      let changes = 0;
      for (const key of [...this.kv.keys()]) {
        if (key.startsWith('receipt_item_index_backfill_')) {
          this.kv.delete(key);
          changes += 1;
        }
      }
      return { changes };
    }
    if (
      /DELETE FROM receipt_items/i.test(source) &&
      /NOT EXISTS/i.test(source)
    ) {
      if (this.failReconcile) throw new Error('reconcile failed');
      let changes = 0;
      for (const [id, row] of [...this.indexRows.entries()]) {
        if (!this.receipts.has(row.receipt_id)) {
          this.indexRows.delete(id);
          changes += 1;
        }
      }
      return { changes };
    }
    if (/DELETE FROM receipt_items/i.test(source)) {
      const receiptId = String(values[0]);
      let changes = 0;
      for (const [id, row] of [...this.indexRows.entries()]) {
        if (row.receipt_id === receiptId) {
          this.indexRows.delete(id);
          changes += 1;
        }
      }
      return { changes };
    }
    if (/INSERT INTO receipt_items/i.test(source)) {
      const row = Object.fromEntries(
        ROW_KEYS.map((key, index) => [key, values[index]])
      ) as ReceiptItemIndexRow;
      if (this.failReceiptIds.has(row.receipt_id)) {
        throw new Error(`rebuild failed: ${row.receipt_id}`);
      }
      this.indexRows.set(row.id, row);
      if (this.mutateAfterFirstInsert) {
        const mutate = this.mutateAfterFirstInsert;
        this.mutateAfterFirstInsert = null;
        mutate(row.receipt_id);
      }
      return { changes: 1 };
    }
    throw new Error(`Unexpected SQL: ${source}`);
  }

  async getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    const values = bindValues(params);
    if (/PRAGMA table_info\(receipt_items\)/i.test(source)) {
      return [...this.tableColumns].map((name) => ({ name })) as T[];
    }
    if (/FROM app_kv/i.test(source)) {
      return [...this.kv.entries()]
        .filter(([key]) => key.startsWith('receipt_item_index_backfill_'))
        .map(([k, v]) => ({ k, v })) as T[];
    }
    if (/FROM receipts/i.test(source) && /created_at > \?/i.test(source)) {
      const cursorCreatedAt =
        values[0] == null ? null : Number(values[0]);
      const cursorId = String(values[3] ?? '');
      const limit = Number(values[4]);
      return [...this.receipts.values()]
        .filter(
          (row) =>
            cursorCreatedAt == null ||
            row.created_at > cursorCreatedAt ||
            (row.created_at === cursorCreatedAt && row.id > cursorId)
        )
        .sort(
          (left, right) =>
            left.created_at - right.created_at || left.id.localeCompare(right.id)
        )
        .slice(0, limit)
        .map((row) => ({ ...row })) as T[];
    }
    if (/FROM receipts/i.test(source) && /WHERE id IN/i.test(source)) {
      return values
        .map((id) => this.receipts.get(String(id)))
        .filter((row): row is StoredReceipt => row != null)
        .map((row) => ({ ...row })) as T[];
    }
    if (/FROM receipt_items/i.test(source) && /INNER JOIN receipts/i.test(source)) {
      const limit = Number(values[0]);
      return [...this.indexRows.values()]
        .filter((row) => this.receipts.has(row.receipt_id))
        .sort(
          (left, right) =>
            left.receipt_id.localeCompare(right.receipt_id) ||
            left.source_index - right.source_index
        )
        .slice(0, limit)
        .map((row) => {
          const receipt = this.receipts.get(row.receipt_id)!;
          return {
            itemId: row.id,
            receiptId: row.receipt_id,
            normalizedName: row.normalized_name,
            transactionAt: receipt.transaction_at ?? receipt.created_at,
            merchantNormalized: receipt.merchant_normalized,
            merchantType: receipt.merchant_type,
          };
        }) as T[];
    }
    if (/FROM receipt_items/i.test(source) && /receipt_id = \?/i.test(source)) {
      return [...this.indexRows.values()]
        .filter((row) => row.receipt_id === String(values[0]))
        .sort((left, right) => left.source_index - right.source_index) as T[];
    }
    throw new Error(`Unexpected query: ${source}`);
  }

  async getFirstAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T | null> {
    const values = bindValues(params);
    if (/FROM receipts/i.test(source) && /WHERE id = \?/i.test(source)) {
      const receipt = this.receipts.get(String(values[0]));
      return (receipt ? { ...receipt } : null) as T | null;
    }
    if (/joinedItemRowCount/i.test(source)) {
      const joinedItemRowCount = [...this.indexRows.values()].filter((row) =>
        this.receipts.has(row.receipt_id)
      ).length;
      return {
        receiptCount: this.receipts.size,
        itemRowCount: this.indexRows.size,
        joinedItemRowCount,
        orphanRowCount: this.indexRows.size - joinedItemRowCount,
      } as T;
    }
    throw new Error(`Unexpected first query: ${source}`);
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const beforeRows = new Map(this.indexRows);
    const beforeKv = new Map(this.kv);
    try {
      await task();
    } catch (error) {
      this.indexRows.clear();
      beforeRows.forEach((row, id) => this.indexRows.set(id, row));
      this.kv.clear();
      beforeKv.forEach((value, key) => this.kv.set(key, value));
      throw error;
    }
  }
}

describe('receipt item index resumable backfill', () => {
  let db: MemoryBackfillDb;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    db = new MemoryBackfillDb();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('backfills three legacy receipts across small batches', async () => {
    db.addReceipt('a', 1, [{ name: '明治 おいしい牛乳 900ml' }]);
    db.addReceipt('b', 2, [{ name: '卵10個' }]);
    db.addReceipt('c', 3, [{ name: '水 500ml×6本' }]);

    const first = await runReceiptItemIndexBackfillBatch(db, { batchSize: 2 });
    const second = await runReceiptItemIndexBackfillBatch(db, { batchSize: 2 });

    expect(first).toMatchObject({ scanned: 2, succeeded: 2, hasMore: true });
    expect(second).toMatchObject({
      scanned: 1,
      succeeded: 1,
      failed: 0,
      hasMore: false,
      version: RECEIPT_ITEM_INDEX_VERSION,
    });
    expect(db.indexRows.size).toBe(3);
    expect((await getReceiptItemIndexBackfillStatus(db)).complete).toBe(true);
  });

  it('batch size one persists a created_at + id cursor and resumes after restart', async () => {
    db.addReceipt('a', 10, [{ name: 'A' }]);
    db.addReceipt('b', 10, [{ name: 'B' }]);
    db.addReceipt('c', 11, [{ name: 'C' }]);

    const first = await runReceiptItemIndexBackfillBatch(db, { batchSize: 1 });
    const persisted = await getReceiptItemIndexBackfillStatus(db);
    const second = await runReceiptItemIndexBackfillBatch(db, { batchSize: 1 });

    expect(first.cursor).toEqual({ createdAt: 10, id: 'a' });
    expect(persisted.cursor).toEqual(first.cursor);
    expect(second.cursor).toEqual({ createdAt: 10, id: 'b' });
    expect(db.indexRows.has('a:0')).toBe(true);
    expect(db.indexRows.has('b:0')).toBe(true);
    expect(db.indexRows.has('c:0')).toBe(false);
  });

  it('a reset and repeated full sweep remain idempotent', async () => {
    db.addReceipt('a', 1, [{ name: 'A' }, { name: 'B' }]);
    await runReceiptItemIndexBackfillBatch(db);
    expect(db.indexRows.size).toBe(2);

    await resetReceiptItemIndexBackfillProgress(db);
    await runReceiptItemIndexBackfillBatch(db);

    expect(db.indexRows.size).toBe(2);
    expect((await getReceiptItemIndexBackfillStatus(db)).complete).toBe(true);
  });

  it('uses user override, empty override, and malformed fallback semantics', async () => {
    db.addReceipt(
      'override',
      1,
      [{ name: '明治 おいしい牛乳 900ml' }],
      [{ name: '明治 おいしい牛乳 450ml' }]
    );
    db.addReceipt(
      'empty',
      2,
      [{ name: '明治 おいしい牛乳 900ml' }],
      []
    );
    db.addReceipt(
      'malformed',
      3,
      [{ name: '明治 おいしい牛乳 900ml' }],
      '{bad-json'
    );
    db.addOrphan('empty');

    await runReceiptItemIndexBackfillBatch(db);

    expect((await getReceiptItemIndexRows(db, 'override'))[0].volume_base_ml).toBe(
      450
    );
    expect(await getReceiptItemIndexRows(db, 'empty')).toEqual([]);
    expect((await getReceiptItemIndexRows(db, 'malformed'))[0].volume_base_ml).toBe(
      900
    );
  });

  it('continues after a per-receipt failure and retries it later', async () => {
    db.addReceipt('a', 1, [{ name: 'A' }]);
    db.addReceipt('b', 2, [{ name: 'B' }]);
    db.addReceipt('c', 3, [{ name: 'C' }]);
    db.failReceiptIds.add('b');

    const first = await runReceiptItemIndexBackfillBatch(db, { batchSize: 3 });

    expect(first).toMatchObject({
      scanned: 3,
      succeeded: 2,
      failed: 1,
      hasMore: true,
    });
    expect(db.indexRows.has('a:0')).toBe(true);
    expect(db.indexRows.has('b:0')).toBe(false);
    expect(db.indexRows.has('c:0')).toBe(true);
    expect(
      (await getReceiptItemIndexBackfillStatus(db)).failedReceiptIds
    ).toEqual(['b']);
    expect(warnSpy).toHaveBeenCalledWith(
      'ReceiptItemIndexBackfill',
      'receipt_item_index_backfill_receipt_failed',
      expect.objectContaining({ receipt_id: 'b' })
    );

    db.failReceiptIds.delete('b');
    const retry = await runReceiptItemIndexBackfillBatch(db, { batchSize: 3 });

    expect(retry).toMatchObject({
      scanned: 1,
      succeeded: 1,
      failed: 0,
      hasMore: false,
    });
    expect(db.indexRows.has('b:0')).toBe(true);
    expect((await getReceiptItemIndexBackfillStatus(db)).complete).toBe(true);
  });

  it('does not modify historical receipt JSON while deriving legacy identity', async () => {
    db.addReceipt('legacy', 1, [{ name: 'なぞ商品 500ml' }]);
    const before = { ...db.receipts.get('legacy') };

    await runReceiptItemIndexBackfillBatch(db);

    expect(db.receipts.get('legacy')).toEqual(before);
    const [row] = await getReceiptItemIndexRows(db, 'legacy');
    expect(row.identity_source).toBe('legacy_fallback');
    expect(row.canonical_product_name).toBeNull();
  });

  it('re-projects a receipt changed concurrently during its rebuild', async () => {
    db.addReceipt('changing', 1, [{ name: '明治 おいしい牛乳 900ml' }]);
    db.mutateAfterFirstInsert = (receiptId) => {
      const receipt = db.receipts.get(receiptId)!;
      receipt.user_items_json = JSON.stringify([
        { name: '明治 おいしい牛乳 450ml' },
      ]);
    };

    await runReceiptItemIndexBackfillBatch(db);

    expect(
      (await getReceiptItemIndexRows(db, 'changing'))[0].volume_base_ml
    ).toBe(450);
  });

  it('resets completed version 1 progress when RECEIPT_ITEM_INDEX_VERSION bumps to 2', async () => {
    db.addReceipt('a', 1, [{ name: 'A' }]);
    db.addReceipt('b', 2, [{ name: 'B' }]);
    db.kv.set('receipt_item_index_backfill_version', '1');
    db.kv.set('receipt_item_index_backfill_completed_at', String(Date.now()));
    db.kv.set('receipt_item_index_backfill_cursor', '');

    const first = await runReceiptItemIndexBackfillBatch(db, { batchSize: 1 });
    const mid = await getReceiptItemIndexBackfillStatus(db);

    expect(mid.complete).toBe(false);
    expect(mid.version).toBe(1);
    expect(mid.targetVersion).toBe(RECEIPT_ITEM_INDEX_VERSION);
    expect(first.hasMore).toBe(true);
    expect(first.scanned).toBeGreaterThan(0);
    expect(db.indexRows.has('a:0')).toBe(true);
    expect((await getReceiptItemIndexRows(db, 'a'))[0].price_observation_version).toBe(
      1
    );

    await runReceiptItemIndexBackfillBatch(db, { batchSize: 1 });
    const done = await runReceiptItemIndexBackfillBatch(db, { batchSize: 1 });
    expect(done.hasMore).toBe(false);
    expect((await getReceiptItemIndexBackfillStatus(db)).version).toBe(
      RECEIPT_ITEM_INDEX_VERSION
    );
    expect((await getReceiptItemIndexBackfillStatus(db)).targetVersion).toBe(
      RECEIPT_ITEM_INDEX_VERSION
    );
  });

  it('4H — partial legacy v1 sweep resets to beginning when v2 starts', async () => {
    db.kv.set('receipt_item_index_backfill_version', '0');
    db.kv.set(
      'receipt_item_index_backfill_cursor',
      JSON.stringify({ createdAt: 10, id: 'mid' })
    );
    db.kv.set('receipt_item_index_backfill_scanned', '5');
    db.kv.set('receipt_item_index_backfill_succeeded', '4');
    db.addReceipt('early', 1, [{ name: 'Early', lineTotal: 100 }]);
    db.addReceipt('mid', 10, [{ name: 'Mid', lineTotal: 200 }]);
    db.addReceipt('late', 11, [{ name: 'Late', lineTotal: 300 }]);

    const first = await runReceiptItemIndexBackfillBatch(db, { batchSize: 1 });
    const status = await getReceiptItemIndexBackfillStatus(db);

    expect(status.targetVersion).toBe(RECEIPT_ITEM_INDEX_VERSION);
    expect(status.scanned).toBe(1);
    expect(status.succeeded).toBe(1);
    expect(first.cursor).toEqual({ createdAt: 1, id: 'early' });
    expect(db.indexRows.has('early:0')).toBe(true);
    expect(db.indexRows.has('mid:0')).toBe(false);
  });

  it('4I — in-progress v2 sweep continues from persisted cursor without reset', async () => {
    db.kv.set('receipt_item_index_backfill_version', '0');
    db.kv.set(
      'receipt_item_index_backfill_target_version',
      String(RECEIPT_ITEM_INDEX_VERSION)
    );
    db.kv.set(
      'receipt_item_index_backfill_cursor',
      JSON.stringify({ createdAt: 1, id: 'a' })
    );
    db.kv.set('receipt_item_index_backfill_scanned', '1');
    db.kv.set('receipt_item_index_backfill_succeeded', '1');
    db.addReceipt('a', 1, [{ name: 'A' }]);
    db.addReceipt('b', 2, [{ name: 'B' }]);
    db.addReceipt('c', 3, [{ name: 'C' }]);

    const batch = await runReceiptItemIndexBackfillBatch(db, { batchSize: 1 });
    const status = await getReceiptItemIndexBackfillStatus(db);

    expect(status.targetVersion).toBe(RECEIPT_ITEM_INDEX_VERSION);
    expect(status.scanned).toBe(2);
    expect(batch.cursor).toEqual({ createdAt: 2, id: 'b' });
    expect(db.indexRows.has('a:0')).toBe(false);
    expect(db.indexRows.has('b:0')).toBe(true);
  });
});

describe('receipt item index reconciliation and JOIN readiness', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('removes orphan rows while preserving valid receipt rows', async () => {
    const db = new MemoryBackfillDb();
    db.addReceipt('valid', 1, [{ name: 'A' }]);
    await runReceiptItemIndexBackfillBatch(db);
    db.addOrphan();

    expect(await reconcileReceiptItemIndex(db)).toBe(1);
    expect(db.indexRows.has('valid:0')).toBe(true);
    expect(db.indexRows.has('missing:0')).toBe(false);
  });

  it('INNER JOIN readiness excludes orphan rows', async () => {
    const db = new MemoryBackfillDb();
    db.addReceipt('valid', 1, [{ name: 'A' }]);
    await runReceiptItemIndexBackfillBatch(db);
    db.addOrphan();

    expect(await getReceiptItemIndexJoinReadiness(db)).toEqual({
      receiptCount: 1,
      itemRowCount: 2,
      joinedItemRowCount: 1,
      orphanRowCount: 1,
    });
    expect(await getReceiptItemIndexJoinReadinessSample(db)).toEqual([
      expect.objectContaining({
        itemId: 'valid:0',
        receiptId: 'valid',
        transactionAt: 1000,
        merchantNormalized: 'merchant-valid',
        merchantType: 'supermarket',
      }),
    ]);
  });

  it('keeps successful rebuilds and retries reconciliation later', async () => {
    const db = new MemoryBackfillDb();
    db.addReceipt('valid', 1, [{ name: 'A' }]);
    db.failReconcile = true;

    const first = await runReceiptItemIndexBackfillBatch(db);

    expect(first.hasMore).toBe(true);
    expect(db.indexRows.has('valid:0')).toBe(true);
    expect((await getReceiptItemIndexBackfillStatus(db)).complete).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'ReceiptItemIndexBackfill',
      'receipt_item_index_reconcile_failed',
      expect.objectContaining({ error: expect.any(Error) })
    );

    db.failReconcile = false;
    const retry = await runReceiptItemIndexBackfillBatch(db);
    expect(retry.hasMore).toBe(false);
    expect((await getReceiptItemIndexBackfillStatus(db)).complete).toBe(true);
  });
});
