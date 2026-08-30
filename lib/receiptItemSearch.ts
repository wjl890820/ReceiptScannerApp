import type * as SQLite from 'expo-sqlite';
import * as ExpoSQLite from 'expo-sqlite';

import { initIfNeeded, type ReceiptListRow } from './db';
import { normalizeReceiptItemSearchQuery } from './receiptItemSearchNormalize';
import {
  buildOwnerScopedReceiptNamedPredicates,
  resolveCurrentLocalReceiptOwnerScope,
  type LocalReceiptOwnerScope,
} from './receiptOwnershipScope';

export { normalizeReceiptItemSearchQuery } from './receiptItemSearchNormalize';

export type ReceiptItemSearchResult = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  displayName: string;
  rawName: string | null;
  normalizedName: string | null;
  normalizedFullName: string | null;
  canonicalProductName: string | null;
  brand: string | null;
  productFamilyKey: string | null;
  skuKey: string | null;
  category: string | null;
  purchaseQuantity: number;
  lineTotal: number | null;
  transactionAt: number;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  merchantType: string | null;
};

export type ReceiptOnlySearchResult = ReceiptListRow;

export type HistoryProductSearchResults = {
  itemResults: ReceiptItemSearchResult[];
  receiptResults: ReceiptOnlySearchResult[];
};

export type ReceiptItemSearchDatabase = {
  getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]>;
};

export type ReceiptItemSearchOptions = {
  itemLimit?: number;
  receiptLimit?: number;
  /** Test seam: explicit owner scope instead of resolving current owner. */
  ownerScope?: LocalReceiptOwnerScope;
};

const DB_NAME = 'receipts_v2.db';
let _db: SQLite.SQLiteDatabase | null = null;

