/**
 * Long-term Frequent Product SSOT (R2-F3B).
 *
 * Answers: "What does this user habitually buy over purchase history?"
 * Distinct from milestone recent-window frequentProductGroups (last 5/10,
 * item-row occurrence counts, top-5 cap).
 *
 * PURE DERIVED / RECOMPUTABLE — no persistence.
 */

import type { ReceiptRow } from './db';
import type {
  EngagementProductRow,
  EngagementReceipt,
} from './engagementMilestones';
import { filterV1SupportedReceipts } from './merchantType';

export const HOME_LONG_TERM_FREQUENT_PRODUCT_CAP = 5 as const;

export type FrequentProductTargetType = 'sku' | 'canonical' | 'family';

/**
 * Long-term habitual purchase profile.
 * Cap is a consumer concern (Home uses HOME_LONG_TERM_FREQUENT_PRODUCT_CAP).
 */
export type FrequentProductProfile = {
  targetType: FrequentProductTargetType;
  key: string;
  displayName: string;
  /** Distinct analytics/V1 receipt IDs — not item-row count, not quantity. */
  distinctReceiptCount: number;
  /**
   * Earliest usable occurrence timestamp among contributing rows.
   * Rows with non-positive / non-finite occurredAt are counted for
   * distinctReceiptCount but excluded from first/latest.
   */
  firstPurchaseAt: number | null;
  /** Latest usable occurrence timestamp among contributing rows. */
  latestPurchaseAt: number | null;
};

export type FrequentProductIdentity = {
  targetType: FrequentProductTargetType;
  key: string;
};

type FrequentProductRowLike = Pick<
  EngagementProductRow,
  | 'receiptId'
  | 'occurredAt'
  | 'sourceIndex'
  | 'displayName'
  | 'canonicalProductName'
  | 'productFamilyKey'
  | 'skuKey'
  | 'purchaseQuantity'
>;

/**
 * GROUPING identity only (canonical > family > sku).
 * Never fuzzy-merges raw/normalized display names.
 * Route-target helpers elsewhere may prefer a different precedence — keep
 * those concerns separate.
 */
export function resolveStableFrequentProductIdentity(
  row: Pick<
    FrequentProductRowLike,
    'canonicalProductName' | 'productFamilyKey' | 'skuKey'
  >
): FrequentProductIdentity | null {
  const canonical = row.canonicalProductName?.trim();
  if (canonical) return { targetType: 'canonical', key: canonical };
  const family = row.productFamilyKey?.trim();
  if (family) return { targetType: 'family', key: family };
  const sku = row.skuKey?.trim();
  if (sku) return { targetType: 'sku', key: sku };
  return null;
}

function usablePurchaseTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Same evidence ranking as milestone SKU frequent labels — never the raw
 * sku_key hash.
 */
