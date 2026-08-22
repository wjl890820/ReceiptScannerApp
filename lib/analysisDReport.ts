/**
 * Analysis D0 — read-only real-data value validation report.
 *
 * Observer only: reuses production domain contracts.
 * Does NOT reimplement analytics formulas.
 * Does NOT write receipts / items / shopping intents / outbox / Supabase.
 */

import type { ReceiptRow } from './db';
import {
  calculateStats,
  type TimeRange,
  type WeeklyMonthlyStats,
} from './statsCalculator';
import {
  buildAnalysisCategoryShares,
  categoryCompositionPercent,
} from './analysisPresentation';
import {
  V1_SPENDING_CATEGORIES,
  isExplicitUserCategoryOverride,
  type V1SpendingCategory,
} from './productTaxonomy';
import {
  aggregateV1MerchantSpend,
  merchantAnalyticsKey,
} from './merchantAnalytics';
import {
  filterV1SupportedReceipts,
  isV1SupportedReceipt,
} from './merchantType';
import { getReceiptItems } from './receiptItems';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { resolveItemFinalCategory } from './homeMetricsHelpers';
import {
  filterByRollingWindowDays,
  rollingDaysForAnalysisRange,
} from './rollingTimeWindow';
import { resolveProductIdentity } from './productIdentity';
import {
  isReliableComparableSpec,
  parseProductSpecification,
  type ProductSpecReliability,
} from './productSpecification';
import {
  buildProductPriceHistory,
  type ProductPriceHistoryRow,
  type ProductPriceHistoryStatus,
} from './productPriceHistory';
import {
  buildFiveReceiptMilestone,
  buildTenReceiptMilestone,
  frequentProductGroups,
  getEngagementMilestoneStatus,
  type EngagementProductRow,
  type EngagementReceipt,
  type MilestoneFrequentProduct,
} from './engagementMilestones';
import { buildInsights } from './buildInsights';
import {
  readUserCorrections,
  resolveLegacyUserOverrideProvenance,
  type UserCorrectionField,
} from './userCorrections';
import { buildReceiptItemIndexRows } from './receiptItemIndex';

export const ANALYSIS_D_REPORT_CONTRACT_VERSION =
  'meruno-analysis-d-report-v1' as const;

export type AnalysisDWindowId = '7d' | '30d' | 'all';

export type AnalysisDDatasetProfile = {
  totalLocalReceiptCount: number;
  v1SupportedReceiptCount: number;
  unsupportedReceiptCount: number;
  earliestTransactionAt: number | null;
  latestTransactionAt: number | null;
  distinctSupportedMerchantCount: number;
  totalItemRowCount: number;
  validTransactionDateCount: number;
  invalidOrMissingTransactionDateCount: number;
  supportedReceiptSpendTotal: number;
};

export type AnalysisDCategoryCoverage = {
  classifiedItemOccurrences: number;
  eligibleItemOccurrences: number;
  classifiedItemOccurrenceRate: number | null;
  classifiedEffectiveMerchandiseAmount: number;
  eligibleEffectiveMerchandiseAmount: number;
  classifiedAmountRate: number | null;
  uncategorizedItemCount: number;
  uncategorizedEffectiveMerchandiseAmount: number;
  coverageDenominator: 'eligible_item_effective_amount';
};

export type AnalysisDCategoryValueWindow = {
  window: AnalysisDWindowId;
  categoryCompositionTotal: number;
  categories: Array<{
    category: V1SpendingCategory;
    amount: number;
    sharePercent: number | null;
  }>;
  topCategory: {
    category: string;
    amount: number;
    sharePercent: number | null;
  } | null;
  stats: WeeklyMonthlyStats;
};

export type AnalysisDMerchantWindow = {
  window: AnalysisDWindowId;
  topMerchants: Array<{
    merchant: string;
    visitCount: number;
    supportedSpend: number;
    sharePercent: number | null;
  }>;
  merchantGroupingCoverage: {
    supportedReceiptsWithKey: number;
    supportedReceiptsTotal: number;
    coverageRate: number | null;
  };
};

export type AnalysisDFrequentProductWindow = {
  window: AnalysisDWindowId;
  frequentProducts: MilestoneFrequentProduct[];
  unresolvedIdentityItemRows: number;
  eligibleItemRows: number;
  unresolvedIdentityRate: number | null;
  dataCoverageIncomplete: boolean;
};

export type AnalysisDIdentityCoverage = {
  eligibleItemRows: number;
  withNormalizedName: number;
  withCanonical: number;
  withFamily: number;
  withBrand: number;
  withSpecEvidence: number;
  specReliability: Record<ProductSpecReliability, number>;
  subcategoryPresent: number;
  productTypePresent: number;
  note: string;
};

export type AnalysisDSpecCoverage = {
  volumeExactCount: number;
  weightExactCount: number;
  countExactCount: number;
  unknownSpecCount: number;
  multipackRecognizedCount: number;
  rawSpecEvidenceWithoutReliableComparable: number;
};

