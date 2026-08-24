import type * as SQLite from 'expo-sqlite';
import * as ExpoSQLite from 'expo-sqlite';

import { initIfNeeded } from './db';
import { merchantAnalyticsKey } from './merchantAnalytics';
import type {
  AggregatableProductDetailTarget,
  ProductDetailTarget,
} from './productDetailTarget';
import type { Locale } from './i18n';

export type ProductSpecificationVariant = {
  sizeValue: number | null;
  sizeUnit: string | null;
  packCount: number | null;
  volumeBaseMl: number | null;
  weightBaseG: number | null;
  countBase: number | null;
  sourceText: string | null;
  purchaseOccurrenceCount: number;
};

export type ProductMerchantSummary = {
  merchantName: string | null;
  purchaseOccurrenceCount: number;
  lastPurchasedAt: number;
};

export type ProductPurchaseOccurrence = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  displayName: string;
  category: string | null;
  purchaseQuantity: number;
  lineTotal: number | null;
  currency: string;
  purchasedAt: number;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  specification: ProductSpecificationVariant;
};

export type ProductCurrencyTotal = {
  currency: string;
  totalSpend: number;
};

export type ProductHistorySummary = {
  target: AggregatableProductDetailTarget;
  title: string | null;
  purchaseOccurrenceCount: number;
  totalPurchaseQuantity: number;
  totalSpend: number | null;
  currency: string | null;
  currencyTotals: ProductCurrencyTotal[];
  firstPurchasedAt: number | null;
  lastPurchasedAt: number | null;
  merchantCount: number;
  canonicalProductCount: number;
  skuCount: number;
  specificationVariants: ProductSpecificationVariant[];
  merchants: ProductMerchantSummary[];
  recentPurchases: ProductPurchaseOccurrence[];
};

export type ProductHistoryDatabase = {
  getFirstAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T | null>;
  getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]>;
};

type AggregateRow = {
  purchaseOccurrenceCount: number;
  totalPurchaseQuantity: number;
  firstPurchasedAt: number | null;
  lastPurchasedAt: number | null;
  canonicalProductCount: number;
  skuCount: number;
};

type RepresentativeRow = {
  rawName: string | null;
  normalizedFullName: string | null;
  canonicalProductName: string | null;
  specSizeValue: number | null;
  specSizeUnit: string | null;
  specPackCount: number | null;
  volumeBaseMl: number | null;
  weightBaseG: number | null;
  countBase: number | null;
  specSourceText: string | null;
};

const DB_NAME = 'receipts_v2.db';
const DEFAULT_RECENT_PURCHASE_LIMIT = 30;
let _db: SQLite.SQLiteDatabase | null = null;

function finiteNumber(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function nullableTimestamp(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? numberValue
    : null;
}

export type ProductMerchantEvidenceRow = {
  merchantRaw: string | null;
  merchantNormalized: string | null;
  purchasedAt: number;
};

/**
 * Group product-history merchant observations by the frozen production identity
 * `merchantAnalyticsKey` (R1-B3c).
 *
 * Display (`merchantName`) stays historical evidence:
 * `merchant_raw || merchant_normalized` from the latest observation in the group.
 * Do NOT show the analytics key as the store label.
 */
export function aggregateProductMerchantsByAnalyticsKey(
  rows: readonly ProductMerchantEvidenceRow[]
): ProductMerchantSummary[] {
  type Acc = {
    merchantName: string | null;
    purchaseOccurrenceCount: number;
    lastPurchasedAt: number;
  };
  const byKey = new Map<string, Acc>();

  for (const row of rows) {
    const key = merchantAnalyticsKey({
      merchant_raw: row.merchantRaw,
      merchant_normalized: row.merchantNormalized,
    });
    // Preserve empty-merchant bucket as one group (matches prior COALESCE null group).
    const mapKey = key;
    const purchasedAt = finiteNumber(row.purchasedAt);
    const display =
      (typeof row.merchantRaw === 'string' && row.merchantRaw.trim()
        ? row.merchantRaw.trim()
        : null) ||
      (typeof row.merchantNormalized === 'string' && row.merchantNormalized.trim()
        ? row.merchantNormalized.trim()
        : null);

    const current = byKey.get(mapKey);
    if (!current) {
      byKey.set(mapKey, {
        merchantName: display,
        purchaseOccurrenceCount: 1,
        lastPurchasedAt: purchasedAt,
      });
      continue;
    }
    current.purchaseOccurrenceCount += 1;
    if (purchasedAt >= current.lastPurchasedAt) {
      current.lastPurchasedAt = purchasedAt;
      // Prefer latest observation's display evidence.
      current.merchantName = display;
    }
  }

  return [...byKey.values()].sort(
    (left, right) =>
      right.purchaseOccurrenceCount - left.purchaseOccurrenceCount ||
      right.lastPurchasedAt - left.lastPurchasedAt
  );
}

/** SQL fragment to exclude high-confidence duplicate receipt ids from product history. */
function excludedReceiptSql(
  excludedReceiptIds?: ReadonlySet<string>
): { sql: string; params: string[] } {
  if (!excludedReceiptIds || excludedReceiptIds.size === 0) {
    return { sql: '', params: [] };
  }
  const ids = [...excludedReceiptIds];
  return {
    sql: ` AND receipt_items.receipt_id NOT IN (${ids.map(() => '?').join(',')})`,
    params: ids,
  };
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(3)));
}