function pickSkuGroupDisplayName(rows: FrequentProductRowLike[]): string {
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

function compareTargetType(
  left: FrequentProductTargetType,
  right: FrequentProductTargetType
): number {
  return left.localeCompare(right);
}

/**
 * Build long-term frequent profiles from an already-selected V1-supported
 * analytics receipt universe (no second duplicate policy).
 *
 * Returns the full eligible list — callers apply presentation caps.
 */
export function buildLongTermFrequentProductProfiles(
  supportedAnalyticsReceipts:
    | readonly EngagementReceipt[]
    | readonly ReceiptRow[],
  productRows: readonly FrequentProductRowLike[]
): FrequentProductProfile[] {
  const supported = filterV1SupportedReceipts(
    supportedAnalyticsReceipts as ReceiptRow[]
  );
  const selectedIds = new Set(supported.map((receipt) => receipt.id));
  // Universe gate is receipt membership (same analytics/V1 set).
  const rows = productRows.filter((row) => selectedIds.has(row.receiptId));

  const groups = new Map<
    string,
    {
      identity: FrequentProductIdentity;
      rows: FrequentProductRowLike[];
    }
  >();

  for (const row of rows) {
    const identity = resolveStableFrequentProductIdentity(row);
    if (!identity) continue;
    const mapKey = `${identity.targetType}:${identity.key}`;
    const existing = groups.get(mapKey);
    if (existing) existing.rows.push(row);
    else groups.set(mapKey, { identity, rows: [row] });
  }

  const profiles: FrequentProductProfile[] = [];

  for (const group of groups.values()) {
    const receiptIds = new Set(group.rows.map((row) => row.receiptId));
    const distinctReceiptCount = receiptIds.size;
    if (distinctReceiptCount < 2) continue;

    let firstPurchaseAt: number | null = null;
    let latestPurchaseAt: number | null = null;
    for (const row of group.rows) {
      const ts = usablePurchaseTimestamp(row.occurredAt);
      if (ts == null) continue;
      if (firstPurchaseAt == null || ts < firstPurchaseAt) firstPurchaseAt = ts;
      if (latestPurchaseAt == null || ts > latestPurchaseAt) {
        latestPurchaseAt = ts;
      }
    }

    const sortedForLabel = [...group.rows].sort(
      (left, right) =>
        left.occurredAt - right.occurredAt ||
        left.receiptId.localeCompare(right.receiptId) ||
        left.sourceIndex - right.sourceIndex
    );

    profiles.push({
      targetType: group.identity.targetType,
      key: group.identity.key,
      displayName:
        group.identity.targetType === 'sku'
          ? pickSkuGroupDisplayName(sortedForLabel)
          : group.identity.key,
      distinctReceiptCount,
      firstPurchaseAt,
      latestPurchaseAt,
    });
  }

  return profiles.sort((left, right) => {
    if (right.distinctReceiptCount !== left.distinctReceiptCount) {
      return right.distinctReceiptCount - left.distinctReceiptCount;
    }
    const leftLatest = left.latestPurchaseAt;
    const rightLatest = right.latestPurchaseAt;
    if (leftLatest == null && rightLatest == null) {
      // fall through
    } else if (leftLatest == null) {
      return 1;
    } else if (rightLatest == null) {
      return -1;
    } else if (rightLatest !== leftLatest) {
      return rightLatest - leftLatest;
    }
    return (
      compareTargetType(left.targetType, right.targetType) ||
      left.key.localeCompare(right.key)
    );
  });
}

/**
 * Canonical entry from stored receipts.
 * Applies analytics selection SSOT via dynamic import (same module as Home /
 * milestones) so this file stays free of the expo-sqlite import graph.
 */
export async function buildLongTermFrequentProductProfilesFromStoredReceipts(
  storedReceipts: readonly ReceiptRow[],
  productRows: readonly FrequentProductRowLike[]
): Promise<FrequentProductProfile[]> {
  const { selectAnalyticsReceipts } = await import('./analyticsReceiptSelection');
  const { analyticsReceipts } = selectAnalyticsReceipts([...storedReceipts]);
  const supported = filterV1SupportedReceipts(analyticsReceipts);
  return buildLongTermFrequentProductProfiles(supported, productRows);
}

/** Home presentation cap — not applied inside the SSOT builder. */
export function takeHomeLongTermFrequentProducts(
  profiles: readonly FrequentProductProfile[]
): FrequentProductProfile[] {
  return profiles.slice(0, HOME_LONG_TERM_FREQUENT_PRODUCT_CAP);
}

/**
 * Map long-term profiles onto the existing Home frequent row shape so
 * ProgressiveHomeInsights / href helpers stay unchanged.
 * purchaseOccurrenceCount carries distinctReceiptCount (purchase occasions).
 */
export function mapFrequentProductProfileToHomeFrequentProduct(
  profile: FrequentProductProfile,
  options?: {
    /** Optional quantity evidence from contributing rows; defaults to 0. */
    totalPurchaseQuantity?: number;
  }
): {
  groupingType: FrequentProductTargetType;
  key: string;
  displayLabel: string;
  displayLabelKey: string | null;
  purchaseOccurrenceCount: number;
  totalPurchaseQuantity: number;
  lastPurchasedAt: number;
  priceSummary: null;
} {
  return {
    groupingType: profile.targetType,
    key: profile.key,
    displayLabel: profile.displayName,
    displayLabelKey:
      profile.targetType === 'family'
        ? `productDetail.family.${profile.key}`
        : null,
    purchaseOccurrenceCount: profile.distinctReceiptCount,
    totalPurchaseQuantity: options?.totalPurchaseQuantity ?? 0,
    lastPurchasedAt: profile.latestPurchaseAt ?? 0,
    priceSummary: null,
  };
}

/** Sum purchase quantities for Home quantity meta (not used as frequency). */
export function sumPurchaseQuantityForProfile(
  profile: FrequentProductProfile,
  productRows: readonly FrequentProductRowLike[]
): number {
  return productRows.reduce((sum, row) => {
    const identity = resolveStableFrequentProductIdentity(row);
    if (
      !identity ||
      identity.targetType !== profile.targetType ||
      identity.key !== profile.key
    ) {
      return sum;
    }
    return sum + (finitePositive(row.purchaseQuantity) ?? 0);
  }, 0);
}
