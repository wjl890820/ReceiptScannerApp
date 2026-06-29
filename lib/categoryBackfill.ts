/**
 * 旧数据本地回填：把历史 receipts 里 item.category 的缺失/空/旧 enum/非法值，
 * 用 normalizeProductCategory 修正为新一级分类。
 *
 * - 同时处理 analysis_json.items 与 user_items_json。
 * - 只改 category 字段，不动金额/商品名/total。
 * - 幂等：已是合法新 enum 不会变化，重复执行无副作用。
 * - 输出修复了多少张 receipt、多少个 item。
 */

import * as SQLite from 'expo-sqlite';
import { initIfNeeded } from './db';
import { normalizeProductCategory } from './productCategory';
import { logger } from './logger';

let _db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  await initIfNeeded();
  if (!_db) {
    _db = await SQLite.openDatabaseAsync('receipts_v2.db');
  }
  return _db;
}

/** 修复单个 items 数组；返回修复的 item 数与（可能）新数组。 */
function fixItemsArray(items: unknown): { changed: number; items: any[] } {
  if (!Array.isArray(items)) return { changed: 0, items: [] };
  let changed = 0;
  const next = items.map((it) => {
    if (!it || typeof it !== 'object') return it;
    const item = it as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : undefined;
    const current = typeof item.category === 'string' ? item.category : '';
    const fixed = normalizeProductCategory(item.category, name);
    if (fixed !== current) {
      changed += 1;
      return { ...item, category: fixed };
    }
    return item;
  });
  return { changed, items: next };
}

/** 修复一个 JSON 字符串里的 items.category；无变化返回 null。（导出供单测） */
export function fixJsonItems(json: string | null): { json: string; changed: number } | null {
  if (!json || typeof json !== 'string') return null;
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  // 兼容两种结构：{ items: [...] } 或 直接 [...]
  if (Array.isArray(parsed)) {
    const { changed, items } = fixItemsArray(parsed);
    if (changed === 0) return null;
    return { json: JSON.stringify(items), changed };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
    const { changed, items } = fixItemsArray(parsed.items);
    if (changed === 0) return null;
    return { json: JSON.stringify({ ...parsed, items }), changed };
  }
  return null;
}

export type BackfillResult = {
  scannedReceipts: number;
  fixedReceipts: number;
  fixedItems: number;
};

/**
 * 遍历全部 receipts，回填 item.category。幂等。
 */
export async function backfillReceiptItemCategories(): Promise<BackfillResult> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    analysis_json: string | null;
    user_items_json: string | null;
  }>(`SELECT id, analysis_json, user_items_json FROM receipts`);

  let fixedReceipts = 0;
  let fixedItems = 0;

  for (const row of rows) {
    const analysisFix = fixJsonItems(row.analysis_json);
    const userFix = fixJsonItems(row.user_items_json);
    if (!analysisFix && !userFix) continue;

    const sets: string[] = [];
    const vals: SQLite.SQLiteBindValue[] = [];
    if (analysisFix) {
      sets.push('analysis_json = ?');
      vals.push(analysisFix.json);
      fixedItems += analysisFix.changed;
    }
    if (userFix) {
      sets.push('user_items_json = ?');
      vals.push(userFix.json);
      fixedItems += userFix.changed;
    }
    vals.push(row.id);

    try {
      await db.runAsync(`UPDATE receipts SET ${sets.join(', ')} WHERE id = ?`, vals);
      fixedReceipts += 1;
    } catch (e) {
      logger.warn('CategoryBackfill', 'update receipt failed', { id: row.id, error: e });
    }
  }

  const result: BackfillResult = {
    scannedReceipts: rows.length,
    fixedReceipts,
    fixedItems,
  };
  logger.info('CategoryBackfill', 'backfill done', result);
  return result;
}

/**
 * 启动时安全执行一次（带本地标记，避免每次冷启动重复扫描）。
 * 标记仅作"已跑过"提示；即便重复执行也是幂等的。
 */
const BACKFILL_FLAG_KEY = 'category_backfill_v1_done';

export async function runCategoryBackfillOnceOnStartup(): Promise<void> {
  try {
    const db = await getDb();
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
    );
    const done = await db.getFirstAsync<{ v: string }>(
      `SELECT v FROM app_kv WHERE k = ?`,
      [BACKFILL_FLAG_KEY]
    );
    if (done?.v === '1') return;

    const result = await backfillReceiptItemCategories();
    await db.runAsync(
      `INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`,
      [BACKFILL_FLAG_KEY, '1']
    );
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[CategoryBackfill] startup backfill', result);
    }
  } catch (e) {
    logger.warn('CategoryBackfill', 'startup backfill failed', { error: e });
  }
}
