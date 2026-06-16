// lib/productDictionary.ts
// Local product dictionary (asset layer) stored in receipts_v2.db.
//
// analysis_tags storage: JSON string of string[] in TEXT column.

import * as SQLite from 'expo-sqlite';
import { nanoid } from 'nanoid/non-secure';
import { initIfNeeded } from './db';

export type ProductDictionaryRow = {
  id: string;
  normalized_name: string;
  canonical_name: string | null;
  brand: string | null;
  category_main: string;
  category_sub: string | null;
  analysis_tags: string; // JSON string
  source_type?: string;
  seen_count: number;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ProductDictionaryHit = {
  normalized_name: string;
  canonical_name: string | null;
  brand: string | null;
  category_main: string;
  category_sub: string | null;
  analysis_tags: string[];
};

let _db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  await initIfNeeded();
  if (!_db) {
    _db = await SQLite.openDatabaseAsync('receipts_v2.db');
  }
  return _db;
}

async function ensureTableExists(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
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
  `);
}

function safeParseTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string') return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export async function lookupProductDictionary(
  normalizedName: string
): Promise<ProductDictionaryHit | null> {
  const key = (normalizedName || '').trim().toLowerCase();
  if (!key) return null;
  try {
    const db = await getDb();
    await ensureTableExists(db);
    const row = await db.getFirstAsync<ProductDictionaryRow>(
      `SELECT * FROM product_dictionary WHERE normalized_name = ? LIMIT 1`,
      [key]
    );
    if (!row) return null;
    return {
      normalized_name: row.normalized_name,
      canonical_name: row.canonical_name ?? null,
      brand: row.brand ?? null,
      category_main: row.category_main,
      category_sub: row.category_sub ?? null,
      analysis_tags: safeParseTags(row.analysis_tags),
    };
  } catch {
    return null; // degrade gracefully
  }
}

export async function upsertProductDictionary(params: {
  normalized_name: string;
  canonical_name?: string | null;
  brand?: string | null;
  category_main: string;
  category_sub?: string | null;
  analysis_tags?: string[];
  source_type?: 'manual' | 'dictionary' | 'rules' | 'ai' | 'mapping' | 'backfill' | 'alias' | 'unknown';
  minConfidenceToWrite?: number;
  confidence?: number;
}): Promise<void> {
  const key = (params.normalized_name || '').trim().toLowerCase();
  if (!key) return;
  const min = params.minConfidenceToWrite ?? 0.85;
  const conf = params.confidence ?? 1.0;
  if (conf < min) return;

  try {
    const db = await getDb();
    await ensureTableExists(db);
    const now = Date.now();
    const tagsJson = JSON.stringify(Array.isArray(params.analysis_tags) ? params.analysis_tags : []);
    const sourceType = params.source_type || 'unknown';

    // Check existing row
    const existing = await db.getFirstAsync<{ id: string; seen_count: number }>(
      `SELECT id, seen_count FROM product_dictionary WHERE normalized_name = ? LIMIT 1`,
      [key]
    );

    if (!existing?.id) {
      await db.runAsync(
        `
        INSERT INTO product_dictionary (
          id, normalized_name, canonical_name, brand,
          category_main, category_sub, analysis_tags,
          source_type,
          seen_count, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          nanoid(),
          key,
          params.canonical_name ?? null,
          params.brand ?? null,
          params.category_main,
          params.category_sub ?? null,
          tagsJson,
          sourceType,
          1,
          now,
          now,
          now,
        ]
      );
      return;
    }

    // Update existing (do not blank out canonical/brand if not provided)
    await db.runAsync(
      `
      UPDATE product_dictionary
      SET
        canonical_name = COALESCE(?, canonical_name),
        brand = COALESCE(?, brand),
        category_main = ?,
        category_sub = ?,
        analysis_tags = ?,
        source_type = COALESCE(?, source_type),
        seen_count = COALESCE(seen_count, 0) + 1,
        last_seen_at = ?,
        updated_at = ?
      WHERE normalized_name = ?
      `,
      [
        params.canonical_name ?? null,
        params.brand ?? null,
        params.category_main,
        params.category_sub ?? null,
        tagsJson,
        sourceType,
        now,
        now,
        key,
      ]
    );
  } catch {
    // degrade gracefully
  }
}

export async function getProductDictionaryCount(): Promise<number> {
  try {
    const db = await getDb();
    await ensureTableExists(db);
    const row = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(1) as c FROM product_dictionary`);
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export async function getTopProductDictionary(limit = 20): Promise<Array<{ normalized_name: string; seen_count: number }>> {
  try {
    const db = await getDb();
    await ensureTableExists(db);
    const rows = await db.getAllAsync<{ normalized_name: string; seen_count: number }>(
      `SELECT normalized_name, seen_count FROM product_dictionary ORDER BY seen_count DESC, updated_at DESC LIMIT ?`,
      [limit]
    );
    return rows ?? [];
  } catch {
    return [];
  }
}

export async function getAllProductDictionaryKeys(): Promise<string[]> {
  try {
    const db = await getDb();
    await ensureTableExists(db);
    const rows = await db.getAllAsync<{ normalized_name: string }>(
      `SELECT normalized_name FROM product_dictionary`
    );
    return (rows ?? []).map((r) => String(r.normalized_name || '').trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

