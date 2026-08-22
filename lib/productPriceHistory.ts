import type * as SQLite from 'expo-sqlite';
import * as ExpoSQLite from 'expo-sqlite';

import { initIfNeeded } from './db';
import type { ProductDetailTarget } from './productDetailTarget';

export type ProductPriceKind =
  | 'purchase_unit'
  | 'per_liter'
  | 'per_100g'
  | 'per_item';

export type ProductPriceHistoryStatus =
  | 'ready'
  | 'not_enough_points'
  | 'unsupported_family'
  | 'no_comparable_spec'
  | 'ambiguous_dimension'
  | 'mixed_currency'
  | 'unknown_currency';

export type ProductPriceHistoryPoint = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  occurredAt: number;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  displayName: string;
  currency: string;
  lineTotal: number;
  purchaseQuantity: number;
  priceValue: number;
  priceKind: ProductPriceKind;
};

export type ProductPriceComparisonEligibility = {
  status: ProductPriceHistoryStatus;
  priceKind: ProductPriceKind | null;
  currency: string | null;
  totalOccurrenceCount: number;
  comparableOccurrenceCount: number;
  excludedOccurrenceCount: number;
};

export type ProductPriceHistoryResult = ProductPriceComparisonEligibility & {
  target: ProductDetailTarget;
  points: ProductPriceHistoryPoint[];
};

export type ProductPriceHistoryRow = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  occurredAt: number;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  displayName: string;
  currency: string | null;
  lineTotal: number | null;
  purchaseQuantity: number | null;
  productFamilyKey: string | null;
  volumeBaseMl: number | null;
  weightBaseG: number | null;
  countBase: number | null;
};

export type ProductPriceHistoryDatabase = {
  getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]>;
};

type PriceDimension = 'volume' | 'weight' | 'count';

type ComparableCandidate = {
  row: ProductPriceHistoryRow;
  dimension: PriceDimension | null;
  currency: string | null;
  priceValue: number;
};

const DB_NAME = 'receipts_v2.db';
let _db: SQLite.SQLiteDatabase | null = null;

const FAMILY_PRICE_DIMENSIONS: Readonly<Record<string, PriceDimension>> = {
  milk: 'volume',
  coffee: 'volume',
  tea: 'volume',
  water: 'volume',
  cola: 'volume',
  eggs: 'count',
  rice: 'weight',
};

const UNSUPPORTED_PRICE_FAMILIES = new Set([
  'tofu',
  'yogurt',
  'bread',
  'onigiri',
  'bento',
]);

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Transaction/occurrence timestamp suitable for price history (never invent "now"). */
function hasValidOccurredAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function knownCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const currency = value.trim();
  if (!currency || currency.toLowerCase() === 'unknown') return null;
  return currency;
}

function dimensionForRow(row: ProductPriceHistoryRow): PriceDimension | null {
  const dimensions: PriceDimension[] = [];
  if (positiveFinite(row.volumeBaseMl)) dimensions.push('volume');
  if (positiveFinite(row.weightBaseG)) dimensions.push('weight');
  if (positiveFinite(row.countBase)) dimensions.push('count');
  return dimensions.length === 1 ? dimensions[0] : null;
}

function priceKindForDimension(dimension: PriceDimension): ProductPriceKind {
  if (dimension === 'volume') return 'per_liter';
  if (dimension === 'weight') return 'per_100g';
  return 'per_item';
}

function normalizedPrice(
  row: ProductPriceHistoryRow,
  dimension: PriceDimension
): number | null {
  if (
    !positiveFinite(row.lineTotal) ||
    !positiveFinite(row.purchaseQuantity)
  ) {
    return null;
  }
  const base =
    dimension === 'volume'
      ? row.volumeBaseMl
      : dimension === 'weight'
        ? row.weightBaseG
        : row.countBase;
  if (!positiveFinite(base)) return null;

  const totalBase = base * row.purchaseQuantity;
  const multiplier = dimension === 'volume' ? 1000 : dimension === 'weight' ? 100 : 1;
  const value = (row.lineTotal / totalBase) * multiplier;
  return positiveFinite(value) ? value : null;
}

