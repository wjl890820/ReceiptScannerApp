/**
 * In-memory Product Identity entity store (Batch 3).
 * Derived / rebuildable — not receipt truth.
 */

import { nanoid } from 'nanoid/non-secure';

import {
  PRODUCT_IDENTITY_RESOLVER_VERSION,
  type CanonicalProduct,
  type ProductAttributes,
  type ProductIdentityLevel,
  type ReceiptItemIdentityLink,
} from './productIdentityContract';

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
};

export type ProductIdentityStore = {
  listMerchantProducts(merchantKey: string): MerchantProductRecord[];
  findMerchantProductByComparisonKey(
    merchantKey: string,
    comparisonKey: string
  ): MerchantProductRecord | null;
  upsertMerchantProduct(input: UpsertMerchantProductInput): MerchantProductRecord;
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
  const canonicals = new Map<string, CanonicalProduct>();
  const links = new Map<string, ReceiptItemIdentityLinkRecord>();
  const keyOf = (receiptId: string, idx: number) => `${receiptId}#${idx}`;

  return {
    listMerchantProducts(merchantKey) {
      return [...merchants.values()].filter((m) => m.merchantKey === merchantKey);
    },

    findMerchantProductByComparisonKey(merchantKey, comparisonKey) {
      if (!comparisonKey) return null;
      for (const m of merchants.values()) {
        if (m.merchantKey === merchantKey && m.comparisonKey === comparisonKey) {
          return m;
        }
      }
      return null;
    },

    upsertMerchantProduct(input) {
      const now = nowIso();
      const existing = input.id ? merchants.get(input.id) : undefined;
      const id = existing?.id ?? input.id ?? nanoid();
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
      };
      merchants.set(id, row);
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
