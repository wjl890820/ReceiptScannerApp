// lib/db.ts
import * as SQLite from 'expo-sqlite';
import { nanoid } from 'nanoid/non-secure';

/**
 * 说明：
 * - 使用 expo-sqlite 的 Async API（SDK 50+）
 * - receipts 表保存：原图 uri + merchant + total/tax/currency + analysis_json（完整识别 JSON）
 * - 分类/统计如果你是“运行时从 analysis_json 计算”，那 DB 不需要额外字段
 */

export type ReceiptRow = {
  id: string;
  created_at: number;

  image_uri: string;

  merchant_raw: string | null;
  merchant_normalized: string | null;

  total: number;
  tax: number;
  currency: string;

  analysis_json: string; // 保存完整 JSON（items、merchant、你后面加的 categories 等）

  // 用户手动编辑字段
  user_edited: number; // 0 或 1
  final_total: number | null;
  final_category: string | null;
  note: string | null;
  user_items_json: string | null; // 用户编辑后的商品列表 JSON
};

export type SaveReceiptParams = {
  imageUri: string;
  analysis: {
    merchant?: string;
    total: number;
    tax: number;
    currency: string;
    items: any[];
    // 你后面加什么字段都可以继续塞进 analysis_json
    [k: string]: any;
  };
};

let _db: SQLite.SQLiteDatabase | null = null;
let _inited = false;
let _initPromise: Promise<void> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('receipts.db');
  return _db;
}

