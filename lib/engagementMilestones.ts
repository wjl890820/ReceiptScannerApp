import type * as SQLite from 'expo-sqlite';

import { resolveItemFinalCategory } from './homeMetricsHelpers';
import {
  filterV1SupportedReceipts,
  isV1SupportedReceipt,
  type V1SupportedReceiptSource,
} from './merchantType';
import type {
  ProductPriceHistoryRow,
  ProductPriceHistoryResult,
  ProductPriceKind,
} from './productPriceHistory';
import { getReceiptItems } from './receiptItems';
import { jstCalendarDayStartMs } from './dateParser';
import type { ReceiptRow } from './db';

export const ENGAGEMENT_MILESTONES = [1, 3, 5, 10] as const;

export type EngagementMilestone = (typeof ENGAGEMENT_MILESTONES)[number];

export type EngagementMilestoneStatus = {
  supportedReceiptCount: number;
  currentMilestone: EngagementMilestone | null;
  justUnlocked: EngagementMilestone | null;
  nextMilestone: EngagementMilestone | null;
  receiptsUntilNext: number | null;
};

export type MilestoneCategory =
  | 'food_ingredients'
  | 'ready_to_eat'
  | 'snacks_drinks'
  | 'household'
  | 'other';

export type MilestoneCategoryComposition = {
  category: MilestoneCategory;
  itemCount: number;
  spend: number;
  itemShare: number;
  spendShare: number;
};

export type MilestoneCategoryStructure = {
  categories: MilestoneCategoryComposition[];
  uncategorizedItemCount: number;
  uncategorizedSpend: number;
};

export type MilestoneDeterministicSummary = {
  summaryType:
    | 'dominant_category'
    | 'recurring_category'
    | 'different_merchants'
    | 'dispersed';
  summaryKey: string;
  data: Record<string, string | number>;
};

export type MilestoneHighestItem = {
  displayName: string;
  lineTotal: number;
  sourceIndex: number;
};

export type ReceiptShoppingSummary = {
  receiptId: string;
  merchant: string | null;
  transactionAt: number;
  total: number;
  currency: string;
  itemCount: number;
  highestItem: MilestoneHighestItem | null;
  categoryStructure: MilestoneCategoryStructure;
  summary: MilestoneDeterministicSummary;
};

export type FrequentProductPriceSummary = {
  priceKind: ProductPriceKind;
  currency: string;
  latestPrice: number;
  minRecordedPrice: number;
};

export type MilestoneFrequentProduct = {
  groupingType:
    | 'canonical'
    | 'family'
    | 'sku'
    | 'merchant_product'
    | 'personal_product';
  key: string;
  displayLabel: string;
  displayLabelKey: string | null;
  /** V1 frozen: distinct receipt_id purchase events — not item-row count. */
  purchaseOccurrenceCount: number;
  totalPurchaseQuantity: number;
  lastPurchasedAt: number;
  priceSummary: FrequentProductPriceSummary | null;
};

export type MilestoneShoppingFrequency = {
  recordedReceiptCount: number;
  firstRecordedAt: number;
  lastRecordedAt: number;
  activeSpanDays: number;
  intervalCount: number;
  averageIntervalDays: number;
};

export type MilestoneWindowComparison = {
  firstReceiptIds: string[];
  latestReceiptIds: string[];
  firstCategoryStructure: MilestoneCategoryStructure;
  latestCategoryStructure: MilestoneCategoryStructure;
};

export type MilestoneRecentChange = {
  changeType: 'category_share_increase' | 'category_share_decrease';
  summaryKey: string;
  category: MilestoneCategory;
  firstShare: number;
  latestShare: number;
  differencePercentagePoints: number;
};

type EngagementMilestoneBase = {
  milestone: EngagementMilestone;
  generatedAt: number;
  supportedReceiptCount: number;
  nextMilestone: EngagementMilestone | null;
  receiptsUntilNext: number | null;
  dataCoverageIncomplete: boolean;
};

export type FirstReceiptMilestone = EngagementMilestoneBase & {
  milestone: 1;
  receiptId: string;
  merchant: string | null;
  transactionAt: number;
  total: number;
  currency: string;
  itemCount: number;
  highestItem: MilestoneHighestItem | null;
  categoryStructure: MilestoneCategoryStructure;
  summary: MilestoneDeterministicSummary;
};

export type ThreeReceiptMilestone = EngagementMilestoneBase & {
  milestone: 3;
  receiptIds: string[];
  totalSpend: number;
  averageSpendPerReceipt: number;
  categoryStructure: MilestoneCategoryStructure;
  summary: MilestoneDeterministicSummary;
};

export type FiveReceiptMilestone = EngagementMilestoneBase & {
  milestone: 5;
  frequentProducts: MilestoneFrequentProduct[];
};

export type TenReceiptMilestone = EngagementMilestoneBase & {
  milestone: 10;
  categoryStructure: MilestoneCategoryStructure;
  frequentProducts: MilestoneFrequentProduct[];
  shoppingFrequency: MilestoneShoppingFrequency | null;
  windowComparison: MilestoneWindowComparison;
  recentChange: MilestoneRecentChange | null;
};