export function formatProductSpecification(
  specification: Pick<
    ProductSpecificationVariant,
    'sizeValue' | 'sizeUnit' | 'packCount' | 'countBase' | 'sourceText'
  >,
  locale: Locale = 'en'
): string | null {
  const sizeValue =
    specification.sizeValue != null && Number.isFinite(specification.sizeValue)
      ? specification.sizeValue
      : null;
  const unit = specification.sizeUnit?.trim().toLowerCase() || null;
  let base: string | null = null;
  if (unit === 'count') {
    const count = sizeValue ?? specification.countBase;
    if (count != null && Number.isFinite(count)) {
      const suffix = locale === 'ja' ? '個' : locale === 'zh' ? '个' : ' items';
      base = `${formatNumber(count)}${suffix}`;
    }
  } else if (sizeValue != null && unit) {
    base = `${formatNumber(sizeValue)}${unit}`;
  }
  if (!base && specification.sourceText?.trim()) {
    base = specification.sourceText.trim();
  }
  if (!base) return null;

  const packCount = finiteNumber(specification.packCount, 1);
  return packCount > 1 ? `${base} × ${formatNumber(packCount)}` : base;
}

function filterForTarget(target: AggregatableProductDetailTarget): {
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
  if (target.type === 'merchant_product') {
    // Do not treat mp id as product_family_key. Broad fetch + identity filter.
    return { sql: '1 = 1', params: [] };
  }
  return {
    sql: 'receipt_items.product_family_key = ?',
    params: [target.key],
  };
}

function toSpecificationVariant(
  row: {
    specSizeValue: number | null;
    specSizeUnit: string | null;
    specPackCount: number | null;
    volumeBaseMl: number | null;
    weightBaseG: number | null;
    countBase: number | null;
    specSourceText: string | null;
    purchaseOccurrenceCount?: number;
  }
): ProductSpecificationVariant {
  return {
    sizeValue: row.specSizeValue,
    sizeUnit: row.specSizeUnit,
    packCount: row.specPackCount,
    volumeBaseMl: row.volumeBaseMl,
    weightBaseG: row.weightBaseG,
    countBase: row.countBase,
    sourceText: row.specSourceText,
    purchaseOccurrenceCount: finiteNumber(row.purchaseOccurrenceCount),
  };
}

function resolveTitle(
  target: AggregatableProductDetailTarget,
  representative: RepresentativeRow | null,
  locale: Locale
): string | null {
  if (target.type === 'canonical') return target.key;
  if (target.type === 'family') return null;
  if (!representative) return null;

  const base =
    representative.canonicalProductName?.trim() ||
    representative.normalizedFullName?.trim() ||
    representative.rawName?.trim() ||
    null;
  if (!base) return null;
  if (!representative.canonicalProductName) return base;

  const specification = formatProductSpecification(
    toSpecificationVariant({
      ...representative,
      purchaseOccurrenceCount: 0,
    }),
    locale
  );
  return specification ? `${base} ${specification}` : base;
}

