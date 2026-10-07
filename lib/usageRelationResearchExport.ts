/**
 * Usage Relation Research Export V1.
 *
 * Read-only research dataset: which merchandise observations were present in
 * each canonical physical purchase basket, according to current production
 * purchase truth and Product Identity.
 *
 * co-purchase is not co-consumption. This module does not score relations,
 * recommend products, or write purchase truth.
 */

import { buildCanonicalPurchaseOccurrenceIndex } from './canonicalPurchaseOccurrence';
import type { ReceiptRow } from './db';
import {
  classifyMerchantScopeGeneration,
  resolveReceiptMerchantScope,
} from './merchantScopeGeneration';
import { createProductIdentityNormalizePassCache } from './normalizeProductForIdentity';
import {
  buildPersonalProductEndpointInventory,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventoryDatabase,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import {
  PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
  type StoredPersonalProductIdentityDecision,
} from './personalProductIdentityContract';
import { resolvePersonalProductTargetFromInventory } from './personalProductTargetResolver';
import { PRODUCT_IDENTITY_RESOLVER_VERSION } from './productIdentityContract';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import { logger } from './logger';
import { classifyLineKind } from './receiptOcrNormalize';
import {
  type LocalReceiptOwnerScope,
  type LocalReceiptOwnerScopeReady,
} from './receiptOwnershipScope';
import { getReceiptItems } from './receiptItems';
import { verifiedPurchaseOccurrenceColumnsSql } from './receiptVerifiedPurchaseOccurrenceSelect';

export const USAGE_RELATION_RESEARCH_EXPORT_NAME =
  'Usage Relation Research Export' as const;

export const USAGE_RELATION_RESEARCH_SCHEMA_VERSION = 1 as const;

export const USAGE_RELATION_RESEARCH_PRIVACY_WARNING =
  'This research export contains merchant names and purchased product names from your local receipt history. It does not include receipt images, account IDs, or cloud credentials. It is not anonymous. Share only with trusted recipients.';

const TRUSTED_CANONICAL_SOURCES = new Set([
  'user_confirmed',
  'merchant_alias',
  'dictionary',
  'high_confidence_rule',
]);

const TIME_PRECISIONS = new Set(['second', 'minute', 'date', 'unknown']);

const FORBIDDEN_EXPORT_KEYS = new Set([
  'image_uri',
  'recognition_snapshot_json',
  'analysis_json',
  'user_items_json',
  'user_id',
  'installation_id',
  'ocr_request_id',
  'note',
  'access_token',
  'refresh_token',
  'apikey',
  'api_key',
  'authorization',
  'supabase',
]);

export class UsageRelationResearchExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageRelationResearchExportError';
  }
}

/** Account/session changed between capture and file write. Nothing was written. */
export class UsageRelationResearchOwnerChangedError extends UsageRelationResearchExportError {
  constructor() {
    super(
      'The account changed during export. The research file was not written.'
    );
    this.name = 'UsageRelationResearchOwnerChangedError';
  }
}

export type UsageRelationIdentityKind =
  | 'personal_product'
  | 'merchant_product'
  | 'sku'
  | 'canonical'
  | 'occurrence';

export type UsageRelationBestAvailableIdentity = {
  kind: UsageRelationIdentityKind;
  key: string;
  source: string;
  confidence: number | null;
  pipelineVersion: string;
};

export type UsageRelationPersistedIdentity = {
  source: string | null;
  confidence: number | null;
  version: number | null;
};

/**
 * Where the persisted identity bundle came from. The bundle is atomic:
 * reviewed_item uses only fields on the reviewed item, reconciled_index uses
 * only the proven receipt_items row, and neither fills gaps from the other.
 * personalProduct is attached only for reconciled_index.
 * unavailable: no authoritative persisted identity. Resolver output is not persisted truth.
 */
export type UsageRelationPersistedIdentityOrigin =
  | 'reviewed_item'
  | 'reconciled_index'
  | 'unavailable';

export type UsageRelationPersonalProductRef = {
  key: string;
} | null;

export type UsageRelationResearchItem = {
  receiptId: string;
  sourceIndex: number;
  reviewSourceIndex: number | null;
  rawName: string | null;
  normalizedName: string | null;
  normalizedFullName: string | null;
  canonicalProductName: string | null;
  brand: string | null;
  productFamilyKey: string | null;
  category: string | null;
  skuKey: string | null;
  purchaseQuantity: number | null;
  itemSource: string;
  persistedIdentity: UsageRelationPersistedIdentity;
  persistedIdentityOrigin: UsageRelationPersistedIdentityOrigin;
  personalProduct: UsageRelationPersonalProductRef;
  bestAvailableIdentity: UsageRelationBestAvailableIdentity;
};

export type UsageRelationResearchPurchase = {
  canonicalOccurrenceKey: string;
  representativeReceiptId: string;
  receiptIds: string[];
  verifiedPurchaseOccurrenceId: string | null;
  verifiedPurchaseOccurrenceSource: string | null;
  verifiedPurchaseOccurrenceVerifiedAt: number | null;
  createdAt: number;
  transactionAt: number | null;
  transactionTimePrecision: 'second' | 'minute' | 'date' | 'unknown';
  merchantRaw: string | null;
  merchantNormalized: string | null;
  merchantType: string | null;
  storeRaw: string | null;
  storeNormalized: string | null;
  merchantScopeGeneration: 2 | null;
  userEdited: boolean;
  items: UsageRelationResearchItem[];
};

