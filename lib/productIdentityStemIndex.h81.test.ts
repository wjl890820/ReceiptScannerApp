/**
 * H8.1 — Insertion-order-preserving merchant-product stem index.
 * Exact identity-truth differential vs baseline linear phase 2b.
 */
/* eslint-disable import/first -- Jest mocks must run before module imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./env', () => ({
  isProductIdentityPriceHistoryV1Enabled: () => true,
}));

import { emptyProductAttributes } from './productIdentityContract';
import type { ProductAttributes } from './productIdentityContract';
import { buildPersonalProductEndpointInventory } from './personalProductEndpointInventory';
import type { PersonalProductEndpointInventorySourceRow } from './personalProductEndpointInventory';
import {
  buildIdentityFrequentProductGroups,
  resolveIdentityConsumerObservations,
} from './productIdentityConsumer';
import { buildIdentityNameStem } from './productIdentityNameStem';
import {
  __baselineStemEqualCandidatesForTests,
  resolveReceiptItemIdentity,
  type ResolveIdentityInput,
  type ResolveIdentityStemPhaseStats,
} from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  merchantProductIdentityStem,
  type MerchantProductRecord,
  type ProductIdentityStore,
} from './productIdentityStore';
import { buildRepeatProductProfiles } from './repeatProductProfile';
import type { ReceiptRow } from './db';
import type { EngagementProductRow } from './engagementMilestones';

const DAY_MS = 24 * 60 * 60 * 1000;

const VOLUME_500_ATTRS: ProductAttributes = {
  version: 'product-attributes-v1',
  entries: [
    {
      dimension: 'volume',
      value: 500,
      unit: 'ml',
      source: 'parsed',
    },
  ],
};

function emptyStats(): ResolveIdentityStemPhaseStats {
  return {
    catalogLists: 0,
    stemCandidateChecks: 0,
    candidateStemComputations: 0,
    stemIndexLookups: 0,
    stemIndexedCandidateChecks: 0,
    fuzzyCandidateChecks: 0,
  };
}

function upsertMp(
  store: ProductIdentityStore,
  input: {
    id: string;
    merchantKey: string;
    comparisonKey: string;
    normalizedName: string;
    canonicalDisplayName?: string | null;
    attributes?: MerchantProductRecord['attributes'];
  }
): MerchantProductRecord {
  return store.upsertMerchantProduct({
    id: input.id,
    merchantKey: input.merchantKey,
    comparisonKey: input.comparisonKey,
    canonicalDisplayName: input.canonicalDisplayName ?? input.normalizedName,
    normalizedName: input.normalizedName,
    brand: null,
    attributes: input.attributes ?? emptyProductAttributes(),
  });
}

function resultCore(
  result: ReturnType<typeof resolveReceiptItemIdentity>
) {
  return {
    merchantProductId: result.link.merchantProductId,
    canonicalProductId: result.link.canonicalProductId,
    identityLevel: result.link.identityLevel,
    identityConfidence: result.link.identityConfidence,
    identitySource: result.link.identitySource,
    reason: result.reason,
    createdMerchantProduct: result.createdMerchantProduct,
  };
}

function catalogSnapshot(store: ProductIdentityStore, merchantKey: string) {
  return store.listMerchantProducts(merchantKey).map((row) => ({
    id: row.id,
    comparisonKey: row.comparisonKey,
    normalizedName: row.normalizedName,
    canonicalDisplayName: row.canonicalDisplayName,
    stem: merchantProductIdentityStem(row),
  }));
}

describe('H8.1 stem index safety + differential', () => {
  it('stem bucket order matches baseline filtered catalog order', () => {
    const store = createMemoryProductIdentityStore();
    upsertMp(store, {
      id: 'mp-a',
      merchantKey: 'm',
      comparisonKey: 'cola-a',
      normalizedName: 'コーラ500ml',
    });
    upsertMp(store, {
      id: 'mp-noise',
      merchantKey: 'm',
      comparisonKey: 'water',
      normalizedName: '水500ml',
    });
    upsertMp(store, {
      id: 'mp-b',
      merchantKey: 'm',
      comparisonKey: 'cola-b',
      normalizedName: 'コーラ 500 ML',
    });

    const inquiryStem = buildIdentityNameStem('コーラ500ml');
    const catalog = store.listMerchantProducts('m');
    const baseline = __baselineStemEqualCandidatesForTests(
      catalog,
      inquiryStem
    );
    const indexed = store.findMerchantProductsByNameStem('m', inquiryStem);
    expect(indexed.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
    expect(indexed.map((r) => r.id)).toEqual(['mp-a', 'mp-b']);
  });

  it('insertion-order reversal: A→B vs B→A winners match baseline', () => {
    const mk = (first: string, second: string) => {
      const baselineStore = createMemoryProductIdentityStore();
      const indexedStore = createMemoryProductIdentityStore();
      for (const store of [baselineStore, indexedStore]) {
        upsertMp(store, {
          id: first,
          merchantKey: 'stem-m',
          comparisonKey: `${first}-key`,
          normalizedName: 'コーラ500ml',
          attributes: VOLUME_500_ATTRS,
        });
        upsertMp(store, {
          id: second,
          merchantKey: 'stem-m',
          comparisonKey: `${second}-key`,
          normalizedName: 'コーラ500ml',
          attributes: VOLUME_500_ATTRS,
        });
      }
      const obs: ResolveIdentityInput = {
        rawName: 'コーラ500ml',
        merchantKey: 'stem-m',
        receiptId: 'q1',
        itemSourceIndex: 0,
      };
      const baseline = resolveReceiptItemIdentity(obs, baselineStore, {
        __useMerchantProductStemIndexForTests: false,
      });
      const indexed = resolveReceiptItemIdentity(obs, indexedStore, {
        __useMerchantProductStemIndexForTests: true,
      });
      expect(resultCore(indexed)).toEqual(resultCore(baseline));
      expect(indexed.link.merchantProductId).toBe(first);
      expect(indexed.reason).toContain('stem');
      return indexed.link.merchantProductId;
    };

    expect(mk('mp-first', 'mp-second')).toBe('mp-first');
    expect(mk('mp-second', 'mp-first')).toBe('mp-second');
  });

  it('first same-stem candidate rejected by structural balance; second wins', () => {
    const baselineStore = createMemoryProductIdentityStore();
    const indexedStore = createMemoryProductIdentityStore();
    for (const store of [baselineStore, indexedStore]) {
      upsertMp(store, {
        id: 'mp-underspec',
        merchantKey: 'stem-m',
        comparisonKey: 'cola-under',
        normalizedName: 'コーラ',
        attributes: emptyProductAttributes(),
      });
      upsertMp(store, {
        id: 'mp-spec',
        merchantKey: 'stem-m',
        comparisonKey: 'cola-spec',
        normalizedName: 'コーラ500ml',
        attributes: VOLUME_500_ATTRS,
      });
    }

    const obs: ResolveIdentityInput = {
      rawName: 'コーラ500ml',
      merchantKey: 'stem-m',
      receiptId: 'q1',
      itemSourceIndex: 0,
    };
    const baseline = resolveReceiptItemIdentity(obs, baselineStore, {
      __useMerchantProductStemIndexForTests: false,
    });
    const indexed = resolveReceiptItemIdentity(obs, indexedStore, {
      __useMerchantProductStemIndexForTests: true,
    });
    expect(resultCore(indexed)).toEqual(resultCore(baseline));
    expect(indexed.link.merchantProductId).toBe('mp-spec');
    expect(indexed.reason).toContain('stem');
  });

  it('stem bucket exists but all candidates rejected → fuzzy fallthrough equals baseline', () => {
    const baselineStore = createMemoryProductIdentityStore();
    const indexedStore = createMemoryProductIdentityStore();
    // Same stem as inquiry but unbalanced structural evidence only —
    // forces stem miss then fuzzy/create.
    for (const store of [baselineStore, indexedStore]) {
      upsertMp(store, {
        id: 'mp-stem-reject',
        merchantKey: 'stem-m',
        comparisonKey: 'cola-reject',
        normalizedName: 'コーラ',
        attributes: emptyProductAttributes(),
      });
    }

    const obs: ResolveIdentityInput = {
      rawName: 'コーラ500ml',
      merchantKey: 'stem-m',
      receiptId: 'q1',
      itemSourceIndex: 0,
    };
    // Inquiry has volume from name parse; candidate underspec → stem reject.
    const baseline = resolveReceiptItemIdentity(obs, baselineStore, {
      __useMerchantProductStemIndexForTests: false,
    });
    const indexed = resolveReceiptItemIdentity(obs, indexedStore, {
      __useMerchantProductStemIndexForTests: true,
    });
    expect(resultCore(indexed)).toEqual(resultCore(baseline));
    expect(baseline.reason).not.toBe('same_merchant_identity_stem');
  });

  it('merchant isolation: identical stems under different merchants', () => {
    const store = createMemoryProductIdentityStore();
    upsertMp(store, {
      id: 'mp-a',
      merchantKey: 'merchant-a',
      comparisonKey: 'cola',
      normalizedName: 'コーラ500ml',
    });
    upsertMp(store, {
      id: 'mp-b',
      merchantKey: 'merchant-b',
      comparisonKey: 'cola',
      normalizedName: 'コーラ500ml',
    });
    const stem = buildIdentityNameStem('コーラ500ml');
    expect(
      store.findMerchantProductsByNameStem('merchant-a', stem).map((r) => r.id)
    ).toEqual(['mp-a']);
    expect(
      store.findMerchantProductsByNameStem('merchant-b', stem).map((r) => r.id)
    ).toEqual(['mp-b']);
  });

  it('incremental catalog: each step matches baseline store', () => {
    const baselineStore = createMemoryProductIdentityStore();
    const indexedStore = createMemoryProductIdentityStore();
    const observations: ResolveIdentityInput[] = [
      {
        rawName: 'お茶500ml',
        merchantKey: 'm1',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      {
        rawName: 'お茶 500 ML',
        merchantKey: 'm1',
        receiptId: 'r2',
        itemSourceIndex: 0,
      },
      {
        rawName: '水2L',
        merchantKey: 'm1',
        receiptId: 'r3',
        itemSourceIndex: 0,
      },
      {
        rawName: 'お茶500ml',
        merchantKey: 'm2',
        receiptId: 'r4',
        itemSourceIndex: 0,
      },
      {
        rawName: 'お茶500ml',
        merchantKey: 'm1',
        receiptId: 'r5',
        itemSourceIndex: 0,
      },
    ];

    for (const obs of observations) {
      const baseline = resolveReceiptItemIdentity(obs, baselineStore, {
        __useMerchantProductStemIndexForTests: false,
      });
      const indexed = resolveReceiptItemIdentity(obs, indexedStore, {
        __useMerchantProductStemIndexForTests: true,
      });
      expect(resultCore(indexed)).toEqual(resultCore(baseline));
      expect(catalogSnapshot(indexedStore, 'm1')).toEqual(
        catalogSnapshot(baselineStore, 'm1')
      );
      expect(catalogSnapshot(indexedStore, 'm2')).toEqual(
        catalogSnapshot(baselineStore, 'm2')
      );
    }
  });

  it('existing MP upsert that changes stem moves bucket without duplicating id', () => {
    const store = createMemoryProductIdentityStore();
    upsertMp(store, {
      id: 'mp-1',
      merchantKey: 'm',
      comparisonKey: 'k1',
      normalizedName: 'コーラ500ml',
    });
    const stemCola = buildIdentityNameStem('コーラ500ml');
    expect(
      store.findMerchantProductsByNameStem('m', stemCola).map((r) => r.id)
    ).toEqual(['mp-1']);

    store.upsertMerchantProduct({
      id: 'mp-1',
      merchantKey: 'm',
      comparisonKey: 'k1',
      canonicalDisplayName: 'お茶500ml',
      normalizedName: 'お茶500ml',
      brand: null,
      attributes: emptyProductAttributes(),
    });
    const stemTea = buildIdentityNameStem('お茶500ml');
    expect(store.findMerchantProductsByNameStem('m', stemCola)).toEqual([]);
    expect(
      store.findMerchantProductsByNameStem('m', stemTea).map((r) => r.id)
    ).toEqual(['mp-1']);
  });

  it('operation counts: indexed stem checks << catalog size when S << K', () => {
    const store = createMemoryProductIdentityStore();
    for (let i = 0; i < 40; i += 1) {
      upsertMp(store, {
        id: `mp-noise-${i}`,
        merchantKey: 'm',
        comparisonKey: `noise-${i}`,
        normalizedName: `ノイズ商品${i} 300ml`,
      });
    }
    upsertMp(store, {
      id: 'mp-cola-1',
      merchantKey: 'm',
      comparisonKey: 'cola-1',
      normalizedName: 'コーラ500ml',
    });
    upsertMp(store, {
      id: 'mp-cola-2',
      merchantKey: 'm',
      comparisonKey: 'cola-2',
      normalizedName: 'コーラ 500ml',
    });

    const catalog = store.listMerchantProducts('m');
    expect(catalog.length).toBe(42);
    const inquiryStem = buildIdentityNameStem('コーラ500ml');

    const baselineStats = emptyStats();
    const baselineCandidates = __baselineStemEqualCandidatesForTests(
      catalog,
      inquiryStem,
      baselineStats
    );
    expect(baselineStats.candidateStemComputations).toBe(42);
    expect(baselineCandidates).toHaveLength(2);

    const indexedStats = emptyStats();
    indexedStats.stemIndexLookups += 1;
    const indexedCandidates = store.findMerchantProductsByNameStem(
      'm',
      inquiryStem
    );
    indexedStats.stemIndexedCandidateChecks = indexedCandidates.length;
    expect(indexedCandidates.map((r) => r.id)).toEqual(
      baselineCandidates.map((r) => r.id)
    );
    expect(indexedStats.stemIndexedCandidateChecks).toBe(2);
    expect(indexedStats.stemIndexedCandidateChecks).toBeLessThan(
      baselineStats.candidateStemComputations
    );
  });

  it('mixed-case / NFKC stem equality matches buildIdentityNameStem', () => {
    const store = createMemoryProductIdentityStore();
    upsertMp(store, {
      id: 'mp-1',
      merchantKey: 'm',
      comparisonKey: 'k',
      normalizedName: 'Cola 500ML',
    });
    const stem = buildIdentityNameStem('ｃｏｌａ５００ｍｌ');
    const hits = store.findMerchantProductsByNameStem('m', stem);
    const baseline = __baselineStemEqualCandidatesForTests(
      store.listMerchantProducts('m'),
      stem
    );
    expect(hits.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
  });
});

describe('H8.1 consumer differentials', () => {
  function receipt(id: string, at: number): ReceiptRow {
    return {
      id,
      created_at: at,
      transaction_at: at,
      transaction_time_precision: 'second',
      image_uri: '',
      total: 100,
      tax: 0,
      tax_is_known: 0,
      currency: 'JPY',
      analysis_json: '{}',
      merchant_raw: 'イオン',
      merchant_normalized: 'イオン',
      merchant_type: 'supermarket',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
      user_id: 'h81',
      installation_id: null,
    };
  }

  it('PI inventory identity fields equal baseline vs indexed stores', () => {
    const sourceRows: PersonalProductEndpointInventorySourceRow[] = [
      {
        receiptId: 'r1',
        itemId: 'r1:0',
        sourceIndex: 0,
        occurredAt: DAY_MS,
        merchantRaw: 'Lawson',
        merchantNormalized: 'lawson',
        displayName: 'コカ・コーラ 500ml',
        rawName: 'コカ・コーラ',
        lineTotal: 150,
        purchaseQuantity: 1,
        skuKey: null,
        brand: null,
      },
      {
        receiptId: 'r2',
        itemId: 'r2:0',
        sourceIndex: 0,
        occurredAt: 2 * DAY_MS,
        merchantRaw: 'Lawson',
        merchantNormalized: 'lawson',
        displayName: 'コカ・コーラ 500ml',
        rawName: 'コカ・コーラ 500ミリ',
        lineTotal: 150,
        purchaseQuantity: 1,
        skuKey: null,
        brand: null,
      },
    ];
    const receipts = [
      receipt('r1', DAY_MS),
      receipt('r2', 2 * DAY_MS),
    ];

    const baseline = buildPersonalProductEndpointInventory({
      ownerKey: 'user:h81',
      sourceRows,
      receipts,
      decisionRows: [],
      store: createMemoryProductIdentityStore(),
    });
    const indexed = buildPersonalProductEndpointInventory({
      ownerKey: 'user:h81',
      sourceRows,
      receipts,
      decisionRows: [],
      store: createMemoryProductIdentityStore(),
    });
    expect(baseline.status).toBe('ready');
    expect(indexed.status).toBe('ready');
    if (baseline.status !== 'ready' || indexed.status !== 'ready') return;

    const mapItems = (inv: typeof baseline.inventory) =>
      [...inv.itemsByRowKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => ({
          key,
          merchantProductId: item.merchantProductId,
          identityLevel: item.identityLevel,
        }));
    expect(mapItems(indexed.inventory)).toEqual(mapItems(baseline.inventory));
  });

  it('Repeat consumer: identity + groups equal across independent indexed stores', () => {
    const observations = [
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        rawName: 'ミルク 1L',
        merchantKey: 'aeon',
        occurredAt: DAY_MS,
        lineTotal: 200,
        quantity: 1,
        displayName: 'ミルク 1L',
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        rawName: 'ミルク 1000ml',
        merchantKey: 'aeon',
        occurredAt: 2 * DAY_MS,
        lineTotal: 200,
        quantity: 1,
        displayName: 'ミルク 1000ml',
      },
      {
        receiptId: 'r3',
        itemSourceIndex: 0,
        rawName: 'パン',
        merchantKey: 'aeon',
        occurredAt: 3 * DAY_MS,
        lineTotal: 100,
        quantity: 1,
        displayName: 'パン',
      },
      {
        receiptId: 'r4',
        itemSourceIndex: 0,
        rawName: 'パン',
        merchantKey: 'aeon',
        occurredAt: 4 * DAY_MS,
        lineTotal: 100,
        quantity: 1,
        displayName: 'パン',
      },
    ];

    const a = resolveIdentityConsumerObservations(
      observations,
      createMemoryProductIdentityStore()
    );
    const b = resolveIdentityConsumerObservations(
      observations,
      createMemoryProductIdentityStore()
    );
    expect(
      a.qualified.map((q) => ({
        receiptId: q.receiptId,
        merchantProductId: q.merchantProductId,
        identityLevel: q.identityLevel,
        identityConfidence: q.identityConfidence,
      }))
    ).toEqual(
      b.qualified.map((q) => ({
        receiptId: q.receiptId,
        merchantProductId: q.merchantProductId,
        identityLevel: q.identityLevel,
        identityConfidence: q.identityConfidence,
      }))
    );

    const groupsA = buildIdentityFrequentProductGroups(
      observations,
      createMemoryProductIdentityStore()
    ).groups;
    const groupsB = buildIdentityFrequentProductGroups(
      observations,
      createMemoryProductIdentityStore()
    ).groups;
    expect(groupsA.map((g) => ({ key: g.key, count: g.distinctReceiptCount }))).toEqual(
      groupsB.map((g) => ({ key: g.key, count: g.distinctReceiptCount }))
    );
  });

  it('Product Detail-style rawName||displayName path is stable across stores', () => {
    const observations = [
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        rawName: '明治おいしい牛乳',
        merchantKey: 'seven',
        occurredAt: DAY_MS,
        lineTotal: 230,
        quantity: 1,
        displayName: '明治 牛乳 1L',
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        rawName: '明治おいしい牛乳',
        merchantKey: 'seven',
        occurredAt: 2 * DAY_MS,
        lineTotal: 230,
        quantity: 1,
        displayName: '明治 牛乳 1000ml',
      },
    ];
    const a = resolveIdentityConsumerObservations(
      observations,
      createMemoryProductIdentityStore()
    );
    const b = resolveIdentityConsumerObservations(
      observations,
      createMemoryProductIdentityStore()
    );
    expect(
      a.qualified.map((q) => ({
        merchantProductId: q.merchantProductId,
        identityLevel: q.identityLevel,
        rawName: q.rawName,
      }))
    ).toEqual(
      b.qualified.map((q) => ({
        merchantProductId: q.merchantProductId,
        identityLevel: q.identityLevel,
        rawName: q.rawName,
      }))
    );
  });

  it('Repeat profiles equal for identical universes on fresh stores', () => {
    const receipts = [1, 2, 3].map((n) => receipt(`r${n}`, n * DAY_MS));
    const rows: EngagementProductRow[] = [
      {
        receiptId: 'r1',
        itemId: 'a',
        sourceIndex: 0,
        occurredAt: DAY_MS,
        merchantRaw: 'イオン',
        merchantNormalized: 'イオン',
        merchant_type: 'supermarket',
        analysis_json: '{}',
        displayName: '天然水 2L',
        currency: 'JPY',
        lineTotal: 100,
        purchaseQuantity: 1,
        canonicalProductName: null,
        productFamilyKey: null,
        skuKey: null,
        volumeBaseMl: null,
        weightBaseG: null,
        countBase: null,
      },
      {
        receiptId: 'r2',
        itemId: 'b',
        sourceIndex: 0,
        occurredAt: 2 * DAY_MS,
        merchantRaw: 'イオン',
        merchantNormalized: 'イオン',
        merchant_type: 'supermarket',
        analysis_json: '{}',
        displayName: '天然水 2000ml',
        currency: 'JPY',
        lineTotal: 100,
        purchaseQuantity: 1,
        canonicalProductName: null,
        productFamilyKey: null,
        skuKey: null,
        volumeBaseMl: null,
        weightBaseG: null,
        countBase: null,
      },
      {
        receiptId: 'r3',
        itemId: 'c',
        sourceIndex: 0,
        occurredAt: 3 * DAY_MS,
        merchantRaw: 'イオン',
        merchantNormalized: 'イオン',
        merchant_type: 'supermarket',
        analysis_json: '{}',
        displayName: '天然水 2L',
        currency: 'JPY',
        lineTotal: 100,
        purchaseQuantity: 1,
        canonicalProductName: null,
        productFamilyKey: null,
        skuKey: null,
        volumeBaseMl: null,
        weightBaseG: null,
        countBase: null,
      },
    ];
    const a = buildRepeatProductProfiles(receipts, rows);
    const b = buildRepeatProductProfiles(receipts, rows);
    expect(a).toEqual(b);
  });
});
