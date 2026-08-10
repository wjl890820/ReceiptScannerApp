// lib/db.ts
import * as SQLite from 'expo-sqlite';
import { nanoid } from 'nanoid/non-secure';
import { listReceiptsForListParams } from './receiptListQuery';
import { detectMerchantType, type MerchantType } from './merchantType';

/**
 * 说明：
 * - 使用 expo-sqlite 的 Async API（SDK 50+）
 * - receipts 表保存：原图 uri + merchant + total/tax/currency + analysis_json（完整识别 JSON）
 * - 分类/统计如果你是“运行时从 analysis_json 计算”，那 DB 不需要额外字段
 */

export type ReceiptRow = {
  id: string;
  created_at: number;
  transaction_at: number | null; // Receipt transaction date (from receipt itself), fallback to created_at if null
  scanned_at?: number | null;

  image_uri: string;

  merchant_raw: string | null;
  merchant_normalized: string | null;
  /** V1 additive：商户类型（supermarket / convenience / other / unknown） */
  merchant_type?: MerchantType | null;
  store_raw?: string | null;
  store_normalized?: string | null;
  source?: string | null;

  total: number;
  tax: number;
  currency: string;

  analysis_json: string; // 保存完整 JSON（items、merchant、你后面加的 categories 等）
  /** 审核闭环：识别完成时点的快照 JSON（人工修正写入 analysis_json） */
  recognition_snapshot_json?: string | null;

  // 用户手动编辑字段
  user_edited: number; // 0 或 1
  final_total: number | null;
  final_category: string | null;
  note: string | null;
  user_items_json: string | null; // 用户编辑后的商品列表 JSON
};

/** 列表用：不含 image_uri，减少内存/IO（历史列表不展示缩略图） */
export type ReceiptListRow = Omit<ReceiptRow, 'image_uri'>;

/**
 * 历史列表查询选项。searchQuery 已在 DB 层用于 merchant/note LIKE。
 */
export type ListReceiptsOptions = {
  limit?: number;
  offset?: number;
  sortBy?: 'date' | 'total';
  /** 预留：关键词/商户过滤，当前未实现 */
  searchQuery?: string;
};

export type SaveReceiptParams = {
  imageUri: string;
  source?: 'self' | 'family' | 'friend' | 'found' | 'test' | 'unknown';
  analysis: {
    merchant?: string;
    total: number;
    tax: number;
    currency: string;
    items: any[];
    // 你后面加什么字段都可以继续塞进 analysis_json
    [k: string]: any;
  };
  /** 与 analysis 分离存储的识别快照（审核保存时写入；直扫旧路径可省略） */
  recognitionSnapshot?: unknown;
  /** 审核页保存：标记 user_edited=1 */
  reviewedSave?: boolean;
  note?: string | null;
};

let _db: SQLite.SQLiteDatabase | null = null;
let _inited = false;
let _initPromise: Promise<void> | null = null;

// 数据库版本升级：使用 receipts_v2.db（强制新 schema，包含 transaction_at）
const DB_NAME = 'receipts_v2.db';

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  return _db;
}