function emptyResult(
  target: ProductDetailTarget,
  status: ProductPriceHistoryStatus,
  totalOccurrenceCount: number,
  priceKind: ProductPriceKind | null = null
): ProductPriceHistoryResult {
  return {
    target,
    status,
    priceKind,
    currency: null,
    points: [],
    totalOccurrenceCount,
    comparableOccurrenceCount: 0,
    excludedOccurrenceCount: totalOccurrenceCount,
  };
}

function finalizeCandidates(
  target: ProductDetailTarget,
  totalOccurrenceCount: number,
  priceKind: ProductPriceKind,
  candidates: ComparableCandidate[]
): ProductPriceHistoryResult {
  const knownCandidates = candidates.filter(
    (
      candidate
    ): candidate is ComparableCandidate & { currency: string } =>
      candidate.currency != null && hasValidOccurredAt(candidate.row.occurredAt)
  );
  const currencies = new Set(
    knownCandidates.map((candidate) => candidate.currency)
  );
  if (currencies.size > 1) {
    return emptyResult(
      target,
      'mixed_currency',
      totalOccurrenceCount,
      priceKind
    );
  }

  const points = knownCandidates
    .map<ProductPriceHistoryPoint>((candidate) => ({
      receiptId: candidate.row.receiptId,
      itemId: candidate.row.itemId,
      sourceIndex: candidate.row.sourceIndex,
      occurredAt: candidate.row.occurredAt,
      merchantRaw: candidate.row.merchantRaw,
      merchantNormalized: candidate.row.merchantNormalized,
      displayName: candidate.row.displayName,
      currency: candidate.currency,
      lineTotal: candidate.row.lineTotal as number,
      purchaseQuantity: candidate.row.purchaseQuantity as number,
      priceValue: candidate.priceValue,
      priceKind,
    }))
    .sort(
      (left, right) =>
        left.occurredAt - right.occurredAt ||
        left.receiptId.localeCompare(right.receiptId) ||
        left.sourceIndex - right.sourceIndex
    );
  const hasUnknownCurrency = candidates.some(
    (candidate) => candidate.currency == null
  );
  const status: ProductPriceHistoryStatus =
    points.length >= 2
      ? 'ready'
      : hasUnknownCurrency
        ? 'unknown_currency'
        : 'not_enough_points';

  return {
    target,
    status,
    priceKind,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    points,
    totalOccurrenceCount,
    comparableOccurrenceCount: points.length,
    excludedOccurrenceCount: totalOccurrenceCount - points.length,
  };
}

export function buildProductPriceHistory(
  target: ProductDetailTarget,
  rows: ProductPriceHistoryRow[]
): ProductPriceHistoryResult {
  const totalOccurrenceCount = rows.length;
  if (target.type === 'occurrence') {
    return emptyResult(target, 'not_enough_points', totalOccurrenceCount);
  }

  if (target.type === 'sku') {
    const candidates = rows.flatMap<ComparableCandidate>((row) => {
      if (
        !positiveFinite(row.lineTotal) ||
        !positiveFinite(row.purchaseQuantity)
      ) {
        return [];
      }
      const priceValue = row.lineTotal / row.purchaseQuantity;
      return positiveFinite(priceValue)
        ? [
            {
              row,
              dimension: null,
              currency: knownCurrency(row.currency),
              priceValue,
            },
          ]
        : [];
    });
    return finalizeCandidates(
      target,
      totalOccurrenceCount,
      'purchase_unit',
      candidates
    );
  }

  if (
    target.type === 'family' &&
    UNSUPPORTED_PRICE_FAMILIES.has(target.key)
  ) {
    return emptyResult(target, 'unsupported_family', totalOccurrenceCount);
  }

  const requiredFamilyDimension =
    target.type === 'family' ? FAMILY_PRICE_DIMENSIONS[target.key] : null;
  if (target.type === 'family' && !requiredFamilyDimension) {
    return emptyResult(target, 'unsupported_family', totalOccurrenceCount);
  }

  const candidates = rows.flatMap<ComparableCandidate>((row) => {
    const dimension = dimensionForRow(row);
    if (!dimension) return [];
    if (requiredFamilyDimension && dimension !== requiredFamilyDimension) {
      return [];
    }
    const explicitFamilyDimension = row.productFamilyKey
      ? FAMILY_PRICE_DIMENSIONS[row.productFamilyKey]
      : null;
    if (
      target.type === 'canonical' &&
      explicitFamilyDimension &&
      explicitFamilyDimension !== dimension
    ) {
      return [];
    }
    const priceValue = normalizedPrice(row, dimension);
    return priceValue == null
      ? []
      : [
          {
            row,
            dimension,
            currency: knownCurrency(row.currency),
            priceValue,
          },
        ];
  });

  if (candidates.length === 0) {
    const priceKind = requiredFamilyDimension
      ? priceKindForDimension(requiredFamilyDimension)
      : null;
    return emptyResult(
      target,
      'no_comparable_spec',
      totalOccurrenceCount,
      priceKind
    );
  }

  const dimensions = new Set(
    candidates.map((candidate) => candidate.dimension)
  );
  if (dimensions.size !== 1) {
    return emptyResult(
      target,
      'ambiguous_dimension',
      totalOccurrenceCount
    );
  }
  const dimension = [...dimensions][0] as PriceDimension;
  return finalizeCandidates(
    target,
    totalOccurrenceCount,
    priceKindForDimension(dimension),
    candidates
  );
}

