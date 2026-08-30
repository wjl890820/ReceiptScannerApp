import type * as SQLite from 'expo-sqlite';
import * as ExpoSQLite from 'expo-sqlite';

import { assessReceiptAmountBasis } from './analysisFoundation/amountBasis';
import type {
  AmountTaxBasis,
  ReceiptAmountBasisAssessment,
} from './analysisFoundation/types';
import { initIfNeeded } from './db';
import type { ReceiptRow } from './db';
import {
  buildOwnerScopedInventoryPredicates,
  buildPersonalProductInventoryRowKey,
} from './personalProductEndpointInventory';
import {
  composeOwnerScopedItemHistoryWhere,
  resolveCurrentLocalReceiptOwnerScope,
} from './receiptOwnershipScope';
import type { ResolvedPersonalProductTarget } from './personalProductTargetResolver';
import type { ProductIdentityLevel } from './productIdentityContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import {
  resolveReceiptItemIdentity,
  scopeMerchantKeyForIdentity,
} from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  type ProductIdentityStore,
} from './productIdentityStore';
import {
  evaluatePriceObservationQuality,
  type PriceObservationQualityLevel,
} from './productIdentityPriceObservationQuality';
import type { ProductDetailTarget } from './productDetailTarget';
import type {
  PriceAmountProvenance,
  PriceItemAmountState,
  PricePromoContext,
} from './priceObservationTruth';
import { buildReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/monetaryCoherenceEvidence';
import type {
  MonetaryCoherenceState,
  ReceiptMonetaryCoherenceEvidence,
} from './receiptEvidenceTruth/types';
import { sanitizePromoMarkers } from './receiptPrintedEvidence';

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
  /** Gross compatibility alias when seriesKind = 'gross'. */
  lineTotal: number;
  purchaseQuantity: number;
  priceValue: number;
  priceKind: ProductPriceKind;
  seriesKind: 'gross' | null;
  grossLineAmount: number;
  amountBasis: AmountTaxBasis | null;
  promoContext?: PricePromoContext;
  promoMarkers?: string[];
  effectiveLineAmount?: number | null;
  discountAllocated?: number | null;
  qualityLevel?: PriceObservationQualityLevel | null;
  skuKey?: string | null;
  merchantProductId?: string | null;
  identityLevel?: ProductIdentityLevel | null;
  identityConfidence?: number | null;
  identitySource?: string | null;
  merchantScopeKey?: string | null;
};

export type ProductPriceComparisonEligibility = {
  status: ProductPriceHistoryStatus;
  priceKind: ProductPriceKind | null;
  currency: string | null;
  totalOccurrenceCount: number;
  comparableOccurrenceCount: number;
  excludedOccurrenceCount: number;
};

export type ProductPriceHistoryObservation = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  occurredAt: number;
  level: 1;
  seriesKind: 'gross';
  grossLineAmount: number | null;
  effectiveLineAmount: number | null;
  purchaseQuantity: number | null;
  currency: string | null;
  amountProvenance: PriceAmountProvenance | null;
  itemAmountEvidenceState: PriceItemAmountState | null;
  priceObservationVersion: number | null;
  amountBasis: AmountTaxBasis | null;
  exactComparisonTrusted: boolean;
  monetaryCoherenceState: MonetaryCoherenceState | null;
  monetaryProvenanceSufficient: boolean;
  discountOwnershipStatus: string | null;
  promoContext: PricePromoContext;
  promoMarkers: string[];
  level2Eligible: boolean;
  level2RejectReasons: string[];
  qualityLevel: PriceObservationQualityLevel | null;
  discountAllocated: number | null;
};

export type PersonalProductPriceAuthority = {
  kind: 'personal_product';
  identityLevel: 'product_exact';
  sourceTier: 'personal_manual';
  anchorMerchantProductId: string;
  memberMerchantProductIds: string[];
  authorizedRows: Array<{
    receiptId: string;
    itemId: string;
    sourceIndex: number;
    merchantProductId: string;
  }>;
};

export type ProductPriceHistoryResult = ProductPriceComparisonEligibility & {
  target: ProductDetailTarget;
  points: ProductPriceHistoryPoint[];
  /**
   * Level-1 target-scoped observations (duplicate-excluded). Receipt events here are
   * a superset of receipt events represented in `points` (Level-2 comparable subset).
   */
  observations: ProductPriceHistoryObservation[];
  seriesKind: 'gross' | null;
  amountBasis: 'tax_included' | 'tax_excluded' | null;
  /** True only when caller positively applied canonical duplicate selection. */
  canonicalDuplicateSelectionApplied: boolean;
  personalProductPriceAuthority?: PersonalProductPriceAuthority | null;
  identityPresentation?: {
    strategy: 'same_merchant_product';
    titleKey: 'priceHistory.titleMerchantLocal';
    subtitleKey: 'priceHistory.subtitle.merchantProduct';
    trendInsightEligible: boolean;
    qualityExcludedCount: number;
    merchantProductId: string;
  } | null;
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
  /** Compatibility alias — prefer grossLineAmount for G3 comparability. */
  lineTotal: number | null;
  purchaseQuantity: number | null;
  skuKey?: string | null;
  productFamilyKey: string | null;
  volumeBaseMl: number | null;
  weightBaseG: number | null;
  countBase: number | null;
  grossLineAmount?: number | null;
  effectiveLineAmount?: number | null;
  discountAllocated?: number | null;
  amountProvenance?: PriceAmountProvenance | null;
  itemAmountEvidenceState?: PriceItemAmountState | null;
  promoMarkersJson?: string | null;
  evidenceCaptureVersion?: number | null;
  priceObservationVersion?: number | null;
  itemSource?: string | null;
  identitySource?: string | null;
  identityConfidence?: number | null;
  receiptAnalysisJson?: string | null;
  receiptUserItemsJson?: string | null;
  receiptUserEdited?: number | null;
  receiptTotal?: number | null;
  receiptFinalTotal?: number | null;
  receiptTax?: number | null;
  receiptTaxIsKnown?: number | null;
  receiptCurrency?: string | null;
};

export type ProductPriceHistoryDatabase = {
  getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]>;
};

export type ReceiptEvidenceCacheEntry = {
  amountBasisAssessment: ReceiptAmountBasisAssessment;
  monetaryCoherenceEvidence: ReceiptMonetaryCoherenceEvidence;
};

export type ReceiptEvidenceCache = Map<string, ReceiptEvidenceCacheEntry>;

export type BuildProductPriceHistoryOptions = {
  receiptEvidenceCache?: ReceiptEvidenceCache;
  canonicalDuplicateSelectionApplied?: boolean;
  personalProductContext?: ResolvedPersonalProductTarget;
};

type RowIdentityMetadata = {
  skuKey: string | null;
  merchantProductId: string | null;
  identityLevel: ProductIdentityLevel;
  identityConfidence: number | null;
  identitySource: string | null;
  merchantScopeKey: string;
};

function isValidOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function personalPriceRowMatchesInventory(
  resolved: ResolvedPersonalProductTarget,
  row: ProductPriceHistoryRow,
  inventoryItem: NonNullable<
    ReturnType<ResolvedPersonalProductTarget['inventory']['itemsByRowKey']['get']>
  >
): boolean {
  const memberSet = new Set(resolved.memberMerchantProductIds);
  if (!memberSet.has(inventoryItem.merchantProductId)) {
    return false;
  }
  if (row.receiptId !== inventoryItem.receiptId) {
    return false;
  }
  if (row.sourceIndex !== inventoryItem.sourceIndex) {
    return false;
  }
  if (!isValidOpaqueIdentifier(row.itemId)) {
    return false;
  }
  if (!isValidOpaqueIdentifier(inventoryItem.itemId)) {
    return false;
  }
  if (row.itemId !== inventoryItem.itemId) {
    return false;
  }
  return true;
}