export type UsageRelationIdentityKindCounts = Record<
  UsageRelationIdentityKind,
  number
>;

export type UsageRelationPersistedIdentityOriginCounts = Record<
  UsageRelationPersistedIdentityOrigin,
  number
>;

export type UsageRelationResearchDatasetSummary = {
  storedReceiptCount: number;
  canonicalPurchaseCount: number;
  merchandiseObservationCount: number;
  trustedIdentityObservationCount: number;
  fallbackIdentityObservationCount: number;
  identityKindCounts: UsageRelationIdentityKindCounts;
  persistedIdentityOriginCounts: UsageRelationPersistedIdentityOriginCounts;
};

export type UsageRelationResearchExport = {
  schemaVersion: typeof USAGE_RELATION_RESEARCH_SCHEMA_VERSION;
  exportedAt: string;
  app: {
    version: string | null;
    build: string | null;
  };
  identityPipelineVersion: typeof PRODUCT_IDENTITY_RESOLVER_VERSION;
  /**
   * ready: personal-product inventory loaded.
   * unavailable: inventory could not be resolved; item.personalProduct stays null.
   * Owner scope failure fails the export instead of using this status.
   */
  personalProductResolution: 'ready' | 'unavailable';
  privacyWarning: string;
  datasetSummary: UsageRelationResearchDatasetSummary;
  purchases: UsageRelationResearchPurchase[];
};

export type UsageRelationResearchItemIndexRow = {
  receipt_id: string;
  source_index: number;
  review_source_index?: number | null;
  raw_name?: string | null;
  normalized_name?: string | null;
  normalized_full_name?: string | null;
  canonical_product_name?: string | null;
  brand?: string | null;
  product_family_key?: string | null;
  category?: string | null;
  sku_key?: string | null;
  purchase_quantity?: number | null;
  item_source?: string | null;
  identity_source?: string | null;
  identity_confidence?: number | null;
  identity_version?: number | null;
  /** Classification only. Not serialized. */
  line_total?: number | null;
};

export type UsageRelationPersonalProductHit = {
  key: string;
  source: string;
  confidence: number | null;
};

type ResearchDatabase = PersonalProductEndpointInventoryDatabase;

export type BuildUsageRelationResearchExportInput = {
  receipts: readonly ReceiptRow[];
  itemIndexRows?: readonly UsageRelationResearchItemIndexRow[];
  exportedAt: string;
  app?: { version?: string | null; build?: string | null };
  /**
   * null: personal-product resolution unavailable.
   * Map: production authorized personal products keyed by receiptId:sourceIndex.
   */
  personalProductByRowKey?: ReadonlyMap<string, UsageRelationPersonalProductHit> | null;
};

