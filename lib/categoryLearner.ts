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

async function ensureMappingTableExists(db: SQLite.SQLiteDatabase): Promise<void> {
  try {
    await db.execAsync(`
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
  confidence: number = 1.0
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
    (normalized_name, merchant_hint, category_id, confidence, updated_at)
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      normalizedName.trim().toLowerCase(),
      normalizedMerchantHint,
      categoryId.trim(),
      confidence,
      now,
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
  await learnCategoryMapping(normalizedName, null, category, 1.0);
}

/**
 * Get learned category (with optional merchant hint)
 * Strategy:
 *  a) Query merchant-specific row (merchant_hint = normalized merchant) first
 *  b) Fallback to merchant_hint = '' row (general mapping)
 */
export async function getLearnedCategory(
  normalizedName: string,
  merchantHint?: string | null
): Promise<string | null> {
  if (!normalizedName) return null;

  const db = await getDb();
  await ensureMappingTableExists(db);
  const normalized = normalizedName.trim().toLowerCase();
  
  // Try with merchant hint first (more specific)
  if (merchantHint) {
    const normalizedMerchantHint = merchantHint
      ? normalizeMerchantName(merchantHint)
      : '';
    try {
      const rowWithHint = await db.getFirstAsync<{ category_id: string }>(
        `
        SELECT category_id FROM item_category_mapping
        WHERE normalized_name = ? AND merchant_hint = ?
        ORDER BY confidence DESC, updated_at DESC
        LIMIT 1
        `,
        [normalized, normalizedMerchantHint]
      );
      if (rowWithHint?.category_id) {
        return rowWithHint.category_id;
      }
    } catch {
      return null;
    }
  }
  
  // Fallback to without merchant hint (general mapping: merchant_hint = '')
  let row: { category_id: string } | null = null;
  try {
    row = await db.getFirstAsync<{ category_id: string }>(
      `
      SELECT category_id FROM item_category_mapping
      WHERE normalized_name = ? AND merchant_hint = ''
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 1
      `,
      [normalized]
    );
  } catch {
    return null;
  }

  return row?.category_id ?? null;
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
