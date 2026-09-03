/**
 * Repeat V1 SSOT (Shopping Loop B1).
 *
 * Answers: for a safely identified product, in how many distinct canonical
 * purchases did it appear, and when?
 *
 * Safe identities only: merchant_product | personal_product.
 * Never family / family_only / unresolved raw names.
 * Occurrence = distinct analytics (canonical) receiptId — not quantity, not item rows.
 *
 * PURE DERIVED / RECOMPUTABLE — no persistence.
 */

import type { ReceiptRow } from './db';
import type {
  EngagementProductRow,
  MilestoneFrequentProduct,
} from './engagementMilestones';
import { filterV1SupportedReceipts } from './merchantType';
import type { PersonalProductEndpointInventory } from './personalProductEndpointInventory';
import type {
  IdentityConsumerObservation,
  IdentityFrequentProductGroup,
  QualifiedIdentityObservation,
} from './productIdentityConsumer';

export const HOME_REPEAT_PRODUCT_CAP = 5 as const;
export const REPEAT_DAY_MS = 24 * 60 * 60 * 1000;

export type RepeatProductIdentityKind =
  | 'merchant_product'
  | 'personal_product';

export type RepeatMerchantSummary = {
  merchantKey: string;
  label: string;
};

export type RepeatProductProfile = {
  identityKind: RepeatProductIdentityKind;
  identityKey: string;
  displayName: string;
  /** Distinct canonical receipt IDs — includes undated occurrences. */
  purchaseOccurrenceCount: number;
  /**
   * One timestamp per dated distinct canonical receipt occurrence.
   * Ascending. Equal timestamps from different receipts are both kept.
   */
  purchaseEventDates: number[];
  datedPurchaseOccurrenceCount: number;
  firstPurchasedAt: number | null;
  lastPurchasedAt: number | null;
  /** Display metadata only — never eligibility / interval / sort. */
  totalPurchaseQuantity?: number;
  merchantSummary?: RepeatMerchantSummary[];
};

export type RepeatIntervalStats = {
  previousPurchasedAt: number | null;
  intervalSampleSize: number;
  /** Null unless datedPurchaseOccurrenceCount >= 3 (at least 2 intervals). */
  medianIntervalDays: number | null;
};

export type RepeatProductRowInput = Pick<
  EngagementProductRow,
  | 'receiptId'
  | 'sourceIndex'
  | 'occurredAt'
  | 'displayName'
  | 'merchantNormalized'
  | 'merchantRaw'
  | 'lineTotal'
  | 'purchaseQuantity'
>;

function usablePurchaseTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finitePositiveQuantity(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function medianSorted(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[mid]!
    : (values[mid - 1]! + values[mid]!) / 2;
}

/**
 * Per distinct receiptId: pick one occurredAt for timeline purposes.
 * Prefer the latest usable timestamp among that receipt's rows.
 * Undated receipts still contribute to purchaseOccurrenceCount.
 */
export function buildPurchaseEventDatesFromRows(
  rows: ReadonlyArray<{ receiptId: string; occurredAt: number }>
): {
  purchaseOccurrenceCount: number;
  purchaseEventDates: number[];
  datedPurchaseOccurrenceCount: number;
  firstPurchasedAt: number | null;
  lastPurchasedAt: number | null;
} {
  const byReceipt = new Map<string, number | null>();
  for (const row of rows) {
    const id = typeof row.receiptId === 'string' ? row.receiptId.trim() : '';
    if (!id) continue;
    const ts = usablePurchaseTimestamp(row.occurredAt);
    const existing = byReceipt.get(id);
    if (!byReceipt.has(id)) {
      byReceipt.set(id, ts);
      continue;
    }
    if (ts == null) continue;
    if (existing == null || ts > existing) {
      byReceipt.set(id, ts);
    }
  }

  const purchaseOccurrenceCount = byReceipt.size;
  const datedEntries = [...byReceipt.entries()]
    .filter((entry): entry is [string, number] => entry[1] != null)
    .sort(
      (left, right) =>
        left[1] - right[1] || left[0].localeCompare(right[0])
    );
  // Keep one date per receipt; do not collapse equal timestamps across receipts.
  const purchaseEventDates = datedEntries.map((entry) => entry[1]);
  return {
    purchaseOccurrenceCount,
    purchaseEventDates,
    datedPurchaseOccurrenceCount: purchaseEventDates.length,
    firstPurchasedAt: purchaseEventDates[0] ?? null,
    lastPurchasedAt:
      purchaseEventDates.length > 0
        ? purchaseEventDates[purchaseEventDates.length - 1]!
        : null,
  };
}

export function buildRepeatIntervalStats(
  profile: Pick<
    RepeatProductProfile,
    'purchaseEventDates' | 'datedPurchaseOccurrenceCount'
  >
): RepeatIntervalStats {
  const dates = profile.purchaseEventDates;
  const dated = profile.datedPurchaseOccurrenceCount;
  const previousPurchasedAt =
    dates.length >= 2 ? dates[dates.length - 2]! : null;
  const intervalSampleSize = Math.max(0, dated - 1);
  if (dated < 3 || dates.length < 3) {
    return {
      previousPurchasedAt,
      intervalSampleSize,
      medianIntervalDays: null,
    };
  }
  const intervalsMs = dates
    .slice(1)
    .map((date, index) => date - dates[index]!);
  const intervalsDays = [...intervalsMs]
    .map((ms) => ms / REPEAT_DAY_MS)
    .sort((left, right) => left - right);
  return {
    previousPurchasedAt,
    intervalSampleSize,
    medianIntervalDays: medianSorted(intervalsDays),
  };
}

export function isRepeatEligible(
  profile: Pick<RepeatProductProfile, 'purchaseOccurrenceCount'>
): boolean {
  return profile.purchaseOccurrenceCount >= 2;
}

function sumQuantity(
  rows: ReadonlyArray<{ quantity?: number | null; purchaseQuantity?: number | null }>
): number | undefined {
  let sum = 0;
  let any = false;
  for (const row of rows) {
    const q =
      finitePositiveQuantity(row.quantity) ??
      finitePositiveQuantity(row.purchaseQuantity);
    if (q == null) continue;
    sum += q;
    any = true;
  }
  return any ? sum : undefined;
}

function merchantSummariesFromRows(
  rows: ReadonlyArray<{ merchantKey?: string; merchantScopeKey?: string }>
): RepeatMerchantSummary[] | undefined {
  const byKey = new Map<string, string>();
  for (const row of rows) {
    const key = (row.merchantKey || row.merchantScopeKey || '').trim();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, key);
  }
  if (byKey.size === 0) return undefined;
  return [...byKey.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([merchantKey, label]) => ({ merchantKey, label }));
}

function profileFromQualifiedRows(
  identityKind: RepeatProductIdentityKind,
  identityKey: string,
  displayName: string,
  rows: ReadonlyArray<
    QualifiedIdentityObservation | IdentityConsumerObservation
  >
): RepeatProductProfile | null {
  const timeline = buildPurchaseEventDatesFromRows(rows);
  if (timeline.purchaseOccurrenceCount < 2) return null;
  const name = displayName.trim();
  if (!name) return null;
  const quantity = sumQuantity(
    rows.map((row) => ({
      quantity: (row as { quantity?: number | null }).quantity,
      purchaseQuantity: (row as { purchaseQuantity?: number | null })
        .purchaseQuantity,
    }))
  );
  return {
    identityKind,
    identityKey,
    displayName: name,
    purchaseOccurrenceCount: timeline.purchaseOccurrenceCount,
    purchaseEventDates: timeline.purchaseEventDates,
    datedPurchaseOccurrenceCount: timeline.datedPurchaseOccurrenceCount,
    firstPurchasedAt: timeline.firstPurchasedAt,
    lastPurchasedAt: timeline.lastPurchasedAt,
    ...(quantity != null ? { totalPurchaseQuantity: quantity } : {}),
    merchantSummary: merchantSummariesFromRows(
      rows.map((row) => ({
        merchantKey: (row as { merchantKey?: string }).merchantKey,
        merchantScopeKey: (row as { merchantScopeKey?: string }).merchantScopeKey,
      }))
    ),
  };
}

function compareRepeatProfiles(
  left: RepeatProductProfile,
  right: RepeatProductProfile
): number {
  if (left.purchaseOccurrenceCount !== right.purchaseOccurrenceCount) {
    return right.purchaseOccurrenceCount - left.purchaseOccurrenceCount;
  }
  const leftLast = left.lastPurchasedAt;
  const rightLast = right.lastPurchasedAt;
  if (leftLast == null && rightLast != null) return 1;
  if (leftLast != null && rightLast == null) return -1;
  if (leftLast != null && rightLast != null && leftLast !== rightLast) {
    return rightLast - leftLast;
  }
  const nameCmp = left.displayName.localeCompare(right.displayName);
  if (nameCmp !== 0) return nameCmp;
  const kindCmp = left.identityKind.localeCompare(right.identityKind);
  if (kindCmp !== 0) return kindCmp;
  return left.identityKey.localeCompare(right.identityKey);
}

function isRepeatMerchantProductObservation(
  row: Pick<QualifiedIdentityObservation, 'identityLevel'>
): boolean {
  return row.identityLevel === 'merchant_product';
}

