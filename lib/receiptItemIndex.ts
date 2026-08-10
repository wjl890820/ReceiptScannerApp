import type * as SQLite from 'expo-sqlite';

import { getReceiptItems, type ReceiptItemSource } from './receiptItems';
import { applyProductIdentityToItem } from './receiptItemIdentity';
import {
  buildSkuKey,
  type ProductIdentity,
  type ProductIdentitySource,
} from './productIdentity';
import {
  PRODUCT_FAMILY_KEYS,
  type ProductFamilyKey,
} from './productFamily';
import type {
  ProductSpecDimension,
  ProductSpecification,
  ProductSpecUnit,
} from './productSpecification';

export type ReceiptItemSourceKind = 'ocr' | 'user_added' | 'legacy' | 'unknown';

export type ReceiptItemIndexRow = {
  id: string;
  receipt_id: string;
  /** Current position in the final getReceiptItems(receipt) array. */
  source_index: number;
  /** Review/OCR provenance only; never used as source_index. */
  review_source_index: number | null;
  raw_name: string | null;
  normalized_name: string;
  normalized_full_name: string;
  canonical_product_name: string | null;
  legacy_canonical_name: string | null;
  brand: string | null;
  product_family_key: ProductFamilyKey | null;
  category: string | null;
  purchase_quantity: number;
  line_total: number;
  purchase_unit_price: number | null;
  spec_size_value: number | null;
  spec_size_unit: ProductSpecUnit | null;
  spec_pack_count: number | null;
  volume_base_ml: number | null;
  weight_base_g: number | null;
  count_base: number | null;
  sku_key: string | null;
  identity_source: ProductIdentitySource;
  identity_confidence: number;
  identity_version: 1;
  spec_source_text: string | null;
  spec_confidence: number;
  item_source: ReceiptItemSourceKind;
  created_at: number;
  updated_at: number;
};

export type ReceiptItemIndexReceipt = ReceiptItemSource & {
  id: string;
};