function emptyKindCounts(): UsageRelationIdentityKindCounts {
  return {
    personal_product: 0,
    merchant_product: 0,
    sku: 0,
    canonical: 0,
    occurrence: 0,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function precisionOf(
  value: string | null | undefined
): 'second' | 'minute' | 'date' | 'unknown' {
  if (value && TIME_PRECISIONS.has(value)) {
    return value as 'second' | 'minute' | 'date' | 'unknown';
  }
  return 'unknown';
}

function rowKey(receiptId: string, sourceIndex: number): string {
  return `${receiptId}:${sourceIndex}`;
}

function occurrenceIdentityKey(receiptId: string, sourceIndex: number): string {
  return `${receiptId}:${sourceIndex}`;
}

export function authorizedPersonalProductByRowKey(
  inventory: PersonalProductEndpointInventory
): Map<string, UsageRelationPersonalProductHit> {
  const hits = new Map<string, UsageRelationPersonalProductHit>();
  const seenAnchors = new Set<string>();
  const merchantProductIds = [...inventory.merchantProductsById.keys()].sort();
  for (const merchantProductId of merchantProductIds) {
    const resolved = resolvePersonalProductTargetFromInventory(
      merchantProductId,
      inventory
    );
    if (resolved.status !== 'ready') continue;
    const anchor = resolved.resolved.canonicalTarget.key;
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    const hit: UsageRelationPersonalProductHit = {
      key: anchor,
      source: 'personal_manual',
      confidence: null,
    };
    for (const authorizedKey of resolved.resolved.authorizedRowKeys) {
      hits.set(authorizedKey, hit);
    }
  }
  return hits;
}

function indexByRow(
  rows: readonly UsageRelationResearchItemIndexRow[]
): Map<string, UsageRelationResearchItemIndexRow> {
  const map = new Map<string, UsageRelationResearchItemIndexRow>();
  for (const row of rows) {
    map.set(rowKey(row.receipt_id, row.source_index), row);
  }
  return map;
}

function reviewedLine(item: Record<string, unknown>): {
  rawName: string | null;
  quantity: number | null;
  lineTotal: number;
  itemSource: string | null;
} {
  const rawName =
    trimmedOrNull(item.name) ??
    trimmedOrNull(item.raw_name) ??
    trimmedOrNull(item.normalized_full_name);
  const quantity = finiteOrNull(item.quantity);
  const lineTotal =
    finiteOrNull(item.lineTotal) ??
    finiteOrNull(item.line_total) ??
    finiteOrNull(item.effectiveLineTotal) ??
    0;
  const itemSource =
    trimmedOrNull(item.item_source) ?? trimmedOrNull(item.source);
  return { rawName, quantity, lineTotal, itemSource };
}

const EMPTY_PERSISTED_IDENTITY: UsageRelationPersistedIdentity = {
  source: null,
  confidence: null,
  version: null,
};

/**
 * Valid review provenance index. Same integer contract as
 * personalProductReturnTarget's persisted source index: non-negative integer.
 * Array position alone is not provenance.
 */
function validReviewSourceIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function persistedIdentityOf(
  row: UsageRelationResearchItemIndexRow | undefined
): UsageRelationPersistedIdentity {
  if (!row) return { ...EMPTY_PERSISTED_IDENTITY };
  return {
    source: trimmedOrNull(row.identity_source),
    confidence: finiteOrNull(row.identity_confidence),
    version: finiteOrNull(row.identity_version),
  };
}

type ReviewedPersistedIdentity = {
  persisted: UsageRelationPersistedIdentity;
  normalizedName: string | null;
  normalizedFullName: string | null;
  canonicalProductName: string | null;
  brand: string | null;
  productFamilyKey: string | null;
  category: string | null;
  skuKey: string | null;
};

/**
 * Identity carried by the reviewed Source-of-Truth item itself.
 * Production index projection treats identity_version === 1 as persisted.
 */
function reviewedItemPersistedIdentity(
  item: Record<string, unknown>
): ReviewedPersistedIdentity | null {
  if (finiteOrNull(item.identity_version) !== 1) return null;
  return {
    persisted: {
      source: trimmedOrNull(item.identity_source),
      confidence: finiteOrNull(item.identity_confidence),
      version: 1,
    },
    normalizedName: trimmedOrNull(item.normalized_name),
    normalizedFullName: trimmedOrNull(item.normalized_full_name),
    canonicalProductName: trimmedOrNull(item.canonical_product_name),
    brand: trimmedOrNull(item.brand),
    productFamilyKey: trimmedOrNull(item.product_family_key),
    category: trimmedOrNull(item.category),
    skuKey: trimmedOrNull(item.sku_key) ?? trimmedOrNull(item.skuKey),
  };
}

/**
 * Attach a receipt_items row only when review_source_index proves it is this
 * reviewed item. Matching receiptId + current array index is not proof.
 * Duplicate provenance on either side fails closed.
 */
function reconcileIndexRow(
  receiptId: string,
  reviewed: readonly (Record<string, unknown> | null)[],
  reviewedIndex: number,
  indexRows: readonly UsageRelationResearchItemIndexRow[]
): UsageRelationResearchItemIndexRow | null {
  const reviewSource = validReviewSourceIndex(
    reviewed[reviewedIndex]?.review_source_index
  );
  if (reviewSource == null) return null;

  let reviewedCount = 0;
  for (const item of reviewed) {
    if (!item) continue;
    if (validReviewSourceIndex(item.review_source_index) === reviewSource) {
      reviewedCount += 1;
    }
  }
  if (reviewedCount !== 1) return null;

  const matches = indexRows.filter(
    (row) =>
      row.receipt_id === receiptId &&
      validReviewSourceIndex(row.review_source_index) === reviewSource
  );
  if (matches.length !== 1) return null;
  return matches[0]!;
}

function exportedMerchantScopeGeneration(receipt: ReceiptRow): 2 | null {
  const presence =
    receipt.merchant_scope_generation === undefined ? 'absent' : 'present';
  const classified = classifyMerchantScopeGeneration(
    receipt.merchant_scope_generation,
    presence
  );
  return classified.state === 'v2' ? 2 : null;
}

function bestAvailableIdentity(input: {
  receiptId: string;
  sourceIndex: number;
  rawName: string;
  merchantKey: string;
  purchaseQuantity: number | null;
  lineTotal: number;
  skuKey: string | null;
  canonicalProductName: string | null;
  persisted: UsageRelationPersistedIdentity;
  personal: UsageRelationPersonalProductHit | null;
  store: ReturnType<typeof createMemoryProductIdentityStore>;
  normalizePassCache: ReturnType<typeof createProductIdentityNormalizePassCache>;
}): UsageRelationBestAvailableIdentity {
  if (input.personal) {
    return {
      kind: 'personal_product',
      key: input.personal.key,
      source: input.personal.source,
      confidence: finiteOrNull(input.personal.confidence),
      pipelineVersion: PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
    };
  }

  const resolved = resolveReceiptItemIdentity(
    {
      rawName: input.rawName,
      merchantKey: input.merchantKey,
      receiptId: input.receiptId,
      itemSourceIndex: input.sourceIndex,
      quantity: input.purchaseQuantity,
      lineTotal: input.lineTotal,
    },
    input.store,
    { normalizePassCache: input.normalizePassCache }
  );
  if (
    resolved.link.identityLevel === 'merchant_product' &&
    resolved.link.merchantProductId
  ) {
    return {
      kind: 'merchant_product',
      key: resolved.link.merchantProductId,
      source: String(resolved.link.identitySource),
      confidence: finiteOrNull(resolved.link.identityConfidence),
      pipelineVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    };
  }

  if (input.skuKey) {
    return {
      kind: 'sku',
      key: input.skuKey,
      source: input.persisted.source ?? 'unresolved',
      confidence: input.persisted.confidence,
      pipelineVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    };
  }

  const persistedSource = input.persisted.source;
  if (
    input.canonicalProductName &&
    persistedSource &&
    TRUSTED_CANONICAL_SOURCES.has(persistedSource)
  ) {
    return {
      kind: 'canonical',
      key: input.canonicalProductName,
      source: persistedSource,
      confidence: input.persisted.confidence,
      pipelineVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    };
  }

  return {
    kind: 'occurrence',
    key: occurrenceIdentityKey(input.receiptId, input.sourceIndex),
    source: 'unresolved',
    confidence: null,
    pipelineVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
  };
}

function projectItems(input: {
  receipt: ReceiptRow;
  index: Map<string, UsageRelationResearchItemIndexRow>;
  personalByRow: ReadonlyMap<string, UsageRelationPersonalProductHit> | null;
  store: ReturnType<typeof createMemoryProductIdentityStore>;
  normalizePassCache: ReturnType<typeof createProductIdentityNormalizePassCache>;
}): UsageRelationResearchItem[] {
  const merchantScope = resolveReceiptMerchantScope({
    receiptId: input.receipt.id,
    merchantRaw: input.receipt.merchant_raw,
    merchantNormalized: input.receipt.merchant_normalized,
    merchantScopeGeneration: input.receipt.merchant_scope_generation,
    merchantScopeGenerationPresence:
      input.receipt.merchant_scope_generation === undefined ? 'absent' : 'present',
  });
  const reviewedSlots = getReceiptItems(input.receipt).map((item) => asRecord(item));
  const receiptIndexRows = [...input.index.values()].filter(
    (row) => row.receipt_id === input.receipt.id
  );
  const items: UsageRelationResearchItem[] = [];
  for (let sourceIndex = 0; sourceIndex < reviewedSlots.length; sourceIndex++) {
    const record = reviewedSlots[sourceIndex];
    if (!record) continue;
    const line = reviewedLine(record);
    if (classifyLineKind(line.rawName ?? '', line.lineTotal) !== 'item') continue;
    const reviewedIdentity = reviewedItemPersistedIdentity(record);
    const reconciled = reconcileIndexRow(
      input.receipt.id,
      reviewedSlots,
      sourceIndex,
      receiptIndexRows
    );
    const origin: UsageRelationPersistedIdentityOrigin = reviewedIdentity
      ? 'reviewed_item'
      : reconciled
        ? 'reconciled_index'
        : 'unavailable';
    const bundle =
      origin === 'reviewed_item' && reviewedIdentity
        ? {
            persisted: reviewedIdentity.persisted,
            normalizedName: reviewedIdentity.normalizedName,
            normalizedFullName: reviewedIdentity.normalizedFullName,
            canonicalProductName: reviewedIdentity.canonicalProductName,
            brand: reviewedIdentity.brand,
            productFamilyKey: reviewedIdentity.productFamilyKey,
            category: reviewedIdentity.category,
            skuKey: reviewedIdentity.skuKey,
          }
        : origin === 'reconciled_index' && reconciled
          ? {
              persisted: persistedIdentityOf(reconciled),
              normalizedName: trimmedOrNull(reconciled.normalized_name),
              normalizedFullName: trimmedOrNull(reconciled.normalized_full_name),
              canonicalProductName: trimmedOrNull(reconciled.canonical_product_name),
              brand: trimmedOrNull(reconciled.brand),
              productFamilyKey: trimmedOrNull(reconciled.product_family_key),
              category: trimmedOrNull(reconciled.category),
              skuKey: trimmedOrNull(reconciled.sku_key),
            }
          : {
              persisted: { ...EMPTY_PERSISTED_IDENTITY },
              normalizedName: null,
              normalizedFullName: null,
              canonicalProductName: null,
              brand: null,
              productFamilyKey: null,
              category: null,
              skuKey: null,
            };
    const reviewedQuantity =
      line.quantity != null && line.quantity > 0 ? line.quantity : null;
    const purchaseQuantity =
      reviewedQuantity ??
      (origin === 'reconciled_index' && reconciled
        ? finiteOrNull(reconciled.purchase_quantity)
        : null);
    const personal =
      origin === 'reconciled_index' && reconciled
        ? input.personalByRow?.get(
            rowKey(input.receipt.id, reconciled.source_index)
          ) ?? null
        : null;
    const identity = bestAvailableIdentity({
      receiptId: input.receipt.id,
      sourceIndex,
      rawName: line.rawName ?? '',
      merchantKey: merchantScope.scopeKey,
      purchaseQuantity,
      lineTotal: line.lineTotal,
      skuKey: bundle.skuKey,
      canonicalProductName: bundle.canonicalProductName,
      persisted: bundle.persisted,
      personal,
      store: input.store,
      normalizePassCache: input.normalizePassCache,
    });
    items.push({
      receiptId: input.receipt.id,
      sourceIndex,
      reviewSourceIndex: validReviewSourceIndex(record.review_source_index),
      rawName: line.rawName,
      normalizedName: bundle.normalizedName,
      normalizedFullName: bundle.normalizedFullName,
      canonicalProductName: bundle.canonicalProductName,
      brand: bundle.brand,
      productFamilyKey: bundle.productFamilyKey,
      category: bundle.category,
      skuKey: bundle.skuKey,
      purchaseQuantity,
      itemSource:
        line.itemSource ??
        (origin === 'reconciled_index' && reconciled
          ? trimmedOrNull(reconciled.item_source)
          : null) ??
        'unknown',
      persistedIdentity: bundle.persisted,
      persistedIdentityOrigin: origin,
      personalProduct: personal ? { key: personal.key } : null,
      bestAvailableIdentity: identity,
    });
  }
  items.sort((left, right) => left.sourceIndex - right.sourceIndex);
  return items;
}

function verifiedBundle(
  groupVerifiedId: string | null,
  members: readonly ReceiptRow[],
  representativeId: string
): {
  id: string | null;
  source: string | null;
  verifiedAt: number | null;
} {
  if (!groupVerifiedId) {
    return { id: null, source: null, verifiedAt: null };
  }
  const carriers = members.filter(
    (receipt) => receipt.verified_purchase_occurrence_id === groupVerifiedId
  );
  const chosen =
    carriers.find((receipt) => receipt.id === representativeId) ??
    [...carriers].sort((left, right) => left.id.localeCompare(right.id))[0];
  return {
    id: groupVerifiedId,
    source: trimmedOrNull(chosen?.verified_purchase_occurrence_source),
    verifiedAt: finiteOrNull(chosen?.verified_purchase_occurrence_verified_at),
  };
}

function purchaseSortMs(receipt: ReceiptRow): number {
  const transactionAt = finiteOrNull(receipt.transaction_at);
  if (transactionAt != null) return transactionAt;
  const createdAt = finiteOrNull(receipt.created_at);
  return createdAt ?? Number.MAX_SAFE_INTEGER;
}

export function buildUsageRelationResearchExport(
  input: BuildUsageRelationResearchExportInput
): UsageRelationResearchExport {
  const receiptsById = new Map<string, ReceiptRow>();
  for (const receipt of input.receipts) {
    receiptsById.set(receipt.id, receipt);
  }
  const occurrence = buildCanonicalPurchaseOccurrenceIndex([...receiptsById.values()]);
  const index = indexByRow(input.itemIndexRows ?? []);
  const personalByRow = input.personalProductByRowKey ?? null;
  const store = createMemoryProductIdentityStore();
  const normalizePassCache = createProductIdentityNormalizePassCache();
  const kindCounts = emptyKindCounts();
  const purchases: UsageRelationResearchPurchase[] = [];

  for (const group of occurrence.groups) {
    const representative = receiptsById.get(group.representativeReceiptId);
    if (!representative) {
      throw new UsageRelationResearchExportError(
        'Canonical purchase representative is missing from the owner receipt set.'
      );
    }
    const createdAt = finiteOrNull(representative.created_at);
    if (createdAt == null) {
      throw new UsageRelationResearchExportError(
        'Canonical purchase is missing a finite createdAt.'
      );
    }
    const members = group.receiptIds
      .map((id) => receiptsById.get(id))
      .filter((receipt): receipt is ReceiptRow => receipt != null);
    const verified = verifiedBundle(
      group.verifiedPurchaseOccurrenceId ?? null,
      members,
      representative.id
    );
    const items = projectItems({
      receipt: representative,
      index,
      personalByRow,
      store,
      normalizePassCache,
    });
    for (const item of items) {
      kindCounts[item.bestAvailableIdentity.kind] += 1;
    }
    purchases.push({
      canonicalOccurrenceKey: group.occurrenceKey,
      representativeReceiptId: representative.id,
      receiptIds: [...group.receiptIds].sort((left, right) =>
        left.localeCompare(right)
      ),
      verifiedPurchaseOccurrenceId: verified.id,
      verifiedPurchaseOccurrenceSource: verified.source,
      verifiedPurchaseOccurrenceVerifiedAt: verified.verifiedAt,
      createdAt,
      transactionAt: finiteOrNull(representative.transaction_at),
      transactionTimePrecision: precisionOf(
        representative.transaction_time_precision
      ),
      merchantRaw: trimmedOrNull(representative.merchant_raw),
      merchantNormalized: trimmedOrNull(representative.merchant_normalized),
      merchantType: trimmedOrNull(representative.merchant_type),
      storeRaw: trimmedOrNull(representative.store_raw),
      storeNormalized: trimmedOrNull(representative.store_normalized),
      merchantScopeGeneration: exportedMerchantScopeGeneration(representative),
      userEdited: representative.user_edited === 1,
      items,
    });
  }

  purchases.sort((left, right) => {
    const leftReceipt = receiptsById.get(left.representativeReceiptId);
    const rightReceipt = receiptsById.get(right.representativeReceiptId);
    const leftMs = leftReceipt ? purchaseSortMs(leftReceipt) : Number.MAX_SAFE_INTEGER;
    const rightMs = rightReceipt ? purchaseSortMs(rightReceipt) : Number.MAX_SAFE_INTEGER;
    if (leftMs !== rightMs) return leftMs - rightMs;
    return left.canonicalOccurrenceKey.localeCompare(right.canonicalOccurrenceKey);
  });

  let merchandiseObservationCount = 0;
  const persistedIdentityOriginCounts: UsageRelationPersistedIdentityOriginCounts =
    {
      reviewed_item: 0,
      reconciled_index: 0,
      unavailable: 0,
    };
  for (const purchase of purchases) {
    merchandiseObservationCount += purchase.items.length;
    for (const item of purchase.items) {
      persistedIdentityOriginCounts[item.persistedIdentityOrigin] += 1;
    }
  }
  const fallbackIdentityObservationCount = kindCounts.occurrence;
  const trustedIdentityObservationCount =
    merchandiseObservationCount - fallbackIdentityObservationCount;

  const doc: UsageRelationResearchExport = {
    schemaVersion: USAGE_RELATION_RESEARCH_SCHEMA_VERSION,
    exportedAt: input.exportedAt,
    app: {
      version: input.app?.version ?? null,
      build: input.app?.build ?? null,
    },
    identityPipelineVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    personalProductResolution: personalByRow ? 'ready' : 'unavailable',
    privacyWarning: USAGE_RELATION_RESEARCH_PRIVACY_WARNING,
    datasetSummary: {
      storedReceiptCount: receiptsById.size,
      canonicalPurchaseCount: purchases.length,
      merchandiseObservationCount,
      trustedIdentityObservationCount,
      fallbackIdentityObservationCount,
      identityKindCounts: kindCounts,
      persistedIdentityOriginCounts,
    },
    purchases,
  };
  assertUsageRelationResearchFiniteNumbers(doc);
  assertUsageRelationResearchPrivacy(doc);
  return doc;
}

export function assertUsageRelationResearchFiniteNumbers(value: unknown): void {
  const seen = new Set<unknown>();
  const visit = (current: unknown): void => {
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new UsageRelationResearchExportError(
          'Research export contains a non-finite number.'
        );
      }
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    for (const entry of Object.values(current)) visit(entry);
  };
  visit(value);
}

export function assertUsageRelationResearchPrivacy(value: unknown): void {
  const seen = new Set<unknown>();
  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object') return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (FORBIDDEN_EXPORT_KEYS.has(key)) {
        throw new UsageRelationResearchExportError(
          'Research export contains a forbidden privacy field.'
        );
      }
      visit(entry);
    }
  };
  visit(value);
}