/**
 * Repeat V1 consumer-side safety filter.
 * merchantProductId alone is insufficient — each contributing observation must
 * independently resolve at identityLevel === 'merchant_product'.
 */
export function filterRepeatSafeMerchantObservations<
  T extends Pick<QualifiedIdentityObservation, 'identityLevel'>
>(rows: readonly T[]): T[] {
  return rows.filter(isRepeatMerchantProductObservation);
}

function observationsFromProductRows(
  productRows: readonly RepeatProductRowInput[],
  supportedReceiptIds: ReadonlySet<string>
): IdentityConsumerObservation[] {
  const out: IdentityConsumerObservation[] = [];
  for (const row of productRows) {
    if (!supportedReceiptIds.has(row.receiptId)) continue;
    const rawName = (row.displayName || '').trim();
    if (!rawName) continue;
    out.push({
      receiptId: row.receiptId,
      itemSourceIndex: row.sourceIndex,
      rawName,
      merchantKey:
        (row.merchantNormalized || row.merchantRaw || '').trim() ||
        'unknown_merchant',
      occurredAt: row.occurredAt,
      lineTotal: row.lineTotal,
      quantity: row.purchaseQuantity,
      displayName: row.displayName,
    });
  }
  return out;
}

function qualifiedRowsForMerchantProduct(
  qualified: readonly QualifiedIdentityObservation[],
  merchantProductId: string,
  supportedReceiptIds: ReadonlySet<string>
): QualifiedIdentityObservation[] {
  return qualified.filter(
    (row) =>
      isRepeatMerchantProductObservation(row) &&
      row.merchantProductId === merchantProductId &&
      supportedReceiptIds.has(row.receiptId)
  );
}

/**
 * Build Repeat V1 profiles from analytics-selected receipts + indexed product rows.
 * Does not use legacy family / canonical / sku as replenishment identities.
 * Only identityLevel === 'merchant_product' observations contribute to merchant
 * or personal Repeat profiles (personal SAME then combines those safe rows).
 */
