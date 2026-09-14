/**
 * G4-2A — owner-scoped exhaustive Product Identity endpoint inventory.
 *
 * Single authoritative construction path for personal identity snapshot + endpoints.
 */

import type * as SQLite from 'expo-sqlite';

import type { HighConfidenceDuplicateReceiptGroupMembership } from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';
import {
  buildPersonalMerchantProductEndpointV1,
  collectOwnerGraphMerchantProductIds,
  resolvePersonalProductIdentityOwnerKey,
  type PersonalMerchantProductEndpointV1,
  type PersonalProductCurrentEndpointSnapshot,
  type StoredPersonalProductIdentityDecision,
} from './personalProductIdentityContract';
import type { PersonalProductIdentityDatabase } from './personalProductIdentityRepository';
import {
  emptyProductAttributes,
  type ProductAttributes,
  type ProductIdentityLevel,
} from './productIdentityContract';
import {
  isUnknownMerchantScopeKey,
  resolveReceiptItemIdentity,
  scopeMerchantKeyForIdentity,
} from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  type MerchantProductRecord,
  type ProductIdentityStore,
} from './productIdentityStore';
import { classifyLineKind } from './receiptOcrNormalize';
import type { LocalOwnershipStamp } from './receiptOwnershipContext';
import {
  buildOwnerScopedInventoryPredicates,
} from './receiptOwnershipScope';
import {
  buildPersonalProductInventoryCacheKey,
  clearPersonalProductInventoryInFlight,
  currentPersonalProductInventoryCacheKeyParts,
  getPersonalProductInventoryInFlight,
  logPersonalProductInventoryPerf,
  readPersonalProductEndpointInventoryCache,
  setPersonalProductInventoryInFlight,
  writePersonalProductEndpointInventoryCache,
} from './personalProductEndpointInventoryCache';

export { buildOwnerScopedInventoryPredicates } from './receiptOwnershipScope';
export {
  invalidatePersonalProductEndpointInventory,
  __resetPersonalProductEndpointInventoryCacheForTests,
  getPersonalProductInventoryDataGeneration,
  getPersonalProductInventoryFullBuildCount,
} from './personalProductEndpointInventoryCache';

const PERSONAL_IDENTITY_STRUCTURAL_DIMENSIONS = [
  'volume',
  'mass',
  'count',
  'pack_count',
  'roll_count',
  'length',
  'total_volume',
  'size',
  'color',
  'model',
  'battery_size',
  'ply',
  'connector',
] as const;

export function hasMeaningfulPersonalIdentityStructuralEvidence(
  attributes: ProductAttributes | null | undefined
): boolean {
  if (!attributes?.entries?.length) return false;
  return attributes.entries.some((entry) => {
    if (
      !(PERSONAL_IDENTITY_STRUCTURAL_DIMENSIONS as readonly string[]).includes(
        entry.dimension
      )
    ) {
      return false;
    }
    if (entry.value == null) return false;
    if (typeof entry.value === 'string') return entry.value.trim().length > 0;
    return Number.isFinite(entry.value);
  });
}

export function buildPersonalProductInventoryRowKey(
  receiptId: string,
  sourceIndex: number
): string {
  return `${receiptId}:${sourceIndex}`;
}

export type PersonalProductInventoryItem = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  occurredAt: number;
  merchantProductId: string;
  identityLevel: ProductIdentityLevel;
  displayName: string;
  merchantName: string;
  rawName: string;
  merchantScopeKey: string;
  skuKey: string | null;
  brand: string | null;
  attributes: ProductAttributes | null;
  specificationLabel?: string | null;
};

export type PersonalProductEndpointInventory = {
  ownerKey: string;
  snapshot: PersonalProductCurrentEndpointSnapshot;
  endpointsById: ReadonlyMap<string, PersonalMerchantProductEndpointV1>;
  merchantProductsById: ReadonlyMap<string, MerchantProductRecord>;
  itemsByRowKey: ReadonlyMap<string, PersonalProductInventoryItem>;
  itemKeysByMerchantProductId: ReadonlyMap<string, readonly string[]>;
  receiptsById: ReadonlyMap<string, ReceiptRow>;
  excludedDuplicateReceiptIds: ReadonlySet<string>;
  highConfidenceDuplicateGroupByReceiptId: ReadonlyMap<
    string,
    HighConfidenceDuplicateReceiptGroupMembership
  >;
  decisionRows: readonly StoredPersonalProductIdentityDecision[];
};