function retainedAuthorizedRowKeys(
  resolved: ResolvedPersonalProductTarget
): string[] | null {
  const excluded = resolved.inventory.excludedDuplicateReceiptIds;
  const retained: string[] = [];
  for (const rowKey of resolved.authorizedRowKeys) {
    const inventoryItem = resolved.inventory.itemsByRowKey.get(rowKey);
    if (!inventoryItem) {
      return null;
    }
    if (excluded.has(inventoryItem.receiptId)) {
      continue;
    }
    retained.push(rowKey);
  }
  return retained.sort();
}

export type SelectAuthorizedPersonalProductPriceRowsResult =
  | { ok: true; rows: ProductPriceHistoryRow[] }
  | { ok: false; reason: 'membership_inconsistent' };

export function selectAuthorizedPersonalProductPriceRows(
  resolved: ResolvedPersonalProductTarget,
  rows: readonly ProductPriceHistoryRow[]
): SelectAuthorizedPersonalProductPriceRowsResult {
  const memberSet = new Set(resolved.memberMerchantProductIds);
  const expectedRetainedKeys = retainedAuthorizedRowKeys(resolved);
  if (expectedRetainedKeys == null) {
    return { ok: false, reason: 'membership_inconsistent' };
  }

  for (const rowKey of expectedRetainedKeys) {
    const inventoryItem = resolved.inventory.itemsByRowKey.get(rowKey)!;
    if (!memberSet.has(inventoryItem.merchantProductId)) {
      return { ok: false, reason: 'membership_inconsistent' };
    }
  }

  const queriedByAuthorizedKey = new Map<string, ProductPriceHistoryRow>();
  for (const row of rows) {
    const rowKey = buildPersonalProductInventoryRowKey(
      row.receiptId,
      row.sourceIndex
    );
    if (!resolved.authorizedRowKeys.has(rowKey)) {
      continue;
    }
    const existing = queriedByAuthorizedKey.get(rowKey);
    if (existing) {
      if (
        existing.receiptId !== row.receiptId ||
        existing.sourceIndex !== row.sourceIndex ||
        existing.itemId !== row.itemId
      ) {
        return { ok: false, reason: 'membership_inconsistent' };
      }
      continue;
    }
    queriedByAuthorizedKey.set(rowKey, row);
  }

  const selected: ProductPriceHistoryRow[] = [];

  for (const rowKey of expectedRetainedKeys) {
    const inventoryItem = resolved.inventory.itemsByRowKey.get(rowKey)!;
    const queriedRow = queriedByAuthorizedKey.get(rowKey);
    if (!queriedRow) {
      return { ok: false, reason: 'membership_inconsistent' };
    }
    if (!personalPriceRowMatchesInventory(resolved, queriedRow, inventoryItem)) {
      return { ok: false, reason: 'membership_inconsistent' };
    }
    selected.push(queriedRow);
  }

  return { ok: true, rows: selected };
}

type PriceDimension = 'volume' | 'weight' | 'count';

type ComparableCandidate = {
  row: ProductPriceHistoryRow;
  observation: ProductPriceHistoryObservation;
  dimension: PriceDimension | null;
  currency: string | null;
  priceValue: number;
  grossLineAmount: number;
  amountBasis: AmountTaxBasis | null;
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

function hasValidOccurredAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function knownCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const currency = value.trim();
  if (!currency || currency.toLowerCase() === 'unknown') return null;
  return currency;
}

function usesG3ObservationTruth(row: ProductPriceHistoryRow): boolean {
  return row.priceObservationVersion === 1;
}

function resolveGrossLineAmount(row: ProductPriceHistoryRow): number | null {
  if (positiveFinite(row.grossLineAmount)) return row.grossLineAmount;
  return null;
}

function nullishNumber(value: number | null | undefined): number | null {
  return value ?? null;
}

function rowToReceiptRow(row: ProductPriceHistoryRow): ReceiptRow {
  return {
    id: row.receiptId,
    created_at: row.occurredAt,
    transaction_at: row.occurredAt,
    image_uri: '',
    merchant_raw: row.merchantRaw,
    merchant_normalized: row.merchantNormalized,
    total: row.receiptTotal ?? 0,
    tax: row.receiptTax ?? 0,
    tax_is_known: row.receiptTaxIsKnown ?? 0,
    currency: row.receiptCurrency ?? row.currency ?? '',
    analysis_json: row.receiptAnalysisJson ?? '{}',
    user_edited: row.receiptUserEdited ?? 0,
    final_total: nullishNumber(row.receiptFinalTotal),
    final_category: null,
    note: null,
    user_items_json: row.receiptUserItemsJson ?? null,
  };
}

export function buildReceiptEvidenceCache(
  rows: readonly ProductPriceHistoryRow[]
): ReceiptEvidenceCache {
  const cache: ReceiptEvidenceCache = new Map();
  for (const row of rows) {
    if (cache.has(row.receiptId)) continue;
    const receipt = rowToReceiptRow(row);
    cache.set(row.receiptId, {
      amountBasisAssessment: assessReceiptAmountBasis(receipt),
      monetaryCoherenceEvidence: buildReceiptMonetaryCoherenceEvidence(receipt),
    });
  }
  return cache;
}

type DiscountFieldRead = {
  present: boolean;
  conflict: boolean;
  value: number | null;
};

function readDiscountFieldFromRow(row: ProductPriceHistoryRow): DiscountFieldRead {
  if (row.discountAllocated == null) {
    return { present: false, conflict: false, value: null };
  }
  const value = row.discountAllocated;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { present: true, conflict: true, value: null };
  }
  if (value > 0) {
    return { present: true, conflict: true, value: null };
  }
  return { present: true, conflict: false, value };
}

function hasExplicitProductDiscount(discountRead: DiscountFieldRead): boolean {
  return (
    discountRead.present &&
    !discountRead.conflict &&
    discountRead.value != null &&
    discountRead.value < 0
  );
}

type PromoMarkersRead =
  | { state: 'absent'; markers: [] }
  | { state: 'valid'; markers: string[] }
  | { state: 'invalid'; markers: [] };

export function readPromoMarkersFromRow(
  row: ProductPriceHistoryRow
): PromoMarkersRead {
  if (row.promoMarkersJson == null) {
    return { state: 'absent', markers: [] };
  }
  if (typeof row.promoMarkersJson !== 'string') {
    return { state: 'invalid', markers: [] };
  }
  const trimmed = row.promoMarkersJson.trim();
  if (!trimmed) {
    return { state: 'invalid', markers: [] };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return { state: 'invalid', markers: [] };
    }
    if (parsed.length === 0) {
      return { state: 'invalid', markers: [] };
    }
    if (parsed.some((value) => typeof value !== 'string')) {
      return { state: 'invalid', markers: [] };
    }
    const markers = sanitizePromoMarkers(parsed) ?? [];
    if (markers.length === 0) {
      return { state: 'invalid', markers: [] };
    }
    return { state: 'valid', markers };
  } catch {
    return { state: 'invalid', markers: [] };
  }
}

