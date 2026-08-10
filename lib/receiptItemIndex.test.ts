import type * as SQLite from 'expo-sqlite';

import { applyProductIdentityToItem } from './receiptItemIdentity';
import {
  buildReceiptItemIndexRows,
  clearReceiptItemIndex,
  deleteReceiptItemIndex,
  ensureReceiptItemsSchema,
  getReceiptItemIndexRows,
  rebuildReceiptItemIndex,
  type ReceiptItemIndexDatabase,
  type ReceiptItemIndexReceipt,
  type ReceiptItemIndexRow,
} from './receiptItemIndex';

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
];

class MemoryIndexDb implements ReceiptItemIndexDatabase {
  readonly schemaCalls: string[] = [];
  private rows = new Map<string, ReceiptItemIndexRow>();
  failNextInsert = false;

  async execAsync(source: string): Promise<void> {
    this.schemaCalls.push(source);
  }

  async runAsync(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<unknown> {
    const values = Array.isArray(params) ? params : [];
    if (/DELETE FROM receipt_items/i.test(source)) {
      if (values.length === 0) {
        this.rows.clear();
        return {};
      }
      const receiptId = String(values[0]);
      for (const [id, row] of this.rows) {
        if (row.receipt_id === receiptId) this.rows.delete(id);
      }
      return {};
    }
    if (/INSERT INTO receipt_items/i.test(source)) {
      if (this.failNextInsert) {
        this.failNextInsert = false;
        throw new Error('simulated insert failure');
      }
      const row = Object.fromEntries(
        ROW_KEYS.map((key, index) => [key, values[index]])
      ) as ReceiptItemIndexRow;
      this.rows.set(row.id, row);
      return {};
    }
    throw new Error(`Unexpected SQL: ${source}`);
  }

  async getAllAsync<T>(
    _source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    const values = Array.isArray(params) ? params : [];
    return [...this.rows.values()]
      .filter((row) => row.receipt_id === String(values[0]))
      .sort((left, right) => left.source_index - right.source_index) as T[];
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const before = new Map(this.rows);
    try {
      await task();
    } catch (error) {
      this.rows = before;
      throw error;
    }
  }
}

function receipt(
  id: string,
  analysisItems: unknown[],
  userItems: unknown[] | string | null = null
): ReceiptItemIndexReceipt {
  return {
    id,
    analysis_json: JSON.stringify({ items: analysisItems }),
    user_items_json:
      typeof userItems === 'string'
        ? userItems
        : userItems == null
          ? null
          : JSON.stringify(userItems),
  };
}

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
      finalCategory: 'food_ingredients',
    }
  );
}