export type EngagementMilestoneResult =
  | FirstReceiptMilestone
  | ThreeReceiptMilestone
  | FiveReceiptMilestone
  | TenReceiptMilestone;

export type EngagementMilestoneEvaluation = {
  status: EngagementMilestoneStatus;
  unlockedResult: EngagementMilestoneResult | null;
};

export type CurrentEngagementMilestoneEvaluation = {
  status: EngagementMilestoneStatus;
  currentResult: EngagementMilestoneResult | null;
};

export type EngagementReceipt = V1SupportedReceiptSource & {
  id: string;
  created_at: number;
  transaction_at: number | null;
  merchant_raw: string | null;
  merchant_normalized: string | null;
  total: number;
  /** Optional — used by duplicate fingerprints when present. */
  tax?: number;
  tax_is_known?: number;
  currency: string;
  final_total: number | null;
  user_items_json: string | null;
};

export type EngagementProductRow = ProductPriceHistoryRow &
  V1SupportedReceiptSource & {
    canonicalProductName: string | null;
    productFamilyKey: string | null;
    /** Existing receipt_items.sku_key only — never derived from bare normalized_name. */
    skuKey: string | null;
  };

export type EngagementMilestoneDatabase = {
  getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]>;
};

export type MilestoneProductInsightContext = {
  rows: EngagementProductRow[];
  queryFailed: boolean;
  priceHistoryBuilder?: (
    target:
      | { type: 'canonical'; key: string }
      | { type: 'family'; key: string }
      | { type: 'sku'; key: string },
    rows: ProductPriceHistoryRow[]
  ) => ProductPriceHistoryResult;
};

type MutableCategoryAggregate = {
  itemCount: number;
  spend: number;
};

const DB_NAME = 'receipts_v2.db';
const DAY_MS = 24 * 60 * 60 * 1000;
const DOMINANT_CATEGORY_SHARE = 0.5;
const CATEGORY_CHANGE_THRESHOLD = 0.15;
const NORMAL_CATEGORIES: readonly MilestoneCategory[] = [
  'food_ingredients',
  'ready_to_eat',
  'snacks_drinks',
  'household',
  'other',
];
let _db: SQLite.SQLiteDatabase | null = null;

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * V1 frozen purchase-event count: one event per distinct receiptId.
 * Rows without a usable receiptId do not add confirmed events (fail-closed).
 */
export function distinctReceiptCount(
  rows: ReadonlyArray<{ receiptId?: string | null }>
): number {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = typeof row.receiptId === 'string' ? row.receiptId.trim() : '';
    if (!id) continue;
    ids.add(id);
  }
  return ids.size;
}

function receiptTimestamp(receipt: EngagementReceipt): number {
  return finitePositive(receipt.transaction_at) ??
    finitePositive(receipt.created_at) ??
    0;
}

function receiptTotal(receipt: EngagementReceipt): number {
  return (
    finiteNonNegative(receipt.final_total) ??
    finiteNonNegative(receipt.total) ??
    0
  );
}

function sortReceiptsChronologically(
  receipts: EngagementReceipt[]
): EngagementReceipt[] {
  return [...receipts].sort(
    (left, right) =>
      receiptTimestamp(left) - receiptTimestamp(right) ||
      left.id.localeCompare(right.id)
  );
}