export type PersonalProductEndpointInventoryLoadResult =
  | {
      status: 'ready';
      inventory: PersonalProductEndpointInventory;
    }
  | {
      status: 'owner_unavailable';
    }
  | {
      status: 'current_endpoint_context_incomplete';
      reason: string;
      missingMerchantProductIds?: string[];
    };

export type PersonalProductEndpointInventoryDatabase = {
  getAllAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T[]>;
};

export type PersonalProductEndpointInventorySourceRow = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  occurredAt: number;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  displayName: string;
  rawName: string;
  lineTotal: number | null;
  purchaseQuantity: number | null;
  skuKey: string | null;
  brand: string | null;
};

const INVENTORY_ITEM_SELECT_SQL = `
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
    COALESCE(receipt_items.raw_name, '') AS rawName,
    receipt_items.line_total AS lineTotal,
    receipt_items.purchase_quantity AS purchaseQuantity,
    receipt_items.sku_key AS skuKey,
    receipt_items.brand AS brand
  FROM receipt_items
  INNER JOIN receipts ON receipts.id = receipt_items.receipt_id`;

const OWNER_RECEIPT_SELECT_SQL = `
  SELECT
    receipts.id AS id,
    receipts.created_at AS created_at,
    receipts.transaction_at AS transaction_at,
    receipts.merchant_raw AS merchant_raw,
    receipts.merchant_normalized AS merchant_normalized,
    receipts.merchant_type AS merchant_type,
    receipts.total AS total,
    receipts.tax AS tax,
    COALESCE(receipts.tax_is_known, 0) AS tax_is_known,
    receipts.currency AS currency,
    receipts.analysis_json AS analysis_json,
    receipts.final_total AS final_total,
    receipts.user_items_json AS user_items_json,
    receipts.user_id AS user_id,
    receipts.installation_id AS installation_id,
    receipts.transaction_source AS transaction_source,
    receipts.image_uri AS image_uri,
    receipts.user_edited AS user_edited,
    receipts.note AS note
  FROM receipts`;

function isProductInventoryRow(row: PersonalProductEndpointInventorySourceRow): boolean {
  const name = (row.rawName || row.displayName || '').trim();
  if (!name) return false;
  const kind = classifyLineKind(name, Number(row.lineTotal) || 0);
  return kind === 'item';
}

function endpointFromMerchantProductRecord(
  record: MerchantProductRecord
): PersonalMerchantProductEndpointV1 {
  return buildPersonalMerchantProductEndpointV1({
    merchantProductId: record.id,
    merchantScopeKey: record.merchantKey,
    comparisonKey: record.comparisonKey,
    attributes: record.attributes,
  });
}