export type AnalysisDPriceCoverage = {
  eligiblePurchaseItemRows: number;
  skuPriceHistoryUsableRows: number;
  familyNormalizedComparableRows: number;
  skuCoverageRate: number | null;
  familyCoverageRate: number | null;
  familyGroupsWithAtLeast2Observations: number;
  familyGroupsWithAtLeast3Observations: number;
  suppressionReasons: Record<string, number>;
};

export type AnalysisDPriceHistoryExample = {
  groupingType: 'canonical' | 'family';
  key: string;
  observationCount: number;
  status: ProductPriceHistoryStatus;
  suppressionReason: ProductPriceHistoryStatus | null;
  points: Array<{
    merchant: string | null;
    occurredAt: number;
    displayName: string;
    purchasePrice: number | null;
    purchaseQuantity: number | null;
    specSummary: string | null;
    normalizedPrice: number | null;
    priceKind: string | null;
  }>;
};

export type AnalysisDTrendEligibility = {
  window: AnalysisDWindowId;
  analysisTimeRange: TimeRange;
  currentReceiptSampleSize: number;
  previousReceiptSampleSize: number;
  eligible: boolean;
  suppressionReason: string | null;
  periodDays: number;
};

export type AnalysisDInsightEmission = {
  surface: 'analysis' | 'home_progressive';
  window: AnalysisDWindowId | 'milestone';
  ruleType: string;
  sampleSize: number | null;
  supportingValues: Record<string, string | number | boolean | null>;
  reviewClassificationSlot:
    | 'USEFUL'
    | 'OBVIOUS'
    | 'NOISY'
    | 'MISLEADING'
    | 'LOW-VALUE'
    | 'GOOD-SUPPRESSION'
    | null;
};

export type AnalysisDCorrectionProfile = {
  totalCorrectionEvents: number;
  countsByField: Record<UserCorrectionField, number>;
  legacyEditedRecordsWithoutProvenance: number;
  privacy: 'local_diagnostic_only';
};

export type AnalysisDDataQualityFlag = {
  code:
    | 'invalid_or_missing_transaction_date'
    | 'unsupported_merchant'
    | 'unresolved_category'
    | 'unresolved_identity'
    | 'exact_spec_unavailable'
    | 'price_normalization_unavailable';
  receiptId: string | null;
  itemSourceIndex: number | null;
  detail: string;
};

export type AnalysisDCrossSurfaceParity = {
  window: AnalysisDWindowId;
  sharedMetric: 'categoryCompositionTotal' | 'supportedSpend';
  analysisValue: number;
  homePathValue: number;
  identical: boolean;
};

export type AnalysisDReport = {
  contractVersion: typeof ANALYSIS_D_REPORT_CONTRACT_VERSION;
  generatedAt: number;
  privacy: {
    localOnly: true;
    autoUpload: false;
    productAnalytics: false;
    supabaseTelemetry: false;
  };
  dataset: AnalysisDDatasetProfile;
  categoryCoverage: AnalysisDCategoryCoverage;
  categoryValue: AnalysisDCategoryValueWindow[];
  merchants: AnalysisDMerchantWindow[];
  frequentProducts: AnalysisDFrequentProductWindow[];
  identityCoverage: AnalysisDIdentityCoverage;
  specCoverage: AnalysisDSpecCoverage;
  priceCoverage: AnalysisDPriceCoverage;
  priceHistoryExamples: AnalysisDPriceHistoryExample[];
  trends: AnalysisDTrendEligibility[];
  insights: AnalysisDInsightEmission[];
  corrections: AnalysisDCorrectionProfile;
  dataQualityFlags: AnalysisDDataQualityFlag[];
  crossSurfaceParity: AnalysisDCrossSurfaceParity[];
  smartShoppingReadiness: {
    familyNormalizedComparableRows: number;
    familyGroupsWithAtLeast2Observations: number;
    note: string;
  };
};

export type AnalysisDReportInput = {
  receipts: ReceiptRow[];
  productRows?: EngagementProductRow[];
  nowMs?: number;
};

const WINDOWS: AnalysisDWindowId[] = ['7d', '30d', 'all'];

function emptyCorrectionCounts(): Record<UserCorrectionField, number> {
  return {
    item_name: 0,
    item_amount: 0,
    item_quantity: 0,
    item_category: 0,
    item_spec: 0,
    merchant: 0,
    transaction_date: 0,
    receipt_total: 0,
    receipt_tax: 0,
    receipt_note: 0,
  };
}

function receiptTs(receipt: ReceiptRow): number {
  return receipt.transaction_at ?? receipt.created_at;
}

function hasValidTransactionDate(receipt: ReceiptRow): boolean {
  const t = receipt.transaction_at;
  return typeof t === 'number' && Number.isFinite(t) && t > 0;
}

function ratio(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return numerator / denominator;
}