export function resolvePromoContextFromRow(
  row: ProductPriceHistoryRow
): PricePromoContext {
  const promoRead = readPromoMarkersFromRow(row);
  const hasMarkers = promoRead.state === 'valid' && promoRead.markers.length > 0;
  const discountRead = readDiscountFieldFromRow(row);

  if (promoRead.state === 'invalid') {
    return 'unknown';
  }

  if (hasMarkers) {
    if (hasExplicitProductDiscount(discountRead)) {
      return 'explicit_discount_and_marker';
    }
    return 'qualitative_marker';
  }

  if (hasExplicitProductDiscount(discountRead)) {
    return 'explicit_discount';
  }

  if (discountRead.conflict) {
    return 'unknown';
  }

  const coherentOcr = row.itemAmountEvidenceState === 'coherent';
  if (
    promoRead.state === 'absent' &&
    row.evidenceCaptureVersion === 1 &&
    coherentOcr
  ) {
    const discountAbsent = !discountRead.present;
    const discountValidZero =
      discountRead.present &&
      !discountRead.conflict &&
      discountRead.value === 0;
    if (discountAbsent || discountValidZero) {
      return 'none_observed';
    }
  }

  return 'unknown';
}

function receiptEvidenceForRow(
  row: ProductPriceHistoryRow,
  cache: ReceiptEvidenceCache
): ReceiptEvidenceCacheEntry | null {
  return cache.get(row.receiptId) ?? null;
}

function trustedAmountBasisForRow(
  row: ProductPriceHistoryRow,
  cache: ReceiptEvidenceCache
): AmountTaxBasis | null {
  const evidence = receiptEvidenceForRow(row, cache);
  if (!evidence?.amountBasisAssessment.exactComparisonTrusted) return null;
  const basis = evidence.amountBasisAssessment.basis;
  if (basis === 'tax_included' || basis === 'tax_excluded') return basis;
  return null;
}

function rowObservationKey(row: ProductPriceHistoryRow): string {
  return `${row.receiptId}:${row.sourceIndex}`;
}

function membershipRowKeysToSet(
  keys: ReadonlyArray<{ receiptId: string; itemSourceIndex: number }>
): Set<string> {
  return new Set(keys.map((key) => `${key.receiptId}:${key.itemSourceIndex}`));
}

function filterRowsByMembershipKeys(
  rows: readonly ProductPriceHistoryRow[],
  membershipKeys: ReadonlySet<string>
): ProductPriceHistoryRow[] {
  return rows.filter((row) => membershipKeys.has(rowObservationKey(row)));
}

function buildObservationsForRows(
  rows: readonly ProductPriceHistoryRow[],
  cache: ReceiptEvidenceCache
): {
  observations: ProductPriceHistoryObservation[];
  observationsByKey: Map<string, ProductPriceHistoryObservation>;
} {
  const structuralCohort = buildSkuStructuralCohort(rows, cache);
  return buildObservationsAndStructuralCohort(rows, cache, structuralCohort);
}

function resolveMerchantTargetMembershipRowKeys(
  filtered: ProductPriceHistoryRow[],
  merchantProductId: string
): Array<{ receiptId: string; itemSourceIndex: number }> {
  const { resolveMerchantProductTargetMembershipRowKeys } =
    require('./productIdentityConsumer') as typeof import('./productIdentityConsumer');
  return resolveMerchantProductTargetMembershipRowKeys(filtered, merchantProductId);
}

function buildMerchantTargetObservations(
  filtered: ProductPriceHistoryRow[],
  cache: ReceiptEvidenceCache,
  merchantProductId: string,
  membershipRowKeys?: ReadonlyArray<{
    receiptId: string;
    itemSourceIndex: number;
  }>
): ProductPriceHistoryObservation[] {
  const keys =
    membershipRowKeys ??
    resolveMerchantTargetMembershipRowKeys(filtered, merchantProductId);
  const targetRows = filterRowsByMembershipKeys(
    filtered,
    membershipRowKeysToSet(keys)
  );
  return buildObservationsForRows(targetRows, cache).observations;
}

function failClosedRequestedMerchantProductTargetResult(
  target: Extract<ProductDetailTarget, { type: 'merchant_product' }>,
  filtered: ProductPriceHistoryRow[],
  cache: ReceiptEvidenceCache,
  canonicalDuplicateSelectionApplied: boolean
): ProductPriceHistoryResult {
  const observations = buildMerchantTargetObservations(
    filtered,
    cache,
    target.key
  );
  const targetRows = filterRowsByMembershipKeys(
    filtered,
    membershipRowKeysToSet(
      resolveMerchantTargetMembershipRowKeys(filtered, target.key)
    )
  );
  return {
    target,
    status: 'not_enough_points',
    priceKind: 'purchase_unit',
    currency: null,
    totalOccurrenceCount: targetRows.length,
    comparableOccurrenceCount: 0,
    excludedOccurrenceCount: targetRows.length,
    points: [],
    observations,
    seriesKind: null,
    amountBasis: null,
    canonicalDuplicateSelectionApplied,
    identityPresentation: null,
  };
}

function buildRowIdentityMetadataByKey(
  rows: readonly ProductPriceHistoryRow[],
  store: ProductIdentityStore = createMemoryProductIdentityStore()
): Map<string, RowIdentityMetadata> {
  const metadataByKey = new Map<string, RowIdentityMetadata>();
  for (const row of rows) {
    const key = rowObservationKey(row);
    if (metadataByKey.has(key)) continue;
    const merchantScopeKey = scopeMerchantKeyForIdentity(
      row.merchantNormalized ?? row.merchantRaw ?? 'unknown_merchant',
      row.receiptId
    );
    const resolved = resolveReceiptItemIdentity(
      {
        rawName: row.displayName,
        merchantKey: row.merchantNormalized ?? row.merchantRaw ?? 'unknown_merchant',
        receiptId: row.receiptId,
        itemSourceIndex: row.sourceIndex,
        quantity: row.purchaseQuantity,
        lineTotal: row.lineTotal,
      },
      store
    );
    metadataByKey.set(key, {
      skuKey: row.skuKey?.trim() || resolved.link.skuId,
      merchantProductId: resolved.link.merchantProductId,
      identityLevel: resolved.link.identityLevel,
      identityConfidence: resolved.link.identityConfidence,
      identitySource: resolved.link.identitySource,
      merchantScopeKey,
    });
  }
  return metadataByKey;
}

function buildPersonalInventoryRowIdentityMetadataByKey(
  resolved: ResolvedPersonalProductTarget,
  rows: readonly ProductPriceHistoryRow[]
): Map<string, RowIdentityMetadata> {
  const metadataByKey = new Map<string, RowIdentityMetadata>();
  for (const row of rows) {
    const key = rowObservationKey(row);
    const inventoryRowKey = buildPersonalProductInventoryRowKey(
      row.receiptId,
      row.sourceIndex
    );
    const item = resolved.inventory.itemsByRowKey.get(inventoryRowKey);
    if (!item) continue;
    metadataByKey.set(key, {
      skuKey: item.skuKey,
      merchantProductId: item.merchantProductId,
      identityLevel: item.identityLevel,
      identityConfidence: null,
      identitySource: null,
      merchantScopeKey: item.merchantScopeKey,
    });
  }
  return metadataByKey;
}