function formatSpecificationLabel(
  attributes: ProductAttributes | null | undefined
): string | null {
  if (!attributes?.entries?.length) return null;
  const parts: string[] = [];
  for (const entry of attributes.entries) {
    if (
      entry.dimension === 'volume' ||
      entry.dimension === 'mass' ||
      entry.dimension === 'count' ||
      entry.dimension === 'pack_count'
    ) {
      parts.push(`${entry.value}${entry.unit ?? ''}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

export type BuildPersonalProductEndpointInventoryInput = {
  ownerKey: string;
  sourceRows: readonly PersonalProductEndpointInventorySourceRow[];
  receipts: readonly ReceiptRow[];
  decisionRows: readonly StoredPersonalProductIdentityDecision[];
  store?: ProductIdentityStore;
  excludedDuplicateReceiptIds?: ReadonlySet<string>;
  highConfidenceDuplicateGroupByReceiptId?: ReadonlyMap<
    string,
    HighConfidenceDuplicateReceiptGroupMembership
  >;
  /** Called once per row that runs resolveReceiptItemIdentity (perf / tests). */
  onIdentityResolve?: () => void;
};

export function buildPersonalProductEndpointInventory(
  input: BuildPersonalProductEndpointInventoryInput
): PersonalProductEndpointInventoryLoadResult {
  const store = input.store ?? createMemoryProductIdentityStore();
  const sortedRows = [...input.sourceRows].sort(
    (left, right) =>
      left.occurredAt - right.occurredAt ||
      left.receiptId.localeCompare(right.receiptId) ||
      left.sourceIndex - right.sourceIndex
  );

  const itemsByRowKey = new Map<string, PersonalProductInventoryItem>();
  const itemKeysByMerchantProductId = new Map<string, string[]>();
  const merchantProductsById = new Map<string, MerchantProductRecord>();
  const endpointsById = new Map<string, PersonalMerchantProductEndpointV1>();

  for (const row of sortedRows) {
    if (!isProductInventoryRow(row)) continue;
    const rowKey = buildPersonalProductInventoryRowKey(row.receiptId, row.sourceIndex);
    if (itemsByRowKey.has(rowKey)) continue;

    const merchantEvidence = row.merchantNormalized ?? row.merchantRaw ?? '';
    const merchantScopeKey = scopeMerchantKeyForIdentity(
      merchantEvidence,
      row.receiptId
    );
    const resolved = resolveReceiptItemIdentity(
      {
        rawName: row.displayName || row.rawName,
        merchantKey: merchantEvidence,
        receiptId: row.receiptId,
        itemSourceIndex: row.sourceIndex,
        quantity: row.purchaseQuantity,
        lineTotal: row.lineTotal,
      },
      store
    );
    input.onIdentityResolve?.();

    const merchantProductId = resolved.link.merchantProductId;
    if (!merchantProductId) continue;

    const record = store.getMerchantProduct(merchantProductId);
    if (!record) {
      return {
        status: 'current_endpoint_context_incomplete',
        reason: 'resolver_selected_merchant_product_missing',
        missingMerchantProductIds: [merchantProductId],
      };
    }

    merchantProductsById.set(record.id, record);
    endpointsById.set(record.id, endpointFromMerchantProductRecord(record));

    const item: PersonalProductInventoryItem = {
      receiptId: row.receiptId,
      itemId: row.itemId,
      sourceIndex: row.sourceIndex,
      occurredAt: row.occurredAt,
      merchantProductId: record.id,
      identityLevel: resolved.link.identityLevel,
      displayName: row.displayName || row.rawName,
      merchantName:
        (row.merchantRaw && row.merchantRaw.trim()) ||
        (row.merchantNormalized && row.merchantNormalized.trim()) ||
        '',
      rawName: row.rawName,
      merchantScopeKey,
      skuKey: row.skuKey?.trim() || null,
      brand: row.brand?.trim() || null,
      attributes: record.attributes ?? emptyProductAttributes(),
      specificationLabel: formatSpecificationLabel(record.attributes),
    };
    itemsByRowKey.set(rowKey, item);
    const keys = itemKeysByMerchantProductId.get(record.id) ?? [];
    keys.push(rowKey);
    itemKeysByMerchantProductId.set(record.id, keys);
  }

  const receiptsById = new Map(input.receipts.map((receipt) => [receipt.id, receipt]));
  const excludedDuplicateReceiptIds =
    input.excludedDuplicateReceiptIds ?? new Set<string>();
  const highConfidenceDuplicateGroupByReceiptId =
    input.highConfidenceDuplicateGroupByReceiptId ?? new Map();

  const requiredGraphIds = collectOwnerGraphMerchantProductIds(input.decisionRows);
  const snapshot = new Map<string, PersonalMerchantProductEndpointV1 | null>();

  for (const [id, endpoint] of endpointsById.entries()) {
    snapshot.set(id, endpoint);
  }

  for (const id of requiredGraphIds) {
    if (!snapshot.has(id)) {
      snapshot.set(id, null);
    }
  }

  const missing = requiredGraphIds.filter((id) => !snapshot.has(id));
  if (missing.length > 0) {
    return {
      status: 'current_endpoint_context_incomplete',
      reason: 'snapshot_missing_required_graph_ids',
      missingMerchantProductIds: missing,
    };
  }

  const itemKeysByMp = new Map<string, readonly string[]>();
  for (const [mpId, keys] of itemKeysByMerchantProductId.entries()) {
    itemKeysByMp.set(mpId, [...keys]);
  }

  return {
    status: 'ready',
    inventory: {
      ownerKey: input.ownerKey,
      snapshot,
      endpointsById,
      merchantProductsById,
      itemsByRowKey,
      itemKeysByMerchantProductId: itemKeysByMp,
      receiptsById,
      excludedDuplicateReceiptIds,
      highConfidenceDuplicateGroupByReceiptId,
      decisionRows: input.decisionRows,
    },
  };
}

export type LoadPersonalProductEndpointInventoryDeps = {
  resolveStamp?: () => Promise<LocalOwnershipStamp>;
  listDecisions?: (
    db: PersonalProductEndpointInventoryDatabase,
    ownerKey: string
  ) => Promise<StoredPersonalProductIdentityDecision[]>;
  createStore?: () => ProductIdentityStore;
  buildInventory?: (
    input: BuildPersonalProductEndpointInventoryInput
  ) => PersonalProductEndpointInventoryLoadResult;
  /**
   * Session cache is ON by default for production Home/History focus reuse.
   * Set false for isolated unit paths that must always hit DB/build.
   */
  useSessionCache?: boolean;
};

async function loadPersonalProductEndpointInventoryUncached(
  db: PersonalProductEndpointInventoryDatabase,
  ownerKey: string,
  deps: LoadPersonalProductEndpointInventoryDeps
): Promise<{
  result: PersonalProductEndpointInventoryLoadResult;
  rowCount: number;
  resolveCount: number;
}> {
  const predicates = buildOwnerScopedInventoryPredicates(ownerKey);
  if (!predicates) {
    return {
      result: { status: 'owner_unavailable' },
      rowCount: 0,
      resolveCount: 0,
    };
  }

  let sourceRows: PersonalProductEndpointInventorySourceRow[];
  let receipts: ReceiptRow[];
  try {
    sourceRows = await db.getAllAsync<PersonalProductEndpointInventorySourceRow>(
      `${INVENTORY_ITEM_SELECT_SQL}
       WHERE ${predicates.itemWhereSql}
       ORDER BY
         COALESCE(receipts.transaction_at, receipts.created_at) ASC,
         receipt_items.receipt_id ASC,
         receipt_items.source_index ASC`,
      predicates.params
    );
    receipts = await db.getAllAsync<ReceiptRow>(
      `${OWNER_RECEIPT_SELECT_SQL}
       WHERE ${predicates.receiptWhereSql}
       ORDER BY COALESCE(receipts.transaction_at, receipts.created_at) ASC, receipts.id ASC`,
      predicates.params
    );
  } catch {
    return {
      result: {
        status: 'current_endpoint_context_incomplete',
        reason: 'owner_inventory_query_failed',
      },
      rowCount: 0,
      resolveCount: 0,
    };
  }

  let decisionRows: StoredPersonalProductIdentityDecision[];
  try {
    const listDecisions =
      deps.listDecisions ??
      (async (database: PersonalProductEndpointInventoryDatabase, key: string) => {
        const { listPersonalProductIdentityDecisionsWithDb } = await import(
          './personalProductIdentityRepository'
        );
        return listPersonalProductIdentityDecisionsWithDb(
          database as PersonalProductIdentityDatabase,
          key
        );
      });
    decisionRows = await listDecisions(db, ownerKey);
  } catch {
    return {
      result: {
        status: 'current_endpoint_context_incomplete',
        reason: 'personal_decision_query_failed',
      },
      rowCount: sourceRows.length,
      resolveCount: 0,
    };
  }

  let excludedDuplicateReceiptIds: ReadonlySet<string> = new Set<string>();
  let highConfidenceDuplicateGroupByReceiptId: ReadonlyMap<
    string,
    HighConfidenceDuplicateReceiptGroupMembership
  > = new Map();
  try {
    const { indexHighConfidenceDuplicateGroupsByReceiptId } = await import(
      './analyticsReceiptSelection'
    );
    const { selectAnalyticsReceiptsCached } = await import(
      './analyticsReceiptSelectionCache'
    );
    const selection =
      selectAnalyticsReceiptsCached({
        ownerKey,
        receipts: [...receipts],
      }) ??
      (
        await import('./analyticsReceiptSelection')
      ).selectAnalyticsReceipts([...receipts]);
    excludedDuplicateReceiptIds = selection.excludedDuplicateReceiptIds;
    highConfidenceDuplicateGroupByReceiptId =
      indexHighConfidenceDuplicateGroupsByReceiptId(
        selection.highConfidenceDuplicateGroups
      );
  } catch {
    return {
      result: {
        status: 'current_endpoint_context_incomplete',
        reason: 'analytics_duplicate_selection_failed',
      },
      rowCount: sourceRows.length,
      resolveCount: 0,
    };
  }

  let resolveCount = 0;
  try {
    const buildInventory =
      deps.buildInventory ?? buildPersonalProductEndpointInventory;
    const result = buildInventory({
      ownerKey,
      sourceRows,
      receipts,
      decisionRows,
      store: deps.createStore?.(),
      excludedDuplicateReceiptIds,
      highConfidenceDuplicateGroupByReceiptId,
      onIdentityResolve: () => {
        resolveCount += 1;
      },
    });
    return { result, rowCount: sourceRows.length, resolveCount };
  } catch {
    return {
      result: {
        status: 'current_endpoint_context_incomplete',
        reason: 'inventory_construction_failed',
      },
      rowCount: sourceRows.length,
      resolveCount,
    };
  }
}

export async function loadPersonalProductEndpointInventoryWithDb(
  db: PersonalProductEndpointInventoryDatabase,
  stamp?: LocalOwnershipStamp,
  deps: LoadPersonalProductEndpointInventoryDeps = {}
): Promise<PersonalProductEndpointInventoryLoadResult> {
  const ownership = stamp
    ? stamp
    : deps.resolveStamp
      ? await deps.resolveStamp()
      : await (async () => {
          const { resolveOwnershipStamp } = await import('./receiptOwnershipContext');
          return resolveOwnershipStamp();
        })();
  const ownerKey = resolvePersonalProductIdentityOwnerKey(ownership);
  if (!ownerKey) {
    return { status: 'owner_unavailable' };
  }

  const useSessionCache = deps.useSessionCache !== false;
  if (!useSessionCache) {
    const { result } = await loadPersonalProductEndpointInventoryUncached(
      db,
      ownerKey,
      deps
    );
    return result;
  }

  const keyParts = currentPersonalProductInventoryCacheKeyParts(ownerKey);
  const cacheKey = buildPersonalProductInventoryCacheKey(keyParts);
  const started = Date.now();

  const cached = readPersonalProductEndpointInventoryCache(cacheKey);
  if (cached) {
    logPersonalProductInventoryPerf({
      cache: 'HIT',
      durationMs: Date.now() - started,
      generation: keyParts.dataGeneration,
    });
    return cached;
  }

  const existingInFlight = getPersonalProductInventoryInFlight(cacheKey);
  if (existingInFlight) {
    const joined = await existingInFlight;
    logPersonalProductInventoryPerf({
      cache: 'JOIN',
      durationMs: Date.now() - started,
      generation: keyParts.dataGeneration,
    });
    return joined;
  }

  const buildPromise = (async (): Promise<PersonalProductEndpointInventoryLoadResult> => {
    try {
      const { result, rowCount, resolveCount } =
        await loadPersonalProductEndpointInventoryUncached(db, ownerKey, deps);
      // Only cache successful ready inventories. Failures must not poison.
      if (result.status === 'ready') {
        // Re-read generation: invalidate during build must not write stale entry.
        const postParts = currentPersonalProductInventoryCacheKeyParts(ownerKey);
        const postKey = buildPersonalProductInventoryCacheKey(postParts);
        if (postKey === cacheKey) {
          writePersonalProductEndpointInventoryCache({
            key: postKey,
            ownerKey,
            dataGeneration: postParts.dataGeneration,
            resolverVersion: postParts.resolverVersion,
            pipelineVersion: postParts.pipelineVersion,
            result,
            rowCount,
            resolveCount,
          });
        }
      }
      logPersonalProductInventoryPerf({
        cache: 'MISS',
        durationMs: Date.now() - started,
        rows: rowCount,
        resolves: resolveCount,
        generation: keyParts.dataGeneration,
      });
      return result;
    } finally {
      clearPersonalProductInventoryInFlight(cacheKey);
    }
  })();

  setPersonalProductInventoryInFlight(cacheKey, buildPromise);
  return buildPromise;
}

export function inventoryItemHasUsableMerchantEndpoint(
  item: PersonalProductInventoryItem,
  inventory: PersonalProductEndpointInventory
): boolean {
  const endpoint = inventory.endpointsById.get(item.merchantProductId);
  if (!endpoint) return false;
  if (isUnknownMerchantScopeKey(endpoint.merchantScopeKey)) return false;
  if (
    item.identityLevel === 'family_spec' ||
    item.identityLevel === 'family_only' ||
    item.identityLevel === 'unresolved'
  ) {
    return false;
  }
  return true;
}