async function getProductHistoryDb(): Promise<SQLite.SQLiteDatabase> {
  await initIfNeeded();
  if (!_db) {
    _db = await ExpoSQLite.openDatabaseAsync(DB_NAME);
  }
  return _db;
}


async function loadMerchantProductHistorySummaryWithDb(
  db: ProductHistoryDatabase,
  target: Extract<AggregatableProductDetailTarget, { type: 'merchant_product' }>,
  options: {
    recentLimit?: number;
    locale?: Locale;
    excludedReceiptIds?: ReadonlySet<string>;
  }
): Promise<ProductHistorySummary | null> {
  const exclusion = excludedReceiptSql(options.excludedReceiptIds);
  const whereSql = `1 = 1${exclusion.sql}`;
  const whereParams = [...exclusion.params];
  const recentLimit = Math.max(
    1,
    Math.min(
      100,
      Math.floor(finiteNumber(options.recentLimit, DEFAULT_RECENT_PURCHASE_LIMIT))
    )
  );

  const rows = await db.getAllAsync<{
    receiptId: string;
    itemId: string;
    sourceIndex: number;
    displayName: string;
    category: string | null;
    purchaseQuantity: number;
    lineTotal: number | null;
    currency: string | null;
    purchasedAt: number;
    merchantRaw: string | null;
    merchantNormalized: string | null;
    rawName: string | null;
  }>(
    `SELECT
       receipt_items.receipt_id AS receiptId,
       receipt_items.id AS itemId,
       receipt_items.source_index AS sourceIndex,
       COALESCE(
         NULLIF(receipt_items.normalized_full_name, ''),
         NULLIF(receipt_items.raw_name, ''),
         NULLIF(receipt_items.canonical_product_name, ''),
         ''
       ) AS displayName,
       receipt_items.category AS category,
       receipt_items.purchase_quantity AS purchaseQuantity,
       receipt_items.line_total AS lineTotal,
       receipts.currency AS currency,
       COALESCE(receipts.transaction_at, receipts.created_at) AS purchasedAt,
       receipts.merchant_raw AS merchantRaw,
       receipts.merchant_normalized AS merchantNormalized,
       receipt_items.raw_name AS rawName
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE ${whereSql}
     ORDER BY COALESCE(receipts.transaction_at, receipts.created_at) DESC,
       receipt_items.source_index ASC`,
    whereParams
  );

  const { resolveIdentityConsumerObservations } = await import(
    './productIdentityConsumer'
  );
  const observations = rows.map((r) => ({
    receiptId: r.receiptId,
    itemSourceIndex: r.sourceIndex,
    rawName: (r.rawName || r.displayName || '').trim(),
    merchantKey: (r.merchantNormalized || r.merchantRaw || '').trim(),
    occurredAt: Number(r.purchasedAt) || 0,
    lineTotal: r.lineTotal,
    quantity: r.purchaseQuantity,
  }));
  const { qualified } = resolveIdentityConsumerObservations(observations);
  const matched = qualified.filter((q) => q.merchantProductId === target.key);
  if (!matched.length) return null;

  const keySet = new Set(
    matched.map((q) => `${q.receiptId}::${q.itemSourceIndex}`)
  );
  const matchedRows = rows.filter((r) =>
    keySet.has(`${r.receiptId}::${r.sourceIndex}`)
  );
  if (!matchedRows.length) return null;

  const title =
    matched.find((q) => (q.rawName || '').trim())?.rawName ??
    matchedRows[0]?.displayName ??
    null;

  const currencyBuckets = new Map<string, number>();
  for (const r of matchedRows) {
    const c = typeof r.currency === 'string' ? r.currency.trim() : '';
    if (!c || c.toLowerCase() === 'unknown') continue;
    const spend = r.lineTotal == null ? 0 : finiteNumber(r.lineTotal);
    currencyBuckets.set(c, (currencyBuckets.get(c) ?? 0) + spend);
  }
  const currencyTotals = [...currencyBuckets.entries()].map(
    ([currency, totalSpend]) => ({ currency, totalSpend })
  );
  const singleCurrency = currencyTotals.length === 1 ? currencyTotals[0]! : null;

  const purchasedAts = matchedRows
    .map((r) => Number(r.purchasedAt))
    .filter((t) => Number.isFinite(t) && t > 0);
  const merchantMap = new Map<string, ProductMerchantSummary>();
  for (const r of matchedRows) {
    const key =
      (r.merchantNormalized || r.merchantRaw || '').trim() || 'unknown';
    const existing = merchantMap.get(key);
    const purchasedAt = Number(r.purchasedAt) || 0;
    if (!existing) {
      merchantMap.set(key, {
        merchantName: key === 'unknown' ? null : key,
        purchaseOccurrenceCount: 1,
        lastPurchasedAt: purchasedAt,
      });
    } else {
      existing.purchaseOccurrenceCount += 1;
      if (purchasedAt > existing.lastPurchasedAt) {
        existing.lastPurchasedAt = purchasedAt;
      }
    }
  }

  return {
    target,
    title,
    purchaseOccurrenceCount: matchedRows.length,
    totalPurchaseQuantity: matchedRows.reduce((sum, r) => {
      const q = finiteNumber(r.purchaseQuantity);
      return sum + (q > 0 ? q : 0);
    }, 0),
    totalSpend: singleCurrency ? singleCurrency.totalSpend : null,
    currency: singleCurrency?.currency ?? null,
    currencyTotals,
    firstPurchasedAt: purchasedAts.length ? Math.min(...purchasedAts) : null,
    lastPurchasedAt: purchasedAts.length ? Math.max(...purchasedAts) : null,
    merchantCount: merchantMap.size,
    canonicalProductCount: 0,
    skuCount: 0,
    specificationVariants: [],
    merchants: [...merchantMap.values()].sort(
      (a, b) =>
        b.purchaseOccurrenceCount - a.purchaseOccurrenceCount ||
        b.lastPurchasedAt - a.lastPurchasedAt
    ),
    recentPurchases: matchedRows.slice(0, recentLimit).map((row) => ({
      receiptId: row.receiptId,
      itemId: row.itemId,
      sourceIndex: row.sourceIndex,
      displayName: row.displayName,
      category: row.category,
      purchaseQuantity: finiteNumber(row.purchaseQuantity, 1),
      lineTotal: row.lineTotal == null ? null : finiteNumber(row.lineTotal),
      currency: (row.currency || '').trim(),
      purchasedAt: Number(row.purchasedAt) || 0,
      merchantRaw: row.merchantRaw,
      merchantNormalized: row.merchantNormalized,
      specification: toSpecificationVariant({
        specSizeValue: null,
        specSizeUnit: null,
        specPackCount: null,
        volumeBaseMl: null,
        weightBaseG: null,
        countBase: null,
        specSourceText: null,
      }),
    })),
  };
}