function buildPersonalProductPriceAuthority(
  resolved: ResolvedPersonalProductTarget,
  rows: readonly ProductPriceHistoryRow[]
): PersonalProductPriceAuthority {
  const authorizedRows = rows
    .map((row) => {
      const inventoryItem = resolved.inventory.itemsByRowKey.get(
        buildPersonalProductInventoryRowKey(row.receiptId, row.sourceIndex)
      )!;
      return {
        receiptId: inventoryItem.receiptId,
        itemId: inventoryItem.itemId,
        sourceIndex: inventoryItem.sourceIndex,
        merchantProductId: inventoryItem.merchantProductId,
      };
    })
    .sort(
      (left, right) =>
        left.receiptId.localeCompare(right.receiptId) ||
        left.sourceIndex - right.sourceIndex
    );

  return {
    kind: 'personal_product',
    identityLevel: 'product_exact',
    sourceTier: 'personal_manual',
    anchorMerchantProductId: resolved.anchorMerchantProductId,
    memberMerchantProductIds: [...resolved.memberMerchantProductIds],
    authorizedRows,
  };
}

function failClosedPersonalProductPriceResult(
  target: Extract<ProductDetailTarget, { type: 'personal_product' }>
): ProductPriceHistoryResult {
  return {
    target,
    status: 'not_enough_points',
    priceKind: null,
    currency: null,
    totalOccurrenceCount: 0,
    comparableOccurrenceCount: 0,
    excludedOccurrenceCount: 0,
    points: [],
    observations: [],
    seriesKind: null,
    amountBasis: null,
    canonicalDuplicateSelectionApplied: false,
    personalProductPriceAuthority: null,
    identityPresentation: null,
  };
}

function buildExactPurchaseUnitPriceHistory(
  target: ProductDetailTarget,
  rows: ProductPriceHistoryRow[],
  identityByRowKey: Map<string, RowIdentityMetadata>,
  options: BuildProductPriceHistoryOptions = {}
): ProductPriceHistoryResult {
  const cache = options.receiptEvidenceCache ?? buildReceiptEvidenceCache(rows);
  const canonicalDuplicateSelectionApplied =
    options.canonicalDuplicateSelectionApplied === true;
  const totalOccurrenceCount = rows.length;
  const structuralCohort = buildSkuStructuralCohort(rows, cache);
  const { observations, observationsByKey } =
    buildObservationsAndStructuralCohort(rows, cache, structuralCohort);
  const specCandidates = buildSkuSpecCoverageCandidates(
    rows,
    cache,
    observationsByKey
  );
  const candidates = comparableCandidatesFromStructural(
    structuralCohort,
    cache,
    observationsByKey
  );
  return finalizeCandidates(
    target,
    totalOccurrenceCount,
    'purchase_unit',
    candidates,
    observations,
    identityByRowKey,
    specCandidates,
    canonicalDuplicateSelectionApplied
  );
}

function buildHistoryPoint(
  candidate: ComparableCandidate,
  priceKind: ProductPriceKind,
  currency: string,
  identityByRowKey: Map<string, RowIdentityMetadata>,
  merchantNormalizedOverride?: string | null
): ProductPriceHistoryPoint {
  const identity =
    identityByRowKey.get(rowObservationKey(candidate.row)) ?? null;
  return {
    receiptId: candidate.row.receiptId,
    itemId: candidate.row.itemId,
    sourceIndex: candidate.row.sourceIndex,
    occurredAt: candidate.row.occurredAt,
    merchantRaw: candidate.row.merchantRaw,
    merchantNormalized:
      merchantNormalizedOverride ?? candidate.row.merchantNormalized,
    displayName: candidate.row.displayName,
    currency,
    lineTotal: candidate.grossLineAmount,
    purchaseQuantity: candidate.row.purchaseQuantity as number,
    priceValue: candidate.priceValue,
    priceKind,
    seriesKind: 'gross',
    grossLineAmount: candidate.grossLineAmount,
    amountBasis: candidate.amountBasis,
    promoContext: candidate.observation.promoContext,
    promoMarkers: candidate.observation.promoMarkers,
    effectiveLineAmount: candidate.observation.effectiveLineAmount,
    discountAllocated: nullishNumber(candidate.row.discountAllocated),
    qualityLevel: candidate.observation.qualityLevel,
    skuKey: candidate.row.skuKey ?? identity?.skuKey ?? null,
    merchantProductId: identity?.merchantProductId ?? null,
    identityLevel: identity?.identityLevel ?? null,
    identityConfidence: identity?.identityConfidence ?? null,
    identitySource: identity?.identitySource ?? null,
    merchantScopeKey: identity?.merchantScopeKey ?? null,
  };
}

type StructuralCandidate = {
  row: ProductPriceHistoryRow;
  priceValue: number;
  grossLineAmount: number;
  amountBasis: AmountTaxBasis | null;
  currency: string | null;
  dimension: PriceDimension | null;
};

function evaluateStructuralGates(
  row: ProductPriceHistoryRow,
  cache: ReceiptEvidenceCache
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const gross = resolveGrossLineAmount(row);
  const qty = row.purchaseQuantity;
  const currency = knownCurrency(row.currency);

  if (!usesG3ObservationTruth(row)) {
    reasons.push('legacy_unbackfilled');
    return { pass: false, reasons };
  }

  if (row.priceObservationVersion !== 1) reasons.push('price_observation_version');
  if (row.itemAmountEvidenceState !== 'coherent') {
    reasons.push('item_amount_evidence_state');
  }
  if (!positiveFinite(gross)) reasons.push('invalid_gross_amount');
  if (!positiveFinite(qty)) reasons.push('invalid_quantity');
  if (currency !== 'JPY') reasons.push('currency_not_jpy');

  const receiptEvidence = receiptEvidenceForRow(row, cache);
  const basisAssessment = receiptEvidence?.amountBasisAssessment;
  const monetaryEvidence = receiptEvidence?.monetaryCoherenceEvidence;
  const trustedBasis = trustedAmountBasisForRow(row, cache);

  if (
    !basisAssessment?.exactComparisonTrusted ||
    (trustedBasis !== 'tax_included' && trustedBasis !== 'tax_excluded')
  ) {
    reasons.push('amount_basis_untrusted');
  }

  if (monetaryEvidence?.state !== 'known_coherent') {
    reasons.push('monetary_incoherent');
  }
  if (monetaryEvidence?.monetaryProvenanceSufficient !== true) {
    reasons.push('monetary_provenance_insufficient');
  }
  if (monetaryEvidence?.discountOwnershipStatus === 'unresolved') {
    reasons.push('discount_ownership_unresolved');
  }

  return { pass: reasons.length === 0, reasons };
}

function qualityPeersForCandidate(
  candidate: StructuralCandidate,
  cohort: readonly StructuralCandidate[]
): number[] {
  return cohort
    .filter(
      (peer) =>
        rowObservationKey(peer.row) !== rowObservationKey(candidate.row) &&
        peer.amountBasis === candidate.amountBasis &&
        (peer.amountBasis === 'tax_included' ||
          peer.amountBasis === 'tax_excluded')
    )
    .map((peer) => peer.priceValue);
}

function evaluateNormalizedGrossQuality(
  row: ProductPriceHistoryRow,
  candidate: StructuralCandidate,
  peerPriceValues: readonly number[]
): PriceObservationQualityLevel {
  const isPurchaseUnit = candidate.dimension == null;
  const quality = evaluatePriceObservationQuality({
    lineTotal: isPurchaseUnit ? candidate.grossLineAmount : candidate.priceValue,
    quantity: isPurchaseUnit ? (row.purchaseQuantity as number) : 1,
    rawName: row.displayName,
    peerPurchaseUnitPrices: peerPriceValues,
    attributes: normalizeProductForIdentity(row.displayName).attributes,
  });
  return quality.quality;
}