function windowToTimeRange(window: AnalysisDWindowId): TimeRange {
  if (window === '7d') return 'week';
  if (window === '30d') return 'month';
  return 'all';
}

function filterReceiptsForWindow(
  receipts: ReceiptRow[],
  window: AnalysisDWindowId,
  nowMs: number
): ReceiptRow[] {
  const days = rollingDaysForAnalysisRange(windowToTimeRange(window));
  return filterByRollingWindowDays(receipts, receiptTs, days, nowMs);
}

function itemName(item: Record<string, unknown>): string {
  for (const key of [
    'name',
    'raw_name',
    'normalized_full_name',
    'canonical_product_name',
  ]) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function asItemRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function deriveProductRows(receipts: ReceiptRow[]): EngagementProductRow[] {
  const rows: EngagementProductRow[] = [];
  for (const receipt of receipts) {
    const indexRows = buildReceiptItemIndexRows(receipt);
    const occurredAt = receiptTs(receipt);
    for (const row of indexRows) {
      rows.push({
        receiptId: receipt.id,
        itemId: row.id,
        sourceIndex: row.source_index,
        occurredAt,
        merchantRaw: receipt.merchant_raw ?? null,
        merchantNormalized: receipt.merchant_normalized ?? null,
        displayName:
          row.normalized_full_name ||
          row.raw_name ||
          row.canonical_product_name ||
          '',
        currency: receipt.currency ?? null,
        lineTotal: row.line_total,
        purchaseQuantity: row.purchase_quantity,
        productFamilyKey: row.product_family_key,
        volumeBaseMl: row.volume_base_ml,
        weightBaseG: row.weight_base_g,
        countBase: row.count_base,
        canonicalProductName: row.canonical_product_name,
        merchant_raw: receipt.merchant_raw ?? null,
        merchant_normalized: receipt.merchant_normalized ?? null,
        merchant_type: receipt.merchant_type ?? null,
        analysis_json: receipt.analysis_json ?? null,
      } as EngagementProductRow);
    }
  }
  return rows;
}

function iterateSupportedItems(
  receipts: ReceiptRow[],
  fn: (
    receipt: ReceiptRow,
    item: Record<string, unknown>,
    sourceIndex: number
  ) => void
): void {
  for (const receipt of filterV1SupportedReceipts(receipts)) {
    getReceiptItems(receipt).forEach((raw, sourceIndex) => {
      fn(receipt, asItemRecord(raw), sourceIndex);
    });
  }
}

function buildDatasetProfile(receipts: ReceiptRow[]): AnalysisDDatasetProfile {
  const supported = filterV1SupportedReceipts(receipts);
  const times = receipts
    .map(receiptTs)
    .filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
  const merchantKeys = new Set(
    supported.map((r) => merchantAnalyticsKey(r)).filter((k) => !!k)
  );
  let totalItemRowCount = 0;
  for (const receipt of receipts) {
    totalItemRowCount += getReceiptItems(receipt).length;
  }
  let validTransactionDateCount = 0;
  let invalidOrMissingTransactionDateCount = 0;
  for (const receipt of receipts) {
    if (hasValidTransactionDate(receipt)) validTransactionDateCount += 1;
    else invalidOrMissingTransactionDateCount += 1;
  }
  return {
    totalLocalReceiptCount: receipts.length,
    v1SupportedReceiptCount: supported.length,
    unsupportedReceiptCount: receipts.length - supported.length,
    earliestTransactionAt: times.length ? Math.min(...times) : null,
    latestTransactionAt: times.length ? Math.max(...times) : null,
    distinctSupportedMerchantCount: merchantKeys.size,
    totalItemRowCount,
    validTransactionDateCount,
    invalidOrMissingTransactionDateCount,
    supportedReceiptSpendTotal: supported.reduce(
      (sum, r) => sum + (Number(r.total) || 0),
      0
    ),
  };
}

function buildCategoryCoverage(
  receipts: ReceiptRow[]
): AnalysisDCategoryCoverage {
  let eligibleItemOccurrences = 0;
  let classifiedItemOccurrences = 0;
  let eligibleEffectiveMerchandiseAmount = 0;
  let classifiedEffectiveMerchandiseAmount = 0;
  let uncategorizedItemCount = 0;
  let uncategorizedEffectiveMerchandiseAmount = 0;

  iterateSupportedItems(receipts, (_receipt, item) => {
    const amount = itemAmountForAnalytics(item as never);
    const category = resolveItemFinalCategory(item as never);
    eligibleItemOccurrences += 1;
    eligibleEffectiveMerchandiseAmount += amount;
    if (category === 'uncategorized') {
      uncategorizedItemCount += 1;
      uncategorizedEffectiveMerchandiseAmount += amount;
      return;
    }
    classifiedItemOccurrences += 1;
    classifiedEffectiveMerchandiseAmount += amount;
  });

  return {
    classifiedItemOccurrences,
    eligibleItemOccurrences,
    classifiedItemOccurrenceRate: ratio(
      classifiedItemOccurrences,
      eligibleItemOccurrences
    ),
    classifiedEffectiveMerchandiseAmount,
    eligibleEffectiveMerchandiseAmount,
    classifiedAmountRate: ratio(
      classifiedEffectiveMerchandiseAmount,
      eligibleEffectiveMerchandiseAmount
    ),
    uncategorizedItemCount,
    uncategorizedEffectiveMerchandiseAmount,
    coverageDenominator: 'eligible_item_effective_amount',
  };
}

function buildCategoryValueWindows(
  receipts: ReceiptRow[],
  nowMs: number
): AnalysisDCategoryValueWindow[] {
  return WINDOWS.map((window) => {
    const filtered = filterReceiptsForWindow(receipts, window, nowMs);
    const stats = calculateStats(filtered, 'all');
    const shares = buildAnalysisCategoryShares(stats);
    const amountByCategory = new Map(
      shares.map((row) => [row.category, row.amount] as const)
    );
    const categories = V1_SPENDING_CATEGORIES.map((category) => {
      const amount = amountByCategory.get(category) ?? 0;
      return {
        category,
        amount,
        sharePercent: categoryCompositionPercent(
          amount,
          stats.categoryCompositionTotal
        ),
      };
    });
    const top = stats.topCategories[0];
    return {
      window,
      categoryCompositionTotal: stats.categoryCompositionTotal,
      categories,
      topCategory: top
        ? {
            category: top.category,
            amount: top.amount,
            sharePercent: categoryCompositionPercent(
              top.amount,
              stats.categoryCompositionTotal
            ),
          }
        : null,
      stats,
    };
  });
}

function buildMerchantWindows(
  receipts: ReceiptRow[],
  nowMs: number
): AnalysisDMerchantWindow[] {
  return WINDOWS.map((window) => {
    const filtered = filterReceiptsForWindow(receipts, window, nowMs);
    const supported = filterV1SupportedReceipts(filtered);
    const aggregates = aggregateV1MerchantSpend(supported);
    const stats = calculateStats(filtered, 'all');
    const topSource =
      stats.topMerchants.length > 0
        ? stats.topMerchants
        : aggregates.slice(0, 3);
    const topMerchants = topSource.map((row) => ({
      merchant: row.merchant,
      visitCount: row.count,
      supportedSpend: row.total,
      sharePercent: categoryCompositionPercent(
        row.total,
        stats.supportedSpend
      ),
    }));
    const withKey = supported.filter((r) => !!merchantAnalyticsKey(r)).length;
    return {
      window,
      topMerchants,
      merchantGroupingCoverage: {
        supportedReceiptsWithKey: withKey,
        supportedReceiptsTotal: supported.length,
        coverageRate: ratio(withKey, supported.length),
      },
    };
  });
}

function buildFrequentProductWindows(
  receipts: ReceiptRow[],
  productRows: EngagementProductRow[],
  nowMs: number
): AnalysisDFrequentProductWindow[] {
  return WINDOWS.map((window) => {
    const filtered = filterReceiptsForWindow(receipts, window, nowMs);
    const supported = filterV1SupportedReceipts(
      filtered
    ) as EngagementReceipt[];
    const selectedIds = new Set(supported.map((r) => r.id));
    const rows = productRows.filter((row) => selectedIds.has(row.receiptId));
    const result = frequentProductGroups(supported, {
      rows,
      queryFailed: false,
      priceHistoryBuilder: buildProductPriceHistory,
    });
    let eligibleItemRows = 0;
    let unresolvedIdentityItemRows = 0;
    for (const row of rows) {
      if (!isV1SupportedReceipt(row)) continue;
      eligibleItemRows += 1;
      const canonical = row.canonicalProductName?.trim();
      const family = row.productFamilyKey?.trim();
      if (!canonical && !family) unresolvedIdentityItemRows += 1;
    }
    return {
      window,
      frequentProducts: result.frequentProducts,
      unresolvedIdentityItemRows,
      eligibleItemRows,
      unresolvedIdentityRate: ratio(
        unresolvedIdentityItemRows,
        eligibleItemRows
      ),
      dataCoverageIncomplete: result.dataCoverageIncomplete,
    };
  });
}

function buildIdentityAndSpecCoverage(receipts: ReceiptRow[]): {
  identityCoverage: AnalysisDIdentityCoverage;
  specCoverage: AnalysisDSpecCoverage;
} {
  let eligibleItemRows = 0;
  let withNormalizedName = 0;
  let withCanonical = 0;
  let withFamily = 0;
  let withBrand = 0;
  let withSpecEvidence = 0;
  const specReliability: Record<ProductSpecReliability, number> = {
    exact: 0,
    partial: 0,
    unknown: 0,
  };
  let subcategoryPresent = 0;
  let productTypePresent = 0;
  let volumeExactCount = 0;
  let weightExactCount = 0;
  let countExactCount = 0;
  let unknownSpecCount = 0;
  let multipackRecognizedCount = 0;
  let rawSpecEvidenceWithoutReliableComparable = 0;

  iterateSupportedItems(receipts, (receipt, item) => {
    eligibleItemRows += 1;
    const name = itemName(item);
    const identity = resolveProductIdentity({
      rawName: name,
      category: typeof item.category === 'string' ? item.category : null,
      merchantName: receipt.merchant_normalized || receipt.merchant_raw,
    });
    if (identity.normalizedName) withNormalizedName += 1;
    if (identity.canonicalProductName) withCanonical += 1;
    if (identity.productFamilyKey) withFamily += 1;
    if (identity.brand) withBrand += 1;
    if (item.subcategory != null && String(item.subcategory).trim()) {
      subcategoryPresent += 1;
    }
    if (item.product_type != null && String(item.product_type).trim()) {
      productTypePresent += 1;
    }
    const spec = identity.specification ?? parseProductSpecification(name);
    if (spec.sourceText || (spec.rawText && spec.dimension !== 'unknown')) {
      withSpecEvidence += 1;
    }
    specReliability[spec.reliability] += 1;
    if (spec.reliability === 'exact' && spec.dimension === 'volume') {
      volumeExactCount += 1;
    } else if (spec.reliability === 'exact' && spec.dimension === 'weight') {
      weightExactCount += 1;
    } else if (spec.reliability === 'exact' && spec.dimension === 'count') {
      countExactCount += 1;
    }
    if (spec.dimension === 'unknown' || spec.reliability === 'unknown') {
      unknownSpecCount += 1;
    }
    if (typeof spec.packCount === 'number' && spec.packCount > 1) {
      multipackRecognizedCount += 1;
    }
    if ((spec.sourceText || spec.rawText) && !isReliableComparableSpec(spec)) {
      rawSpecEvidenceWithoutReliableComparable += 1;
    }
  });

  return {
    identityCoverage: {
      eligibleItemRows,
      withNormalizedName,
      withCanonical,
      withFamily,
      withBrand,
      withSpecEvidence,
      specReliability,
      subcategoryPresent,
      productTypePresent,
      note:
        'subcategory/productType slots are currently unset in V1; absence is expected.',
    },
    specCoverage: {
      volumeExactCount,
      weightExactCount,
      countExactCount,
      unknownSpecCount,
      multipackRecognizedCount,
      rawSpecEvidenceWithoutReliableComparable,
    },
  };
}

function buildPriceCoverage(productRows: EngagementProductRow[]): {
  priceCoverage: AnalysisDPriceCoverage;
  priceHistoryExamples: AnalysisDPriceHistoryExample[];
} {
  const eligible = productRows.filter((row) => isV1SupportedReceipt(row));
  let skuPriceHistoryUsableRows = 0;
  let familyNormalizedComparableRows = 0;
  const suppressionReasons: Record<string, number> = {};
  const bump = (reason: string) => {
    suppressionReasons[reason] = (suppressionReasons[reason] ?? 0) + 1;
  };

  for (const row of eligible) {
    const purchaseUnitOk =
      typeof row.lineTotal === 'number' &&
      row.lineTotal > 0 &&
      typeof row.purchaseQuantity === 'number' &&
      row.purchaseQuantity > 0;
    if (purchaseUnitOk) skuPriceHistoryUsableRows += 1;
    else bump('sku_missing_line_or_quantity');

    const family = row.productFamilyKey?.trim();
    if (!family) {
      bump('insufficient_identity');
      continue;
    }
    const result = buildProductPriceHistory(
      { type: 'family', key: family },
      [row]
    );
    if (result.comparableOccurrenceCount > 0) {
      familyNormalizedComparableRows += 1;
    } else {
      bump(result.status);
    }
  }

  const familyGroups = new Map<string, EngagementProductRow[]>();
  for (const row of eligible) {
    const family = row.productFamilyKey?.trim();
    if (!family) continue;
    const list = familyGroups.get(family) ?? [];
    list.push(row);
    familyGroups.set(family, list);
  }

  let familyGroupsWithAtLeast2Observations = 0;
  let familyGroupsWithAtLeast3Observations = 0;
  const exampleCandidates: Array<{
    key: string;
    rows: EngagementProductRow[];
    result: ReturnType<typeof buildProductPriceHistory>;
  }> = [];

  for (const [key, rows] of Array.from(familyGroups.entries())) {
    if (rows.length >= 2) familyGroupsWithAtLeast2Observations += 1;
    if (rows.length >= 3) familyGroupsWithAtLeast3Observations += 1;
    const result = buildProductPriceHistory({ type: 'family', key }, rows);
    exampleCandidates.push({ key, rows, result });
  }

  exampleCandidates.sort(
    (a, b) =>
      b.result.comparableOccurrenceCount - a.result.comparableOccurrenceCount ||
      b.rows.length - a.rows.length ||
      a.key.localeCompare(b.key)
  );

  const priceHistoryExamples: AnalysisDPriceHistoryExample[] = exampleCandidates
    .slice(0, 5)
    .map(({ key, rows, result }) => ({
      groupingType: 'family',
      key,
      observationCount: rows.length,
      status: result.status,
      suppressionReason: result.status === 'ready' ? null : result.status,
      points: result.points.map((point) => ({
        merchant: point.merchantNormalized || point.merchantRaw,
        occurredAt: point.occurredAt,
        displayName: point.displayName,
        purchasePrice: point.lineTotal,
        purchaseQuantity: point.purchaseQuantity,
        specSummary: point.priceKind,
        normalizedPrice: point.priceValue,
        priceKind: point.priceKind,
      })),
    }));

  return {
    priceCoverage: {
      eligiblePurchaseItemRows: eligible.length,
      skuPriceHistoryUsableRows,
      familyNormalizedComparableRows,
      skuCoverageRate: ratio(skuPriceHistoryUsableRows, eligible.length),
      familyCoverageRate: ratio(
        familyNormalizedComparableRows,
        eligible.length
      ),
      familyGroupsWithAtLeast2Observations,
      familyGroupsWithAtLeast3Observations,
      suppressionReasons,
    },
    priceHistoryExamples,
  };
}

function buildTrendEligibility(
  receipts: ReceiptRow[]
): AnalysisDTrendEligibility[] {
  return WINDOWS.map((window) => {
    const timeRange = windowToTimeRange(window);
    const insights = buildInsights(receipts, timeRange);
    const current = insights.currentReceiptsCount;
    const previous = insights.previousStats
      ? insights.previousStats.supportedReceiptCount
      : 0;
    let eligible = false;
    let suppressionReason: string | null = null;
    if (window === 'all') {
      if (!insights.previousStats || previous === 0) {
        suppressionReason = 'no_matched_prior_period';
      } else if (current < 3 || previous < 3) {
        suppressionReason = 'both_sides_need_at_least_3_supported_receipts';
      } else {
        eligible = true;
      }
    } else if (current < 3 || previous < 3) {
      suppressionReason = 'both_sides_need_at_least_3_supported_receipts';
    } else {
      eligible = true;
    }
    return {
      window,
      analysisTimeRange: timeRange,
      currentReceiptSampleSize: current,
      previousReceiptSampleSize: previous,
      eligible,
      suppressionReason,
      periodDays: insights.periodDays,
    };
  });
}

function buildInsightEmissions(
  receipts: ReceiptRow[],
  productRows: EngagementProductRow[],
  nowMs: number
): AnalysisDInsightEmission[] {
  const out: AnalysisDInsightEmission[] = [];
  for (const window of WINDOWS) {
    const insights = buildInsights(receipts, windowToTimeRange(window));
    if (insights.story.type === 'full') {
      out.push({
        surface: 'analysis',
        window,
        ruleType: 'story.full',
        sampleSize: insights.currentReceiptsCount,
        supportingValues: {
          conclusionKey: insights.story.conclusionKey,
          ...insights.story.conclusionParams,
        },
        reviewClassificationSlot: null,
      });
    } else {
      out.push({
        surface: 'analysis',
        window,
        ruleType: 'story.fallback',
        sampleSize: insights.currentReceiptsCount,
        supportingValues: { fallbackKey: insights.story.fallbackKey },
        reviewClassificationSlot: null,
      });
    }
    for (const change of insights.changes) {
      out.push({
        surface: 'analysis',
        window,
        ruleType: `change.${change.changeKey}`,
        sampleSize: insights.currentReceiptsCount,
        supportingValues: { ...(change.changeParams ?? {}) },
        reviewClassificationSlot: null,
      });
    }
    for (const tip of insights.tips) {
      out.push({
        surface: 'analysis',
        window,
        ruleType: `tip.${tip.tipKey}`,
        sampleSize: insights.currentReceiptsCount,
        supportingValues: { ...(tip.tipParams ?? {}) },
        reviewClassificationSlot: null,
      });
    }
    if (insights.changes.length === 0) {
      out.push({
        surface: 'analysis',
        window,
        ruleType: 'change.suppressed',
        sampleSize: insights.currentReceiptsCount,
        supportingValues: {
          previousSupported:
            insights.previousStats?.supportedReceiptCount ?? 0,
          reason: 'low_sample_or_no_previous_matched_period',
        },
        reviewClassificationSlot: null,
      });
    }
  }

  const supported = filterV1SupportedReceipts(receipts) as EngagementReceipt[];
  const status = getEngagementMilestoneStatus(supported.length);
  out.push({
    surface: 'home_progressive',
    window: 'milestone',
    ruleType: 'engagement.status',
    sampleSize: supported.length,
    supportingValues: {
      currentMilestone: status.currentMilestone,
      nextMilestone: status.nextMilestone,
      receiptsUntilNext: status.receiptsUntilNext,
    },
    reviewClassificationSlot: null,
  });

  const productContext = {
    rows: productRows,
    queryFailed: false,
    priceHistoryBuilder: buildProductPriceHistory,
  };
  const five = buildFiveReceiptMilestone(supported, productContext, nowMs);
  if (five) {
    out.push({
      surface: 'home_progressive',
      window: 'milestone',
      ruleType: 'engagement.milestone.5',
      sampleSize: five.supportedReceiptCount,
      supportingValues: {
        frequentProductCount: five.frequentProducts.length,
        dataCoverageIncomplete: five.dataCoverageIncomplete,
      },
      reviewClassificationSlot: null,
    });
  }
  const ten = buildTenReceiptMilestone(supported, productContext, nowMs);
  if (ten) {
    out.push({
      surface: 'home_progressive',
      window: 'milestone',
      ruleType: 'engagement.milestone.10',
      sampleSize: ten.supportedReceiptCount,
      supportingValues: {
        frequentProductCount: ten.frequentProducts.length,
        dataCoverageIncomplete: ten.dataCoverageIncomplete,
      },
      reviewClassificationSlot: null,
    });
  }
  return out;
}

function buildCorrectionProfile(
  receipts: ReceiptRow[]
): AnalysisDCorrectionProfile {
  const countsByField = emptyCorrectionCounts();
  let totalCorrectionEvents = 0;
  let legacyEditedRecordsWithoutProvenance = 0;

  for (const receipt of receipts) {
    for (const event of readUserCorrections(receipt as never)) {
      totalCorrectionEvents += 1;
      countsByField[event.field] += 1;
    }
    try {
      const analysis = JSON.parse(receipt.analysis_json || '{}') as Record<
        string,
        unknown
      >;
      for (const event of readUserCorrections(analysis)) {
        totalCorrectionEvents += 1;
        countsByField[event.field] += 1;
      }
    } catch {
      /* ignore */
    }

    iterateSupportedItems([receipt], (_r, item) => {
      const events = readUserCorrections(item);
      for (const event of events) {
        totalCorrectionEvents += 1;
        countsByField[event.field] += 1;
      }
      const hasEvents = events.length > 0;
      const hasExplicitOverride =
        isExplicitUserCategoryOverride(item as never) ||
        item.amountUserEdited === true ||
        item.quantityUserEdited === true ||
        item.nameUserEdited === true;
      const legacy = resolveLegacyUserOverrideProvenance({
        hasExplicitOverride: !!hasExplicitOverride,
        hasCorrectionEvents: hasEvents,
      });
      if (legacy.status === 'legacy_unavailable') {
        legacyEditedRecordsWithoutProvenance += 1;
      }
    });
  }

  return {
    totalCorrectionEvents,
    countsByField,
    legacyEditedRecordsWithoutProvenance,
    privacy: 'local_diagnostic_only',
  };
}

function buildDataQualityFlags(
  receipts: ReceiptRow[],
  productRows: EngagementProductRow[]
): AnalysisDDataQualityFlag[] {
  const flags: AnalysisDDataQualityFlag[] = [];
  for (const receipt of receipts) {
    if (!hasValidTransactionDate(receipt)) {
      flags.push({
        code: 'invalid_or_missing_transaction_date',
        receiptId: receipt.id,
        itemSourceIndex: null,
        detail: 'transaction_at missing or invalid',
      });
    }
    if (!isV1SupportedReceipt(receipt)) {
      flags.push({
        code: 'unsupported_merchant',
        receiptId: receipt.id,
        itemSourceIndex: null,
        detail: 'outside V1 supermarket+convenience universe',
      });
    }
  }

  iterateSupportedItems(receipts, (receipt, item, sourceIndex) => {
    const category = resolveItemFinalCategory(item as never);
    if (category === 'uncategorized') {
      flags.push({
        code: 'unresolved_category',
        receiptId: receipt.id,
        itemSourceIndex: sourceIndex,
        detail: 'final category is uncategorized',
      });
    }
    const identity = resolveProductIdentity({
      rawName: itemName(item),
      category: typeof item.category === 'string' ? item.category : null,
    });
    if (!identity.canonicalProductName && !identity.productFamilyKey) {
      flags.push({
        code: 'unresolved_identity',
        receiptId: receipt.id,
        itemSourceIndex: sourceIndex,
        detail: 'no canonical or family',
      });
    }
    if (identity.specification.reliability !== 'exact') {
      flags.push({
        code: 'exact_spec_unavailable',
        receiptId: receipt.id,
        itemSourceIndex: sourceIndex,
        detail: `spec reliability=${identity.specification.reliability}`,
      });
    }
  });

  for (const row of productRows) {
    if (!isV1SupportedReceipt(row)) continue;
    const family = row.productFamilyKey?.trim();
    if (!family) continue;
    const result = buildProductPriceHistory({ type: 'family', key: family }, [
      row as ProductPriceHistoryRow,
    ]);
    if (result.comparableOccurrenceCount === 0) {
      flags.push({
        code: 'price_normalization_unavailable',
        receiptId: row.receiptId,
        itemSourceIndex: row.sourceIndex,
        detail: result.status,
      });
    }
  }

  return flags;
}

function buildCrossSurfaceParity(
  receipts: ReceiptRow[],
  nowMs: number
): AnalysisDCrossSurfaceParity[] {
  const out: AnalysisDCrossSurfaceParity[] = [];
  for (const window of WINDOWS) {
    const filtered = filterReceiptsForWindow(receipts, window, nowMs);
    const analysisStats = calculateStats(filtered, 'all');
    const homePathStats = calculateStats(filtered, 'all');
    out.push({
      window,
      sharedMetric: 'categoryCompositionTotal',
      analysisValue: analysisStats.categoryCompositionTotal,
      homePathValue: homePathStats.categoryCompositionTotal,
      identical:
        analysisStats.categoryCompositionTotal ===
        homePathStats.categoryCompositionTotal,
    });
    out.push({
      window,
      sharedMetric: 'supportedSpend',
      analysisValue: analysisStats.supportedSpend,
      homePathValue: homePathStats.supportedSpend,
      identical: analysisStats.supportedSpend === homePathStats.supportedSpend,
    });
  }
  return out;
}

/** Build the Analysis D validation report (pure / read-only). */
export function buildAnalysisDReport(
  input: AnalysisDReportInput
): AnalysisDReport {
  const nowMs = input.nowMs ?? Date.now();
  const receipts = input.receipts;
  const productRows = input.productRows ?? deriveProductRows(receipts);

  const dataset = buildDatasetProfile(receipts);
  const categoryCoverage = buildCategoryCoverage(receipts);
  const categoryValue = buildCategoryValueWindows(receipts, nowMs);
  const merchants = buildMerchantWindows(receipts, nowMs);
  const frequentProducts = buildFrequentProductWindows(
    receipts,
    productRows,
    nowMs
  );
  const { identityCoverage, specCoverage } =
    buildIdentityAndSpecCoverage(receipts);
  const { priceCoverage, priceHistoryExamples } =
    buildPriceCoverage(productRows);
  const trends = buildTrendEligibility(receipts);
  const insights = buildInsightEmissions(receipts, productRows, nowMs);
  const corrections = buildCorrectionProfile(receipts);
  const dataQualityFlags = buildDataQualityFlags(receipts, productRows);
  const crossSurfaceParity = buildCrossSurfaceParity(receipts, nowMs);

  return {
    contractVersion: ANALYSIS_D_REPORT_CONTRACT_VERSION,
    generatedAt: nowMs,
    privacy: {
      localOnly: true,
      autoUpload: false,
      productAnalytics: false,
      supabaseTelemetry: false,
    },
    dataset,
    categoryCoverage,
    categoryValue,
    merchants,
    frequentProducts,
    identityCoverage,
    specCoverage,
    priceCoverage,
    priceHistoryExamples,
    trends,
    insights,
    corrections,
    dataQualityFlags,
    crossSurfaceParity,
    smartShoppingReadiness: {
      familyNormalizedComparableRows:
        priceCoverage.familyNormalizedComparableRows,
      familyGroupsWithAtLeast2Observations:
        priceCoverage.familyGroupsWithAtLeast2Observations,
      note:
        'ShoppingIntent has no V1 UI; these metrics only indicate future Smart Shopping evidence density.',
    },
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable JSON serialization for manual D1 export / fixtures. */
export function serializeAnalysisDReport(report: AnalysisDReport): string {
  return `${JSON.stringify(sortKeysDeep(report))}\n`;
}

/** Concise human-readable summary for on-device diagnostics. */
export function formatAnalysisDReportSummary(report: AnalysisDReport): string {
  return [
    `Analysis D report (${report.contractVersion})`,
    `generatedAt=${new Date(report.generatedAt).toISOString()}`,
    `receipts=${report.dataset.totalLocalReceiptCount} supported=${report.dataset.v1SupportedReceiptCount} unsupported=${report.dataset.unsupportedReceiptCount}`,
    `items=${report.dataset.totalItemRowCount} merchants=${report.dataset.distinctSupportedMerchantCount}`,
    `classifiedAmountRate=${report.categoryCoverage.classifiedAmountRate ?? 'n/a'}`,
    `familyPriceComparableRows=${report.priceCoverage.familyNormalizedComparableRows}`,
    `familyGroups>=2=${report.priceCoverage.familyGroupsWithAtLeast2Observations}`,
    `insightsEmitted=${report.insights.length} flags=${report.dataQualityFlags.length}`,
    `corrections=${report.corrections.totalCorrectionEvents} legacyWithoutProvenance=${report.corrections.legacyEditedRecordsWithoutProvenance}`,
    `privacy=local-only; no auto-upload`,
  ].join('\n');
}

/** Documents occurrence = row count (quantity ignored). */
export function occurrenceCountIgnoringQuantity(
  itemRows: number,
  _totalQuantity: number
): number {
  return itemRows;
}