async function initIfNeeded() {
  // 如果已经初始化完成，直接返回
  if (_inited) return;

  // 如果正在初始化，等待正在进行的初始化完成
  if (_initPromise) {
    await _initPromise;
    return;
  }

  // 创建初始化 Promise，确保只执行一次
  _initPromise = (async () => {
    try {
      const db = await getDb();

      // 建表
      await db.execAsync(`
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY NOT NULL,
          created_at INTEGER NOT NULL,

          image_uri TEXT NOT NULL,

          merchant_raw TEXT,
          merchant_normalized TEXT,

          total REAL NOT NULL,
          tax REAL NOT NULL,
          currency TEXT NOT NULL,

          analysis_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_receipts_created_at
          ON receipts(created_at DESC);

        CREATE TABLE IF NOT EXISTS item_category_mapping (
          normalized_name TEXT NOT NULL,
          merchant_hint TEXT NOT NULL DEFAULT '',
          category_id TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (normalized_name, merchant_hint)
        );

        CREATE INDEX IF NOT EXISTS idx_item_category_mapping_updated_at
          ON item_category_mapping(updated_at DESC);
        
        CREATE INDEX IF NOT EXISTS idx_item_category_mapping_name
          ON item_category_mapping(normalized_name);
        
        CREATE INDEX IF NOT EXISTS idx_item_category_mapping_name_hint
          ON item_category_mapping(normalized_name, merchant_hint);
      `);

      // 安全迁移：检查并添加新字段（如果不存在）
      // 使用 PRAGMA table_info 获取现有列，确保幂等性
      const tableInfo = await db.getAllAsync<{ name: string; type: string }>(
        `PRAGMA table_info(receipts)`
      );
      const columnNames = new Set(tableInfo.map((col) => col.name));

      // 只添加不存在的列，使用 try-catch 防止并发情况下的重复添加
      if (!columnNames.has('user_edited')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN user_edited INTEGER DEFAULT 0`);
        } catch (e: any) {
          // 如果列已存在（并发情况），忽略错误
          if (!e?.message?.includes('duplicate column')) {
            throw e;
          }
        }
      }
      if (!columnNames.has('final_total')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN final_total REAL`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) {
            throw e;
          }
        }
      }
      if (!columnNames.has('final_category')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN final_category TEXT`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) {
            throw e;
          }
        }
      }
      if (!columnNames.has('note')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN note TEXT`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) {
            throw e;
          }
        }
      }
      if (!columnNames.has('user_items_json')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN user_items_json TEXT`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) {
            throw e;
          }
        }
      }

      // 迁移 item_category_mapping 表结构（如果存在旧表）
      try {
        const oldTableInfo = await db.getAllAsync<{ name: string; type: string }>(
          `PRAGMA table_info(item_category_mapping)`
        );
        const oldColumnNames = new Set(oldTableInfo.map((col) => col.name));
        
        // 如果表存在但没有 merchant_hint 字段，需要迁移
        if (oldColumnNames.size > 0 && !oldColumnNames.has('merchant_hint')) {
          // 创建新表（merchant_hint 默认值为 ''）
          await db.execAsync(`
            CREATE TABLE IF NOT EXISTS item_category_mapping_new (
              normalized_name TEXT NOT NULL,
              merchant_hint TEXT NOT NULL DEFAULT '',
              category_id TEXT NOT NULL,
              confidence REAL NOT NULL DEFAULT 1.0,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (normalized_name, merchant_hint)
            );
            
            INSERT INTO item_category_mapping_new (normalized_name, merchant_hint, category_id, confidence, updated_at)
            SELECT 
              normalized_name, 
              COALESCE(merchant_hint, '') as merchant_hint,
              COALESCE(category_id, category) as category_id,
              COALESCE(confidence, 1.0) as confidence,
              updated_at
            FROM item_category_mapping;
            
            DROP TABLE item_category_mapping;
            ALTER TABLE item_category_mapping_new RENAME TO item_category_mapping;
            
            CREATE INDEX IF NOT EXISTS idx_item_category_mapping_updated_at
              ON item_category_mapping(updated_at DESC);
            
            CREATE INDEX IF NOT EXISTS idx_item_category_mapping_name
              ON item_category_mapping(normalized_name);
            
            CREATE INDEX IF NOT EXISTS idx_item_category_mapping_name_hint
              ON item_category_mapping(normalized_name, merchant_hint);
          `);
        } else if (oldColumnNames.size > 0 && oldColumnNames.has('merchant_hint')) {
          // 表已存在 merchant_hint，但可能为 NULL，需要更新为 ''
          // 同时确保 confidence 字段存在
          if (!oldColumnNames.has('confidence')) {
            await db.runAsync(`ALTER TABLE item_category_mapping ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0`);
          }
          
          // 更新所有 NULL merchant_hint 为 ''
          await db.runAsync(`
            UPDATE item_category_mapping 
            SET merchant_hint = '' 
            WHERE merchant_hint IS NULL
          `);
          
          // 确保索引存在
          await db.execAsync(`
            CREATE INDEX IF NOT EXISTS idx_item_category_mapping_updated_at
              ON item_category_mapping(updated_at DESC);
            
            CREATE INDEX IF NOT EXISTS idx_item_category_mapping_name
              ON item_category_mapping(normalized_name);
            
            CREATE INDEX IF NOT EXISTS idx_item_category_mapping_name_hint
              ON item_category_mapping(normalized_name, merchant_hint);
          `);
        }
      } catch (e: any) {
        // 如果迁移失败，忽略（可能是表不存在或已是最新结构）
        if (!e?.message?.includes('no such table')) {
          console.warn('[DB] Failed to migrate item_category_mapping:', e);
        }
      }

      // 所有迁移完成后才设置 _inited 标志
      _inited = true;
    } catch (error) {
      // 如果初始化失败，清除 Promise 以便重试
      _initPromise = null;
      
      // 开发模式：如果迁移失败且可能是由于不兼容的 schema，尝试重置数据库
      if (__DEV__) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('no such table') ||
          errorMessage.includes('duplicate column') ||
          errorMessage.includes('syntax error')
        ) {
          console.warn('[DB] Migration failed, attempting to reset database in dev mode:', errorMessage);
          try {
            const db = await getDb();
            
            // 尝试删除所有表并重新创建
            await db.execAsync(`
              DROP TABLE IF EXISTS item_category_mapping;
              DROP TABLE IF EXISTS receipts;
            `);
            
            // 关闭连接
            await db.closeAsync();
            _db = null;
            
            // 重置状态
            _inited = false;
            _initPromise = null;
            
            // 重试初始化（会重新创建所有表）
            console.log('[DB] Retrying initialization after reset...');
            return await initIfNeeded();
          } catch (resetError) {
            console.error('[DB] Failed to reset database:', resetError);
            throw error; // 抛出原始错误
          }
        }
      }
      
      throw error;
    }
  })();

  await _initPromise;
}

/**
 * 导出初始化函数供其他模块使用（如 categoryLearner）
 */
export { initIfNeeded };

/**
 * 保存一条记录（你现在是“手动保存”按钮触发）
 */
export async function saveReceipt(params: SaveReceiptParams): Promise<string> {
  await initIfNeeded();
  const db = await getDb();

  const id = nanoid();
  const now = Date.now();

  const merchantRaw =
    typeof params.analysis.merchant === 'string' ? params.analysis.merchant : null;

  // normalized 目前先等同 raw（你后面要做统一化再改这里）
  const merchantNormalized = merchantRaw;

  const total = Number.isFinite(params.analysis.total) ? params.analysis.total : 0;
  const tax = Number.isFinite(params.analysis.tax) ? params.analysis.tax : 0;
  const currency =
    typeof params.analysis.currency === 'string' && params.analysis.currency.trim()
      ? params.analysis.currency
      : 'JPY';

  const analysisJson = JSON.stringify(params.analysis);

  await db.runAsync(
    `
    INSERT INTO receipts (
      id, created_at,
      image_uri,
      merchant_raw, merchant_normalized,
      total, tax, currency,
      analysis_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      now,
      params.imageUri,
      merchantRaw,
      merchantNormalized,
      total,
      tax,
      currency,
      analysisJson,
    ]
  );

  return id;
}