// receiptsHasTransactionAt 函数已删除
// 新数据库 receipts_v2.db 强制包含 transaction_at 列，不再需要检测

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
          transaction_at INTEGER,

          image_uri TEXT NOT NULL,

          merchant_raw TEXT,
          merchant_normalized TEXT,

          total REAL NOT NULL,
          tax REAL NOT NULL,
          currency TEXT NOT NULL,

          analysis_json TEXT NOT NULL,
          recognition_snapshot_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_receipts_created_at
          ON receipts(created_at DESC);
        
        CREATE INDEX IF NOT EXISTS idx_receipts_transaction_at
          ON receipts(transaction_at ASC);
        
        -- 复合索引用于 COALESCE(transaction_at, created_at) 排序优化
        CREATE INDEX IF NOT EXISTS idx_receipts_transaction_created
          ON receipts(transaction_at ASC, created_at ASC);

        CREATE TABLE IF NOT EXISTS item_category_mapping (
          normalized_name TEXT NOT NULL,
          merchant_hint TEXT NOT NULL DEFAULT '',
          category_id TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          updated_at INTEGER NOT NULL,
          source TEXT,
          PRIMARY KEY (normalized_name, merchant_hint)
        );

        CREATE INDEX IF NOT EXISTS idx_item_category_mapping_updated_at
          ON item_category_mapping(updated_at DESC);
        
        CREATE INDEX IF NOT EXISTS idx_item_category_mapping_name
          ON item_category_mapping(normalized_name);
        
        CREATE INDEX IF NOT EXISTS idx_item_category_mapping_name_hint
          ON item_category_mapping(normalized_name, merchant_hint);

        -- Product dictionary: normalized_name -> canonical/main/sub/tags (asset layer)
        -- analysis_tags stored as JSON string of string[]
        CREATE TABLE IF NOT EXISTS product_dictionary (
          id TEXT PRIMARY KEY NOT NULL,
          normalized_name TEXT NOT NULL,
          canonical_name TEXT,
          brand TEXT,
          category_main TEXT NOT NULL,
          category_sub TEXT,
          analysis_tags TEXT NOT NULL DEFAULT '[]',
          source_type TEXT NOT NULL DEFAULT 'unknown',
          seen_count INTEGER NOT NULL DEFAULT 0,
          last_seen_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ux_product_dictionary_normalized_name
          ON product_dictionary(normalized_name);

        -- Exact aliases: normalized OCR/abbrev -> canonical_name + category (optional merchant_hint)
        CREATE TABLE IF NOT EXISTS product_name_alias (
          alias_normalized TEXT NOT NULL,
          merchant_hint TEXT NOT NULL DEFAULT '',
          canonical_name TEXT NOT NULL,
          category_main TEXT NOT NULL,
          category_sub TEXT,
          analysis_tags TEXT NOT NULL DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 1.0,
          source TEXT NOT NULL DEFAULT 'rule',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (alias_normalized, merchant_hint)
        );

        CREATE INDEX IF NOT EXISTS idx_product_name_alias_lookup
          ON product_name_alias(alias_normalized, merchant_hint);

        -- 审核草稿持久化（冷启动可恢复）
        CREATE TABLE IF NOT EXISTS scan_review_draft (
          id TEXT PRIMARY KEY NOT NULL,
          image_uri TEXT NOT NULL,
          recognition_snapshot_json TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          editor_state_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_scan_review_draft_updated
          ON scan_review_draft(updated_at DESC);

        CREATE TABLE IF NOT EXISTS scan_review_queue (
          slot INTEGER PRIMARY KEY NOT NULL CHECK (slot = 1),
          queue_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // 安全迁移：检查并添加新字段（如果不存在）
      // 使用 PRAGMA table_info 获取现有列，确保幂等性
      const tableInfo = await db.getAllAsync<{ name: string; type: string }>(
        `PRAGMA table_info(receipts)`
      );
      const columnNames = new Set(tableInfo.map((col) => col.name));

      // 只添加不存在的列，使用 try-catch 防止并发情况下的重复添加
      if (!columnNames.has('source')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN source TEXT NOT NULL DEFAULT 'self'`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) throw e;
        }
      }
      if (!columnNames.has('store_raw')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN store_raw TEXT`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) throw e;
        }
      }
      if (!columnNames.has('store_normalized')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN store_normalized TEXT`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) throw e;
        }
      }
      if (!columnNames.has('scanned_at')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN scanned_at INTEGER`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) throw e;
        }
      }
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
      if (!columnNames.has('merchant_type')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN merchant_type TEXT`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) {
            throw e;
          }
        }
      }
      if (!columnNames.has('recognition_snapshot_json')) {
        try {
          await db.runAsync(`ALTER TABLE receipts ADD COLUMN recognition_snapshot_json TEXT`);
        } catch (e: any) {
          if (!e?.message?.includes('duplicate column')) {
            throw e;
          }
        }
      }
      // 新数据库 receipts_v2.db 已包含 transaction_at 列，无需迁移

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

      // 迁移：item_category_mapping 增加 source 列 + 一次性清理 legacy/auto 学习脏数据。
      // 旧版本会在普通扫描时自动写入学习表（无 provenance），导致错误分类自我强化
      // （如 シュガーバター 被旧数据学成 food_ingredients）。新增 source 列后，所有旧行
      // 的 source 均为 NULL，一次性删除非 user_edit 行，仅保留用户手动修改的学习。
      try {
        const mapInfo = await db.getAllAsync<{ name: string }>(
          `PRAGMA table_info(item_category_mapping)`
        );
        const mapCols = new Set(mapInfo.map((c) => c.name));
        if (mapCols.size > 0 && !mapCols.has('source')) {
          await db.runAsync(`ALTER TABLE item_category_mapping ADD COLUMN source TEXT`);
          // 列刚新增，存量行 source 全为 NULL → 清理 legacy/auto 脏数据（仅一次）。
          const res = await db.runAsync(
            `DELETE FROM item_category_mapping WHERE source IS NULL OR source <> 'user_edit'`
          );
          const removed = (res as any)?.changes ?? 0;
          if (removed > 0) {
            console.warn(`[DB] Cleaned ${removed} legacy/auto item_category_mapping rows`);
          }
        }
      } catch (e: any) {
        if (!e?.message?.includes('no such table')) {
          console.warn('[DB] Failed to migrate item_category_mapping source column:', e);
        }
      }

      // Migrate product_dictionary: add source_type if missing
      try {
        const pdInfo = await db.getAllAsync<{ name: string; type: string }>(
          `PRAGMA table_info(product_dictionary)`
        );
        const pdCols = new Set(pdInfo.map((c) => c.name));
        if (pdCols.size > 0 && !pdCols.has('source_type')) {
          await db.runAsync(`ALTER TABLE product_dictionary ADD COLUMN source_type TEXT NOT NULL DEFAULT 'unknown'`);
        }
      } catch (e: any) {
        if (!e?.message?.includes('no such table')) {
          console.warn('[DB] Failed to migrate product_dictionary:', e);
        }
      }

      try {
        const { seedBuiltinProductAliases } = await import('./productAlias');
        await seedBuiltinProductAliases(db);
      } catch (e: any) {
        console.warn('[DB] Failed to seed product_name_alias:', e);
      }

      try {
        await db.runAsync(
          `INSERT OR IGNORE INTO scan_review_queue (slot, queue_json, updated_at) VALUES (1, '[]', ?)`,
          [Date.now()]
        );
      } catch (e: any) {
        if (!e?.message?.includes('no such table')) {
          console.warn('[DB] Failed to seed scan_review_queue:', e);
        }
      }

      // 所有迁移完成后才设置 _inited 标志
      _inited = true;

      // 临时"核爆式验证"（DEV ONLY）
      if (__DEV__) {
        try {
          const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(receipts)`);
          console.log(
            '[DB][FINAL SCHEMA]',
            rows.map((r) => r.name).join(', ')
          );
        } catch (e) {
          console.warn('[DB] Failed to print final schema:', e);
        }
      }
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