function passesLevel2Quality(quality: PriceObservationQualityLevel): boolean {
  return quality !== 'invalid' && quality !== 'suspected_anomaly';
}

function buildObservationForRow(
  row: ProductPriceHistoryRow,
  cache: ReceiptEvidenceCache,
  promoRead: PromoMarkersRead,
  promoContext: PricePromoContext,
  structural: { pass: boolean; reasons: string[] },
  qualityLevel: PriceObservationQualityLevel | null,
  qualityReasons: string[]
): ProductPriceHistoryObservation {
  const receiptEvidence = receiptEvidenceForRow(row, cache);
  const basisAssessment = receiptEvidence?.amountBasisAssessment;
  const monetaryEvidence = receiptEvidence?.monetaryCoherenceEvidence;
  const rejectReasons = [...structural.reasons, ...qualityReasons];
  const level2Eligible =
    structural.pass &&
    qualityLevel != null &&
    passesLevel2Quality(qualityLevel);

  return {
    receiptId: row.receiptId,
    itemId: row.itemId,
    sourceIndex: row.sourceIndex,
    occurredAt: row.occurredAt,
    level: 1,
    seriesKind: 'gross',
    grossLineAmount: nullishNumber(row.grossLineAmount),
    effectiveLineAmount: nullishNumber(row.effectiveLineAmount),
    purchaseQuantity: nullishNumber(row.purchaseQuantity),
    currency: knownCurrency(row.currency),
    amountProvenance: row.amountProvenance ?? null,
    itemAmountEvidenceState: row.itemAmountEvidenceState ?? null,
    priceObservationVersion: nullishNumber(row.priceObservationVersion),
    amountBasis: basisAssessment?.basis ?? null,
    exactComparisonTrusted: basisAssessment?.exactComparisonTrusted ?? false,
    monetaryCoherenceState: monetaryEvidence?.state ?? null,
    monetaryProvenanceSufficient:
      monetaryEvidence?.monetaryProvenanceSufficient ?? false,
    discountOwnershipStatus: monetaryEvidence?.discountOwnershipStatus ?? null,
    promoContext,
    promoMarkers: promoRead.state === 'valid' ? promoRead.markers : [],
    level2Eligible,
    level2RejectReasons: rejectReasons,
    qualityLevel,
    discountAllocated: nullishNumber(row.discountAllocated),
  };
}

function structuralToComparableCandidates(
  structuralCohort: readonly StructuralCandidate[],
  observationsByKey: Map<string, ProductPriceHistoryObservation>
): ComparableCandidate[] {
  return structuralCohort.map((candidate) => ({
    row: candidate.row,
    observation:
      observationsByKey.get(rowObservationKey(candidate.row)) ??
      observationByRowKey([], candidate.row),
    dimension: candidate.dimension,
    currency: candidate.currency,
    priceValue: candidate.priceValue,
    grossLineAmount: candidate.grossLineAmount,
    amountBasis: candidate.amountBasis,
  }));
}

function comparableCandidatesFromStructural(
  structuralCohort: readonly StructuralCandidate[],
  cache: ReceiptEvidenceCache,
  observationsByKey: Map<string, ProductPriceHistoryObservation>
): ComparableCandidate[] {
  return structuralCohort.flatMap((candidate) => {
    const observation =
      observationsByKey.get(rowObservationKey(candidate.row)) ?? null;
    if (!observation?.level2Eligible) return [];
    return [
      {
        row: candidate.row,
        observation,
        dimension: candidate.dimension,
        currency: candidate.currency,
        priceValue: candidate.priceValue,
        grossLineAmount: candidate.grossLineAmount,
        amountBasis: candidate.amountBasis,
      },
    ];
  });
}

function buildObservationsAndStructuralCohort(
  rows: readonly ProductPriceHistoryRow[],
  cache: ReceiptEvidenceCache,
  structuralCohort: readonly StructuralCandidate[]
): {
  observations: ProductPriceHistoryObservation[];
  observationsByKey: Map<string, ProductPriceHistoryObservation>;
} {
  const structuralByKey = new Map(
    structuralCohort.map((candidate) => [
      rowObservationKey(candidate.row),
      candidate,
    ])
  );
  const observations = rows.map((row) => {
    const promoRead = readPromoMarkersFromRow(row);
    const promoContext = resolvePromoContextFromRow(row);
    const structural = evaluateStructuralGates(row, cache);
    const candidate = structuralByKey.get(rowObservationKey(row));
    let qualityLevel: PriceObservationQualityLevel | null = null;
    const qualityReasons: string[] = [];
    if (structural.pass && candidate) {
      const peers = qualityPeersForCandidate(candidate, structuralCohort);
      qualityLevel = evaluateNormalizedGrossQuality(
        row,
        candidate,
        peers
      );
      if (!passesLevel2Quality(qualityLevel)) {
        qualityReasons.push(`price_quality_${qualityLevel}`);
      }
    }
    return buildObservationForRow(
      row,
      cache,
      promoRead,
      promoContext,
      structural,
      qualityLevel,
      qualityReasons
    );
  });
  const observationsByKey = new Map(
    observations.map((observation) => [
      `${observation.receiptId}:${observation.sourceIndex}`,
      observation,
    ])
  );
  return { observations, observationsByKey };
}

/**
 * Selected MerchantProduct history currency gate:
 * every observation must have a known currency, and all must be identical.
 * Never defaults to JPY. Any unknown → not eligible.
 */
