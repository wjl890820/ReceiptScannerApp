// lib/categoryLearner.ts
import * as SQLite from 'expo-sqlite';
import { ALL_CATEGORIES, type Category } from './categories';
import { initIfNeeded } from './db';
import { normalizeMerchantName } from './productNormalizer';

// Re-export for backward compatibility (deprecated, use categories.ts)
/** @deprecated Use GROCERY_CATEGORIES from './categories' instead */
export const STANDARD_CATEGORIES = ALL_CATEGORIES as readonly string[];

let _db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  // 确保数据库已初始化（包括 item_category_mapping 表）
  await initIfNeeded();
  
  if (!_db) {
    // IMPORTANT: must match lib/db.ts DB_NAME (receipts_v2.db)
    _db = await SQLite.openDatabaseAsync('receipts_v2.db');
  }
  return _db;
}

/**
 * 学习来源 provenance：
 *  - 'user_edit'：用户在审核页/历史详情手动修改过分类（最高优先，可覆盖规则）。
 *  - 'auto'：自动分类结果（规则/AI）。不再写入；仅历史遗留可能存在。
 *  - null（legacy）：无 provenance 的旧数据，视为脏数据，不得高于 name_rule。
 */
export type LearnedCategorySource = 'user_edit' | 'auto';

async function ensureMappingTableExists(db: SQLite.SQLiteDatabase): Promise<void> {
  try {
    await db.execAsync(`
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
    `);
    // 幂等补列：旧库可能没有 source 列。
    try {
      const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(item_category_mapping)`);
      if (cols.length > 0 && !cols.some((c) => c.name === 'source')) {
        await db.runAsync(`ALTER TABLE item_category_mapping ADD COLUMN source TEXT`);
      }
    } catch {
      // 忽略：补列失败时按无 source（legacy）处理。
    }
  } catch {
    // Non-fatal: callers will fall back to rules/fallback when mapping isn't available.
  }
}

/**
 * Learn category mapping (from user edit or high-confidence classification)
 * merchantHint: normalized merchant name or empty string '' for general mapping
 */
export async function learnCategoryMapping(
  normalizedName: string,
  merchantHint: string | null,
  categoryId: string,
  confidence: number = 1.0,
  source: LearnedCategorySource = 'user_edit'
): Promise<void> {
  if (!normalizedName || !categoryId) return;

  const db = await getDb();
  await ensureMappingTableExists(db);
  const now = Date.now();

  // 与 getLearnedCategory / classifyItem 一致：商户 hint 使用 normalizeMerchantName
  const normalizedMerchantHint = merchantHint
    ? normalizeMerchantName(merchantHint)
    : '';

  await db.runAsync(
    `
    INSERT OR REPLACE INTO item_category_mapping 
    (normalized_name, merchant_hint, category_id, confidence, updated_at, source)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      normalizedName.trim().toLowerCase(),
      normalizedMerchantHint,
      categoryId.trim(),
      confidence,
      now,
      source,
    ]
  );
}

/**
 * 从用户编辑历史中学习分类（向后兼容）
 */
export async function learnCategoryFromEdit(
  normalizedName: string,
  category: string
): Promise<void> {
  await learnCategoryMapping(normalizedName, null, category, 1.0, 'user_edit');
}

/**
 * 一次性清理 legacy / auto 学习脏数据。
 * 仅保留 source='user_edit'（用户手动修改）的学习记录，删除：
 *  - source IS NULL（无 provenance 的旧自动学习数据，曾由扫描自动写入污染）
 *  - source != 'user_edit'（如 'auto'）
 * 不动收据历史，只清理 item_category_mapping。返回删除行数。
 */
export async function invalidateLegacyCategoryLearning(): Promise<number> {
  const db = await getDb();
  await ensureMappingTableExists(db);
  try {
    const res = await db.runAsync(
      `DELETE FROM item_category_mapping WHERE source IS NULL OR source <> 'user_edit'`
    );
    return (res as any)?.changes ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get learned category (with optional merchant hint)
 * Strategy:
 *  a) Query merchant-specific row (merchant_hint = normalized merchant) first
 *  b) Fallback to merchant_hint = '' row (general mapping)
 */
export type LearnedCategoryEntry = {
  category: string;
  /** 'user_edit' | 'auto' | null(legacy)。仅 'user_edit' 可享最高优先。 */
  source: string | null;
};

/**
 * 查询学习分类（含 provenance）。
 * 调用方据 source 决定优先级：仅 'user_edit' 可覆盖 name_rule，legacy/auto 不得。
 */
export async function getLearnedCategoryEntry(
  normalizedName: string,
  merchantHint?: string | null
): Promise<LearnedCategoryEntry | null> {
  if (!normalizedName) return null;

  const db = await getDb();
  await ensureMappingTableExists(db);
  const normalized = normalizedName.trim().toLowerCase();

  // Try with merchant hint first (more specific)
  if (merchantHint) {
    const normalizedMerchantHint = normalizeMerchantName(merchantHint);
    try {
      const rowWithHint = await db.getFirstAsync<{ category_id: string; source: string | null }>(
        `
        SELECT category_id, source FROM item_category_mapping
        WHERE normalized_name = ? AND merchant_hint = ?
        ORDER BY confidence DESC, updated_at DESC
        LIMIT 1
        `,
        [normalized, normalizedMerchantHint]
      );
      if (rowWithHint?.category_id) {
        return { category: rowWithHint.category_id, source: rowWithHint.source ?? null };
      }
    } catch {
      return null;
    }
  }

  // Fallback to without merchant hint (general mapping: merchant_hint = '')
  try {
    const row = await db.getFirstAsync<{ category_id: string; source: string | null }>(
      `
      SELECT category_id, source FROM item_category_mapping
      WHERE normalized_name = ? AND merchant_hint = ''
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 1
      `,
      [normalized]
    );
    return row?.category_id ? { category: row.category_id, source: row.source ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Get learned category id (string), regardless of provenance (向后兼容)。
 * 新代码请用 getLearnedCategoryEntry 以区分 user_edit / legacy。
 */
export async function getLearnedCategory(
  normalizedName: string,
  merchantHint?: string | null
): Promise<string | null> {
  const entry = await getLearnedCategoryEntry(normalizedName, merchantHint);
  return entry?.category ?? null;
}

/**
 * 获取所有已学习的映射（用于调试/导出）
 */
export async function getAllLearnedMappings(): Promise<
  Array<{ name: string; merchantHint: string | null; category: string; confidence: number }>
> {
  const db = await getDb();
  await ensureMappingTableExists(db);
  const rows = await db.getAllAsync<{
    normalized_name: string;
    merchant_hint: string | null;
    category_id: string;
    confidence: number;
  }>(
    `SELECT normalized_name, merchant_hint, category_id, confidence FROM item_category_mapping ORDER BY updated_at DESC`
  );

  return rows.map((r) => ({
    name: r.normalized_name,
    merchantHint: r.merchant_hint,
    category: r.category_id,
    confidence: r.confidence,
  }));
}
