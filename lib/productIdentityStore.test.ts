import * as fs from 'fs';
import * as path from 'path';

import {
  PRODUCT_IDENTITY_RESOLVER_VERSION,
  emptyProductAttributes,
} from './productIdentityContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import {
  resolveReceiptItemIdentity,
  scopeMerchantKeyForIdentity,
  type ResolveIdentityInput,
} from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  deterministicMerchantProductId,
  type MerchantProductRecord,
  type ProductIdentityStore,
} from './productIdentityStore';

function createLinearReferenceStore(diagnostics?: {
  globalMerchantProductVisits: number;
}): ProductIdentityStore {
  const supportStore = createMemoryProductIdentityStore();
  const merchants = new Map<string, MerchantProductRecord>();

  const store: ProductIdentityStore = {
    ...supportStore,

    listMerchantProducts(merchantKey) {
      const rows: MerchantProductRecord[] = [];
      for (const row of merchants.values()) {
        if (diagnostics) diagnostics.globalMerchantProductVisits += 1;
        if (row.merchantKey === merchantKey) rows.push(row);
      }
      return rows;
    },

    findMerchantProductByComparisonKey(merchantKey, comparisonKey) {
      if (!comparisonKey) return null;
      for (const row of merchants.values()) {
        if (diagnostics) diagnostics.globalMerchantProductVisits += 1;
        if (
          row.merchantKey === merchantKey &&
          row.comparisonKey === comparisonKey
        ) {
          return row;
        }
      }
      return null;
    },

    upsertMerchantProduct(input) {
      const now = new Date().toISOString();
      const existingById = input.id ? merchants.get(input.id) : undefined;
      let existingByKey: MerchantProductRecord | undefined;
      if (!existingById && input.comparisonKey) {
        for (const row of merchants.values()) {
          if (diagnostics) diagnostics.globalMerchantProductVisits += 1;
          if (
            row.merchantKey === input.merchantKey &&
            row.comparisonKey === input.comparisonKey
          ) {
            existingByKey = row;
            break;
          }
        }
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
      merchants.set(id, row);
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
        updatedAt: new Date().toISOString(),
      };
      merchants.set(merchantProductId, row);
      return row;
    },

    clearDerived() {
      merchants.clear();
      supportStore.clearDerived();
    },
  };

  return store;
}

function upsertFixture(
  store: ProductIdentityStore,
  input: {
    id: string;
    merchantKey: string;
    comparisonKey: string;
    normalizedName?: string;
  }
): MerchantProductRecord {
  const normalized = normalizeProductForIdentity(
    input.normalizedName ?? input.comparisonKey
  );
  return store.upsertMerchantProduct({
    ...input,
    canonicalDisplayName: input.normalizedName ?? input.comparisonKey,
    normalizedName: input.normalizedName ?? input.comparisonKey,
    brand: null,
    attributes: normalized.attributes,
  });
}

function snapshotMerchantProducts(
  store: ProductIdentityStore,
  merchantKeys: readonly string[]
) {
  return merchantKeys.map((merchantKey) => ({
    merchantKey,
    products: store.listMerchantProducts(merchantKey).map((row) => ({
      id: row.id,
      merchantKey: row.merchantKey,
      comparisonKey: row.comparisonKey,
      normalizedName: row.normalizedName,
    })),
  }));
}

