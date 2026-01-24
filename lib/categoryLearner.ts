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
 * 从用户编辑历史中学习分类
 * 返回：normalized_name -> category 的映射
 */
export async function learnCategoryFromEdit(
  normalizedName: string,
  category: string
): Promise<void> {
  if (!normalizedName || !category) return;

  const db = await getDb();
  const now = Date.now();

  await db.runAsync(
    `
    INSERT OR REPLACE INTO item_category_mapping (normalized_name, category, updated_at)
    VALUES (?, ?, ?)
    `,
    [normalizedName.trim().toLowerCase(), category.trim(), now]
  );
}

/**
 * 获取已学习的分类（如果存在）
 */
export async function getLearnedCategory(normalizedName: string): Promise<string | null> {
  if (!normalizedName) return null;

  const db = await getDb();
  const row = await db.getFirstAsync<{ category: string }>(
    `
    SELECT category FROM item_category_mapping
    WHERE normalized_name = ?
    LIMIT 1
    `,
    [normalizedName.trim().toLowerCase()]
  );

  return row?.category ?? null;
}

/**
 * 获取所有已学习的映射（用于调试/导出）
 */
export async function getAllLearnedMappings(): Promise<Array<{ name: string; category: string }>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ normalized_name: string; category: string }>(
    `SELECT normalized_name, category FROM item_category_mapping ORDER BY updated_at DESC`
  );

  return rows.map((r) => ({ name: r.normalized_name, category: r.category }));
}