export function gateIdentityHistoryCurrencies(
  currencies: ReadonlyArray<unknown>
):
  | { status: 'ok'; currency: string }
  | { status: 'mixed_currency' | 'unknown_currency'; currency: null } {
  const known = currencies.map(knownCurrency);
  if (known.some((c) => c == null)) {
    return { status: 'unknown_currency', currency: null };
  }
  const set = new Set(known as string[]);
  if (set.size === 0) {
    return { status: 'unknown_currency', currency: null };
  }
  if (set.size > 1) {
    return { status: 'mixed_currency', currency: null };
  }
  return { status: 'ok', currency: [...set][0]! };
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
  const gross = resolveGrossLineAmount(row);
  if (!positiveFinite(gross) || !positiveFinite(row.purchaseQuantity)) {
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
  const multiplier =
    dimension === 'volume' ? 1000 : dimension === 'weight' ? 100 : 1;
  const value = (gross / totalBase) * multiplier;
  return positiveFinite(value) ? value : null;
}

function emptyResult(
  target: ProductDetailTarget,
  status: ProductPriceHistoryStatus,
  totalOccurrenceCount: number,
  observations: ProductPriceHistoryObservation[],
  priceKind: ProductPriceKind | null = null,
  canonicalDuplicateSelectionApplied = false
): ProductPriceHistoryResult {
  return {
    target,
    status,
    priceKind,
    currency: null,
    points: [],
    observations,
    seriesKind: null,
    amountBasis: null,
    canonicalDuplicateSelectionApplied,
    totalOccurrenceCount,
    comparableOccurrenceCount: 0,
    excludedOccurrenceCount: totalOccurrenceCount,
  };
}

function evaluateAmountBasisSeriesGate(
  candidates: ComparableCandidate[]
): {
  mixedBasis: boolean;
  amountBasis: 'tax_included' | 'tax_excluded' | null;
} {
  const trustedBases = new Set<'tax_included' | 'tax_excluded'>();
  for (const candidate of candidates) {
    if (
      candidate.amountBasis === 'tax_included' ||
      candidate.amountBasis === 'tax_excluded'
    ) {
      trustedBases.add(candidate.amountBasis);
    }
  }
  if (trustedBases.size > 1) {
    return { mixedBasis: true, amountBasis: null };
  }
  return {
    mixedBasis: false,
    amountBasis: trustedBases.size === 1 ? [...trustedBases][0]! : null,
  };
}

function finalizeCandidates(
  target: ProductDetailTarget,
  totalOccurrenceCount: number,
  priceKind: ProductPriceKind,
  candidates: ComparableCandidate[],
  observations: ProductPriceHistoryObservation[],
  identityByRowKey: Map<string, RowIdentityMetadata>,
  specCandidates: ComparableCandidate[] = candidates,
  canonicalDuplicateSelectionApplied = false
): ProductPriceHistoryResult {
  const basisGate = evaluateAmountBasisSeriesGate(candidates);
  if (basisGate.mixedBasis) {
    const observationsWithBasisMismatch = observations.map((observation) =>
      observation.level2Eligible
        ? {
            ...observation,
            level2Eligible: false,
            level2RejectReasons: [
              ...observation.level2RejectReasons,
              'amount_basis_mismatch',
            ],
          }
        : observation
    );
    return emptyResult(
      target,
      'not_enough_points',
      totalOccurrenceCount,
      observationsWithBasisMismatch,
      priceKind,
      canonicalDuplicateSelectionApplied
    );
  }

  const selected = candidates;
  const level2Currencies = new Set(
    selected
      .map((candidate) => candidate.currency)
      .filter((currency): currency is string => currency != null)
  );
  if (level2Currencies.size > 1) {
    return emptyResult(
      target,
      'mixed_currency',
      totalOccurrenceCount,
      observations,
      priceKind,
      canonicalDuplicateSelectionApplied
    );
  }

  const knownCandidates = selected.filter(
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
      observations,
      priceKind,
      canonicalDuplicateSelectionApplied
    );
  }

  const points = knownCandidates
    .map<ProductPriceHistoryPoint>((candidate) =>
      buildHistoryPoint(
        candidate,
        priceKind,
        candidate.currency,
        identityByRowKey
      )
    )
    .sort(
      (left, right) =>
        left.occurredAt - right.occurredAt ||
        left.receiptId.localeCompare(right.receiptId) ||
        left.sourceIndex - right.sourceIndex
    );

  const hasUnknownCurrency = specCandidates.some(
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
    observations,
    seriesKind: points.length > 0 ? 'gross' : null,
    amountBasis: points.length >= 2 ? basisGate.amountBasis : null,
    canonicalDuplicateSelectionApplied,
    totalOccurrenceCount,
    comparableOccurrenceCount: points.length,
    excludedOccurrenceCount: totalOccurrenceCount - points.length,
  };
}

function observationByRowKey(
  observations: readonly ProductPriceHistoryObservation[],
  row: ProductPriceHistoryRow
): ProductPriceHistoryObservation {
  return (
    observations.find(
      (observation) =>
        observation.receiptId === row.receiptId &&
        observation.sourceIndex === row.sourceIndex
    ) ?? {
      receiptId: row.receiptId,
      itemId: row.itemId,
      sourceIndex: row.sourceIndex,
      occurredAt: row.occurredAt,
      level: 1,
      seriesKind: 'gross',
      grossLineAmount: nullishNumber(row.grossLineAmount),
      effectiveLineAmount: nullishNumber(row.effectiveLineAmount),
      purchaseQuantity: nullishNumber(row.purchaseQuantity),
      currency: knownCurrency(row.currency),
      amountProvenance: row.amountProvenance ?? null,
      itemAmountEvidenceState: row.itemAmountEvidenceState ?? null,
      priceObservationVersion: nullishNumber(row.priceObservationVersion),
      amountBasis: null,
      exactComparisonTrusted: false,
      monetaryCoherenceState: null,
      monetaryProvenanceSufficient: false,
      discountOwnershipStatus: null,
      promoContext: resolvePromoContextFromRow(row),
      promoMarkers: (() => {
        const read = readPromoMarkersFromRow(row);
        return read.state === 'valid' ? read.markers : [];
      })(),
      level2Eligible: false,
      level2RejectReasons: ['missing_observation'],
      qualityLevel: null,
      discountAllocated: nullishNumber(row.discountAllocated),
    }
  );
}

function buildSkuSpecCoverageCandidates(
  rows: readonly ProductPriceHistoryRow[],
  cache: ReceiptEvidenceCache,
  observationsByKey: Map<string, ProductPriceHistoryObservation>
): ComparableCandidate[] {
  return rows.flatMap((row) => {
    const gross = resolveGrossLineAmount(row);
    const qty = row.purchaseQuantity;
    if (!positiveFinite(gross) || !positiveFinite(qty)) return [];
    const priceValue = gross / qty;
    if (!positiveFinite(priceValue)) return [];
    return [
      {
        row,
        observation: observationByRowKey([], row),
        dimension: null,
        currency: knownCurrency(row.currency),
        priceValue,
        grossLineAmount: gross,
        amountBasis: trustedAmountBasisForRow(row, cache),
      },
    ];
  }).map((candidate) => ({
    ...candidate,
    observation:
      observationsByKey.get(rowObservationKey(candidate.row)) ??
      candidate.observation,
  }));
}

function buildSkuStructuralCohort(
  rows: readonly ProductPriceHistoryRow[],
  cache: ReceiptEvidenceCache
): StructuralCandidate[] {
  return rows.flatMap((row) => {
    const structural = evaluateStructuralGates(row, cache);
    if (!structural.pass) return [];
    const gross = resolveGrossLineAmount(row);
    const qty = row.purchaseQuantity;
    if (!positiveFinite(gross) || !positiveFinite(qty)) return [];
    const priceValue = gross / qty;
    if (!positiveFinite(priceValue)) return [];
    return [
      {
        row,
        priceValue,
        grossLineAmount: gross,
        amountBasis: trustedAmountBasisForRow(row, cache),
        currency: knownCurrency(row.currency),
        dimension: null,
      },
    ];
  });
}

function buildSpecStructuralCohort(
  rows: readonly ProductPriceHistoryRow[],
  cache: ReceiptEvidenceCache,
  target: ProductDetailTarget
): StructuralCandidate[] {
  const requiredFamilyDimension =
    target.type === 'family' ? FAMILY_PRICE_DIMENSIONS[target.key] : null;

  return rows.flatMap((row) => {
    const structural = evaluateStructuralGates(row, cache);
    if (!structural.pass) return [];
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
    const gross = resolveGrossLineAmount(row);
    if (priceValue == null || !positiveFinite(gross)) return [];
    return [
      {
        row,
        priceValue,
        grossLineAmount: gross,
        amountBasis: trustedAmountBasisForRow(row, cache),
        currency: knownCurrency(row.currency),
        dimension,
      },
    ];
  });
}

export function buildObservations(
  rows: readonly ProductPriceHistoryRow[],
  cache: ReceiptEvidenceCache
): ProductPriceHistoryObservation[] {
  const structuralCohort = buildSkuStructuralCohort(rows, cache);
  return buildObservationsAndStructuralCohort(rows, cache, structuralCohort)
    .observations;
}