describe('buildReceiptItemIndexRows', () => {
  it('indexes a Phase 3B Meiji milk item from persisted identity', () => {
    const rows = buildReceiptItemIndexRows(
      receipt('new', [persistedItem('明治 おいしい牛乳 900ml')]),
      { indexedAt: 100 }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'new:0',
      normalized_full_name: '明治 おいしい牛乳 900ml',
      canonical_product_name: '明治 おいしい牛乳',
      product_family_key: 'milk',
      volume_base_ml: 900,
      identity_source: 'high_confidence_rule',
      created_at: 100,
      updated_at: 100,
    });
    expect(rows[0].sku_key).not.toBeNull();
  });

  it('best-effort derives legacy identity without promoting unknown names to canonical', () => {
    const [row] = buildReceiptItemIndexRows(
      receipt('legacy', [{ name: 'なぞ商品 500ml', normalized_name: 'なぞ商品' }])
    );

    expect(row.normalized_full_name).toBe('なぞ商品 500ml');
    expect(row.normalized_name).toBe('なぞ商品');
    expect(row.canonical_product_name).toBeNull();
    expect(row.identity_source).toBe('legacy_fallback');
    expect(row.identity_confidence).toBeLessThanOrEqual(0.65);
    expect(row.sku_key).toBeNull();
    expect(row.item_source).toBe('legacy');
  });

  it('uses user_items_json first, including a valid empty override', () => {
    const analysisItem = persistedItem('明治 おいしい牛乳 900ml');
    const userItem = persistedItem('明治 おいしい牛乳 450ml');

    const rows = buildReceiptItemIndexRows(
      receipt('priority', [analysisItem], [userItem])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].volume_base_ml).toBe(450);

    expect(
      buildReceiptItemIndexRows(receipt('empty', [analysisItem], []))
    ).toEqual([]);
  });

  it('falls back to analysis items when user_items_json is malformed', () => {
    const rows = buildReceiptItemIndexRows(
      receipt(
        'malformed',
        [persistedItem('明治 おいしい牛乳 900ml')],
        '{not-json'
      )
    );
    expect(rows[0].volume_base_ml).toBe(900);
  });

  it('freezes source_index as final array order and keeps review provenance separate', () => {
    const rows = buildReceiptItemIndexRows(
      receipt('order', [
        { name: 'A', review_source_index: 7 },
        { name: 'B' },
        { name: 'C' },
      ])
    );

    expect(rows.map((row) => row.source_index)).toEqual([0, 1, 2]);
    expect(rows[0].review_source_index).toBe(7);
    expect(rows[0].source_index).toBe(0);
  });

  it('recomputes purchase unit price and does not multiply per-unit spec by quantity', () => {
    const [row] = buildReceiptItemIndexRows(
      receipt('amount', [
        persistedItem('明治 おいしい牛乳 900ml', {
          quantity: 2,
          lineTotal: 500,
          unitPrice: 999,
          unit_price: 888,
        }),
      ])
    );

    expect(row.purchase_quantity).toBe(2);
    expect(row.line_total).toBe(500);
    expect(row.purchase_unit_price).toBe(250);
    expect(row.volume_base_ml).toBe(900);
  });

  it('keeps multipack size separate from purchase quantity', () => {
    const [row] = buildReceiptItemIndexRows(
      receipt('multipack', [
        persistedItem('水 500ml×6本', { quantity: 2, lineTotal: 600 }),
      ])
    );

    expect(row.spec_size_value).toBe(500);
    expect(row.spec_pack_count).toBe(6);
    expect(row.volume_base_ml).toBe(3000);
    expect(row.purchase_quantity).toBe(2);
  });

  it('defaults invalid quantity to one and invalid amount to null unit price', () => {
    const [row] = buildReceiptItemIndexRows(
      receipt('defensive', [
        { name: '商品', quantity: 0, lineTotal: 'bad', unitPrice: 999 },
      ])
    );

    expect(row.purchase_quantity).toBe(1);
    expect(row.line_total).toBe(0);
    expect(row.purchase_unit_price).toBeNull();
  });

  it('marks user-added eggs and indexes count specification', () => {
    const [row] = buildReceiptItemIndexRows(
      receipt('user-added', [
        persistedItem('卵10個', { user_added: true, quantity: 1, lineTotal: 300 }),
      ])
    );

    expect(row.item_source).toBe('user_added');
    expect(row.product_family_key).toBe('eggs');
    expect(row.count_base).toBe(10);
  });

  it('generates deterministic IDs and leaves unknown canonical SKU null', () => {
    const source = receipt('stable', [
      persistedItem('明治 おいしい牛乳 900ml'),
      persistedItem('なぞ商品 500ml'),
    ]);
    const first = buildReceiptItemIndexRows(source);
    const second = buildReceiptItemIndexRows(source);

    expect(first).toEqual(second);
    expect(first.map((row) => row.id)).toEqual(['stable:0', 'stable:1']);
    expect(first[0].sku_key).not.toBeNull();
    expect(first[1].sku_key).toBeNull();
  });
});