export function serializeUsageRelationResearchExport(
  doc: UsageRelationResearchExport
): string {
  assertUsageRelationResearchFiniteNumbers(doc);
  assertUsageRelationResearchPrivacy(doc);
  const json = JSON.stringify(doc, null, 2);
  if (!Number.isFinite(JSON.parse(json).schemaVersion)) {
    throw new UsageRelationResearchExportError(
      'Research export JSON is not finite.'
    );
  }
  for (const key of FORBIDDEN_EXPORT_KEYS) {
    if (json.includes(`"${key}"`)) {
      throw new UsageRelationResearchExportError(
        'Research export JSON contains a forbidden privacy field.'
      );
    }
  }
  return json;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function buildUsageRelationResearchFilename(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `meruno-usage-relation-research-${stamp}.json`;
}

export function formatUsageRelationResearchExportSummary(
  doc: UsageRelationResearchExport
): string {
  return `canonical purchases: ${doc.datasetSummary.canonicalPurchaseCount}\nmerchandise observations: ${doc.datasetSummary.merchandiseObservationCount}`;
}

const RESEARCH_RECEIPT_COLUMNS = `
  id, created_at, transaction_at,
  COALESCE(transaction_time_precision, 'unknown') as transaction_time_precision,
  merchant_raw, merchant_normalized, merchant_type,
  store_raw, store_normalized,
  merchant_scope_generation,
  total, tax, COALESCE(tax_is_known, 0) as tax_is_known, currency,
  analysis_json, user_items_json,
  COALESCE(user_edited, 0) as user_edited,
  ${verifiedPurchaseOccurrenceColumnsSql()}
`;

const RESEARCH_ITEM_COLUMNS = `
  receipt_items.receipt_id,
  receipt_items.source_index,
  receipt_items.review_source_index,
  receipt_items.raw_name,
  receipt_items.normalized_name,
  receipt_items.normalized_full_name,
  receipt_items.canonical_product_name,
  receipt_items.brand,
  receipt_items.product_family_key,
  receipt_items.category,
  receipt_items.sku_key,
  receipt_items.purchase_quantity,
  receipt_items.item_source,
  receipt_items.identity_source,
  receipt_items.identity_confidence,
  receipt_items.identity_version,
  receipt_items.line_total
`;

const PERSONAL_DECISION_TABLE = 'personal_product_identity_decisions';

const PERSONAL_DECISION_SELECT_SQL = `
  SELECT
    owner_key,
    left_merchant_product_id,
    right_merchant_product_id,
    left_merchant_scope_key,
    right_merchant_scope_key,
    left_comparison_key,
    right_comparison_key,
    left_structural_signature,
    right_structural_signature,
    identity_pipeline_version,
    decision,
    created_at,
    updated_at
  FROM personal_product_identity_decisions
  WHERE owner_key = ?
`;

type PersonalDecisionSqlRow = {
  owner_key: string;
  left_merchant_product_id: string;
  right_merchant_product_id: string;
  left_merchant_scope_key: string;
  right_merchant_scope_key: string;
  left_comparison_key: string;
  right_comparison_key: string;
  left_structural_signature: string;
  right_structural_signature: string;
  identity_pipeline_version: string;
  decision: StoredPersonalProductIdentityDecision['decision'];
  created_at: number;
  updated_at: number;
};

export type CapturedOwnerPersonalInventory =
  | { status: 'unavailable' }
  | { status: 'ready'; inventory: PersonalProductEndpointInventory };

function decisionFromSqlRow(
  row: PersonalDecisionSqlRow,
  ownerKey: string
): StoredPersonalProductIdentityDecision | null {
  if (row.owner_key !== ownerKey) return null;
  return {
    ownerKey,
    leftMerchantProductId: row.left_merchant_product_id,
    rightMerchantProductId: row.right_merchant_product_id,
    leftMerchantScopeKey: row.left_merchant_scope_key,
    rightMerchantScopeKey: row.right_merchant_scope_key,
    leftComparisonKey: row.left_comparison_key,
    rightComparisonKey: row.right_comparison_key,
    leftStructuralSignature: row.left_structural_signature,
    rightStructuralSignature: row.right_structural_signature,
    identityPipelineVersion: row.identity_pipeline_version,
    decision: row.decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * SELECT-only personal decisions for one already captured owner.
 * Missing table → unavailable. Does not create schema.
 */
export async function loadPersonalProductDecisionsForCapturedOwner(
  db: ResearchDatabase,
  ownerKey: string
): Promise<StoredPersonalProductIdentityDecision[] | null> {
  let tables: { name?: string }[] = [];
  try {
    tables = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [PERSONAL_DECISION_TABLE]
    );
  } catch {
    return null;
  }
  if (!tables?.some((row) => row?.name === PERSONAL_DECISION_TABLE)) return null;
  try {
    const rows = await db.getAllAsync<PersonalDecisionSqlRow>(
      PERSONAL_DECISION_SELECT_SQL,
      [ownerKey]
    );
    const decisions: StoredPersonalProductIdentityDecision[] = [];
    for (const row of rows ?? []) {
      const decision = decisionFromSqlRow(row, ownerKey);
      if (decision) decisions.push(decision);
    }
    return decisions;
  } catch {
    return null;
  }
}

function inventorySourceRows(
  receipts: readonly ReceiptRow[],
  itemIndexRows: readonly UsageRelationResearchItemIndexRow[]
): PersonalProductEndpointInventorySourceRow[] {
  const receiptsById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  return itemIndexRows.flatMap((row) => {
    const receipt = receiptsById.get(row.receipt_id);
    if (!receipt) return [];
    const occurredAt =
      finiteOrNull(receipt.transaction_at) ?? finiteOrNull(receipt.created_at) ?? 0;
    return [
      {
        receiptId: row.receipt_id,
        itemId: `${row.receipt_id}:${row.source_index}`,
        sourceIndex: row.source_index,
        occurredAt,
        merchantRaw: receipt.merchant_raw,
        merchantNormalized: receipt.merchant_normalized,
        merchantScopeGeneration: receipt.merchant_scope_generation,
        displayName:
          trimmedOrNull(row.normalized_full_name) ??
          trimmedOrNull(row.raw_name) ??
          trimmedOrNull(row.canonical_product_name) ??
          trimmedOrNull(row.normalized_name) ??
          '',
        rawName: trimmedOrNull(row.raw_name) ?? '',
        lineTotal: finiteOrNull(row.line_total),
        purchaseQuantity: finiteOrNull(row.purchase_quantity),
        skuKey: trimmedOrNull(row.sku_key),
        brand: trimmedOrNull(row.brand),
      },
    ];
  });
}

async function loadCapturedOwnerPersonalInventory(
  db: ResearchDatabase,
  ownerKey: string,
  receipts: readonly ReceiptRow[],
  itemIndexRows: readonly UsageRelationResearchItemIndexRow[]
): Promise<CapturedOwnerPersonalInventory> {
  const decisions = await loadPersonalProductDecisionsForCapturedOwner(db, ownerKey);
  if (!decisions) return { status: 'unavailable' };
  const built = buildPersonalProductEndpointInventory({
    ownerKey,
    sourceRows: inventorySourceRows(receipts, itemIndexRows),
    receipts,
    decisionRows: decisions,
  });
  if (built.status !== 'ready') return { status: 'unavailable' };
  if (built.inventory.ownerKey !== ownerKey) {
    throw new UsageRelationResearchExportError(
      'Personal product inventory owner does not match the captured owner. Research export failed closed.'
    );
  }
  return built;
}

function assertOwnerScopeReady(
  scope: LocalReceiptOwnerScope
): LocalReceiptOwnerScopeReady {
  if (scope.status !== 'ready') {
    throw new UsageRelationResearchExportError(
      'Current owner scope is unavailable. Research export failed closed.'
    );
  }
  if (!scope.receiptWhereSql.includes('?') || scope.params.length === 0) {
    throw new UsageRelationResearchExportError(
      'Current owner scope is unavailable. Research export failed closed.'
    );
  }
  return scope;
}

export type BuildUsageRelationResearchExportFromLocalDbDeps = {
  db?: ResearchDatabase;
  resolveOwnerScope?: () => Promise<LocalReceiptOwnerScope>;
  loadPersonalInventory?: (
    db: ResearchDatabase,
    ownerKey: string,
    receipts: readonly ReceiptRow[],
    itemIndexRows: readonly UsageRelationResearchItemIndexRow[]
  ) => Promise<CapturedOwnerPersonalInventory>;
  now?: Date;
  app?: { version?: string | null; build?: string | null };
};

async function defaultObservationalOwnerScope(): Promise<LocalReceiptOwnerScope> {
  const { resolveObservationalReceiptOwnerScope } = await import(
    './observationalReceiptOwnerScope'
  );
  return resolveObservationalReceiptOwnerScope();
}

export async function buildUsageRelationResearchExportFromLocalDb(
  deps: BuildUsageRelationResearchExportFromLocalDbDeps = {}
): Promise<UsageRelationResearchExport> {
  const db =
    deps.db ??
    (await import('./db')).getInitializedReceiptsDatabaseOrThrow();
  const resolveScope = deps.resolveOwnerScope ?? defaultObservationalOwnerScope;
  const scope = assertOwnerScopeReady(await resolveScope());
  const receipts = await db.getAllAsync<ReceiptRow>(
    `
    SELECT
      ${RESEARCH_RECEIPT_COLUMNS}
    FROM receipts
    WHERE ${scope.receiptWhereSql}
    `,
    scope.params
  );
  const itemIndexRows = await db.getAllAsync<UsageRelationResearchItemIndexRow>(
    `
    SELECT
      ${RESEARCH_ITEM_COLUMNS}
    FROM receipt_items
    INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
    WHERE ${scope.itemWhereSql}
    `,
    scope.params
  );
  const loadInventory =
    deps.loadPersonalInventory ?? loadCapturedOwnerPersonalInventory;
  const inventory = await loadInventory(
    db,
    scope.ownerKey,
    receipts ?? [],
    itemIndexRows ?? []
  );
  if (inventory.status === 'ready' && inventory.inventory.ownerKey !== scope.ownerKey) {
    throw new UsageRelationResearchExportError(
      'Personal product inventory owner does not match the captured owner. Research export failed closed.'
    );
  }
  const personalProductByRowKey =
    inventory.status === 'ready'
      ? authorizedPersonalProductByRowKey(inventory.inventory)
      : null;
  return buildUsageRelationResearchExport({
    receipts: receipts ?? [],
    itemIndexRows: itemIndexRows ?? [],
    exportedAt: (deps.now ?? new Date()).toISOString(),
    app: deps.app,
    personalProductByRowKey,
  });
}

export type WriteUsageRelationResearchFileDeps = {
  doc: UsageRelationResearchExport;
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  nowMs?: number;
};

export async function writeUsageRelationResearchFile(
  deps: WriteUsageRelationResearchFileDeps
): Promise<{ fileUri: string; filename: string; json: string }> {
  if (!deps.cacheDirectory) {
    throw new UsageRelationResearchExportError(
      'Cache directory unavailable. Cannot export Usage Relation Research Data.'
    );
  }
  const filename = buildUsageRelationResearchFilename(deps.nowMs ?? Date.now());
  const json = serializeUsageRelationResearchExport(deps.doc);
  const fileUri = `${deps.cacheDirectory}${filename}`;
  await deps.writeAsStringAsync(fileUri, json);
  return { fileUri, filename, json };
}

export type ShareUsageRelationResearchFileDeps = {
  fileUri: string;
  filename: string;
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (
    url: string,
    options?: { mimeType?: string; UTI?: string; dialogTitle?: string }
  ) => Promise<void>;
};

export async function shareUsageRelationResearchFile(
  deps: ShareUsageRelationResearchFileDeps
): Promise<void> {
  const available = await deps.isAvailableAsync();
  if (!available) {
    throw new UsageRelationResearchExportError(
      'Native file sharing is unavailable. Cannot export Usage Relation Research Data as a file.'
    );
  }
  await deps.shareAsync(deps.fileUri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: deps.filename,
  });
}

async function ownerMatchesCaptured(
  resolveScope: () => Promise<LocalReceiptOwnerScope>,
  capturedOwnerKey: string | null
): Promise<boolean> {
  if (!capturedOwnerKey) return false;
  const scope = await resolveScope();
  return scope.status === 'ready' && scope.ownerKey === capturedOwnerKey;
}

async function discardUnsharedResearchFile(
  deleteAsync: ((fileUri: string) => Promise<void>) | undefined,
  fileUri: string
): Promise<void> {
  if (!deleteAsync) {
    logger.warn(
      'UsageRelationResearchExport',
      'Stale research cache file was not deleted because no delete function was provided.'
    );
    return;
  }
  try {
    await deleteAsync(fileUri);
  } catch (cleanupError) {
    logger.warn(
      'UsageRelationResearchExport',
      'Failed to delete the unshared research cache file after the owner changed.',
      cleanupError
    );
  }
}

export async function exportAndShareUsageRelationResearchData(deps: {
  db?: ResearchDatabase;
  resolveOwnerScope?: () => Promise<LocalReceiptOwnerScope>;
  loadPersonalInventory?: BuildUsageRelationResearchExportFromLocalDbDeps['loadPersonalInventory'];
  now?: Date;
  app?: { version?: string | null; build?: string | null };
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  deleteAsync?: (fileUri: string) => Promise<void>;
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: ShareUsageRelationResearchFileDeps['shareAsync'];
}): Promise<{
  doc: UsageRelationResearchExport;
  filename: string;
  fileUri: string;
}> {
  const resolveScope = deps.resolveOwnerScope ?? defaultObservationalOwnerScope;
  let capturedOwnerKey: string | null = null;
  const doc = await buildUsageRelationResearchExportFromLocalDb({
    ...deps,
    resolveOwnerScope: async () => {
      const scope = await resolveScope();
      if (scope.status === 'ready' && capturedOwnerKey == null) {
        capturedOwnerKey = scope.ownerKey;
      }
      return scope;
    },
  });
  if (!deps.cacheDirectory) {
    throw new UsageRelationResearchExportError(
      'Cache directory unavailable. Cannot export Usage Relation Research Data.'
    );
  }
  const filename = buildUsageRelationResearchFilename(deps.now?.getTime());
  const fileUri = `${deps.cacheDirectory}${filename}`;
  const json = serializeUsageRelationResearchExport(doc);
  if (!(await ownerMatchesCaptured(resolveScope, capturedOwnerKey))) {
    throw new UsageRelationResearchOwnerChangedError();
  }
  await deps.writeAsStringAsync(fileUri, json);
  const available = await deps.isAvailableAsync();
  if (!available) {
    throw new UsageRelationResearchExportError(
      'Native file sharing is unavailable. Cannot export Usage Relation Research Data as a file.'
    );
  }
  // Final owner check. shareAsync is the next operation; do not await anything else first.
  if (!(await ownerMatchesCaptured(resolveScope, capturedOwnerKey))) {
    await discardUnsharedResearchFile(deps.deleteAsync, fileUri);
    throw new UsageRelationResearchOwnerChangedError();
  }
  await deps.shareAsync(fileUri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: filename,
  });
  return { doc, filename, fileUri };
}