export async function loadProductHistoryWithDb(
  db: ProductHistoryDatabase,
  target: ProductDetailTarget,
  options: {
    recentLimit?: number;
    locale?: Locale;
    excludedReceiptIds?: ReadonlySet<string>;
  } = {}
): Promise<ProductHistorySummary | null> {
  if (target.type === 'occurrence') return null;

  // MerchantProduct detail: never treat mp_* as product_family_key.
  if (target.type === 'merchant_product') {
    return loadMerchantProductHistorySummaryWithDb(db, target, options);
  }
  const filter = filterForTarget(target);
  const exclusion = excludedReceiptSql(options.excludedReceiptIds);
  const whereSql = `${filter.sql}${exclusion.sql}`;
  const whereParams = [...filter.params, ...exclusion.params];
  const recentLimit = Math.max(
    1,
    Math.min(100, Math.floor(finiteNumber(options.recentLimit, DEFAULT_RECENT_PURCHASE_LIMIT)))
  );

  const aggregate = await db.getFirstAsync<AggregateRow>(
    `SELECT
       COUNT(*) AS purchaseOccurrenceCount,
       COALESCE(SUM(
         CASE
           WHEN receipt_items.purchase_quantity > 0
             THEN receipt_items.purchase_quantity
           ELSE 1
         END
       ), 0) AS totalPurchaseQuantity,
       MIN(COALESCE(receipts.transaction_at, receipts.created_at)) AS firstPurchasedAt,
       MAX(COALESCE(receipts.transaction_at, receipts.created_at)) AS lastPurchasedAt,
       COUNT(DISTINCT receipt_items.canonical_product_name) AS canonicalProductCount,
       COUNT(DISTINCT receipt_items.sku_key) AS skuCount
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE ${whereSql}`,
    whereParams
  );
  const occurrenceCount = finiteNumber(aggregate?.purchaseOccurrenceCount);
  if (occurrenceCount === 0) return null;

  const representative = await db.getFirstAsync<RepresentativeRow>(
    `SELECT
       receipt_items.raw_name AS rawName,
       receipt_items.normalized_full_name AS normalizedFullName,
       receipt_items.canonical_product_name AS canonicalProductName,
       receipt_items.spec_size_value AS specSizeValue,
       receipt_items.spec_size_unit AS specSizeUnit,
       receipt_items.spec_pack_count AS specPackCount,
       receipt_items.volume_base_ml AS volumeBaseMl,
       receipt_items.weight_base_g AS weightBaseG,
       receipt_items.count_base AS countBase,
       receipt_items.spec_source_text AS specSourceText
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE ${whereSql}
     ORDER BY COALESCE(receipts.transaction_at, receipts.created_at) DESC,
       receipt_items.source_index ASC
     LIMIT 1`,
    whereParams
  );

  const currencyTotals = await db.getAllAsync<ProductCurrencyTotal>(
    `SELECT
       receipts.currency AS currency,
       COALESCE(SUM(
         CASE
           WHEN typeof(receipt_items.line_total) IN ('integer', 'real')
             THEN receipt_items.line_total
           ELSE 0
         END
       ), 0) AS totalSpend
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE ${whereSql}
     GROUP BY receipts.currency
     ORDER BY receipts.currency ASC`,
    whereParams
  );

  // R1-B3c: read merchant evidence, group by merchantAnalyticsKey in app layer
  // (SQL cannot safely replicate normalizeMerchantName). Display stays raw||normalized.
  const merchantEvidence = await db.getAllAsync<ProductMerchantEvidenceRow>(
    `SELECT
       receipts.merchant_raw AS merchantRaw,
       receipts.merchant_normalized AS merchantNormalized,
       COALESCE(receipts.transaction_at, receipts.created_at) AS purchasedAt
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE ${whereSql}`,
    whereParams
  );
  const merchants = aggregateProductMerchantsByAnalyticsKey(merchantEvidence);

  const specificationVariants = await db.getAllAsync<ProductSpecificationVariant>(
    `SELECT
       receipt_items.spec_size_value AS sizeValue,
       receipt_items.spec_size_unit AS sizeUnit,
       receipt_items.spec_pack_count AS packCount,
       receipt_items.volume_base_ml AS volumeBaseMl,
       receipt_items.weight_base_g AS weightBaseG,
       receipt_items.count_base AS countBase,
       receipt_items.spec_source_text AS sourceText,
       COUNT(*) AS purchaseOccurrenceCount
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE ${whereSql}
       AND (
         receipt_items.spec_size_value IS NOT NULL
         OR receipt_items.volume_base_ml IS NOT NULL
         OR receipt_items.weight_base_g IS NOT NULL
         OR receipt_items.count_base IS NOT NULL
       )
     GROUP BY
       receipt_items.spec_size_value,
       receipt_items.spec_size_unit,
       receipt_items.spec_pack_count,
       receipt_items.volume_base_ml,
       receipt_items.weight_base_g,
       receipt_items.count_base,
       receipt_items.spec_source_text
     ORDER BY purchaseOccurrenceCount DESC, sizeValue ASC`,
    whereParams
  );

  const recentPurchases = await db.getAllAsync<ProductPurchaseOccurrence>(
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
       receipt_items.category AS category,
       receipt_items.purchase_quantity AS purchaseQuantity,
       receipt_items.line_total AS lineTotal,
       receipts.currency AS currency,
       COALESCE(receipts.transaction_at, receipts.created_at) AS purchasedAt,
       receipts.merchant_raw AS merchantRaw,
       receipts.merchant_normalized AS merchantNormalized,
       receipt_items.spec_size_value AS specSizeValue,
       receipt_items.spec_size_unit AS specSizeUnit,
       receipt_items.spec_pack_count AS specPackCount,
       receipt_items.volume_base_ml AS volumeBaseMl,
       receipt_items.weight_base_g AS weightBaseG,
       receipt_items.count_base AS countBase,
       receipt_items.spec_source_text AS specSourceText
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     WHERE ${whereSql}
     ORDER BY COALESCE(receipts.transaction_at, receipts.created_at) DESC,
       receipt_items.source_index ASC
     LIMIT ?`,
    [...whereParams, recentLimit]
  );

  const normalizedPurchases = recentPurchases.map((purchase) => {
    const row = purchase as ProductPurchaseOccurrence & {
      specSizeValue?: number | null;
      specSizeUnit?: string | null;
      specPackCount?: number | null;
      volumeBaseMl?: number | null;
      weightBaseG?: number | null;
      countBase?: number | null;
      specSourceText?: string | null;
    };
    return {
      receiptId: row.receiptId,
      itemId: row.itemId,
      sourceIndex: row.sourceIndex,
      displayName: row.displayName,
      category: row.category,
      purchaseQuantity: finiteNumber(row.purchaseQuantity, 1),
      lineTotal:
        row.lineTotal == null ? null : finiteNumber(row.lineTotal),
      currency: row.currency,
      purchasedAt: row.purchasedAt,
      merchantRaw: row.merchantRaw,
      merchantNormalized: row.merchantNormalized,
      specification: toSpecificationVariant({
        specSizeValue: row.specSizeValue ?? null,
        specSizeUnit: row.specSizeUnit ?? null,
        specPackCount: row.specPackCount ?? null,
        volumeBaseMl: row.volumeBaseMl ?? null,
        weightBaseG: row.weightBaseG ?? null,
        countBase: row.countBase ?? null,
        specSourceText: row.specSourceText ?? null,
      }),
    };
  });

  const singleCurrency = currencyTotals.length === 1 ? currencyTotals[0] : null;
  return {
    target,
    title: resolveTitle(target, representative, options.locale ?? 'en'),
    purchaseOccurrenceCount: occurrenceCount,
    totalPurchaseQuantity: finiteNumber(aggregate?.totalPurchaseQuantity),
    totalSpend: singleCurrency ? finiteNumber(singleCurrency.totalSpend) : null,
    currency: singleCurrency?.currency ?? null,
    currencyTotals: currencyTotals.map((row) => ({
      currency: (typeof row.currency === 'string' && row.currency.trim()) ? row.currency.trim() : 'UNKNOWN',
      totalSpend: finiteNumber(row.totalSpend),
    })),
    firstPurchasedAt: nullableTimestamp(aggregate?.firstPurchasedAt),
    lastPurchasedAt: nullableTimestamp(aggregate?.lastPurchasedAt),
    merchantCount: merchants.length,
    canonicalProductCount: finiteNumber(aggregate?.canonicalProductCount),
    skuCount: finiteNumber(aggregate?.skuCount),
    specificationVariants: specificationVariants.map((row) => ({
      ...row,
      purchaseOccurrenceCount: finiteNumber(row.purchaseOccurrenceCount),
    })),
    merchants: merchants.map((row) => ({
      merchantName: row.merchantName,
      purchaseOccurrenceCount: finiteNumber(row.purchaseOccurrenceCount),
      lastPurchasedAt: finiteNumber(row.lastPurchasedAt),
    })),
    recentPurchases: normalizedPurchases,
  };
}

export async function loadProductHistory(
  target: ProductDetailTarget,
  options: {
    recentLimit?: number;
    locale?: Locale;
    excludedReceiptIds?: ReadonlySet<string>;
  } = {}
): Promise<ProductHistorySummary | null> {
  const db = await getProductHistoryDb();
  return loadProductHistoryWithDb(db, target, options);
}