describe('receipt item index persistence primitives', () => {
  it('rebuild is idempotent and query results are source-index ordered', async () => {
    const db = new MemoryIndexDb();
    const source = receipt('same', [
      persistedItem('明治 おいしい牛乳 900ml'),
      persistedItem('卵10個'),
    ]);

    await rebuildReceiptItemIndex(db, source, { indexedAt: 500 });
    const first = await getReceiptItemIndexRows(db, 'same');
    await rebuildReceiptItemIndex(db, source, { indexedAt: 500 });
    const second = await getReceiptItemIndexRows(db, 'same');

    expect(second).toEqual(first);
    expect(second.map((row) => row.id)).toEqual(['same:0', 'same:1']);
  });

  it('rebuild replaces changed rows and an empty override removes old rows', async () => {
    const db = new MemoryIndexDb();
    await rebuildReceiptItemIndex(
      db,
      receipt('changed', [persistedItem('明治 おいしい牛乳 900ml')]),
      { indexedAt: 1 }
    );
    await rebuildReceiptItemIndex(
      db,
      receipt('changed', [persistedItem('明治 おいしい牛乳 450ml')]),
      { indexedAt: 2 }
    );
    expect(await getReceiptItemIndexRows(db, 'changed')).toMatchObject([
      { volume_base_ml: 450 },
    ]);

    await rebuildReceiptItemIndex(
      db,
      receipt(
        'changed',
        [persistedItem('明治 おいしい牛乳 900ml')],
        []
      ),
      { indexedAt: 3 }
    );
    expect(await getReceiptItemIndexRows(db, 'changed')).toEqual([]);
  });

  it('delete removes only the requested receipt rows', async () => {
    const db = new MemoryIndexDb();
    await rebuildReceiptItemIndex(db, receipt('a', [{ name: 'A' }]));
    await rebuildReceiptItemIndex(db, receipt('b', [{ name: 'B' }]));

    await deleteReceiptItemIndex(db, 'a');

    expect(await getReceiptItemIndexRows(db, 'a')).toEqual([]);
    expect(await getReceiptItemIndexRows(db, 'b')).toHaveLength(1);
  });

  it('clear removes all index rows without dropping the schema', async () => {
    const db = new MemoryIndexDb();
    await rebuildReceiptItemIndex(db, receipt('a', [{ name: 'A' }]));
    await rebuildReceiptItemIndex(db, receipt('b', [{ name: 'B' }]));

    await clearReceiptItemIndex(db);

    expect(await getReceiptItemIndexRows(db, 'a')).toEqual([]);
    expect(await getReceiptItemIndexRows(db, 'b')).toEqual([]);
  });

  it('rolls back delete when an insert fails and rethrows', async () => {
    const db = new MemoryIndexDb();
    await rebuildReceiptItemIndex(db, receipt('rollback', [{ name: 'old' }]));
    db.failNextInsert = true;

    await expect(
      rebuildReceiptItemIndex(db, receipt('rollback', [{ name: 'new' }]))
    ).rejects.toThrow('simulated insert failure');

    const rows = await getReceiptItemIndexRows(db, 'rollback');
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_name).toBe('old');
  });
});

describe('ensureReceiptItemsSchema', () => {
  it('is additive, repeatable, and creates all required ordinary indexes', async () => {
    const db = new MemoryIndexDb();

    await ensureReceiptItemsSchema(db);
    await ensureReceiptItemsSchema(db);

    const ddl = db.schemaCalls.join('\n');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS receipt_items');
    expect(ddl).toContain('UNIQUE(receipt_id, source_index)');
    expect(ddl).not.toMatch(/\bDROP\b|\bALTER\b|\bFTS5\b/i);
    for (const indexName of [
      'idx_receipt_items_receipt_id',
      'idx_receipt_items_normalized_name',
      'idx_receipt_items_normalized_full_name',
      'idx_receipt_items_canonical_product_name',
      'idx_receipt_items_family',
      'idx_receipt_items_brand',
      'idx_receipt_items_sku',
    ]) {
      expect(ddl).toContain(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    }
  });
});