export function buildRepeatProductProfiles(
  analyticsReceipts: readonly ReceiptRow[],
  productRows: readonly RepeatProductRowInput[],
  options?: {
    personalInventory?: PersonalProductEndpointInventory | null;
    identityStore?: import('./productIdentityStore').ProductIdentityStore;
  }
): RepeatProductProfile[] {
  const supported = filterV1SupportedReceipts(analyticsReceipts as ReceiptRow[]);
  const supportedReceiptIds = new Set(supported.map((receipt) => receipt.id));
  if (supportedReceiptIds.size === 0) return [];

  const observations = observationsFromProductRows(
    productRows,
    supportedReceiptIds
  );
  if (observations.length === 0) return [];

  const {
    buildIdentityFrequentProductGroups,
  } = require('./productIdentityConsumer') as typeof import('./productIdentityConsumer');
  const { createMemoryProductIdentityStore } =
    require('./productIdentityStore') as typeof import('./productIdentityStore');
  const {
    resolvePersonalProductTargetFromInventory,
  } = require('./personalProductTargetResolver') as typeof import('./personalProductTargetResolver');
  const {
    buildPersonalProductInventoryRowKey,
  } = require('./personalProductEndpointInventory') as typeof import('./personalProductEndpointInventory');

  const store =
    options?.identityStore ?? createMemoryProductIdentityStore();
  const { groups, qualified } = buildIdentityFrequentProductGroups(
    observations,
    store
  ) as {
    groups: IdentityFrequentProductGroup[];
    qualified: QualifiedIdentityObservation[];
  };

  // Strict qualification: family_only / family_spec / unresolved never contribute,
  // even when they share merchantProductId with a later merchant_product row.
  const safeQualified = filterRepeatSafeMerchantObservations(qualified);

  const personalInventory = options?.personalInventory ?? null;
  const suppressedMemberMerchantProductIds = new Set<string>();
  const profiles: RepeatProductProfile[] = [];
  const personalKeysSeen = new Set<string>();

  if (personalInventory) {
    for (const row of safeQualified) {
      if (!supportedReceiptIds.has(row.receiptId)) continue;
      const resolution = resolvePersonalProductTargetFromInventory(
        row.merchantProductId,
        personalInventory
      );
      if (resolution.status !== 'ready') continue;
      const personalKey = resolution.resolved.canonicalTarget.key;
      if (personalKeysSeen.has(personalKey)) continue;
      personalKeysSeen.add(personalKey);

      const memberSet = new Set(resolution.resolved.memberMerchantProductIds);
      const authorized = new Set(resolution.resolved.authorizedRowKeys);
      const retained: QualifiedIdentityObservation[] = [];
      for (const candidate of safeQualified) {
        if (!supportedReceiptIds.has(candidate.receiptId)) continue;
        if (personalInventory.excludedDuplicateReceiptIds.has(candidate.receiptId)) {
          continue;
        }
        if (!memberSet.has(candidate.merchantProductId)) continue;
        const rowKey = buildPersonalProductInventoryRowKey(
          candidate.receiptId,
          candidate.itemSourceIndex
        );
        if (!authorized.has(rowKey)) continue;
        const inventoryItem = personalInventory.itemsByRowKey.get(rowKey);
        if (
          !inventoryItem ||
          inventoryItem.merchantProductId !== candidate.merchantProductId
        ) {
          continue;
        }
        retained.push(candidate);
      }
      if (retained.length === 0) {
        personalKeysSeen.delete(personalKey);
        continue;
      }

      const displayName =
        retained
          .slice()
          .sort(
            (left, right) =>
              right.occurredAt - left.occurredAt ||
              right.receiptId.localeCompare(left.receiptId)
          )
          .map((r) => (r.displayName || r.rawName || '').trim())
          .find(Boolean) || personalKey;

      const profile = profileFromQualifiedRows(
        'personal_product',
        personalKey,
        displayName,
        retained
      );
      if (!profile) {
        personalKeysSeen.delete(personalKey);
        continue;
      }

      profiles.push(profile);
      for (const memberId of memberSet) {
        suppressedMemberMerchantProductIds.add(memberId);
      }
    }
  }

  // Iterate MPs that appear in safe observations (not merely in frequent groups
  // that may have been inflated by family_only / family_spec rows).
  const safeMpIds = new Set(safeQualified.map((row) => row.merchantProductId));
  const groupByKey = new Map(groups.map((group) => [group.key, group]));
  for (const mpId of [...safeMpIds].sort((left, right) => left.localeCompare(right))) {
    if (suppressedMemberMerchantProductIds.has(mpId)) continue;
    const rows = qualifiedRowsForMerchantProduct(
      safeQualified,
      mpId,
      supportedReceiptIds
    );
    if (rows.length === 0) continue;
    const group = groupByKey.get(mpId);
    const displayName =
      group?.displayName ||
      rows
        .slice()
        .sort(
          (left, right) =>
            right.occurredAt - left.occurredAt ||
            right.receiptId.localeCompare(left.receiptId)
        )
        .map((r) => (r.displayName || r.rawName || '').trim())
        .find(Boolean) ||
      mpId;
    const profile = profileFromQualifiedRows(
      'merchant_product',
      mpId,
      displayName,
      rows
    );
    if (profile) profiles.push(profile);
  }

  return profiles.sort(compareRepeatProfiles);
}

/** Home presentation cap — not applied inside the SSOT builder. */
export function takeHomeRepeatProducts(
  profiles: readonly RepeatProductProfile[]
): RepeatProductProfile[] {
  return profiles.slice(0, HOME_REPEAT_PRODUCT_CAP);
}

/** Map Repeat SSOT onto existing Home frequent card / href contract. */
export function mapRepeatProductProfileToHomeFrequentProduct(
  profile: RepeatProductProfile
): MilestoneFrequentProduct {
  return {
    groupingType: profile.identityKind,
    key: profile.identityKey,
    displayLabel: profile.displayName,
    displayLabelKey: null,
    purchaseOccurrenceCount: profile.purchaseOccurrenceCount,
    totalPurchaseQuantity: profile.totalPurchaseQuantity ?? 0,
    lastPurchasedAt: profile.lastPurchasedAt ?? 0,
    priceSummary: null,
  };
}

/**
 * Home「常购」consumer: Repeat V1 only.
 * No legacy family/canonical/sku filler when identity path is empty/unavailable.
 */
export function buildHomeRepeatFrequentProducts(
  analyticsReceipts: readonly ReceiptRow[],
  productRows: readonly RepeatProductRowInput[],
  personalInventory: PersonalProductEndpointInventory | null = null
): MilestoneFrequentProduct[] {
  try {
    const { isProductIdentityPriceHistoryV1Enabled } =
      require('./env') as typeof import('./env');
    if (!isProductIdentityPriceHistoryV1Enabled()) {
      return [];
    }
  } catch {
    return [];
  }

  try {
    const profiles = takeHomeRepeatProducts(
      buildRepeatProductProfiles(analyticsReceipts, productRows, {
        personalInventory,
      })
    );
    return profiles.map(mapRepeatProductProfileToHomeFrequentProduct);
  } catch {
    return [];
  }
}