/**
 * 列表：按时间倒序
 */
export async function listReceipts(limit = 200): Promise<ReceiptRow[]> {
  await initIfNeeded();
  const db = await getDb();

  const rows = await db.getAllAsync<ReceiptRow>(
    `
    SELECT
      id, created_at,
      image_uri,
      merchant_raw, merchant_normalized,
      total, tax, currency,
      analysis_json,
      COALESCE(user_edited, 0) as user_edited,
      final_total,
      final_category,
      note,
      user_items_json
    FROM receipts
    ORDER BY created_at DESC
    LIMIT ?
    `,
    [limit]
  );

  return rows ?? [];
}

/**
 * 详情：按 id 获取一条
 * 重点：你现在 [id].tsx 调用的就是这个函数名 getReceipt
 */
export async function getReceipt(id: string): Promise<ReceiptRow | null> {
  await initIfNeeded();
  const db = await getDb();

  const row = await db.getFirstAsync<ReceiptRow>(
    `
    SELECT
      id, created_at,
      image_uri,
      merchant_raw, merchant_normalized,
      total, tax, currency,
      analysis_json,
      COALESCE(user_edited, 0) as user_edited,
      final_total,
      final_category,
      note,
      user_items_json
    FROM receipts
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  return row ?? null;
}

/**
 * 删除一条
 */
export async function deleteReceipt(id: string): Promise<void> {
  await initIfNeeded();
  const db = await getDb();
  await db.runAsync(`DELETE FROM receipts WHERE id = ?`, [id]);
}

/**
 * 清空（可选）
 */
export async function clearReceipts(): Promise<void> {
  await initIfNeeded();
  const db = await getDb();
  await db.runAsync(`DELETE FROM receipts`);
}

/**
 * 更新（A3 可编辑纠错会用到）
 * 你传入任何字段都可以覆盖：total/tax/currency/merchant/items 等（统一存在 analysis_json）
 * 也支持更新用户手动编辑字段：user_edited, final_total, final_category, note
 */
export async function updateReceipt(params: {
  id: string;
  imageUri?: string;
  analysis?: any;
  user_edited?: number;
  final_total?: number | null;
  final_category?: string | null;
  note?: string | null;
  user_items_json?: string | null;
}): Promise<void> {
  await initIfNeeded();
  const db = await getDb();

  const sets: string[] = [];
  const values: any[] = [];

  if (typeof params.imageUri === 'string') {
    sets.push(`image_uri = ?`);
    values.push(params.imageUri);
  }

  if (params.analysis && typeof params.analysis === 'object') {
    const merchantRaw =
      typeof params.analysis.merchant === 'string' ? params.analysis.merchant : null;
    const merchantNormalized = merchantRaw;

    const total = Number.isFinite(params.analysis.total) ? params.analysis.total : 0;
    const tax = Number.isFinite(params.analysis.tax) ? params.analysis.tax : 0;
    const currency =
      typeof params.analysis.currency === 'string' && params.analysis.currency.trim()
        ? params.analysis.currency
        : 'JPY';

    sets.push(`merchant_raw = ?`);
    values.push(merchantRaw);

    sets.push(`merchant_normalized = ?`);
    values.push(merchantNormalized);

    sets.push(`total = ?`);
    values.push(total);

    sets.push(`tax = ?`);
    values.push(tax);

    sets.push(`currency = ?`);
    values.push(currency);

    sets.push(`analysis_json = ?`);
    values.push(JSON.stringify(params.analysis));
  }

  // 支持用户手动编辑字段
  if (params.user_edited !== undefined) {
    sets.push(`user_edited = ?`);
    values.push(params.user_edited === 1 ? 1 : 0);
  }

  if (params.final_total !== undefined) {
    sets.push(`final_total = ?`);
    values.push(
      params.final_total !== null && Number.isFinite(params.final_total)
        ? params.final_total
        : null
    );
  }

  if (params.final_category !== undefined) {
    sets.push(`final_category = ?`);
    values.push(
      params.final_category !== null && typeof params.final_category === 'string'
        ? params.final_category.trim() || null
        : null
    );
  }

  if (params.note !== undefined) {
    sets.push(`note = ?`);
    values.push(
      params.note !== null && typeof params.note === 'string'
        ? params.note.trim() || null
        : null
    );
  }

  if (params.user_items_json !== undefined) {
    sets.push(`user_items_json = ?`);
    values.push(
      params.user_items_json !== null && typeof params.user_items_json === 'string'
        ? params.user_items_json.trim() || null
        : null
    );
  }

  if (sets.length === 0) return;

  values.push(params.id);

  await db.runAsync(
    `
    UPDATE receipts
    SET ${sets.join(', ')}
    WHERE id = ?
    `,
    values
  );
}