export type ReceiptItemIndexDatabase = {
  execAsync(source: string): Promise<void>;
  runAsync(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<unknown>;
  getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
};

export type BuildReceiptItemIndexOptions = {
  /** Index-row timestamp supplied by the persistence layer; defaults to 0 for pure deterministic builds. */
  indexedAt?: number;
};

const IDENTITY_SOURCES = new Set<ProductIdentitySource>([
  'user_confirmed',
  'merchant_alias',
  'dictionary',
  'high_confidence_rule',
  'legacy_fallback',
  'unknown',
]);

const FAMILY_KEYS = new Set<ProductFamilyKey>(PRODUCT_FAMILY_KEYS);

const SPEC_UNITS = new Set<ProductSpecUnit>(['ml', 'l', 'g', 'kg', 'count']);

const INSERT_SQL = `
  INSERT INTO receipt_items (
    id, receipt_id, source_index, review_source_index,
    raw_name, normalized_name, normalized_full_name,
    canonical_product_name, legacy_canonical_name,
    brand, product_family_key, category,
    purchase_quantity, line_total, purchase_unit_price,
    spec_size_value, spec_size_unit, spec_pack_count,
    volume_base_ml, weight_base_g, count_base,
    sku_key,
    identity_source, identity_confidence, identity_version,
    spec_source_text, spec_confidence,
    item_source, created_at, updated_at
  ) VALUES (
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?,
    ?, ?, ?,
    ?, ?,
    ?, ?, ?
  )
`;

function hasOwn(item: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(item, key);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  const numberValue = finiteNumberOrNull(value);
  return numberValue != null && numberValue >= 0 ? numberValue : null;
}

function positiveNumberOrNull(value: unknown): number | null {
  const numberValue = finiteNumberOrNull(value);
  return numberValue != null && numberValue > 0 ? numberValue : null;
}

function integerOrNull(value: unknown): number | null {
  const numberValue = finiteNumberOrNull(value);
  return numberValue != null && Number.isInteger(numberValue) ? numberValue : null;
}

function readIdentitySource(value: unknown): ProductIdentitySource {
  return typeof value === 'string' && IDENTITY_SOURCES.has(value as ProductIdentitySource)
    ? (value as ProductIdentitySource)
    : 'unknown';
}

function readFamily(value: unknown): ProductFamilyKey | null {
  return typeof value === 'string' && FAMILY_KEYS.has(value as ProductFamilyKey)
    ? (value as ProductFamilyKey)
    : null;
}

function readSpecUnit(value: unknown): ProductSpecUnit | null {
  return typeof value === 'string' && SPEC_UNITS.has(value as ProductSpecUnit)
    ? (value as ProductSpecUnit)
    : null;
}

function dimensionForSpecUnit(unit: ProductSpecUnit | null): ProductSpecDimension {
  if (unit === 'ml' || unit === 'l') return 'volume';
  if (unit === 'g' || unit === 'kg') return 'weight';
  if (unit === 'count') return 'count';
  return 'unknown';
}

function resolveItemSource(item: Record<string, unknown>): ReceiptItemSourceKind {
  if (item.user_added === true) return 'user_added';
  if (
    stringOrNull(item.raw_name) ||
    stringOrNull(item.ocr_recognized_name) ||
    integerOrNull(item.review_source_index) != null
  ) {
    return 'ocr';
  }
  if (!hasOwn(item, 'identity_version') && stringOrNull(item.name)) return 'legacy';
  return 'unknown';
}

function buildSpecification(
  sizeValue: number | null,
  sizeUnit: ProductSpecUnit | null,
  packCount: number | null,
  volumeBaseMl: number | null,
  weightBaseG: number | null,
  countBase: number | null,
  sourceText: string | null,
  confidence: number
): ProductSpecification {
  return {
    dimension: dimensionForSpecUnit(sizeUnit),
    sizeValue,
    sizeUnit,
    packCount,
    volumeBaseMl,
    weightBaseG,
    countBase,
    sourceText,
    confidence,
  };
}

function toInsertParams(row: ReceiptItemIndexRow): SQLite.SQLiteBindParams {
  return [
    row.id,
    row.receipt_id,
    row.source_index,
    row.review_source_index,
    row.raw_name,
    row.normalized_name,
    row.normalized_full_name,
    row.canonical_product_name,
    row.legacy_canonical_name,
    row.brand,
    row.product_family_key,
    row.category,
    row.purchase_quantity,
    row.line_total,
    row.purchase_unit_price,
    row.spec_size_value,
    row.spec_size_unit,
    row.spec_pack_count,
    row.volume_base_ml,
    row.weight_base_g,
    row.count_base,
    row.sku_key,
    row.identity_source,
    row.identity_confidence,
    row.identity_version,
    row.spec_source_text,
    row.spec_confidence,
    row.item_source,
    row.created_at,
    row.updated_at,
  ];
}

/**
 * Additive schema only. No receipt scan, backfill, or mutation integration.
 */
export async function ensureReceiptItemsSchema(
  db: Pick<ReceiptItemIndexDatabase, 'execAsync'>
): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS receipt_items (
      id TEXT PRIMARY KEY NOT NULL,
      receipt_id TEXT NOT NULL,
      source_index INTEGER NOT NULL,
      review_source_index INTEGER,
      raw_name TEXT,
      normalized_name TEXT,
      normalized_full_name TEXT,
      canonical_product_name TEXT,
      legacy_canonical_name TEXT,
      brand TEXT,
      product_family_key TEXT,
      category TEXT,
      purchase_quantity REAL,
      line_total REAL,
      purchase_unit_price REAL,
      spec_size_value REAL,
      spec_size_unit TEXT,
      spec_pack_count REAL,
      volume_base_ml REAL,
      weight_base_g REAL,
      count_base REAL,
      sku_key TEXT,
      identity_source TEXT,
      identity_confidence REAL,
      identity_version INTEGER,
      spec_source_text TEXT,
      spec_confidence REAL,
      item_source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(receipt_id, source_index)
    );

    CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt_id
      ON receipt_items(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_receipt_items_normalized_name
      ON receipt_items(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_receipt_items_normalized_full_name
      ON receipt_items(normalized_full_name);
    CREATE INDEX IF NOT EXISTS idx_receipt_items_canonical_product_name
      ON receipt_items(canonical_product_name);
    CREATE INDEX IF NOT EXISTS idx_receipt_items_family
      ON receipt_items(product_family_key);
    CREATE INDEX IF NOT EXISTS idx_receipt_items_brand
      ON receipt_items(brand);
    CREATE INDEX IF NOT EXISTS idx_receipt_items_sku
      ON receipt_items(sku_key);
  `);
}

/**
 * Pure projection from receipt Source of Truth to deterministic index rows.
 */
export function buildReceiptItemIndexRows(
  receipt: ReceiptItemIndexReceipt,
  options: BuildReceiptItemIndexOptions = {}
): ReceiptItemIndexRow[] {
  const sourceItems = getReceiptItems(receipt);
  const indexedAt =
    finiteNumberOrNull(options.indexedAt) != null
      ? Number(options.indexedAt)
      : 0;

  return sourceItems.map((sourceItem, sourceIndex) => {
    const item =
      sourceItem && typeof sourceItem === 'object'
        ? (sourceItem as Record<string, unknown>)
        : {};
    const finalName = stringOrNull(item.name) ?? '';
    const rawName =
      stringOrNull(item.raw_name) ??
      stringOrNull(item.ocr_recognized_name) ??
      stringOrNull(item.name);
    const category = stringOrNull(item.category);

    const derived = applyProductIdentityToItem(item, {
      finalName,
      finalCategory: category,
      classificationBrand: item.brand,
      useExistingClassificationEvidence: true,
    });
    const hasPersistedIdentity = finiteNumberOrNull(item.identity_version) === 1;

    const normalizedName =
      typeof item.normalized_name === 'string'
        ? item.normalized_name
        : derived.normalized_name ?? '';
    const normalizedFullName =
      hasPersistedIdentity && typeof item.normalized_full_name === 'string'
        ? item.normalized_full_name
        : derived.normalized_full_name;
    const canonicalProductName = hasPersistedIdentity
      ? stringOrNull(item.canonical_product_name)
      : derived.canonical_product_name;
    const brand = hasPersistedIdentity
      ? stringOrNull(item.brand)
      : derived.brand;
    const family = hasPersistedIdentity
      ? readFamily(item.product_family_key)
      : derived.product_family_key;
    const identitySource = hasPersistedIdentity
      ? readIdentitySource(item.identity_source)
      : derived.identity_source;
    const identityConfidence = hasPersistedIdentity
      ? nonNegativeNumberOrNull(item.identity_confidence) ?? 0
      : derived.identity_confidence;

    const specSizeValue = hasPersistedIdentity
      ? positiveNumberOrNull(item.spec_size_value)
      : derived.spec_size_value;
    const specSizeUnit = hasPersistedIdentity
      ? readSpecUnit(item.spec_size_unit)
      : derived.spec_size_unit;
    const specPackCount = hasPersistedIdentity
      ? positiveNumberOrNull(item.spec_pack_count)
      : derived.spec_pack_count;
    const volumeBaseMl = hasPersistedIdentity
      ? positiveNumberOrNull(item.volume_base_ml)
      : derived.volume_base_ml;
    const weightBaseG = hasPersistedIdentity
      ? positiveNumberOrNull(item.weight_base_g)
      : derived.weight_base_g;
    const countBase = hasPersistedIdentity
      ? positiveNumberOrNull(item.count_base)
      : derived.count_base;
    const specSourceText = hasPersistedIdentity
      ? stringOrNull(item.spec_source_text)
      : derived.spec_source_text;
    const specConfidence = hasPersistedIdentity
      ? nonNegativeNumberOrNull(item.spec_confidence) ?? 0
      : derived.spec_confidence;

    const purchaseQuantity = positiveNumberOrNull(item.quantity) ?? 1;
    const camelLineTotal = nonNegativeNumberOrNull(item.lineTotal);
    const snakeLineTotal =
      camelLineTotal == null ? nonNegativeNumberOrNull(item.line_total) : null;
    const hasValidLineTotal = camelLineTotal != null || snakeLineTotal != null;
    const lineTotal = camelLineTotal ?? snakeLineTotal ?? 0;
    const purchaseUnitPrice = hasValidLineTotal
      ? lineTotal / purchaseQuantity
      : null;

    const specification = buildSpecification(
      specSizeValue,
      specSizeUnit,
      specPackCount,
      volumeBaseMl,
      weightBaseG,
      countBase,
      specSourceText,
      specConfidence
    );
    const identityForSku: ProductIdentity = {
      rawName: finalName,
      normalizedName,
      normalizedFullName,
      canonicalProductName,
      brand,
      productFamilyKey: family,
      specification,
      identitySource,
      identityConfidence,
      identityVersion: 1,
    };

    return {
      id: `${receipt.id}:${sourceIndex}`,
      receipt_id: receipt.id,
      source_index: sourceIndex,
      review_source_index: integerOrNull(item.review_source_index),
      raw_name: rawName,
      normalized_name: normalizedName,
      normalized_full_name: normalizedFullName,
      canonical_product_name: canonicalProductName,
      legacy_canonical_name: stringOrNull(item.canonical_name),
      brand,
      product_family_key: family,
      category,
      purchase_quantity: purchaseQuantity,
      line_total: lineTotal,
      purchase_unit_price: purchaseUnitPrice,
      spec_size_value: specSizeValue,
      spec_size_unit: specSizeUnit,
      spec_pack_count: specPackCount,
      volume_base_ml: volumeBaseMl,
      weight_base_g: weightBaseG,
      count_base: countBase,
      sku_key: buildSkuKey(identityForSku),
      identity_source: identitySource,
      identity_confidence: identityConfidence,
      identity_version: 1,
      spec_source_text: specSourceText,
      spec_confidence: specConfidence,
      item_source: resolveItemSource(item),
      created_at: indexedAt,
      updated_at: indexedAt,
    };
  });
}

/**
 * Replace one receipt's derived rows atomically. Errors intentionally throw;
 * Phase 3D will decide how integration layers isolate failures.
 */
export async function rebuildReceiptItemIndex(
  db: ReceiptItemIndexDatabase,
  receipt: ReceiptItemIndexReceipt,
  options: BuildReceiptItemIndexOptions = {}
): Promise<void> {
  await ensureReceiptItemsSchema(db);
  const indexedAt = options.indexedAt ?? Date.now();

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `DELETE FROM receipt_items WHERE receipt_id = ?`,
      [receipt.id]
    );
    const rows = buildReceiptItemIndexRows(receipt, { indexedAt });
    for (const row of rows) {
      await db.runAsync(INSERT_SQL, toInsertParams(row));
    }
  });
}

export async function deleteReceiptItemIndex(
  db: ReceiptItemIndexDatabase,
  receiptId: string
): Promise<void> {
  await ensureReceiptItemsSchema(db);
  await db.runAsync(
    `DELETE FROM receipt_items WHERE receipt_id = ?`,
    [receiptId]
  );
}

export async function clearReceiptItemIndex(
  db: ReceiptItemIndexDatabase
): Promise<void> {
  await ensureReceiptItemsSchema(db);
  await db.runAsync(`DELETE FROM receipt_items`, []);
}

export async function getReceiptItemIndexRows(
  db: ReceiptItemIndexDatabase,
  receiptId: string
): Promise<ReceiptItemIndexRow[]> {
  await ensureReceiptItemsSchema(db);
  return db.getAllAsync<ReceiptItemIndexRow>(
    `SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY source_index ASC`,
    [receiptId]
  );
}