describe('Product Identity store secondary indexes', () => {
  it('preserves linear merchant order, exact first-match, and repeated-upsert behavior', () => {
    const reference = createLinearReferenceStore();
    const indexed = createMemoryProductIdentityStore();

    for (const store of [reference, indexed]) {
      upsertFixture(store, {
        id: 'mp-a',
        merchantKey: 'merchant-a',
        comparisonKey: 'key-a',
      });
      upsertFixture(store, {
        id: 'mp-b',
        merchantKey: 'merchant-b',
        comparisonKey: 'key-b',
      });
      upsertFixture(store, {
        id: 'mp-c',
        merchantKey: 'merchant-a',
        comparisonKey: 'key-c',
      });
      upsertFixture(store, {
        id: 'mp-b',
        merchantKey: 'merchant-a',
        comparisonKey: 'key-a',
      });
      upsertFixture(store, {
        id: 'mp-b',
        merchantKey: 'merchant-a',
        comparisonKey: 'key-a',
      });
    }

    expect(snapshotMerchantProducts(indexed, ['merchant-a', 'merchant-b'])).toEqual(
      snapshotMerchantProducts(reference, ['merchant-a', 'merchant-b'])
    );
    expect(indexed.listMerchantProducts('merchant-a').map((row) => row.id)).toEqual([
      'mp-a',
      'mp-b',
      'mp-c',
    ]);
    expect(
      indexed.findMerchantProductByComparisonKey('merchant-a', 'key-a')?.id
    ).toBe('mp-a');

    for (const store of [reference, indexed]) {
      upsertFixture(store, {
        id: 'mp-a',
        merchantKey: 'merchant-b',
        comparisonKey: 'key-moved',
      });
    }

    expect(snapshotMerchantProducts(indexed, ['merchant-a', 'merchant-b'])).toEqual(
      snapshotMerchantProducts(reference, ['merchant-a', 'merchant-b'])
    );
    expect(
      indexed.findMerchantProductByComparisonKey('merchant-a', 'key-a')?.id
    ).toBe('mp-b');
  });

  it('matches the linear resolver observation-by-observation, including ordered stem and fuzzy ties', () => {
    const reference = createLinearReferenceStore();
    const indexed = createMemoryProductIdentityStore();
    const stores = [reference, indexed];

    for (const store of stores) {
      upsertFixture(store, {
        id: 'mp-stem-first',
        merchantKey: 'stem-store',
        comparisonKey: 'stored-stem-a',
        normalizedName: 'コーラ500ml',
      });
      upsertFixture(store, {
        id: 'mp-stem-second',
        merchantKey: 'stem-store',
        comparisonKey: 'stored-stem-b',
        normalizedName: 'コーラ500ml',
      });

      const commonTokens = Array.from(
        { length: 100 },
        (_, index) => `token${String(index).padStart(3, '0')}`
      );
      upsertFixture(store, {
        id: 'mp-fuzzy-first',
        merchantKey: 'fuzzy-store',
        comparisonKey: [...commonTokens.slice(0, -1), 'tokenx99'].join('-'),
      });
      upsertFixture(store, {
        id: 'mp-fuzzy-second',
        merchantKey: 'fuzzy-store',
        comparisonKey: [...commonTokens.slice(0, -1), 'tokeny99'].join('-'),
      });
    }

    const fuzzyQuery = Array.from(
      { length: 100 },
      (_, index) => `token${String(index).padStart(3, '0')}`
    ).join('-');
    const observations: ResolveIdentityInput[] = [
      {
        rawName: '定番商品500ml',
        merchantKey: 'exact-store',
        receiptId: 'exact-1',
        itemSourceIndex: 0,
      },
      {
        rawName: '定番商品500ml',
        merchantKey: 'exact-store',
        receiptId: 'exact-2',
        itemSourceIndex: 0,
      },
      {
        rawName: '定番商品500ml',
        merchantKey: 'other-store',
        receiptId: 'other-1',
        itemSourceIndex: 0,
      },
      {
        rawName: '不明商品',
        merchantKey: '',
        receiptId: 'unknown-1',
        itemSourceIndex: 0,
      },
      {
        rawName: '不明商品',
        merchantKey: '',
        receiptId: 'unknown-2',
        itemSourceIndex: 0,
      },
      {
        rawName: 'コーラ500ml',
        merchantKey: 'stem-store',
        receiptId: 'stem-query',
        itemSourceIndex: 0,
      },
      {
        rawName: fuzzyQuery,
        merchantKey: 'fuzzy-store',
        receiptId: 'fuzzy-query',
        itemSourceIndex: 0,
      },
    ];

    let resolverResultDifferences = 0;
    const referenceResults = observations.map((observation) =>
      resolveReceiptItemIdentity(observation, reference)
    );
    const indexedResults = observations.map((observation) =>
      resolveReceiptItemIdentity(observation, indexed)
    );

    for (let index = 0; index < observations.length; index += 1) {
      const expected = referenceResults[index]!;
      const actual = indexedResults[index]!;
      const expectedSnapshot = {
        merchantProductId: expected.link.merchantProductId,
        identityLevel: expected.link.identityLevel,
        identitySource: expected.link.identitySource,
        reason: expected.reason,
        comparisonKey: expected.comparisonKey,
        createdMerchantProduct: expected.createdMerchantProduct,
      };
      const actualSnapshot = {
        merchantProductId: actual.link.merchantProductId,
        identityLevel: actual.link.identityLevel,
        identitySource: actual.link.identitySource,
        reason: actual.reason,
        comparisonKey: actual.comparisonKey,
        createdMerchantProduct: actual.createdMerchantProduct,
      };
      if (JSON.stringify(actualSnapshot) !== JSON.stringify(expectedSnapshot)) {
        resolverResultDifferences += 1;
      }
      expect(actualSnapshot).toEqual(expectedSnapshot);
    }

    expect(referenceResults[1]?.reason).toBe('same_merchant_comparison_key');
    expect(referenceResults[3]?.link.merchantProductId).not.toBe(
      referenceResults[4]?.link.merchantProductId
    );
    expect(referenceResults[5]?.reason).toBe('same_merchant_identity_stem');
    expect(referenceResults[5]?.link.merchantProductId).toBe('mp-stem-first');
    expect(referenceResults[6]?.reason).toBe('same_merchant_fuzzy_auto');
    expect(referenceResults[6]?.link.merchantProductId).toBe('mp-fuzzy-first');
    expect(resolverResultDifferences).toBe(0);

    const merchantKeys = [
      'exact-store',
      'other-store',
      scopeMerchantKeyForIdentity('', 'unknown-1'),
      scopeMerchantKeyForIdentity('', 'unknown-2'),
      'stem-store',
      'fuzzy-store',
    ];
    expect(snapshotMerchantProducts(indexed, merchantKeys)).toEqual(
      snapshotMerchantProducts(reference, merchantKeys)
    );
  });

  it('removes global MerchantProduct scans from indexed listing and exact lookup', () => {
    const diagnostics = { globalMerchantProductVisits: 0 };
    const reference = createLinearReferenceStore(diagnostics);
    for (let index = 0; index < 100; index += 1) {
      upsertFixture(reference, {
        id: `mp-${index}`,
        merchantKey: `merchant-${index % 10}`,
        comparisonKey: `key-${index}`,
      });
    }
    diagnostics.globalMerchantProductVisits = 0;
    reference.listMerchantProducts('merchant-5');
    reference.findMerchantProductByComparisonKey('merchant-5', 'key-55');
    expect(diagnostics.globalMerchantProductVisits).toBeGreaterThan(100);

    const source = fs.readFileSync(
      path.join(__dirname, 'productIdentityStore.ts'),
      'utf8'
    );
    expect(source).not.toContain('merchants.values()');
  });

  it('keeps empty attributes usable for exact indexed fixtures', () => {
    const store = createMemoryProductIdentityStore();
    const row = store.upsertMerchantProduct({
      merchantKey: 'empty-attributes',
      comparisonKey: 'item',
      canonicalDisplayName: 'item',
      normalizedName: 'item',
      brand: null,
      attributes: emptyProductAttributes(),
    });
    expect(
      store.findMerchantProductByComparisonKey('empty-attributes', 'item')?.id
    ).toBe(row.id);
  });
});
