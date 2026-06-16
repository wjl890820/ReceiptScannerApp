// lib/productAlias.ts
// Exact alias table: OCR/abbrev normalized_name -> canonical_name + category (no fuzzy match).

import * as SQLite from 'expo-sqlite';
import { initIfNeeded } from './db';
import { normalizeReceiptItemName, normalizeMerchantName } from './productNormalizer';
import type { MainCategory, SubCategory } from './categoryTaxonomyV1';

export type ProductNameAliasRow = {
  alias_normalized: string;
  merchant_hint: string;
  canonical_name: string;
  category_main: string;
  category_sub: string | null;
  analysis_tags: string;
  confidence: number;
  source: string;
};

let _db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  await initIfNeeded();
  if (!_db) {
    _db = await SQLite.openDatabaseAsync('receipts_v2.db');
  }
  return _db;
}

function safeParseTags(raw: string): string[] {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Seed built-in exact aliases (idempotent: INSERT OR IGNORE).
 */
export async function seedBuiltinProductAliases(db: SQLite.SQLiteDatabase): Promise<void> {
  const now = Date.now();
  const builtins: Array<{
    rawAlias: string;
    canonical: string;
    main: MainCategory;
    sub: SubCategory | null;
    tags: string[];
  }> = [
    {
      rawAlias: 'プレーンビス',
      canonical: 'プレーンビスケット',
      main: 'snacks',
      sub: 'biscuits',
      tags: ['snack', 'sweet', 'non_essential_spend'],
    },
    {
      rawAlias: 'チョレート効果カ',
      canonical: 'チョコレート効果',
      main: 'snacks',
      sub: 'chocolate',
      tags: ['snack', 'sweet', 'non_essential_spend'],
    },
    {
      rawAlias: 'さつま揚げ4枚',
      canonical: 'さつま揚げ',
      main: 'prepared_food',
      sub: 'deli',
      tags: ['ready_to_eat', 'non_essential_spend'],
    },
    {
      rawAlias: '太ちくわ',
      canonical: 'ちくわ',
      main: 'prepared_food',
      sub: 'deli',
      tags: ['ready_to_eat', 'non_essential_spend'],
    },
  ];

  for (const b of builtins) {
    const aliasNorm = normalizeReceiptItemName(b.rawAlias).normalized_name;
    if (!aliasNorm) continue;
    await db.runAsync(
      `
      INSERT OR IGNORE INTO product_name_alias (
        alias_normalized, merchant_hint, canonical_name,
        category_main, category_sub, analysis_tags,
        confidence, source, created_at, updated_at
      ) VALUES (?, '', ?, ?, ?, ?, ?, 'rule', ?, ?)
      `,
      [
        aliasNorm,
        b.canonical,
        b.main,
        b.sub,
        JSON.stringify(b.tags),
        0.95,
        now,
        now,
      ]
    );
  }
}

export async function lookupProductNameAlias(
  normalizedName: string,
  merchantNameRaw?: string | null
): Promise<(ProductNameAliasRow & { analysis_tags_parsed: string[] }) | null> {
  const key = (normalizedName || '').trim().toLowerCase();
  if (!key) return null;
  try {
    const db = await getDb();
    const mhFull = merchantNameRaw ? normalizeMerchantName(merchantNameRaw) : '';

    const trySelect = async (merchantHint: string) => {
      return await db.getFirstAsync<ProductNameAliasRow>(
        `SELECT * FROM product_name_alias WHERE alias_normalized = ? AND merchant_hint = ? LIMIT 1`,
        [key, merchantHint]
      );
    };

    let row: ProductNameAliasRow | null = null;
    if (mhFull) {
      row = await trySelect(mhFull);
    }
    if (!row) {
      row = await trySelect('');
    }
    if (!row) return null;
    return {
      ...row,
      analysis_tags_parsed: safeParseTags(row.analysis_tags),
    };
  } catch {
    return null;
  }
}

export async function upsertProductNameAlias(params: {
  alias_normalized: string;
  merchant_hint?: string | null;
  canonical_name: string;
  category_main: string;
  category_sub?: string | null;
  analysis_tags?: string[];
  confidence?: number;
  source?: 'manual' | 'rule' | 'ai';
}): Promise<void> {
  const key = (params.alias_normalized || '').trim().toLowerCase();
  if (!key || !params.canonical_name?.trim()) return;
  const mh = params.merchant_hint ? normalizeMerchantName(params.merchant_hint) : '';
  try {
    const db = await getDb();
    const now = Date.now();
    const tagsJson = JSON.stringify(Array.isArray(params.analysis_tags) ? params.analysis_tags : []);
    const conf = params.confidence ?? 1.0;
    const src = params.source || 'manual';
    await db.runAsync(`DELETE FROM product_name_alias WHERE alias_normalized = ? AND merchant_hint = ?`, [
      key,
      mh,
    ]);
    await db.runAsync(
      `
      INSERT INTO product_name_alias (
        alias_normalized, merchant_hint, canonical_name,
        category_main, category_sub, analysis_tags,
        confidence, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        key,
        mh,
        params.canonical_name.trim(),
        params.category_main,
        params.category_sub ?? null,
        tagsJson,
        conf,
        src,
        now,
        now,
      ]
    );
  } catch {
    // degrade gracefully
  }
}