// debugReceiptsSchema 函数已移除，改为在 initIfNeeded 最后直接打印

// 新数据库 receipts_v2.db 强制包含 transaction_at 列，不再需要复杂的检测和迁移逻辑
// 旧数据库 receipts.db 已弃用，用户需要重新扫描小票（V1 前允许的破坏性升级）

/**
 * 保存一条记录（你现在是“手动保存”按钮触发）
 */
export async function saveReceipt(
  params: SaveReceiptParams,
  trace?: { id: string; t0: number }
): Promise<string> {
  // Timing: write start/end around DB ops
  const tSave0 = Date.now();
  if (__DEV__ && trace) {
    // eslint-disable-next-line no-console
    console.log('[ScanTiming] db_save_start', { id: trace.id });
  }
  await initIfNeeded();
  const db = await getDb();

  const id = nanoid();
  const now = Date.now();

  const merchantRaw =
    typeof params.analysis.merchant === 'string' ? params.analysis.merchant : null;

  const merchantRawTrimmed = merchantRaw && merchantRaw.trim() ? merchantRaw.trim() : null;
  const merchantNormalized =
    merchantRawTrimmed ? merchantRawTrimmed.replace(/\s+/g, ' ').trim().toLowerCase() : null;

  const merchantType = detectMerchantType(merchantRawTrimmed, merchantNormalized);

  // New stable fields
  const source = params.source || 'self';
  const storeRaw = merchantRawTrimmed;
  const storeNormalized = merchantNormalized;
  const scannedAt = now;

  const total = Number.isFinite(params.analysis.total) ? params.analysis.total : 0;
  const tax = Number.isFinite(params.analysis.tax) ? params.analysis.tax : 0;
  const currency =
    typeof params.analysis.currency === 'string' && params.analysis.currency.trim()
      ? params.analysis.currency
      : 'JPY';

  const analysisJson = JSON.stringify(params.analysis);
  const recognitionSnapshotJson =
    params.recognitionSnapshot !== undefined && params.recognitionSnapshot !== null
      ? JSON.stringify(params.recognitionSnapshot)
      : null;

  // Extract transaction_at from analysis.transactionDate (或 transactionAt / purchasedAt / datetime)
  // 仅日期：dateParser 用当天 00:00；日期+时间：按原字符串解析（ISO 或本地/Asia/Tokyo 格式）；解析失败则 null，排序回退 created_at
  let transactionAt: number | null = null;
  const txDateStr =
    params.analysis.transactionDate ||
    (params.analysis as any).transactionAt ||
    (params.analysis as any).purchasedAt ||
    (params.analysis as any).datetime;
  if (txDateStr && typeof txDateStr === 'string' && txDateStr.trim()) {
    try {
      const isoDate = new Date(txDateStr.trim());
      if (!isNaN(isoDate.getTime())) {
        transactionAt = isoDate.getTime();
      } else {
        const { parseReceiptDateTime } = await import('./dateParser');
        transactionAt = parseReceiptDateTime(txDateStr.trim(), false);
      }
    } catch (e) {
      if (__DEV__) {
        console.warn('[DB] Failed to parse transactionDate:', txDateStr, e);
      }
    }
  }

  // 新数据库 receipts_v2.db 强制包含 transaction_at 列，直接使用
  const insertSql = `
    INSERT INTO receipts (
      id, created_at, transaction_at,
      scanned_at,
      image_uri,
      source,
      merchant_raw, merchant_normalized,
      merchant_type,
      store_raw, store_normalized,
      total, tax, currency,
      analysis_json,
      recognition_snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const insertParams = [
    id,
    now,
    transactionAt,
    scannedAt,
    params.imageUri,
    source,
    merchantRawTrimmed,
    merchantNormalized,
    merchantType,
    storeRaw,
    storeNormalized,
    total,
    tax,
    currency,
    analysisJson,
    recognitionSnapshotJson,
  ];
  const placeholderCount = (insertSql.match(/\?/g) ?? []).length;
  if (__DEV__ && trace) {
    const preview = insertParams.map((v, i) => {
      if (typeof v === 'string' && v.length > 120) return { i, kind: 'string', len: v.length, head: v.slice(0, 120) + '…' };
      return { i, v };
    });
    // eslint-disable-next-line no-console
    console.log('[DB][saveReceipt] insert shape', {
      insertColumnsCount: 16,
      placeholderCount,
      paramsCount: insertParams.length,
      preview,
    });
  }
  await db.runAsync(insertSql, insertParams);

  if (params.reviewedSave || params.note !== undefined) {
    const sets: string[] = [];
    const vals: SQLite.SQLiteBindValue[] = [];
    if (params.reviewedSave) {
      sets.push('user_edited = 1');
    }
    if (params.note !== undefined) {
      sets.push('note = ?');
      vals.push(params.note !== null && typeof params.note === 'string' ? params.note.trim() || null : null);
    }
    if (sets.length > 0) {
      vals.push(id);
      await db.runAsync(`UPDATE receipts SET ${sets.join(', ')} WHERE id = ?`, vals);
    }
  }

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[DB] saved receipt:', { id: id.slice(0, 8), txAt: !!transactionAt, createdAt: true });
  }
  if (__DEV__ && trace) {
    // eslint-disable-next-line no-console
    console.log('[ScanTiming] db_save_end_ms', { id: trace.id, ms: Date.now() - tSave0 });
  }
  return id;
}

/**
 * 列表：按时间升序（从过去到现在）
 * 排序依据：优先 transaction_at（小票发生时间），没有则 fallback created_at
 * 新数据库 receipts_v2.db 强制包含 transaction_at 列，直接使用
 */
export async function listReceipts(limit = 200): Promise<ReceiptRow[]> {
  await initIfNeeded();
  const db = await getDb();

  const rows = await db.getAllAsync<ReceiptRow>(
    `
    SELECT
      id, created_at,
      COALESCE(transaction_at, created_at) AS transaction_at,
      image_uri,
      merchant_raw, merchant_normalized,
      merchant_type,
      total, tax, currency,
      analysis_json,
      COALESCE(user_edited, 0) as user_edited,
      final_total,
      final_category,
      note,
      user_items_json
    FROM receipts
    ORDER BY COALESCE(transaction_at, created_at) DESC
    LIMIT ?
    `,
    [limit]
  );

  return rows ?? [];
}

/**
 * 列表（历史等）：不查 image_uri，减少内存/IO；列表不展示缩略图。
 * 支持 options：limit、offset、sortBy（date | total）、searchQuery（merchant/note LIKE）。
 */
export async function listReceiptsForList(
  options?: ListReceiptsOptions | number
): Promise<ReceiptListRow[]> {
  await initIfNeeded();
  const db = await getDb();
  const { orderBy, limit, offset, whereClause, whereParams } = listReceiptsForListParams(options);

  const rows = await db.getAllAsync<ReceiptListRow>(
    `
    SELECT
      id, created_at,
      COALESCE(transaction_at, created_at) AS transaction_at,
      merchant_raw, merchant_normalized,
      merchant_type,
      total, tax, currency,
      analysis_json,
      COALESCE(user_edited, 0) as user_edited,
      final_total,
      final_category,
      note,
      user_items_json
    FROM receipts
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
    `,
    [...whereParams, limit, offset]
  );

  return rows ?? [];
}

/**
 * 详情：按 id 获取一条
 * 新数据库 receipts_v2.db 强制包含 transaction_at 列，直接使用
 */
/** 复盘统计：仅拉取带识别快照的行（审核闭环落库） */
export type ReceiptReviewStatsRow = {
  id: string;
  created_at: number;
  analysis_json: string;
  recognition_snapshot_json: string;
};

export async function listReceiptsForReviewStats(limit = 2000): Promise<ReceiptReviewStatsRow[]> {
  await initIfNeeded();
  const db = await getDb();
  const lim = Math.max(1, Math.min(10000, limit));
  const rows = await db.getAllAsync<ReceiptReviewStatsRow>(
    `
    SELECT id, created_at, analysis_json, recognition_snapshot_json
    FROM receipts
    WHERE recognition_snapshot_json IS NOT NULL
      AND TRIM(recognition_snapshot_json) != ''
    ORDER BY created_at DESC
    LIMIT ?
    `,
    [lim]
  );
  return rows ?? [];
}

export async function listManualProductNameAliases(): Promise<
  { alias_normalized: string; canonical_name: string; merchant_hint: string }[]
> {
  await initIfNeeded();
  const db = await getDb();
  try {
    const rows = await db.getAllAsync<{
      alias_normalized: string;
      canonical_name: string;
      merchant_hint: string;
    }>(
      `SELECT alias_normalized, canonical_name, merchant_hint
       FROM product_name_alias
       WHERE source = 'manual'`
    );
    return rows ?? [];
  } catch {
    return [];
  }
}

export async function countManualProductDictionaryEntries(): Promise<number> {
  await initIfNeeded();
  const db = await getDb();
  try {
    const row = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(1) as c FROM product_dictionary WHERE source_type = 'manual'`
    );
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export async function getReceipt(id: string): Promise<ReceiptRow | null> {
  await initIfNeeded();
  const db = await getDb();

  const row = await db.getFirstAsync<ReceiptRow>(
    `
    SELECT
      id, created_at,
      COALESCE(transaction_at, created_at) AS transaction_at,
      image_uri,
      merchant_raw, merchant_normalized,
      merchant_type,
      total, tax, currency,
      analysis_json,
      recognition_snapshot_json,
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
 * 批量删除（事务内一次性执行）。关联数据：仅 receipts 表；item_category_mapping 为全局学习表不删。
 * 用于单条删除、批量删除；priceRadar / Analysis 无持久缓存，删后重拉即可。
 */
export async function deleteReceipts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await initIfNeeded();
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(
    `DELETE FROM receipts WHERE id IN (${placeholders})`,
    ids
  );
}

/**
 * 删除一条（复用批量删除）
 */
export async function deleteReceipt(id: string): Promise<void> {
  await deleteReceipts([id]);
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