export function buildProductPriceHistory(
  target: ProductDetailTarget,
  rows: ProductPriceHistoryRow[],
  options: BuildProductPriceHistoryOptions = {}
): ProductPriceHistoryResult {
  const cache = options.receiptEvidenceCache ?? buildReceiptEvidenceCache(rows);
  const canonicalDuplicateSelectionApplied =
    options.canonicalDuplicateSelectionApplied === true;
  const identityByRowKey = buildRowIdentityMetadataByKey(rows);
  const totalOccurrenceCount = rows.length;

  if (target.type === 'occurrence') {
    const observations = buildObservations(rows, cache);
    return emptyResult(
      target,
      'not_enough_points',
      totalOccurrenceCount,
      observations,
      null,
      canonicalDuplicateSelectionApplied
    );
  }

  if (target.type === 'sku') {
    return buildExactPurchaseUnitPriceHistory(
      target,
      rows,
      identityByRowKey,
      options
    );
  }

  if (
    target.type === 'family' &&
    UNSUPPORTED_PRICE_FAMILIES.has(target.key)
  ) {
    const observations = buildObservations(rows, cache);
    return emptyResult(
      target,
      'unsupported_family',
      totalOccurrenceCount,
      observations,
      null,
      canonicalDuplicateSelectionApplied
    );
  }

  const requiredFamilyDimension =
    target.type === 'family' ? FAMILY_PRICE_DIMENSIONS[target.key] : null;
  if (target.type === 'family' && !requiredFamilyDimension) {
    const observations = buildObservations(rows, cache);
    return emptyResult(
      target,
      'unsupported_family',
      totalOccurrenceCount,
      observations,
      null,
      canonicalDuplicateSelectionApplied
    );
  }

  const structuralCohort = buildSpecStructuralCohort(rows, cache, target);
  const { observations, observationsByKey } = buildObservationsAndStructuralCohort(
    rows,
    cache,
    structuralCohort
  );
  const specCandidates = structuralToComparableCandidates(
    structuralCohort,
    observationsByKey
  );
  const candidates = comparableCandidatesFromStructural(
    structuralCohort,
    cache,
    observationsByKey
  );

  const dimensionSet = new Set(
    specCandidates
      .map((candidate) => candidate.dimension)
      .filter((dimension): dimension is PriceDimension => dimension != null)
  );
  if (dimensionSet.size > 1) {
    return emptyResult(
      target,
      'ambiguous_dimension',
      totalOccurrenceCount,
      observations,
      null,
      canonicalDuplicateSelectionApplied
    );
  }
  if (specCandidates.length === 0) {
    return emptyResult(
      target,
      'no_comparable_spec',
      totalOccurrenceCount,
      observations,
      null,
      canonicalDuplicateSelectionApplied
    );
  }

  const dimension = [...dimensionSet][0]!;
  return finalizeCandidates(
    target,
    totalOccurrenceCount,
    priceKindForDimension(dimension),
    candidates,
    observations,
    identityByRowKey,
    specCandidates,
    canonicalDuplicateSelectionApplied
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
  if (target.type === 'merchant_product') {
    return { sql: '1 = 1', params: [] };
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

const PRICE_HISTORY_SELECT_SQL = `
  SELECT
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
    receipt_items.count_base AS countBase,
    receipt_items.sku_key AS skuKey,
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
    receipts.analysis_json AS receiptAnalysisJson,
    receipts.user_items_json AS receiptUserItemsJson,
    COALESCE(receipts.user_edited, 0) AS receiptUserEdited,
    receipts.total AS receiptTotal,
    receipts.final_total AS receiptFinalTotal,
    receipts.tax AS receiptTax,
    COALESCE(receipts.tax_is_known, 0) AS receiptTaxIsKnown,
    receipts.currency AS receiptCurrency
  FROM receipt_items
  INNER JOIN receipts ON receipts.id = receipt_items.receipt_id`;

function applyIdentityG3Gates(
  target: ProductDetailTarget,
  filtered: ProductPriceHistoryRow[],
  identityView: {
    merchantProductId: string;
    merchantKey: string;
    trendInsightEligible: boolean;
    stats: { qualityExcludedCount: number };
    targetMembershipRowKeys: Array<{
      receiptId: string;
      itemSourceIndex: number;
    }>;
    historyPoints: Array<{
      receiptId: string;
      itemSourceIndex: number;
      occurredAt: number;
      rawName: string;
      purchaseUnitPrice: number;
    }>;
  },
  cache: ReceiptEvidenceCache,
  identityByRowKey: Map<string, RowIdentityMetadata>,
  canonicalDuplicateSelectionApplied: boolean
): ProductPriceHistoryResult {
  const targetScopedRows =
    target.type === 'merchant_product'
      ? filterRowsByMembershipKeys(
          filtered,
          membershipRowKeysToSet(identityView.targetMembershipRowKeys)
        )
      : filtered;

  const identityRows = identityView.historyPoints.flatMap((point) => {
    const src =
      filtered.find(
        (row) =>
          row.receiptId === point.receiptId &&
          row.sourceIndex === point.itemSourceIndex
      ) ?? null;
    return src ? [src] : [];
  });

  const { observations, observationsByKey } = buildObservationsForRows(
    targetScopedRows,
    cache
  );
  const totalOccurrenceCount =
    target.type === 'merchant_product'
      ? targetScopedRows.length
      : filtered.length;

  const structuralCohort = buildSkuStructuralCohort(identityRows, cache);

  const pointCurrencies = identityRows.map((row) => knownCurrency(row.currency));
  const currencyGate = gateIdentityHistoryCurrencies(pointCurrencies);
  if (currencyGate.status !== 'ok') {
    return {
      target,
      status: currencyGate.status,
      priceKind: 'purchase_unit',
      currency: null,
      totalOccurrenceCount,
      comparableOccurrenceCount: 0,
      excludedOccurrenceCount: totalOccurrenceCount,
      points: [],
      observations,
      seriesKind: null,
      amountBasis: null,
      canonicalDuplicateSelectionApplied,
      identityPresentation: null,
    };
  }

  const candidates = comparableCandidatesFromStructural(
    structuralCohort,
    cache,
    observationsByKey
  ).map((candidate) => ({
    ...candidate,
    currency: currencyGate.currency,
  }));

  const basisGate = evaluateAmountBasisSeriesGate(candidates);
  if (basisGate.mixedBasis) {
    const observationsWithBasisMismatch = observations.map((observation) =>
      observation.level2Eligible
        ? {
            ...observation,
            level2Eligible: false,
            level2RejectReasons: [
              ...observation.level2RejectReasons,
              'amount_basis_mismatch',
            ],
          }
        : observation
    );
    return {
      target,
      status: 'not_enough_points',
      priceKind: 'purchase_unit',
      currency: currencyGate.currency,
      totalOccurrenceCount,
      comparableOccurrenceCount: 0,
      excludedOccurrenceCount: totalOccurrenceCount,
      points: [],
      observations: observationsWithBasisMismatch,
      seriesKind: null,
      amountBasis: null,
      canonicalDuplicateSelectionApplied,
      identityPresentation: null,
    };
  }

  const points = candidates
    .map((candidate) =>
      buildHistoryPoint(
        candidate,
        'purchase_unit',
        currencyGate.currency,
        identityByRowKey,
        candidate.row.merchantNormalized ?? identityView.merchantKey
      )
    )
    .sort(
      (left, right) =>
        left.occurredAt - right.occurredAt ||
        left.receiptId.localeCompare(right.receiptId) ||
        left.sourceIndex - right.sourceIndex
    );

  return {
    target,
    status: points.length >= 2 ? 'ready' : 'not_enough_points',
    priceKind: 'purchase_unit',
    currency: currencyGate.currency,
    totalOccurrenceCount,
    comparableOccurrenceCount: points.length,
    excludedOccurrenceCount: Math.max(0, totalOccurrenceCount - points.length),
    points,
    observations,
    seriesKind: points.length > 0 ? 'gross' : null,
    amountBasis: points.length >= 2 ? basisGate.amountBasis : null,
    canonicalDuplicateSelectionApplied,
    identityPresentation: {
      strategy: 'same_merchant_product',
      titleKey: 'priceHistory.titleMerchantLocal',
      subtitleKey: 'priceHistory.subtitle.merchantProduct',
      trendInsightEligible: identityView.trendInsightEligible,
      qualityExcludedCount: identityView.stats.qualityExcludedCount,
      merchantProductId: identityView.merchantProductId,
    },
  };
}

async function loadPersonalProductPriceHistoryWithDb(
  db: ProductPriceHistoryDatabase,
  target: Extract<ProductDetailTarget, { type: 'personal_product' }>,
  options: BuildProductPriceHistoryOptions = {}
): Promise<ProductPriceHistoryResult> {
  const resolveResult =
    options.personalProductContext &&
    (await import('./personalProductTargetResolver')).assertPersonalProductContextMatchesTarget(
      target,
      options.personalProductContext
    )
      ? { status: 'ready' as const, resolved: options.personalProductContext }
      : await (
          await import('./personalProductTargetResolver')
        ).resolvePersonalProductTargetWithDb(target.key, db as never);

  if (resolveResult.status !== 'ready') {
    return failClosedPersonalProductPriceResult(target);
  }

  const resolved = resolveResult.resolved;
  const predicates = buildOwnerScopedInventoryPredicates(resolved.ownerKey);
  if (!predicates) {
    return failClosedPersonalProductPriceResult(target);
  }

  const rows = await db.getAllAsync<ProductPriceHistoryRow>(
    `${PRICE_HISTORY_SELECT_SQL}
     WHERE ${predicates.itemWhereSql}
     ORDER BY
       COALESCE(receipts.transaction_at, receipts.created_at) ASC,
       receipt_items.receipt_id ASC,
       receipt_items.source_index ASC`,
    predicates.params
  );

  const selection = selectAuthorizedPersonalProductPriceRows(resolved, rows);
  if (!selection.ok) {
    return failClosedPersonalProductPriceResult(target);
  }

  const filtered = selection.rows;
  const cache = buildReceiptEvidenceCache(filtered);
  const identityByRowKey = buildPersonalInventoryRowIdentityMetadataByKey(
    resolved,
    filtered
  );
  const canonicalTarget = resolved.canonicalTarget;
  const result = buildExactPurchaseUnitPriceHistory(
    canonicalTarget,
    filtered,
    identityByRowKey,
    {
      receiptEvidenceCache: cache,
      canonicalDuplicateSelectionApplied: true,
    }
  );

  if (filtered.length === 0) {
    return {
      ...result,
      target: canonicalTarget,
      personalProductPriceAuthority: null,
    };
  }

  return {
    ...result,
    target: canonicalTarget,
    personalProductPriceAuthority: buildPersonalProductPriceAuthority(
      resolved,
      filtered
    ),
  };
}

export async function loadProductPriceHistoryWithDb(
  db: ProductPriceHistoryDatabase,
  target: ProductDetailTarget,
  options: BuildProductPriceHistoryOptions & {
    excludedReceiptIds?: ReadonlySet<string>;
  } = {}
): Promise<ProductPriceHistoryResult> {
  if (target.type === 'occurrence') {
    return buildProductPriceHistory(target, []);
  }
  if (target.type === 'personal_product') {
    return loadPersonalProductPriceHistoryWithDb(db, target, options);
  }

  const canonicalDuplicateSelectionApplied = options.excludedReceiptIds !== undefined;
  const ownerScope = await resolveCurrentLocalReceiptOwnerScope();
  if (ownerScope.status !== 'ready') {
    if (target.type === 'merchant_product') {
      return failClosedRequestedMerchantProductTargetResult(
        target,
        [],
        new Map(),
        canonicalDuplicateSelectionApplied
      );
    }
    return buildProductPriceHistory(target, [], {
      canonicalDuplicateSelectionApplied,
    });
  }

  const filter = filterForTarget(target);
  const { whereSql, whereParams } = composeOwnerScopedItemHistoryWhere(
    ownerScope,
    { sql: filter.sql, params: filter.params.map(String) }
  );
  const rows = await db.getAllAsync<ProductPriceHistoryRow>(
    `${PRICE_HISTORY_SELECT_SQL}
     WHERE ${whereSql}
     ORDER BY
       COALESCE(receipts.transaction_at, receipts.created_at) ASC,
       receipt_items.receipt_id ASC,
       receipt_items.source_index ASC`,
    whereParams
  );
  const excluded = options.excludedReceiptIds;
  const filtered =
    excluded && excluded.size > 0
      ? rows.filter((row) => !excluded.has(row.receiptId))
      : rows;
  const cache = buildReceiptEvidenceCache(filtered);
  const identityByRowKey = buildRowIdentityMetadataByKey(filtered);

  try {
    const { isProductIdentityPriceHistoryV1Enabled } = await import('./env');
    if (isProductIdentityPriceHistoryV1Enabled()) {
      const { tryBuildIdentityPriceHistoryForRows } = await import(
        './productIdentityConsumer'
      );
      const preferredMpId =
        target.type === 'merchant_product' ? target.key : null;
      const identityView = tryBuildIdentityPriceHistoryForRows(
        filtered,
        preferredMpId
      );
      if (identityView) {
        if (
          target.type === 'merchant_product' &&
          identityView.merchantProductId !== target.key
        ) {
          return failClosedRequestedMerchantProductTargetResult(
            target,
            filtered,
            cache,
            canonicalDuplicateSelectionApplied
          );
        }
        return applyIdentityG3Gates(
          target,
          filtered,
          identityView,
          cache,
          identityByRowKey,
          canonicalDuplicateSelectionApplied
        );
      }
      if (target.type === 'merchant_product') {
        return failClosedRequestedMerchantProductTargetResult(
          target,
          filtered,
          cache,
          canonicalDuplicateSelectionApplied
        );
      }
    }
  } catch {
    if (target.type === 'merchant_product') {
      return failClosedRequestedMerchantProductTargetResult(
        target,
        filtered,
        cache,
        canonicalDuplicateSelectionApplied
      );
    }
  }

  if (target.type === 'merchant_product') {
    return failClosedRequestedMerchantProductTargetResult(
      target,
      filtered,
      cache,
      canonicalDuplicateSelectionApplied
    );
  }

  return buildProductPriceHistory(target, filtered, {
    receiptEvidenceCache: cache,
    canonicalDuplicateSelectionApplied,
  });
}

export async function loadProductPriceHistory(
  target: ProductDetailTarget,
  options: BuildProductPriceHistoryOptions & {
    excludedReceiptIds?: ReadonlySet<string>;
  } = {}
): Promise<ProductPriceHistoryResult> {
  const db = await getProductPriceHistoryDb();
  return loadProductPriceHistoryWithDb(db, target, options);
}