function positiveLimit(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0
    ? Math.min(200, numberValue)
    : fallback;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function getSearchDb(): Promise<SQLite.SQLiteDatabase> {
  await initIfNeeded();
  if (!_db) {
    _db = await ExpoSQLite.openDatabaseAsync(DB_NAME);
  }
  return _db;
}

export async function searchHistoryPurchasesWithDb(
  db: ReceiptItemSearchDatabase,
  rawQuery: string,
  options: ReceiptItemSearchOptions = {}
): Promise<HistoryProductSearchResults> {
  const query = normalizeReceiptItemSearchQuery(rawQuery);
  if (!query) return { itemResults: [], receiptResults: [] };

  const scope =
    options.ownerScope ?? (await resolveCurrentLocalReceiptOwnerScope());
  if (scope.status !== 'ready') {
    return { itemResults: [], receiptResults: [] };
  }
  const ownerNamed = buildOwnerScopedReceiptNamedPredicates(scope.ownerKey);
  if (!ownerNamed) {
    return { itemResults: [], receiptResults: [] };
  }

  const escaped = escapeLikePattern(query);
  const binds = {
    ...ownerNamed.binds,
    $exact: query,
    $prefix: `${escaped}%`,
    $contains: `%${escaped}%`,
    $itemLimit: positiveLimit(options.itemLimit, 100),
  };

  const itemResults = await db.getAllAsync<ReceiptItemSearchResult>(
    `SELECT
       receipt_items.receipt_id AS receiptId,
       receipt_items.id AS itemId,
       receipt_items.source_index AS sourceIndex,
       COALESCE(
         NULLIF(receipt_items.normalized_full_name, ''),
         NULLIF(receipt_items.raw_name, ''),
         NULLIF(receipt_items.canonical_product_name, ''),
         receipt_items.normalized_name,
         ''
       ) AS displayName,
       receipt_items.raw_name AS rawName,
       receipt_items.normalized_name AS normalizedName,
       receipt_items.normalized_full_name AS normalizedFullName,
       receipt_items.canonical_product_name AS canonicalProductName,
       receipt_items.brand AS brand,
       receipt_items.product_family_key AS productFamilyKey,
       receipt_items.sku_key AS skuKey,
       receipt_items.category AS category,
       receipt_items.purchase_quantity AS purchaseQuantity,
       receipt_items.line_total AS lineTotal,
       COALESCE(receipts.transaction_at, receipts.created_at) AS transactionAt,
       receipts.merchant_raw AS merchantRaw,
       receipts.merchant_normalized AS merchantNormalized,
       receipts.merchant_type AS merchantType
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE (${ownerNamed.itemWhereSql})
       AND (
       LOWER(COALESCE(receipt_items.raw_name, '')) LIKE $contains ESCAPE '\\'
       OR LOWER(COALESCE(receipt_items.normalized_name, '')) LIKE $contains ESCAPE '\\'
       OR LOWER(COALESCE(receipt_items.normalized_full_name, '')) LIKE $contains ESCAPE '\\'
       OR LOWER(COALESCE(receipt_items.canonical_product_name, '')) LIKE $contains ESCAPE '\\'
       OR LOWER(COALESCE(receipt_items.brand, '')) LIKE $contains ESCAPE '\\'
       OR LOWER(COALESCE(receipt_items.product_family_key, '')) LIKE $contains ESCAPE '\\'
     )
     ORDER BY
       COALESCE(receipts.transaction_at, receipts.created_at) DESC,
       CASE
         WHEN LOWER(COALESCE(receipt_items.canonical_product_name, '')) = $exact THEN 0
         WHEN LOWER(COALESCE(receipt_items.normalized_full_name, '')) = $exact
           OR LOWER(COALESCE(receipt_items.normalized_name, '')) = $exact THEN 1
         WHEN LOWER(COALESCE(receipt_items.brand, '')) = $exact
           OR LOWER(COALESCE(receipt_items.product_family_key, '')) = $exact THEN 2
         WHEN LOWER(COALESCE(receipt_items.canonical_product_name, '')) LIKE $prefix ESCAPE '\\'
           OR LOWER(COALESCE(receipt_items.normalized_full_name, '')) LIKE $prefix ESCAPE '\\'
           OR LOWER(COALESCE(receipt_items.raw_name, '')) LIKE $prefix ESCAPE '\\'
           OR LOWER(COALESCE(receipt_items.brand, '')) LIKE $prefix ESCAPE '\\' THEN 3
         ELSE 4
       END ASC,
       receipt_items.source_index ASC
     LIMIT $itemLimit`,
    binds
  );

  const receiptRows = await db.getAllAsync<ReceiptOnlySearchResult>(
    `SELECT
       id,
       created_at,
       COALESCE(transaction_at, created_at) AS transaction_at,
       merchant_raw,
       merchant_normalized,
       merchant_type,
       total,
       tax,
       currency,
       analysis_json,
       COALESCE(user_edited, 0) AS user_edited,
       final_total,
       final_category,
       note,
       user_items_json
     FROM receipts
     WHERE (${ownerNamed.receiptWhereSql})
       AND (
       LOWER(COALESCE(merchant_raw, '')) LIKE $contains ESCAPE '\\'
       OR LOWER(COALESCE(merchant_normalized, '')) LIKE $contains ESCAPE '\\'
       OR LOWER(COALESCE(note, '')) LIKE $contains ESCAPE '\\'
     )
     ORDER BY COALESCE(transaction_at, created_at) DESC
     LIMIT $receiptLimit`,
    {
      ...ownerNamed.binds,
      $contains: `%${escaped}%`,
      $receiptLimit: positiveLimit(options.receiptLimit, 100),
    }
  );

  const itemMatchedReceiptIds = new Set(
    itemResults.map((result) => result.receiptId)
  );
  return {
    itemResults,
    receiptResults: receiptRows.filter(
      (receipt) => !itemMatchedReceiptIds.has(receipt.id)
    ),
  };
}

export async function searchHistoryPurchases(
  query: string,
  options: ReceiptItemSearchOptions = {}
): Promise<HistoryProductSearchResults> {
  const db = await getSearchDb();
  return searchHistoryPurchasesWithDb(db, query, options);
}
