/**
 * In-memory Product Identity entity store (Batch 3).
 * Derived / rebuildable — not receipt truth.
 */

import { nanoid } from 'nanoid/non-secure';

/** Stable MerchantProduct ids for consumer hrefs (no SQLite required). */
export function deterministicMerchantProductId(
  merchantKey: string,
  comparisonKey: string
): string {
  const raw = `${merchantKey}\0${comparisonKey}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  let hash2 = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    hash2 = (hash2 * 33) ^ raw.charCodeAt(i);
  }
  const hex2 = (hash2 >>> 0).toString(16).padStart(8, '0');
  return `mp_${hex}${hex2}`;
}

import {
  PRODUCT_IDENTITY_RESOLVER_VERSION,
  type CanonicalProduct,
  type ProductAttributes,
  type ProductIdentityLevel,
  type ReceiptItemIdentityLink,
} from './productIdentityContract';
import type { MerchantProductSemanticCache } from './productIdentitySemanticContract';
import type { SemanticStatus } from './productIdentitySemanticGate';

export type MerchantProductRecord = {
  id: string;
  merchantKey: string;
  comparisonKey: string;
  canonicalDisplayName: string | null;
  normalizedName: string | null;
  brand: string | null;
  attributes: ProductAttributes | null;
  createdAt: string;
  updatedAt: string;
  resolverVersion: string;
  /** Batch 4 — cached semantic enrichment (derived; not receipt SoT). */
  semanticStatus?: SemanticStatus | null;
  semanticJson?: MerchantProductSemanticCache | null;
  semanticConfidence?: number | null;
  semanticResolverVersion?: string | null;
};

export type ReceiptItemIdentityLinkRecord = ReceiptItemIdentityLink & {
  id: string;
  receiptId: string;
  itemSourceIndex: number;
  itemFingerprint: string;
  merchantKey: string;
  createdAt: string;
  updatedAt: string;
  stale: boolean;
};

export type UpsertMerchantProductInput = {
  id?: string;
  merchantKey: string;
  comparisonKey: string;
  canonicalDisplayName: string | null;
  normalizedName: string | null;
  brand: string | null;
  attributes: ProductAttributes | null;
  semanticStatus?: SemanticStatus | null;
  semanticJson?: MerchantProductSemanticCache | null;
  semanticConfidence?: number | null;
  semanticResolverVersion?: string | null;
};

export type ProductIdentityStore = {
  listMerchantProducts(merchantKey: string): MerchantProductRecord[];
  findMerchantProductByComparisonKey(
    merchantKey: string,
    comparisonKey: string
  ): MerchantProductRecord | null;
  upsertMerchantProduct(input: UpsertMerchantProductInput): MerchantProductRecord;
  /** Persist AI semantic cache on MerchantProduct (Batch 4). */
  saveMerchantProductSemantic(
    merchantProductId: string,
    cache: MerchantProductSemanticCache
  ): MerchantProductRecord | null;
  getCanonicalProduct(id: string): CanonicalProduct | null;
  upsertCanonicalProduct(
    input: Omit<CanonicalProduct, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ): CanonicalProduct;
  getLink(receiptId: string, itemSourceIndex: number): ReceiptItemIdentityLinkRecord | null;
  saveLink(
    input: Omit<
      ReceiptItemIdentityLinkRecord,
      'id' | 'createdAt' | 'updatedAt' | 'stale'
    > & { id?: string }
  ): ReceiptItemIdentityLinkRecord;
  markLinkStale(receiptId: string, itemSourceIndex: number): void;
  clearDerived(): void;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function createMemoryProductIdentityStore(): ProductIdentityStore {
  const merchants = new Map<string, MerchantProductRecord>();
  const merchantProductIdsByMerchant = new Map<string, string[]>();
  const merchantProductIdsByExactKey = new Map<
    string,
    Map<string, string[]>
  >();
  const merchantProductInsertionOrder = new Map<string, number>();
  let nextMerchantProductInsertionOrder = 0;
  const canonicals = new Map<string, CanonicalProduct>();
  const links = new Map<string, ReceiptItemIdentityLinkRecord>();
  const keyOf = (receiptId: string, idx: number) => `${receiptId}#${idx}`;

  const insertMerchantProductIdInOrder = (ids: string[], id: string) => {
    if (ids.includes(id)) return;
    const order = merchantProductInsertionOrder.get(id);
    if (order == null) return;
    const insertionIndex = ids.findIndex((candidateId) => {
      const candidateOrder = merchantProductInsertionOrder.get(candidateId);
      return candidateOrder != null && candidateOrder > order;
    });
    if (insertionIndex < 0) {
      ids.push(id);
    } else {
      ids.splice(insertionIndex, 0, id);
    }
  };

  const addMerchantProductToIndexes = (row: MerchantProductRecord) => {
    const merchantIds = merchantProductIdsByMerchant.get(row.merchantKey) ?? [];
    insertMerchantProductIdInOrder(merchantIds, row.id);
    merchantProductIdsByMerchant.set(row.merchantKey, merchantIds);

    if (!row.comparisonKey) return;
    const exactByComparisonKey =
      merchantProductIdsByExactKey.get(row.merchantKey) ?? new Map();
    const exactIds = exactByComparisonKey.get(row.comparisonKey) ?? [];
    insertMerchantProductIdInOrder(exactIds, row.id);
    exactByComparisonKey.set(row.comparisonKey, exactIds);
    merchantProductIdsByExactKey.set(row.merchantKey, exactByComparisonKey);
  };

  const removeMerchantProductFromIndexes = (row: MerchantProductRecord) => {
    const merchantIds = merchantProductIdsByMerchant.get(row.merchantKey);
    if (merchantIds) {
      const index = merchantIds.indexOf(row.id);
      if (index >= 0) merchantIds.splice(index, 1);
      if (merchantIds.length === 0) {
        merchantProductIdsByMerchant.delete(row.merchantKey);
      }
    }

    if (!row.comparisonKey) return;
    const exactByComparisonKey = merchantProductIdsByExactKey.get(
      row.merchantKey
    );
    const exactIds = exactByComparisonKey?.get(row.comparisonKey);
    if (exactIds) {
      const index = exactIds.indexOf(row.id);
      if (index >= 0) exactIds.splice(index, 1);
      if (exactIds.length === 0) {
        exactByComparisonKey?.delete(row.comparisonKey);
      }
      if (exactByComparisonKey?.size === 0) {
        merchantProductIdsByExactKey.delete(row.merchantKey);
      }
    }
  };

  const findMerchantProductByExactKey = (
    merchantKey: string,
    comparisonKey: string
  ): MerchantProductRecord | null => {
    if (!comparisonKey) return null;
    const firstId = merchantProductIdsByExactKey
      .get(merchantKey)
      ?.get(comparisonKey)?.[0];
    return firstId ? merchants.get(firstId) ?? null : null;
  };

  return {
    listMerchantProducts(merchantKey) {
      return (merchantProductIdsByMerchant.get(merchantKey) ?? [])
        .map((id) => merchants.get(id))
        .filter((row): row is MerchantProductRecord => row != null);
    },

    findMerchantProductByComparisonKey(merchantKey, comparisonKey) {
      return findMerchantProductByExactKey(merchantKey, comparisonKey);
    },

    upsertMerchantProduct(input) {
      const now = nowIso();
      const existingById = input.id ? merchants.get(input.id) : undefined;
      let existingByKey: MerchantProductRecord | undefined;
      if (!existingById && input.comparisonKey) {
        existingByKey =
          findMerchantProductByExactKey(
            input.merchantKey,
            input.comparisonKey
          ) ?? undefined;
      }
      const existing = existingById ?? existingByKey;
      const id =
        existing?.id ??
        input.id ??
        deterministicMerchantProductId(input.merchantKey, input.comparisonKey);
      const row: MerchantProductRecord = {
        id,
        merchantKey: input.merchantKey,
        comparisonKey: input.comparisonKey,
        canonicalDisplayName: input.canonicalDisplayName,
        normalizedName: input.normalizedName,
        brand: input.brand,
        attributes: input.attributes,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
        semanticStatus:
          input.semanticStatus !== undefined
            ? input.semanticStatus
            : existing?.semanticStatus ?? null,
        semanticJson:
          input.semanticJson !== undefined
            ? input.semanticJson
            : existing?.semanticJson ?? null,
        semanticConfidence:
          input.semanticConfidence !== undefined
            ? input.semanticConfidence
            : existing?.semanticConfidence ?? null,
        semanticResolverVersion:
          input.semanticResolverVersion !== undefined
            ? input.semanticResolverVersion
            : existing?.semanticResolverVersion ?? null,
      };
      const previous = merchants.get(id);
      if (!merchantProductInsertionOrder.has(id)) {
        merchantProductInsertionOrder.set(
          id,
          nextMerchantProductInsertionOrder
        );
        nextMerchantProductInsertionOrder += 1;
      }
      if (
        previous &&
        (previous.merchantKey !== row.merchantKey ||
          previous.comparisonKey !== row.comparisonKey)
      ) {
        removeMerchantProductFromIndexes(previous);
      }
      merchants.set(id, row);
      if (
        !previous ||
        previous.merchantKey !== row.merchantKey ||
        previous.comparisonKey !== row.comparisonKey
      ) {
        addMerchantProductToIndexes(row);
      }
      return row;
    },

    saveMerchantProductSemantic(merchantProductId, cache) {
      const existing = merchants.get(merchantProductId);
      if (!existing) return null;
      const row: MerchantProductRecord = {
        ...existing,
        semanticStatus: cache.status,
        semanticJson: cache,
        semanticConfidence: cache.confidence,
        semanticResolverVersion: cache.semanticResolverVersion,
        brand: cache.brand ?? existing.brand,
        attributes: cache.attributes ?? existing.attributes,
        updatedAt: nowIso(),
      };
      merchants.set(merchantProductId, row);
      return row;
    },

    getCanonicalProduct(id) {
      return canonicals.get(id) ?? null;
    },

    upsertCanonicalProduct(input) {
      const now = nowIso();
      const existing = input.id ? canonicals.get(input.id) : undefined;
      const id = existing?.id ?? input.id ?? nanoid();
      const row: CanonicalProduct = {
        id,
        canonicalName: input.canonicalName,
        brand: input.brand,
        categoryId: input.categoryId,
        attributes: input.attributes,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      canonicals.set(id, row);
      return row;
    },

    getLink(receiptId, itemSourceIndex) {
      return links.get(keyOf(receiptId, itemSourceIndex)) ?? null;
    },

    saveLink(input) {
      const now = nowIso();
      const key = keyOf(input.receiptId, input.itemSourceIndex);
      const existing = links.get(key);
      const row: ReceiptItemIdentityLinkRecord = {
        id: existing?.id ?? input.id ?? nanoid(),
        receiptId: input.receiptId,
        itemSourceIndex: input.itemSourceIndex,
        itemFingerprint: input.itemFingerprint,
        merchantKey: input.merchantKey,
        merchantProductId: input.merchantProductId,
        canonicalProductId: input.canonicalProductId,
        skuId: input.skuId,
        identityLevel: input.identityLevel,
        identityConfidence: input.identityConfidence,
        identitySource: input.identitySource,
        resolverVersion: input.resolverVersion,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        stale: false,
      };
      links.set(key, row);
      return row;
    },

    markLinkStale(receiptId, itemSourceIndex) {
      const key = keyOf(receiptId, itemSourceIndex);
      const existing = links.get(key);
      if (existing) {
        links.set(key, { ...existing, stale: true, updatedAt: nowIso() });
      }
    },

    clearDerived() {
      merchants.clear();
      merchantProductIdsByMerchant.clear();
      merchantProductIdsByExactKey.clear();
      merchantProductInsertionOrder.clear();
      nextMerchantProductInsertionOrder = 0;
      canonicals.clear();
      links.clear();
    },
  };
}

export function isIdentityLevel(value: string): value is ProductIdentityLevel {
  return (
    value === 'sku_exact' ||
    value === 'product_exact' ||
    value === 'merchant_product' ||
    value === 'family_spec' ||
    value === 'family_only' ||
    value === 'unresolved'
  );
}