function filterForTarget(target: Exclude<ProductDetailTarget, { type: 'occurrence' }>): {
  sql: string;
  params: SQLite.SQLiteBindValue[];
} {
  if (target.type === 'sku') {
    return { sql: 'receipt_items.sku_key = ?', params: [target.key] };
  }
  if (target.type === 'canonical') {
    return {
      sql: 'receipt_items.canonical_product_name = ?',
      params: [target.key],
    };
  }
  return {
    sql: 'receipt_items.product_family_key = ?',
    params: [target.key],
  };
}

async function getProductPriceHistoryDb(): Promise<SQLite.SQLiteDatabase> {
  await initIfNeeded();
  if (!_db) {
    _db = await ExpoSQLite.openDatabaseAsync(DB_NAME);
  }
  return _db;
}

export async function loadProductPriceHistoryWithDb(
  db: ProductPriceHistoryDatabase,
  target: ProductDetailTarget
): Promise<ProductPriceHistoryResult> {
  if (target.type === 'occurrence') {
    return buildProductPriceHistory(target, []);
  }
  const filter = filterForTarget(target);
  const rows = await db.getAllAsync<ProductPriceHistoryRow>(
    `SELECT
       receipt_items.receipt_id AS receiptId,
       receipt_items.id AS itemId,
       receipt_items.source_index AS sourceIndex,
       COALESCE(receipts.transaction_at, receipts.created_at) AS occurredAt,
       receipts.merchant_raw AS merchantRaw,
       receipts.merchant_normalized AS merchantNormalized,
       COALESCE(
         NULLIF(receipt_items.normalized_full_name, ''),
         NULLIF(receipt_items.raw_name, ''),
         NULLIF(receipt_items.canonical_product_name, ''),
         receipt_items.normalized_name,
         ''
       ) AS displayName,
       receipts.currency AS currency,
       receipt_items.line_total AS lineTotal,
       receipt_items.purchase_quantity AS purchaseQuantity,
       receipt_items.product_family_key AS productFamilyKey,
       receipt_items.volume_base_ml AS volumeBaseMl,
       receipt_items.weight_base_g AS weightBaseG,
       receipt_items.count_base AS countBase
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE ${filter.sql}
     ORDER BY
       COALESCE(receipts.transaction_at, receipts.created_at) ASC,
       receipt_items.receipt_id ASC,
       receipt_items.source_index ASC`,
    filter.params
  );
  return buildProductPriceHistory(target, rows);
}

export async function loadProductPriceHistory(
  target: ProductDetailTarget
): Promise<ProductPriceHistoryResult> {
  const db = await getProductPriceHistoryDb();
  return loadProductPriceHistoryWithDb(db, target);
}