function itemName(item: Record<string, unknown>): string {
  for (const value of [
    item.name,
    item.raw_name,
    item.normalized_full_name,
    item.canonical_product_name,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function itemLineTotal(item: Record<string, unknown>): number | null {
  const camel = finiteNonNegative(item.lineTotal);
  return camel ?? finiteNonNegative(item.line_total);
}

function milestoneCategory(item: Record<string, unknown>): MilestoneCategory | null {
  const resolved = resolveItemFinalCategory(item as never);
  if (resolved === 'uncategorized') return null;
  if (
    resolved === 'personal_care' ||
    resolved === 'pet_care' ||
    !NORMAL_CATEGORIES.includes(resolved as MilestoneCategory)
  ) {
    return 'other';
  }
  return resolved as MilestoneCategory;
}

export function getEngagementMilestoneStatus(
  supportedReceiptCount: number,
  beforeSupportedReceiptCount?: number | null
): EngagementMilestoneStatus {
  const count = nonNegativeInteger(supportedReceiptCount);
  const before =
    beforeSupportedReceiptCount == null
      ? null
      : nonNegativeInteger(beforeSupportedReceiptCount);
  const currentMilestone =
    [...ENGAGEMENT_MILESTONES]
      .reverse()
      .find((milestone) => milestone <= count) ?? null;
  const nextMilestone =
    ENGAGEMENT_MILESTONES.find((milestone) => milestone > count) ?? null;
  const justUnlocked =
    before != null &&
    count > before &&
    ENGAGEMENT_MILESTONES.includes(count as EngagementMilestone)
      ? (count as EngagementMilestone)
      : null;

  return {
    supportedReceiptCount: count,
    currentMilestone,
    justUnlocked,
    nextMilestone,
    receiptsUntilNext:
      nextMilestone == null ? null : nextMilestone - count,
  };
}

export function countSupportedReceipts(
  receipts: EngagementReceipt[]
): number {
  return filterV1SupportedReceipts(receipts).length;
}

export function buildMilestoneCategoryStructure(
  receipts: EngagementReceipt[]
): MilestoneCategoryStructure {
  const aggregates = new Map<MilestoneCategory, MutableCategoryAggregate>();
  for (const category of NORMAL_CATEGORIES) {
    aggregates.set(category, { itemCount: 0, spend: 0 });
  }
  let uncategorizedItemCount = 0;
  let uncategorizedSpend = 0;

  for (const receipt of receipts) {
    const items = getReceiptItems(receipt) as Record<string, unknown>[];
    for (const item of items) {
      const category = milestoneCategory(item);
      const lineTotal = itemLineTotal(item) ?? 0;
      if (!category) {
        uncategorizedItemCount += 1;
        uncategorizedSpend += lineTotal;
        continue;
      }
      const aggregate = aggregates.get(category)!;
      aggregate.itemCount += 1;
      aggregate.spend += lineTotal;
    }
  }

  const categorizedItems = [...aggregates.values()].reduce(
    (sum, aggregate) => sum + aggregate.itemCount,
    0
  );
  const categorizedSpend = [...aggregates.values()].reduce(
    (sum, aggregate) => sum + aggregate.spend,
    0
  );
  return {
    categories: NORMAL_CATEGORIES.map((category) => {
      const aggregate = aggregates.get(category)!;
      return {
        category,
        itemCount: aggregate.itemCount,
        spend: aggregate.spend,
        itemShare:
          categorizedItems > 0 ? aggregate.itemCount / categorizedItems : 0,
        spendShare:
          categorizedSpend > 0 ? aggregate.spend / categorizedSpend : 0,
      };
    }),
    uncategorizedItemCount,
    uncategorizedSpend,
  };
}

function dominantCategorySummary(
  structure: MilestoneCategoryStructure
): MilestoneDeterministicSummary | null {
  const hasSpend = structure.categories.some((entry) => entry.spend > 0);
  const shareKey: 'spendShare' | 'itemShare' = hasSpend
    ? 'spendShare'
    : 'itemShare';
  const sorted = [...structure.categories].sort(
    (left, right) =>
      right[shareKey] - left[shareKey] ||
      NORMAL_CATEGORIES.indexOf(left.category) -
        NORMAL_CATEGORIES.indexOf(right.category)
  );
  const first = sorted[0];
  const second = sorted[1];
  if (
    !first ||
    first.category === 'other' ||
    first[shareKey] < DOMINANT_CATEGORY_SHARE ||
    (second && second[shareKey] === first[shareKey])
  ) {
    return null;
  }
  return {
    summaryType: 'dominant_category',
    summaryKey: `engagementMilestone.summary.dominant.${first.category}`,
    data: {
      category: first.category,
      share: first[shareKey],
      metric: hasSpend ? 'spend' : 'items',
    },
  };
}

function dispersedSummary(): MilestoneDeterministicSummary {
  return {
    summaryType: 'dispersed',
    summaryKey: 'engagementMilestone.summary.dispersed',
    data: {},
  };
}

function milestoneBase(
  milestone: EngagementMilestone,
  supportedReceiptCount: number,
  generatedAt: number,
  dataCoverageIncomplete: boolean
): EngagementMilestoneBase {
  const progress = getEngagementMilestoneStatus(supportedReceiptCount);
  return {
    milestone,
    generatedAt,
    supportedReceiptCount,
    nextMilestone: progress.nextMilestone,
    receiptsUntilNext: progress.receiptsUntilNext,
    dataCoverageIncomplete,
  };
}

export function buildFirstReceiptMilestone(
  supportedReceipts: EngagementReceipt[],
  generatedAt = Date.now()
): FirstReceiptMilestone | null {
  const receipts = sortReceiptsChronologically(
    filterV1SupportedReceipts(supportedReceipts)
  );
  const receipt = receipts[0];
  if (!receipt) return null;
  const shoppingSummary = buildReceiptShoppingSummary(receipt);

  return {
    ...milestoneBase(1, receipts.length, generatedAt, false),
    milestone: 1,
    ...shoppingSummary,
  };
}

export function buildReceiptShoppingSummary(
  receipt: EngagementReceipt
): ReceiptShoppingSummary {
  const items = getReceiptItems(receipt) as Record<string, unknown>[];
  let highestItem: MilestoneHighestItem | null = null;
  items.forEach((item, sourceIndex) => {
    const lineTotal = itemLineTotal(item);
    if (lineTotal == null) return;
    if (!highestItem || lineTotal > highestItem.lineTotal) {
      highestItem = {
        displayName: itemName(item),
        lineTotal,
        sourceIndex,
      };
    }
  });
  const categoryStructure = buildMilestoneCategoryStructure([receipt]);
  return {
    receiptId: receipt.id,
    merchant:
      receipt.merchant_raw?.trim() ||
      receipt.merchant_normalized?.trim() ||
      null,
    transactionAt: receiptTimestamp(receipt),
    total: receiptTotal(receipt),
    currency: receipt.currency,
    itemCount: items.length,
    highestItem,
    categoryStructure,
    summary: dominantCategorySummary(categoryStructure) ?? dispersedSummary(),
  };
}

function receiptCategoryPresence(
  receipt: EngagementReceipt
): Set<MilestoneCategory> {
  const categories = new Set<MilestoneCategory>();
  for (const item of getReceiptItems(receipt) as Record<string, unknown>[]) {
    const category = milestoneCategory(item);
    if (category && category !== 'other') categories.add(category);
  }
  return categories;
}

function buildThreeReceiptSummary(
  receipts: EngagementReceipt[],
  structure: MilestoneCategoryStructure
): MilestoneDeterministicSummary {
  const dominant = dominantCategorySummary(structure);
  if (dominant) return dominant;

  const presenceCounts = new Map<MilestoneCategory, number>();
  for (const receipt of receipts) {
    for (const category of receiptCategoryPresence(receipt)) {
      presenceCounts.set(category, (presenceCounts.get(category) ?? 0) + 1);
    }
  }
  const recurring = [...presenceCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(
      ([leftCategory, leftCount], [rightCategory, rightCount]) =>
        rightCount - leftCount ||
        NORMAL_CATEGORIES.indexOf(leftCategory) -
          NORMAL_CATEGORIES.indexOf(rightCategory)
    )[0];
  if (recurring) {
    return {
      summaryType: 'recurring_category',
      summaryKey: 'engagementMilestone.summary.recurringCategory',
      data: { category: recurring[0], receiptCount: recurring[1] },
    };
  }

  const merchants = receipts.map(
    (receipt) =>
      receipt.merchant_normalized?.trim() ||
      receipt.merchant_raw?.trim() ||
      ''
  );
  if (merchants.every(Boolean) && new Set(merchants).size === receipts.length) {
    return {
      summaryType: 'different_merchants',
      summaryKey: 'engagementMilestone.summary.differentMerchants',
      data: { merchantCount: merchants.length },
    };
  }
  return dispersedSummary();
}

export function buildThreeReceiptMilestone(
  supportedReceipts: EngagementReceipt[],
  generatedAt = Date.now()
): ThreeReceiptMilestone | null {
  const allSupported = sortReceiptsChronologically(
    filterV1SupportedReceipts(supportedReceipts)
  );
  if (allSupported.length < 3) return null;
  const receipts = allSupported.slice(-3);
  const totalSpend = receipts.reduce(
    (sum, receipt) => sum + receiptTotal(receipt),
    0
  );
  const categoryStructure = buildMilestoneCategoryStructure(receipts);

  return {
    ...milestoneBase(3, allSupported.length, generatedAt, false),
    milestone: 3,
    receiptIds: receipts.map((receipt) => receipt.id),
    totalSpend,
    averageSpendPerReceipt: totalSpend / receipts.length,
    categoryStructure,
    summary: buildThreeReceiptSummary(receipts, categoryStructure),
  };
}

/**
 * Deterministic display label for SKU frequent groups.
 * Never surfaces the raw sku_key hash.
 */
function pickSkuGroupDisplayLabel(rows: EngagementProductRow[]): string {
  type Acc = {
    count: number;
    earliestOccurredAt: number;
    earliestReceiptId: string;
  };
  const byLabel = new Map<string, Acc>();
  for (const row of rows) {
    const label = row.displayName?.trim();
    if (!label) continue;
    const existing = byLabel.get(label);
    if (!existing) {
      byLabel.set(label, {
        count: 1,
        earliestOccurredAt: row.occurredAt,
        earliestReceiptId: row.receiptId,
      });
      continue;
    }
    existing.count += 1;
    if (
      row.occurredAt < existing.earliestOccurredAt ||
      (row.occurredAt === existing.earliestOccurredAt &&
        row.receiptId.localeCompare(existing.earliestReceiptId) < 0)
    ) {
      existing.earliestOccurredAt = row.occurredAt;
      existing.earliestReceiptId = row.receiptId;
    }
  }
  const ranked = [...byLabel.entries()].sort(
    (left, right) =>
      right[1].count - left[1].count ||
      left[1].earliestOccurredAt - right[1].earliestOccurredAt ||
      left[1].earliestReceiptId.localeCompare(right[1].earliestReceiptId) ||
      left[0].localeCompare(right[0])
  );
  if (ranked[0]) return ranked[0][0];
  const fallback = [...rows]
    .sort(
      (left, right) =>
        left.occurredAt - right.occurredAt ||
        left.receiptId.localeCompare(right.receiptId) ||
        left.sourceIndex - right.sourceIndex
    )
    .map((row) => row.displayName?.trim())
    .find((label) => !!label);
  return fallback || 'product';
}

export function frequentProductGroups(
  receipts: EngagementReceipt[],
  context: MilestoneProductInsightContext
): {
  frequentProducts: MilestoneFrequentProduct[];
  dataCoverageIncomplete: boolean;
} {
  const selectedIds = new Set(receipts.map((receipt) => receipt.id));
  const rows = context.rows.filter(
    (row) => selectedIds.has(row.receiptId) && isV1SupportedReceipt(row)
  );
  const indexedReceiptIds = new Set(rows.map((row) => row.receiptId));
  const expectedIndexedReceiptIds = receipts
    .filter((receipt) => getReceiptItems(receipt).length > 0)
    .map((receipt) => receipt.id);
  const dataCoverageIncomplete =
    context.queryFailed ||
    expectedIndexedReceiptIds.some(
      (receiptId) => !indexedReceiptIds.has(receiptId)
    );
  const groups = new Map<
    string,
    {
      groupingType: 'canonical' | 'family' | 'sku';
      key: string;
      rows: EngagementProductRow[];
    }
  >();

  for (const row of rows) {
    const canonical = row.canonicalProductName?.trim();
    const family = row.productFamilyKey?.trim();
    const sku = row.skuKey?.trim();
    // Hierarchy: canonical > family > existing sku_key only.
    // Never fuzzy-merge bare normalized names into 常购.
    const groupingType: 'canonical' | 'family' | 'sku' | null = canonical
      ? 'canonical'
      : family
        ? 'family'
        : sku
          ? 'sku'
          : null;
    const key = canonical || family || sku;
    if (!groupingType || !key) continue;
    const mapKey = `${groupingType}:${key}`;
    const existing = groups.get(mapKey);
    if (existing) existing.rows.push(row);
    else groups.set(mapKey, { groupingType, key, rows: [row] });
  }

  const frequentProducts = [...groups.values()]
    .filter((group) => distinctReceiptCount(group.rows) >= 2)
    .map<MilestoneFrequentProduct>((group) => {
      const purchaseOccurrenceCount = distinctReceiptCount(group.rows);
      const sortedRows = [...group.rows].sort(
        (left, right) =>
          left.occurredAt - right.occurredAt ||
          left.receiptId.localeCompare(right.receiptId) ||
          left.sourceIndex - right.sourceIndex
      );
      const priceHistory = context.priceHistoryBuilder?.(
        { type: group.groupingType, key: group.key },
        sortedRows
      );
      const latestPoint =
        priceHistory?.points[priceHistory.points.length - 1] ?? null;
      const priceSummary =
        priceHistory?.status === 'ready' &&
        priceHistory.currency &&
        priceHistory.priceKind &&
        latestPoint
          ? {
              priceKind: priceHistory.priceKind,
              currency: priceHistory.currency,
              latestPrice: latestPoint.priceValue,
              minRecordedPrice: Math.min(
                ...priceHistory.points.map((point) => point.priceValue)
              ),
            }
          : null;
      return {
        groupingType: group.groupingType,
        key: group.key,
        displayLabel:
          group.groupingType === 'sku'
            ? pickSkuGroupDisplayLabel(sortedRows)
            : group.key,
        displayLabelKey:
          group.groupingType === 'family'
            ? `productDetail.family.${group.key}`
            : null,
        // Occurrence = distinct receipt events (not row count, not quantity).
        purchaseOccurrenceCount,
        totalPurchaseQuantity: group.rows.reduce(
          (sum, row) => sum + (finitePositive(row.purchaseQuantity) ?? 0),
          0
        ),
        lastPurchasedAt: sortedRows[sortedRows.length - 1].occurredAt,
        priceSummary,
      };
    })
    .sort(
      (left, right) =>
        right.purchaseOccurrenceCount - left.purchaseOccurrenceCount ||
        right.totalPurchaseQuantity - left.totalPurchaseQuantity ||
        right.lastPurchasedAt - left.lastPurchasedAt ||
        left.groupingType.localeCompare(right.groupingType) ||
        left.key.localeCompare(right.key)
    )
    .slice(0, 5);

  return { frequentProducts, dataCoverageIncomplete };
}

export function buildFiveReceiptMilestone(
  supportedReceipts: EngagementReceipt[],
  productContext: MilestoneProductInsightContext = {
    rows: [],
    queryFailed: true,
  },
  generatedAt = Date.now()
): FiveReceiptMilestone | null {
  const allSupported = sortReceiptsChronologically(
    filterV1SupportedReceipts(supportedReceipts)
  );
  if (allSupported.length < 5) return null;
  const receipts = allSupported.slice(-5);
  const products = frequentProductGroups(receipts, productContext);
  return {
    ...milestoneBase(
      5,
      allSupported.length,
      generatedAt,
      products.dataCoverageIncomplete
    ),
    milestone: 5,
    frequentProducts: products.frequentProducts,
  };
}

export function buildShoppingFrequency(
  receipts: EngagementReceipt[]
): MilestoneShoppingFrequency | null {
  const dates = [
    ...new Set(
      sortReceiptsChronologically(receipts)
        .map(receiptTimestamp)
        .map((timestamp) => jstCalendarDayStartMs(timestamp))
        .filter((timestamp): timestamp is number => timestamp != null)
    ),
  ].sort((left, right) => left - right);
  if (dates.length < 2) return null;
  const intervals = dates.slice(1).map((date, index) => date - dates[index]);
  const activeSpanDays = (dates[dates.length - 1] - dates[0]) / DAY_MS;
  return {
    recordedReceiptCount: receipts.length,
    firstRecordedAt: dates[0],
    lastRecordedAt: dates[dates.length - 1],
    activeSpanDays,
    intervalCount: intervals.length,
    averageIntervalDays:
      intervals.reduce((sum, interval) => sum + interval, 0) /
      intervals.length /
      DAY_MS,
  };
}

function categoryShare(
  structure: MilestoneCategoryStructure,
  category: MilestoneCategory
): number {
  return (
    structure.categories.find((entry) => entry.category === category)
      ?.spendShare ?? 0
  );
}

export function buildRecentCategoryChange(
  first: MilestoneCategoryStructure,
  latest: MilestoneCategoryStructure
): MilestoneRecentChange | null {
  const changes = NORMAL_CATEGORIES.map((category) => {
    const firstShare = categoryShare(first, category);
    const latestShare = categoryShare(latest, category);
    return {
      category,
      firstShare,
      latestShare,
      difference: latestShare - firstShare,
    };
  }).sort(
    (left, right) => {
      const magnitudeDifference =
        Math.abs(right.difference) - Math.abs(left.difference);
      return Math.abs(magnitudeDifference) > Number.EPSILON * 10
        ? magnitudeDifference
        : NORMAL_CATEGORIES.indexOf(left.category) -
            NORMAL_CATEGORIES.indexOf(right.category);
    }
  );
  const change = changes[0];
  if (!change || Math.abs(change.difference) < CATEGORY_CHANGE_THRESHOLD) {
    return null;
  }
  const increase = change.difference > 0;
  return {
    changeType: increase
      ? 'category_share_increase'
      : 'category_share_decrease',
    summaryKey: increase
      ? 'engagementMilestone.change.categoryIncrease'
      : 'engagementMilestone.change.categoryDecrease',
    category: change.category,
    firstShare: change.firstShare,
    latestShare: change.latestShare,
    differencePercentagePoints: Math.abs(change.difference) * 100,
  };
}

export function buildTenReceiptMilestone(
  supportedReceipts: EngagementReceipt[],
  productContext: MilestoneProductInsightContext = {
    rows: [],
    queryFailed: true,
  },
  generatedAt = Date.now()
): TenReceiptMilestone | null {
  const allSupported = sortReceiptsChronologically(
    filterV1SupportedReceipts(supportedReceipts)
  );
  if (allSupported.length < 10) return null;
  const receipts = allSupported.slice(-10);
  const firstWindow = receipts.slice(0, 5);
  const latestWindow = receipts.slice(-5);
  const firstCategoryStructure =
    buildMilestoneCategoryStructure(firstWindow);
  const latestCategoryStructure =
    buildMilestoneCategoryStructure(latestWindow);
  const products = frequentProductGroups(receipts, productContext);

  return {
    ...milestoneBase(
      10,
      allSupported.length,
      generatedAt,
      products.dataCoverageIncomplete
    ),
    milestone: 10,
    categoryStructure: buildMilestoneCategoryStructure(receipts),
    frequentProducts: products.frequentProducts,
    shoppingFrequency: buildShoppingFrequency(receipts),
    windowComparison: {
      firstReceiptIds: firstWindow.map((receipt) => receipt.id),
      latestReceiptIds: latestWindow.map((receipt) => receipt.id),
      firstCategoryStructure,
      latestCategoryStructure,
    },
    recentChange: buildRecentCategoryChange(
      firstCategoryStructure,
      latestCategoryStructure
    ),
  };
}

async function readAllReceipts(
  db: EngagementMilestoneDatabase
): Promise<EngagementReceipt[]> {
  return db.getAllAsync<EngagementReceipt>(
    `SELECT
       id,
       created_at,
       transaction_at,
       merchant_raw,
       merchant_normalized,
       merchant_type,
       total,
       COALESCE(tax, 0) AS tax,
       COALESCE(tax_is_known, 0) AS tax_is_known,
       currency,
       analysis_json,
       final_total,
       user_items_json
     FROM receipts
     ORDER BY COALESCE(transaction_at, created_at) ASC, id ASC`,
    []
  );
}

/** Apply D2-A3 analytics selection; returns purchase-candidate receipts + excluded ids. */
async function selectEngagementAnalyticsReceipts(
  receipts: EngagementReceipt[]
): Promise<{
  analyticsReceipts: EngagementReceipt[];
  excludedDuplicateReceiptIds: ReadonlySet<string>;
}> {
  // Dynamic import keeps engagement module graph free of analysisDReport → expo-sqlite.
  const { selectAnalyticsReceipts } = await import('./analyticsReceiptSelection');
  const selection = selectAnalyticsReceipts(receipts as ReceiptRow[]);
  return {
    analyticsReceipts: selection.analyticsReceipts as EngagementReceipt[],
    excludedDuplicateReceiptIds: selection.excludedDuplicateReceiptIds,
  };
}

function filterProductRowsByExcludedReceiptIds<T extends { receiptId: string }>(
  rows: readonly T[],
  excludedIds: ReadonlySet<string>
): T[] {
  if (excludedIds.size === 0) return [...rows];
  return rows.filter((row) => !excludedIds.has(row.receiptId));
}

async function readProductRows(
  db: EngagementMilestoneDatabase
): Promise<EngagementProductRow[]> {
  return db.getAllAsync<EngagementProductRow>(
    `SELECT
       receipt_items.receipt_id AS receiptId,
       receipt_items.id AS itemId,
       receipt_items.source_index AS sourceIndex,
       COALESCE(receipts.transaction_at, receipts.created_at) AS occurredAt,
       receipts.merchant_raw AS merchantRaw,
       receipts.merchant_normalized AS merchantNormalized,
       receipts.merchant_raw AS merchant_raw,
       receipts.merchant_normalized AS merchant_normalized,
       receipts.merchant_type AS merchant_type,
       receipts.analysis_json AS receiptAnalysisJson,
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
       receipt_items.canonical_product_name AS canonicalProductName,
       receipt_items.product_family_key AS productFamilyKey,
       receipt_items.sku_key AS skuKey,
       receipt_items.volume_base_ml AS volumeBaseMl,
       receipt_items.weight_base_g AS weightBaseG,
       receipt_items.count_base AS countBase,
       receipt_items.gross_line_amount AS grossLineAmount,
       receipt_items.effective_line_amount AS effectiveLineAmount,
       receipt_items.discount_allocated AS discountAllocated,
       receipt_items.amount_provenance AS amountProvenance,
       receipt_items.item_amount_evidence_state AS itemAmountEvidenceState,
       receipt_items.promo_markers_json AS promoMarkersJson,
       receipt_items.evidence_capture_version AS evidenceCaptureVersion,
       receipt_items.price_observation_version AS priceObservationVersion,
       receipt_items.item_source AS itemSource,
       receipt_items.identity_source AS identitySource,
       receipt_items.identity_confidence AS identityConfidence,
       receipts.user_items_json AS receiptUserItemsJson,
       COALESCE(receipts.user_edited, 0) AS receiptUserEdited,
       receipts.total AS receiptTotal,
       receipts.final_total AS receiptFinalTotal,
       receipts.tax AS receiptTax,
       COALESCE(receipts.tax_is_known, 0) AS receiptTaxIsKnown,
       receipts.currency AS receiptCurrency
     FROM receipt_items
     INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
     ORDER BY
       COALESCE(receipts.transaction_at, receipts.created_at) ASC,
       receipt_items.receipt_id ASC,
       receipt_items.source_index ASC`,
    []
  );
}

async function readProductInsightContext(
  db: EngagementMilestoneDatabase,
  excludedDuplicateReceiptIds?: ReadonlySet<string>
): Promise<MilestoneProductInsightContext> {
  try {
    const rows = await readProductRows(db);
    const filtered =
      excludedDuplicateReceiptIds && excludedDuplicateReceiptIds.size > 0
        ? filterProductRowsByExcludedReceiptIds(
            rows,
            excludedDuplicateReceiptIds
          )
        : rows;
    try {
      const { buildProductPriceHistory } = await import(
        './productPriceHistory'
      );
      return {
        rows: filtered,
        queryFailed: false,
        priceHistoryBuilder: buildProductPriceHistory,
      };
    } catch {
      return { rows: filtered, queryFailed: false };
    }
  } catch {
    return { rows: [], queryFailed: true };
  }
}

async function evaluateReceiptSetWithDb(
  db: EngagementMilestoneDatabase,
  receipts: EngagementReceipt[],
  options: {
    beforeSupportedReceiptCount?: number | null;
    generatedAt?: number;
    excludedDuplicateReceiptIds?: ReadonlySet<string>;
  }
): Promise<EngagementMilestoneEvaluation> {
  const supportedReceipts = filterV1SupportedReceipts(receipts);
  const status = getEngagementMilestoneStatus(
    supportedReceipts.length,
    options.beforeSupportedReceiptCount
  );
  if (!status.justUnlocked) {
    return { status, unlockedResult: null };
  }

  const generatedAt = options.generatedAt ?? Date.now();
  if (status.justUnlocked === 1) {
    return {
      status,
      unlockedResult: buildFirstReceiptMilestone(
        supportedReceipts,
        generatedAt
      ),
    };
  }
  if (status.justUnlocked === 3) {
    return {
      status,
      unlockedResult: buildThreeReceiptMilestone(
        supportedReceipts,
        generatedAt
      ),
    };
  }

  const productContext = await readProductInsightContext(
    db,
    options.excludedDuplicateReceiptIds
  );
  return {
    status,
    unlockedResult:
      status.justUnlocked === 5
        ? buildFiveReceiptMilestone(
            supportedReceipts,
            productContext,
            generatedAt
          )
        : buildTenReceiptMilestone(
            supportedReceipts,
            productContext,
            generatedAt
          ),
  };
}

export async function evaluateEngagementMilestonesWithDb(
  db: EngagementMilestoneDatabase,
  options: {
    beforeSupportedReceiptCount?: number | null;
    generatedAt?: number;
  } = {}
): Promise<EngagementMilestoneEvaluation> {
  const receipts = await readAllReceipts(db);
  const { analyticsReceipts, excludedDuplicateReceiptIds } =
    await selectEngagementAnalyticsReceipts(receipts);
  return evaluateReceiptSetWithDb(db, analyticsReceipts, {
    ...options,
    excludedDuplicateReceiptIds,
  });
}

export async function evaluateSavedReceiptMilestoneWithDb(
  db: EngagementMilestoneDatabase,
  savedReceiptId: string,
  options: { generatedAt?: number } = {}
): Promise<EngagementMilestoneEvaluation> {
  const receipts = await readAllReceipts(db);
  const { analyticsReceipts, excludedDuplicateReceiptIds } =
    await selectEngagementAnalyticsReceipts(receipts);
  const supportedCount = countSupportedReceipts(analyticsReceipts);
  const savedReceipt = analyticsReceipts.find(
    (receipt) => receipt.id === savedReceiptId
  );
  const savedReceiptIsSupported =
    savedReceipt != null && isV1SupportedReceipt(savedReceipt);
  return evaluateReceiptSetWithDb(db, analyticsReceipts, {
    generatedAt: options.generatedAt,
    beforeSupportedReceiptCount:
      supportedCount - (savedReceiptIsSupported ? 1 : 0),
    excludedDuplicateReceiptIds,
  });
}

export async function evaluateCurrentEngagementMilestoneWithDb(
  db: EngagementMilestoneDatabase,
  options: { generatedAt?: number } = {}
): Promise<CurrentEngagementMilestoneEvaluation> {
  const receipts = await readAllReceipts(db);
  const { analyticsReceipts, excludedDuplicateReceiptIds } =
    await selectEngagementAnalyticsReceipts(receipts);
  const supportedReceipts = filterV1SupportedReceipts(analyticsReceipts);
  const status = getEngagementMilestoneStatus(supportedReceipts.length);
  const generatedAt = options.generatedAt ?? Date.now();
  if (supportedReceipts.length === 0) {
    return { status, currentResult: null };
  }
  if (supportedReceipts.length < 3) {
    return {
      status,
      currentResult: buildFirstReceiptMilestone(
        supportedReceipts,
        generatedAt
      ),
    };
  }
  if (supportedReceipts.length < 5) {
    return {
      status,
      currentResult: buildThreeReceiptMilestone(
        supportedReceipts,
        generatedAt
      ),
    };
  }
  const productContext = await readProductInsightContext(
    db,
    excludedDuplicateReceiptIds
  );
  return {
    status,
    currentResult:
      supportedReceipts.length < 10
        ? buildFiveReceiptMilestone(
            supportedReceipts,
            productContext,
            generatedAt
          )
        : buildTenReceiptMilestone(
            supportedReceipts,
            productContext,
            generatedAt
          ),
  };
}

async function getEngagementMilestoneDb(): Promise<SQLite.SQLiteDatabase> {
  const [{ initIfNeeded }, ExpoSQLite] = await Promise.all([
    import('./db'),
    import('expo-sqlite'),
  ]);
  await initIfNeeded();
  if (!_db) {
    _db = await ExpoSQLite.openDatabaseAsync(DB_NAME);
  }
  return _db;
}

export async function evaluateEngagementMilestones(
  options: {
    beforeSupportedReceiptCount?: number | null;
    generatedAt?: number;
  } = {}
): Promise<EngagementMilestoneEvaluation> {
  const db = await getEngagementMilestoneDb();
  return evaluateEngagementMilestonesWithDb(db, options);
}

export async function evaluateSavedReceiptMilestone(
  savedReceiptId: string,
  options: { generatedAt?: number } = {}
): Promise<EngagementMilestoneEvaluation> {
  const db = await getEngagementMilestoneDb();
  return evaluateSavedReceiptMilestoneWithDb(db, savedReceiptId, options);
}


/**
 * Load analytics-deduped product insight rows for long-term Home frequent
 * profiles. Reuses the same selectAnalyticsReceipts exclusion set as
 * evaluateCurrentEngagementMilestone — no second duplicate policy.
 */
export async function loadEngagementProductInsightContext(): Promise<MilestoneProductInsightContext> {
  const db = await getEngagementMilestoneDb();
  const receipts = await readAllReceipts(db);
  const { excludedDuplicateReceiptIds } =
    await selectEngagementAnalyticsReceipts(receipts);
  return readProductInsightContext(db, excludedDuplicateReceiptIds);
}

export async function evaluateCurrentEngagementMilestone(
  options: { generatedAt?: number } = {}
): Promise<CurrentEngagementMilestoneEvaluation> {
  const db = await getEngagementMilestoneDb();
  return evaluateCurrentEngagementMilestoneWithDb(db, options);
}
