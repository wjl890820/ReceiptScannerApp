// lib/categoryLearner.ts
import * as SQLite from 'expo-sqlite';
import { ALL_CATEGORIES, type Category } from './categories';
import { initIfNeeded } from './db';

// Re-export for backward compatibility (deprecated, use categories.ts)
/** @deprecated Use GROCERY_CATEGORIES from './categories' instead */
export const STANDARD_CATEGORIES = ALL_CATEGORIES as readonly string[];

let _db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  // 确保数据库已初始化（包括 item_category_mapping 表）
  await initIfNeeded();
  
  if (!_db) {
    _db = await SQLite.openDatabaseAsync('receipts.db');
  }
  return _db;
}

/**
 * Learn category mapping (from user edit or high-confidence classification)
 */
export async function learnCategoryMapping(
  normalizedName: string,
  merchantHint: string | null,
  categoryId: string,
  confidence: number = 1.0
): Promise<void> {
  if (!normalizedName || !categoryId) return;

  const db = await getDb();
  const now = Date.now();

  await db.runAsync(
    `
    INSERT OR REPLACE INTO item_category_mapping 
    (normalized_name, merchant_hint, category_id, confidence, updated_at)
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      normalizedName.trim().toLowerCase(),
      merchantHint ? merchantHint.trim().toLowerCase() : null,
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
 */
export async function getLearnedCategory(
  normalizedName: string,
  merchantHint?: string | null
): Promise<string | null> {
  if (!normalizedName) return null;

  const db = await getDb();
  
  // Try with merchant hint first (more specific)
  if (merchantHint) {
    const rowWithHint = await db.getFirstAsync<{ category_id: string }>(
      `
      SELECT category_id FROM item_category_mapping
      WHERE normalized_name = ? AND merchant_hint = ?
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 1
      `,
      [normalizedName.trim().toLowerCase(), merchantHint.trim().toLowerCase()]
    );
    if (rowWithHint?.category_id) {
      return rowWithHint.category_id;
    }
  }
  
  // Fallback to without merchant hint (general mapping)
  const row = await db.getFirstAsync<{ category_id: string }>(
    `
    SELECT category_id FROM item_category_mapping
    WHERE normalized_name = ? AND (merchant_hint IS NULL OR merchant_hint = '')
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 1
    `,
    [normalizedName.trim().toLowerCase()]
  );

  return row?.category_id ?? null;
}

/**
 * 获取所有已学习的映射（用于调试/导出）
 */
export async function getAllLearnedMappings(): Promise<
  Array<{ name: string; merchantHint: string | null; category: string; confidence: number }>
> {
  const db = await getDb();
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
