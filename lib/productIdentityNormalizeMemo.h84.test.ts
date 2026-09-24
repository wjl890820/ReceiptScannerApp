/**
 * H8.4 — Pass-local normalizeProductForIdentity memo.
 * Exact identity-truth differential vs no-memo baseline.
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

import {
  createProductIdentityNormalizePassCache,
  normalizeProductForIdentity,
  normalizeProductForIdentityCached,
  type ProductNormalizationResult,
} from './normalizeProductForIdentity';
import { buildPersonalProductEndpointInventory } from './personalProductEndpointInventory';
import type { PersonalProductEndpointInventorySourceRow } from './personalProductEndpointInventory';
import {
  buildIdentityFrequentProductGroups,
  resolveIdentityConsumerObservations,
  resolveIdentityConsumerObservationsAsync,
} from './productIdentityConsumer';
import {
  resolveReceiptItemIdentity,
  type ResolveIdentityInput,
  type ResolveIdentityResult,
} from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import { buildRepeatProductProfiles } from './repeatProductProfile';
import type { ReceiptRow } from './db';
import type { EngagementProductRow } from './engagementMilestones';

const DAY_MS = 24 * 60 * 60 * 1000;

function deepFreezeNorm(result: ProductNormalizationResult): ProductNormalizationResult {
  Object.freeze(result.tokens);
  Object.freeze(result.evidence);
  Object.freeze(result.attributes.entries);
  Object.freeze(result.attributes);
  return Object.freeze(result);
}

function resultCore(r: ResolveIdentityResult) {
  return {
    merchantProductId: r.link.merchantProductId,
    canonicalProductId: r.link.canonicalProductId,
    identityLevel: r.link.identityLevel,
    identityConfidence: r.link.identityConfidence,
    identitySource: r.link.identitySource,
    reason: r.reason,
    createdMerchantProduct: r.createdMerchantProduct,
  };
}

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
    user_id: 'h84',
    installation_id: null,
  };
}

describe('H8.4 pass-local normalize memo — unit', () => {
  it('duplicate exact inputs: memo computes once', () => {
    const N = 12;
    const raw = 'コカ・コーラ500ml';
    const cache = createProductIdentityNormalizePassCache();
    const outs: ProductNormalizationResult[] = [];
    for (let i = 0; i < N; i += 1) {
      outs.push(normalizeProductForIdentityCached(raw, cache));
    }
    expect(cache.stats.normalizeRequests).toBe(N);
    expect(cache.stats.normalizeComputations).toBe(1);
    expect(cache.stats.normalizeCacheHits).toBe(N - 1);
    for (const o of outs) {
      expect(o).toBe(outs[0]);
      expect(o).toEqual(normalizeProductForIdentity(raw));
    }
  });

  it('mixed visually-similar strings do not collide', () => {
    const cache = createProductIdentityNormalizePassCache();
    const a = normalizeProductForIdentityCached('お茶500ml', cache);
    const b = normalizeProductForIdentityCached('お茶 500ml', cache);
    const c = normalizeProductForIdentityCached('おちや500ml', cache);
    const d = normalizeProductForIdentityCached('お茶500ml', cache);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(d);
    expect(cache.stats.normalizeComputations).toBe(3);
    expect(cache.stats.normalizeCacheHits).toBe(1);
    expect(cache.map.size).toBe(3);
    expect(cache.map.has('お茶500ml')).toBe(true);
    expect(cache.map.has('お茶 500ml')).toBe(true);
    expect(cache.map.has('おちや500ml')).toBe(true);
  });

  it('null cache delegates to uncached normalize', () => {
    const a = normalizeProductForIdentityCached('水2L', null);
    const b = normalizeProductForIdentity('水2L');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('mutation safety: frozen cached result survives reuse', () => {
    const cache = createProductIdentityNormalizePassCache();
    const first = normalizeProductForIdentityCached('明治おいしい牛乳1L', cache);
    deepFreezeNorm(first);
    expect(() =>
      normalizeProductForIdentityCached('明治おいしい牛乳1L', cache)
    ).not.toThrow();
    const store = createMemoryProductIdentityStore();
    expect(() =>
      resolveReceiptItemIdentity(
        {
          rawName: '明治おいしい牛乳1L',
          merchantKey: 'm',
          receiptId: 'r1',
          itemSourceIndex: 0,
        },
        store,
        { normalizePassCache: cache }
      )
    ).not.toThrow();
  });
});

describe('H8.4a public return shapes — no cache escape', () => {
  const oneObs = [
    {
      receiptId: 'r1',
      itemSourceIndex: 0,
      rawName: 'お茶500ml',
      merchantKey: 'm',
      occurredAt: DAY_MS,
      lineTotal: 120,
      quantity: 1,
    },
  ];

  it('sync consumer result does not expose normalizePassCache', () => {
    const result = resolveIdentityConsumerObservations(
      oneObs,
      createMemoryProductIdentityStore()
    );
    expect(Object.keys(result).sort()).toEqual(['qualified', 'store']);
    expect('normalizePassCache' in result).toBe(false);
  });

  it('async consumer result does not expose normalizePassCache', async () => {
    const result = await resolveIdentityConsumerObservationsAsync(
      oneObs,
      createMemoryProductIdentityStore(),
      { yieldFn: async () => undefined }
    );
    expect(result).not.toBeNull();
    if (!result) return;
    expect(Object.keys(result).sort()).toEqual(['qualified', 'store']);
    expect('normalizePassCache' in result).toBe(false);
  });

  it('frequent-group result does not expose normalizePassCache', () => {
    const result = buildIdentityFrequentProductGroups(
      [
        ...oneObs,
        {
          receiptId: 'r2',
          itemSourceIndex: 0,
          rawName: 'お茶500ml',
          merchantKey: 'm',
          occurredAt: 2 * DAY_MS,
          lineTotal: 120,
          quantity: 1,
        },
      ],
      createMemoryProductIdentityStore()
    );
    expect(Object.keys(result).sort()).toEqual(['groups', 'qualified', 'store']);
    expect('normalizePassCache' in result).toBe(false);
  });
});

describe('H8.4 resolver + qualification reuse', () => {
  it('N identical resolve inputs: baseline N comps, memo 1; outputs equal', () => {
    const N = 10;
    const raw = '天然水2L';
    const observations: ResolveIdentityInput[] = Array.from({ length: N }, (_, i) => ({
      rawName: raw,
      merchantKey: 'aeon',
      receiptId: `r${i}`,
      itemSourceIndex: 0,
    }));

    const baselineStore = createMemoryProductIdentityStore();
    const memoStore = createMemoryProductIdentityStore();
    const memoCache = createProductIdentityNormalizePassCache();

    const baselineResults = observations.map((obs) =>
      resolveReceiptItemIdentity(obs, baselineStore)
    );
    const memoResults = observations.map((obs) =>
      resolveReceiptItemIdentity(obs, memoStore, {
        normalizePassCache: memoCache,
      })
    );

    expect(memoResults.map(resultCore)).toEqual(baselineResults.map(resultCore));
    expect(memoCache.stats.normalizeComputations).toBe(1);
    expect(memoCache.stats.normalizeRequests).toBe(N);
    expect(memoCache.stats.normalizeCacheHits).toBe(N - 1);
  });

  it('resolve then qualify same rawName reuses cached normalization', () => {
    const raw = 'パン';
    const cache = createProductIdentityNormalizePassCache();
    const store = createMemoryProductIdentityStore();
    const { qualified } = resolveIdentityConsumerObservations(
      [
        {
          receiptId: 'r1',
          itemSourceIndex: 0,
          rawName: raw,
          merchantKey: 'm',
          occurredAt: DAY_MS,
          lineTotal: 100,
          quantity: 1,
        },
      ],
      store,
      { normalizePassCache: cache }
    );
    expect(qualified).toHaveLength(1);
    // resolve + qualify both call normalize with the same raw string.
    expect(cache.stats.normalizeRequests).toBe(2);
    expect(cache.stats.normalizeComputations).toBe(1);
    expect(cache.stats.normalizeCacheHits).toBe(1);
  });
});

describe('H8.4 consumer / PI / Repeat / Detail differentials', () => {
  const obsStream = [
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
      rawName: 'ミルク 1L',
      merchantKey: 'aeon',
      occurredAt: 2 * DAY_MS,
      lineTotal: 200,
      quantity: 1,
      displayName: 'ミルク 1L',
    },
    {
      receiptId: 'r3',
      itemSourceIndex: 0,
      rawName: 'ミルク 1000ml',
      merchantKey: 'aeon',
      occurredAt: 3 * DAY_MS,
      lineTotal: 200,
      quantity: 1,
      displayName: 'ミルク 1000ml',
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
    {
      receiptId: 'r5',
      itemSourceIndex: 0,
      rawName: 'パン',
      merchantKey: 'aeon',
      occurredAt: 5 * DAY_MS,
      lineTotal: 100,
      quantity: 1,
      displayName: 'パン',
    },
  ];

  function mapQualified(
    rows: ReturnType<typeof resolveIdentityConsumerObservations>['qualified']
  ) {
    return rows.map((q) => ({
      receiptId: q.receiptId,
      merchantProductId: q.merchantProductId,
      identityLevel: q.identityLevel,
      identityConfidence: q.identityConfidence,
      identitySource: q.identitySource,
      quality: q.quality,
      includeInHistory: q.includeInHistory,
      includeInTrend: q.includeInTrend,
    }));
  }

  it('Repeat/consumer: baseline vs memo identity + qualification + groups equal', () => {
    const baseline = resolveIdentityConsumerObservations(
      obsStream,
      createMemoryProductIdentityStore(),
      { __disableNormalizePassCacheForTests: true }
    );
    const memoCache = createProductIdentityNormalizePassCache();
    const memo = resolveIdentityConsumerObservations(
      obsStream,
      createMemoryProductIdentityStore(),
      { normalizePassCache: memoCache }
    );
    expect(mapQualified(memo.qualified)).toEqual(mapQualified(baseline.qualified));
    expect(memoCache.stats.normalizeComputations).toBeLessThan(
      memoCache.stats.normalizeRequests
    );
    expect(memoCache.stats.normalizeCacheHits).toBeGreaterThan(0);

    const groupsBaseline = buildIdentityFrequentProductGroups(
      obsStream,
      createMemoryProductIdentityStore(),
      { __disableNormalizePassCacheForTests: true }
    ).groups;
    const groupsMemo = buildIdentityFrequentProductGroups(
      obsStream,
      createMemoryProductIdentityStore()
    ).groups;
    expect(
      groupsMemo.map((g) => ({
        key: g.key,
        count: g.distinctReceiptCount,
        displayName: g.displayName,
      }))
    ).toEqual(
      groupsBaseline.map((g) => ({
        key: g.key,
        count: g.distinctReceiptCount,
        displayName: g.displayName,
      }))
    );
  });

  it('Product Detail-style rawName||displayName: baseline vs memo equal', () => {
    const detailObs = [
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
    ].map((o) => ({
      ...o,
      // Detail projection uses rawName || displayName as the resolve input.
      rawName: o.rawName || o.displayName,
    }));

    const baseline = resolveIdentityConsumerObservations(
      detailObs,
      createMemoryProductIdentityStore(),
      { __disableNormalizePassCacheForTests: true }
    );
    const memo = resolveIdentityConsumerObservations(
      detailObs,
      createMemoryProductIdentityStore()
    );
    expect(mapQualified(memo.qualified)).toEqual(mapQualified(baseline.qualified));
  });

  it('PI displayName||rawName: baseline vs memo inventory identity equal', () => {
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
      {
        receiptId: 'r3',
        itemId: 'r3:0',
        sourceIndex: 0,
        occurredAt: 3 * DAY_MS,
        merchantRaw: 'Lawson',
        merchantNormalized: 'lawson',
        displayName: 'コカ・コーラ 500ml',
        rawName: 'cola',
        lineTotal: 150,
        purchaseQuantity: 1,
        skuKey: null,
        brand: null,
      },
    ];
    const receipts = [
      receipt('r1', DAY_MS),
      receipt('r2', 2 * DAY_MS),
      receipt('r3', 3 * DAY_MS),
    ];

    const baselineCache = createProductIdentityNormalizePassCache();
    const memoCache = createProductIdentityNormalizePassCache();
    // Force baseline by disabling; still pass a throwaway cache object unused.
    const baseline = buildPersonalProductEndpointInventory({
      ownerKey: 'user:h84',
      sourceRows,
      receipts,
      decisionRows: [],
      store: createMemoryProductIdentityStore(),
      __disableNormalizePassCacheForTests: true,
    });
    const memo = buildPersonalProductEndpointInventory({
      ownerKey: 'user:h84',
      sourceRows,
      receipts,
      decisionRows: [],
      store: createMemoryProductIdentityStore(),
      normalizePassCache: memoCache,
    });
    expect(baseline.status).toBe('ready');
    expect(memo.status).toBe('ready');
    if (baseline.status !== 'ready' || memo.status !== 'ready') return;

    const mapItems = (inv: typeof baseline.inventory) =>
      [...inv.itemsByRowKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => ({
          key,
          merchantProductId: item.merchantProductId,
          identityLevel: item.identityLevel,
          displayName: item.displayName,
        }));
    expect(mapItems(memo.inventory)).toEqual(mapItems(baseline.inventory));
    // Same displayName used for all three → one computation on memo path.
    expect(memoCache.stats.normalizeComputations).toBe(1);
    expect(memoCache.stats.normalizeRequests).toBe(3);
    expect(baselineCache.stats.normalizeComputations).toBe(0);
  });

  it('PI / Repeat / Detail caches are independent (no cross-consumer reuse)', () => {
    const piCache = createProductIdentityNormalizePassCache();
    const repeatCache = createProductIdentityNormalizePassCache();
    const detailCache = createProductIdentityNormalizePassCache();

    buildPersonalProductEndpointInventory({
      ownerKey: 'user:h84-x',
      sourceRows: [
        {
          receiptId: 'r1',
          itemId: 'r1:0',
          sourceIndex: 0,
          occurredAt: DAY_MS,
          merchantRaw: 'A',
          merchantNormalized: 'a',
          displayName: '共有名500ml',
          rawName: 'x',
          lineTotal: 100,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
      ],
      receipts: [receipt('r1', DAY_MS)],
      decisionRows: [],
      store: createMemoryProductIdentityStore(),
      normalizePassCache: piCache,
    });

    resolveIdentityConsumerObservations(
      [
        {
          receiptId: 'r1',
          itemSourceIndex: 0,
          rawName: '共有名500ml',
          merchantKey: 'a',
          occurredAt: DAY_MS,
          lineTotal: 100,
          quantity: 1,
        },
      ],
      createMemoryProductIdentityStore(),
      { normalizePassCache: repeatCache }
    );

    resolveIdentityConsumerObservations(
      [
        {
          receiptId: 'r1',
          itemSourceIndex: 0,
          rawName: '共有名500ml',
          merchantKey: 'a',
          occurredAt: DAY_MS,
          lineTotal: 100,
          quantity: 1,
        },
      ],
      createMemoryProductIdentityStore(),
      { normalizePassCache: detailCache }
    );

    expect(piCache.map).not.toBe(repeatCache.map);
    expect(repeatCache.map).not.toBe(detailCache.map);
    expect(piCache.stats.normalizeComputations).toBeGreaterThanOrEqual(1);
    expect(repeatCache.stats.normalizeComputations).toBeGreaterThanOrEqual(1);
    expect(detailCache.stats.normalizeComputations).toBeGreaterThanOrEqual(1);
  });

  it('Repeat profiles equal across independent memo passes', () => {
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
    expect(buildRepeatProductProfiles(receipts, rows)).toEqual(
      buildRepeatProductProfiles(receipts, rows)
    );
  });
});

describe('H8.4 H8.1/H8.2 smoke preservation', () => {
  it('stem hit and lazy catalog still work with normalize memo', () => {
    const store = createMemoryProductIdentityStore();
    const cache = createProductIdentityNormalizePassCache();
    resolveReceiptItemIdentity(
      {
        rawName: 'コーラ500ml',
        merchantKey: 'm',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store,
      { normalizePassCache: cache }
    );
    const second = resolveReceiptItemIdentity(
      {
        rawName: 'コーラ 500 ML',
        merchantKey: 'm',
        receiptId: 'r2',
        itemSourceIndex: 0,
      },
      store,
      { normalizePassCache: cache }
    );
    expect(second.reason).toMatch(/stem|comparison_key|generic|fuzzy|merchant/);
    expect(second.link.merchantProductId).toBeTruthy();
    expect(cache.stats.normalizeComputations).toBe(2);
  });
});
