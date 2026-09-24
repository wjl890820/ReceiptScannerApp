/**
 * H8.2 — Lazy merchant catalog materialization.
 * Exact identity-truth differential vs pre-H8.2 eager HEAD oracle.
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
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import { buildIdentityNameStem } from './productIdentityNameStem';
import {
  __emptyResolveIdentityStemPhaseStatsForTests,
  resolveReceiptItemIdentity,
  type ResolveIdentityInput,
  type ResolveIdentityOptions,
  type ResolveIdentityResult,
  type ResolveIdentityStemPhaseStats,
} from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  type MerchantProductRecord,
  type ProductIdentityStore,
} from './productIdentityStore';
import { buildRepeatProductProfiles } from './repeatProductProfile';
import type { ReceiptRow } from './db';
import type { EngagementProductRow } from './engagementMilestones';
import * as fs from 'fs';
import * as path from 'path';

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

const EAGER: ResolveIdentityOptions = {
  __eagerCatalogMaterializationForTests: true,
};
const LAZY: ResolveIdentityOptions = {
  __eagerCatalogMaterializationForTests: false,
};

function emptyStats(): ResolveIdentityStemPhaseStats {
  return __emptyResolveIdentityStemPhaseStatsForTests();
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

function catalogSnapshot(store: ProductIdentityStore, merchantKey: string) {
  return store.listMerchantProducts(merchantKey).map((mp) => ({
    id: mp.id,
    comparisonKey: mp.comparisonKey,
    normalizedName: mp.normalizedName,
  }));
}

function linkSnapshot(store: ProductIdentityStore, receiptId: string, idx: number) {
  const link = store.getLink(receiptId, idx);
  if (!link) return null;
  return {
    merchantProductId: link.merchantProductId,
    canonicalProductId: link.canonicalProductId,
    identityLevel: link.identityLevel,
    identityConfidence: link.identityConfidence,
    identitySource: link.identitySource,
    stale: link.stale,
    itemFingerprint: link.itemFingerprint,
  };
}

function hyphenSeries(count: number, last: string): string {
  const tokens = Array.from({ length: count - 1 }, (_, i) => `token${i}`);
  tokens.push(last);
  return tokens.join('-');
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
    user_id: 'h82',
    installation_id: null,
  };
}

describe('H8.2 lazy catalog — counters & fast paths', () => {
  it('exact hit: catalogMaterializations === 0', () => {
    const store = createMemoryProductIdentityStore();
    const n = normalizeProductForIdentity('コカ・コーラ500ml');
    upsertMp(store, {
      id: 'mp-exact',
      merchantKey: 'm',
      comparisonKey: n.comparisonKey,
      normalizedName: n.normalizedName,
    });
    const stats = emptyStats();
    const r = resolveReceiptItemIdentity(
      { rawName: 'コカ・コーラ500ml', merchantKey: 'm', receiptId: 'r1', itemSourceIndex: 0 },
      store,
      { ...LAZY, __stemPhaseStatsForTests: stats }
    );
    expect(r.link.merchantProductId).toBe('mp-exact');
    expect(r.reason).toMatch(/comparison_key|generic/);
    expect(stats.catalogMaterializations).toBe(0);
    expect(stats.exactHits).toBe(1);
    expect(stats.fuzzyEntries).toBe(0);
  });

  it('indexed stem hit: catalogMaterializations === 0', () => {
    const store = createMemoryProductIdentityStore();
    upsertMp(store, {
      id: 'mp-stem',
      merchantKey: 'm',
      comparisonKey: 'cola-stem-key',
      normalizedName: 'コーラ500ml',
      attributes: VOLUME_500_ATTRS,
    });
    const stats = emptyStats();
    const r = resolveReceiptItemIdentity(
      { rawName: 'コーラ 500 ML', merchantKey: 'm', receiptId: 'r1', itemSourceIndex: 0 },
      store,
      { ...LAZY, __stemPhaseStatsForTests: stats }
    );
    expect(r.link.merchantProductId).toBe('mp-stem');
    expect(r.reason).toContain('stem');
    expect(stats.catalogMaterializations).toBe(0);
    expect(stats.stemHits).toBe(1);
    expect(stats.fuzzyEntries).toBe(0);
  });

  it('baseline stem test mode materializes catalog (not production stem skip)', () => {
    const store = createMemoryProductIdentityStore();
    upsertMp(store, {
      id: 'mp-stem',
      merchantKey: 'm',
      comparisonKey: 'cola-stem-key',
      normalizedName: 'コーラ500ml',
      attributes: VOLUME_500_ATTRS,
    });
    const stats = emptyStats();
    const r = resolveReceiptItemIdentity(
      { rawName: 'コーラ 500 ML', merchantKey: 'm', receiptId: 'r1', itemSourceIndex: 0 },
      store,
      {
        ...LAZY,
        __useMerchantProductStemIndexForTests: false,
        __stemPhaseStatsForTests: stats,
      }
    );
    expect(r.link.merchantProductId).toBe('mp-stem');
    expect(stats.catalogMaterializations).toBe(1);
    expect(stats.stemHits).toBe(1);
    expect(stats.fuzzyEntries).toBe(0);
  });

  it('alias hit: catalogMaterializations === 0', () => {
    const store = createMemoryProductIdentityStore();
    const aliasName = 'コカコーラ500ml';
    const n = normalizeProductForIdentity(aliasName);
    upsertMp(store, {
      id: 'mp-alias',
      merchantKey: 'm',
      comparisonKey: n.comparisonKey,
      normalizedName: n.normalizedName,
    });
    const stats = emptyStats();
    const r = resolveReceiptItemIdentity(
      {
        rawName: '謎OCRゴミZZZ999unique',
        merchantKey: 'm',
        receiptId: 'r1',
        itemSourceIndex: 0,
        evidence: { aliasCanonicalName: aliasName },
      },
      store,
      { ...LAZY, __stemPhaseStatsForTests: stats }
    );
    expect(r.link.merchantProductId).toBe('mp-alias');
    expect(r.reason).toBe('alias_or_dictionary_exact');
    expect(stats.catalogMaterializations).toBe(0);
    expect(stats.fuzzyEntries).toBe(0);
  });

  it('link cache hit: catalogMaterializations === 0', () => {
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      { rawName: 'コカ・コーラ500ml', merchantKey: 'm', receiptId: 'r1', itemSourceIndex: 0 },
      store,
      LAZY
    );
    expect(first.reason).not.toMatch(/^cache_hit/);
    const stats = emptyStats();
    const cached = resolveReceiptItemIdentity(
      { rawName: 'コカ・コーラ500ml', merchantKey: 'm', receiptId: 'r1', itemSourceIndex: 0 },
      store,
      { ...LAZY, __stemPhaseStatsForTests: stats }
    );
    expect(cached.reason).toMatch(/^cache_hit/);
    expect(cached.link.merchantProductId).toBe(first.link.merchantProductId);
    expect(stats.catalogMaterializations).toBe(0);
    expect(stats.resolverCalls).toBe(1);
  });

  it('fuzzy path: at-most-once materialization + structural counts', () => {
    const store = createMemoryProductIdentityStore();
    const K = 12;
    for (let i = 0; i < K; i += 1) {
      upsertMp(store, {
        id: `mp-noise-${i}`,
        merchantKey: 'm',
        comparisonKey: `noise-key-${i}`,
        normalizedName: `ノイズ商品${i} 300ml`,
      });
    }
    const stats = emptyStats();
    const r = resolveReceiptItemIdentity(
      {
        rawName: '完全に新しい商品XYZ987654',
        merchantKey: 'm',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store,
      { ...LAZY, __stemPhaseStatsForTests: stats }
    );
    expect(r.createdMerchantProduct).toBe(true);
    expect(stats.catalogMaterializations).toBe(1);
    expect(stats.fuzzyEntries).toBe(1);
    expect(stats.fuzzyCandidateChecks).toBe(K);
    expect(stats.exactHits).toBe(0);
    expect(stats.stemHits).toBe(0);
  });

  it('exact large-catalog: lazy skips O(K) materialization', () => {
    const K = 80;
    const store = createMemoryProductIdentityStore();
    for (let i = 0; i < K; i += 1) {
      upsertMp(store, {
        id: `mp-noise-${i}`,
        merchantKey: 'm',
        comparisonKey: `noise-${i}`,
        normalizedName: `ノイズ${i} 200ml`,
      });
    }
    const n = normalizeProductForIdentity('ターゲットコーラ500ml');
    upsertMp(store, {
      id: 'mp-target',
      merchantKey: 'm',
      comparisonKey: n.comparisonKey,
      normalizedName: n.normalizedName,
    });
    const eagerStore = createMemoryProductIdentityStore();
    for (let i = 0; i < K; i += 1) {
      upsertMp(eagerStore, {
        id: `mp-noise-${i}`,
        merchantKey: 'm',
        comparisonKey: `noise-${i}`,
        normalizedName: `ノイズ${i} 200ml`,
      });
    }
    upsertMp(eagerStore, {
      id: 'mp-target',
      merchantKey: 'm',
      comparisonKey: n.comparisonKey,
      normalizedName: n.normalizedName,
    });

    const lazyStats = emptyStats();
    const eagerStats = emptyStats();
    const obs: ResolveIdentityInput = {
      rawName: 'ターゲットコーラ500ml',
      merchantKey: 'm',
      receiptId: 'r1',
      itemSourceIndex: 0,
    };
    const lazy = resolveReceiptItemIdentity(obs, store, {
      ...LAZY,
      __stemPhaseStatsForTests: lazyStats,
    });
    const eager = resolveReceiptItemIdentity(obs, eagerStore, {
      ...EAGER,
      __stemPhaseStatsForTests: eagerStats,
    });
    expect(resultCore(lazy)).toEqual(resultCore(eager));
    expect(lazy.link.merchantProductId).toBe('mp-target');
    expect(lazyStats.catalogMaterializations).toBe(0);
    expect(eagerStats.catalogMaterializations).toBe(1);
  });

  it('stem large-catalog: indexed stem hit skips catalog materialization', () => {
    const store = createMemoryProductIdentityStore();
    for (let i = 0; i < 50; i += 1) {
      upsertMp(store, {
        id: `mp-noise-${i}`,
        merchantKey: 'm',
        comparisonKey: `noise-${i}`,
        normalizedName: `別物ノイズ${i} 100ml`,
      });
    }
    upsertMp(store, {
      id: 'mp-cola',
      merchantKey: 'm',
      comparisonKey: 'cola-unique',
      normalizedName: 'コーラ500ml',
      attributes: VOLUME_500_ATTRS,
    });
    const eagerStore = createMemoryProductIdentityStore();
    for (let i = 0; i < 50; i += 1) {
      upsertMp(eagerStore, {
        id: `mp-noise-${i}`,
        merchantKey: 'm',
        comparisonKey: `noise-${i}`,
        normalizedName: `別物ノイズ${i} 100ml`,
      });
    }
    upsertMp(eagerStore, {
      id: 'mp-cola',
      merchantKey: 'm',
      comparisonKey: 'cola-unique',
      normalizedName: 'コーラ500ml',
      attributes: VOLUME_500_ATTRS,
    });

    const obs: ResolveIdentityInput = {
      rawName: 'コーラ 500 ML',
      merchantKey: 'm',
      receiptId: 'r1',
      itemSourceIndex: 0,
    };
    const lazyStats = emptyStats();
    const eagerStats = emptyStats();
    const lazy = resolveReceiptItemIdentity(obs, store, {
      ...LAZY,
      __stemPhaseStatsForTests: lazyStats,
    });
    const eager = resolveReceiptItemIdentity(obs, eagerStore, {
      ...EAGER,
      __stemPhaseStatsForTests: eagerStats,
    });
    expect(resultCore(lazy)).toEqual(resultCore(eager));
    expect(lazy.link.merchantProductId).toBe('mp-cola');
    expect(lazy.reason).toContain('stem');
    expect(lazyStats.catalogMaterializations).toBe(0);
    expect(eagerStats.catalogMaterializations).toBe(1);
  });

  it('stem all-reject → fuzzy: catalogMaterializations === 1; equals eager', () => {
    const seed = (store: ProductIdentityStore) => {
      upsertMp(store, {
        id: 'mp-stem-reject',
        merchantKey: 'm',
        comparisonKey: 'cola-reject',
        normalizedName: 'コーラ',
        attributes: emptyProductAttributes(),
      });
      upsertMp(store, {
        id: 'mp-other',
        merchantKey: 'm',
        comparisonKey: 'other-1',
        normalizedName: 'お茶300ml',
      });
    };
    const lazyStore = createMemoryProductIdentityStore();
    const eagerStore = createMemoryProductIdentityStore();
    seed(lazyStore);
    seed(eagerStore);
    const obs: ResolveIdentityInput = {
      rawName: 'コーラ500ml',
      merchantKey: 'm',
      receiptId: 'r1',
      itemSourceIndex: 0,
    };
    const lazyStats = emptyStats();
    const eagerStats = emptyStats();
    const lazy = resolveReceiptItemIdentity(obs, lazyStore, {
      ...LAZY,
      __stemPhaseStatsForTests: lazyStats,
    });
    const eager = resolveReceiptItemIdentity(obs, eagerStore, {
      ...EAGER,
      __stemPhaseStatsForTests: eagerStats,
    });
    expect(resultCore(lazy)).toEqual(resultCore(eager));
    expect(lazy.reason).not.toBe('same_merchant_identity_stem');
    expect(lazyStats.catalogMaterializations).toBe(1);
    expect(lazyStats.stemRejected).toBe(1);
    expect(lazyStats.fuzzyEntries).toBe(1);
    expect(catalogSnapshot(lazyStore, 'm')).toEqual(catalogSnapshot(eagerStore, 'm'));
  });

  it('fuzzy tie: eager vs lazy choose same first-on-tie candidate', () => {
    const autoMatch = hyphenSeries(100, 'token099');
    const tieFirst = hyphenSeries(100, 'tokenx99');
    const tieSecond = hyphenSeries(100, 'tokeny99');

    const seed = (store: ProductIdentityStore) => {
      const n1 = normalizeProductForIdentity(tieFirst);
      const n2 = normalizeProductForIdentity(tieSecond);
      upsertMp(store, {
        id: 'tie-first',
        merchantKey: 'm',
        comparisonKey: n1.comparisonKey,
        normalizedName: n1.normalizedName,
      });
      upsertMp(store, {
        id: 'tie-second',
        merchantKey: 'm',
        comparisonKey: n2.comparisonKey,
        normalizedName: n2.normalizedName,
      });
    };
    const lazyStore = createMemoryProductIdentityStore();
    const eagerStore = createMemoryProductIdentityStore();
    seed(lazyStore);
    seed(eagerStore);
    expect(catalogSnapshot(lazyStore, 'm').map((x) => x.id)).toEqual([
      'tie-first',
      'tie-second',
    ]);

    const obs: ResolveIdentityInput = {
      rawName: autoMatch,
      merchantKey: 'm',
      receiptId: 'r1',
      itemSourceIndex: 0,
    };
    const lazy = resolveReceiptItemIdentity(obs, lazyStore, LAZY);
    const eager = resolveReceiptItemIdentity(obs, eagerStore, EAGER);
    expect(resultCore(lazy)).toEqual(resultCore(eager));
    expect(lazy.link.merchantProductId).toBe('tie-first');
    expect(lazy.reason).toBe('same_merchant_fuzzy_auto');
  });

  it('ensureCatalog preserves listMerchantProducts insertion order', () => {
    const store = createMemoryProductIdentityStore();
    const order = ['mp-c', 'mp-a', 'mp-b'];
    for (const id of order) {
      upsertMp(store, {
        id,
        merchantKey: 'm',
        comparisonKey: `key-${id}`,
        normalizedName: `商品${id}`,
      });
    }
    const listed = store.listMerchantProducts('m').map((mp) => mp.id);
    expect(listed).toEqual(order);
    const stats = emptyStats();
    resolveReceiptItemIdentity(
      { rawName: '全く違う新商品WWW', merchantKey: 'm', receiptId: 'r1', itemSourceIndex: 0 },
      store,
      { ...LAZY, __stemPhaseStatsForTests: stats }
    );
    expect(stats.catalogMaterializations).toBe(1);
    expect(store.listMerchantProducts('m').map((mp) => mp.id).slice(0, 3)).toEqual(order);
  });

  it('no catalog mutation before fuzzy: upsert only after fuzzy universe', () => {
    const store = createMemoryProductIdentityStore();
    upsertMp(store, {
      id: 'mp-existing',
      merchantKey: 'm',
      comparisonKey: 'existing-key',
      normalizedName: '既存商品100ml',
    });
    const before = catalogSnapshot(store, 'm');
    const listSpy = jest.spyOn(store, 'listMerchantProducts');
    const upsertSpy = jest.spyOn(store, 'upsertMerchantProduct');
    const semanticSpy = jest.spyOn(store, 'saveMerchantProductSemantic');

    const r = resolveReceiptItemIdentity(
      {
        rawName: '完全新規プロダクトH82',
        merchantKey: 'm',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store,
      LAZY
    );
    expect(r.createdMerchantProduct).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(1);
    const listOrder = listSpy.mock.invocationCallOrder[0]!;
    const upsertOrders = upsertSpy.mock.invocationCallOrder;
    expect(upsertOrders.every((o) => o > listOrder)).toBe(true);
    expect(semanticSpy).not.toHaveBeenCalled();
    // Fuzzy universe was pre-upsert catalog
    expect(before).toEqual([{ id: 'mp-existing', comparisonKey: 'existing-key', normalizedName: '既存商品100ml' }]);
  });

  it('source guard: no upsert/semantic between link and fuzzy ensureCatalog', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'productIdentityResolver.ts'),
      'utf8'
    );
    const start = src.indexOf('export function resolveReceiptItemIdentity');
    const fuzzyMarker = src.indexOf(
      'const fuzzyCatalog = ensureCatalog()',
      start
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(fuzzyMarker).toBeGreaterThan(start);
    const preFuzzy = src.slice(start, fuzzyMarker);
    expect(preFuzzy).not.toMatch(/upsertMerchantProduct\s*\(/);
    expect(preFuzzy).not.toMatch(/saveMerchantProductSemantic\s*\(/);
  });
});

describe('H8.2 eager baseline vs lazy differential', () => {
  it('per-step sequential stream: identity + catalog + links equal', () => {
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
        rawName: '完全新規ABC',
        merchantKey: 'm1',
        receiptId: 'r5',
        itemSourceIndex: 0,
      },
      {
        rawName: 'お茶500ml',
        merchantKey: 'm1',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
    ];

    const eagerStore = createMemoryProductIdentityStore();
    const lazyStore = createMemoryProductIdentityStore();

    for (const obs of observations) {
      const eager = resolveReceiptItemIdentity(obs, eagerStore, EAGER);
      const lazy = resolveReceiptItemIdentity(obs, lazyStore, LAZY);
      expect(resultCore(lazy)).toEqual(resultCore(eager));
      expect(catalogSnapshot(lazyStore, 'm1')).toEqual(
        catalogSnapshot(eagerStore, 'm1')
      );
      expect(catalogSnapshot(lazyStore, 'm2')).toEqual(
        catalogSnapshot(eagerStore, 'm2')
      );
      if (obs.receiptId != null && obs.itemSourceIndex != null) {
        expect(linkSnapshot(lazyStore, obs.receiptId, obs.itemSourceIndex)).toEqual(
          linkSnapshot(eagerStore, obs.receiptId, obs.itemSourceIndex)
        );
      }
    }
  });

  it('stale link path still resolves without changing link semantics', () => {
    const seedResolve = (
      store: ProductIdentityStore,
      opts: ResolveIdentityOptions
    ) =>
      resolveReceiptItemIdentity(
        {
          rawName: '東北恵牛乳1L',
          merchantKey: 'm',
          receiptId: 'r1',
          itemSourceIndex: 0,
          quantity: 1,
          lineTotal: 200,
        },
        store,
        opts
      );

    const eagerStore = createMemoryProductIdentityStore();
    const lazyStore = createMemoryProductIdentityStore();
    seedResolve(eagerStore, EAGER);
    seedResolve(lazyStore, LAZY);

    const next: ResolveIdentityInput = {
      rawName: '東北恵牛乳1L 編集後',
      merchantKey: 'm',
      receiptId: 'r1',
      itemSourceIndex: 0,
      quantity: 2,
      lineTotal: 400,
    };
    const eagerStats = emptyStats();
    const lazyStats = emptyStats();
    const eager = resolveReceiptItemIdentity(next, eagerStore, {
      ...EAGER,
      __stemPhaseStatsForTests: eagerStats,
    });
    const lazy = resolveReceiptItemIdentity(next, lazyStore, {
      ...LAZY,
      __stemPhaseStatsForTests: lazyStats,
    });
    expect(resultCore(lazy)).toEqual(resultCore(eager));
    expect(eager.reason).not.toBe('cache_hit');
    expect(lazy.reason).not.toBe('cache_hit');
    expect(lazyStats.catalogMaterializations).toBeLessThanOrEqual(1);
    if (lazyStats.fuzzyEntries > 0) {
      expect(lazyStats.catalogMaterializations).toBe(1);
    }
  });

  it('PI naming (displayName || rawName): eager vs lazy identity equal', () => {
    const rows = [
      { displayName: 'コカ・コーラ 500ml', rawName: 'コカ・コーラ', merchantKey: 'lawson', receiptId: 'r1' },
      {
        displayName: 'コカ・コーラ 500ml',
        rawName: 'コカ・コーラ 500ミリ',
        merchantKey: 'lawson',
        receiptId: 'r2',
      },
    ];
    const eagerStore = createMemoryProductIdentityStore();
    const lazyStore = createMemoryProductIdentityStore();
    const map = (store: ProductIdentityStore, opts: ResolveIdentityOptions) =>
      rows.map((row, i) => {
        const r = resolveReceiptItemIdentity(
          {
            rawName: row.displayName || row.rawName,
            merchantKey: row.merchantKey,
            receiptId: row.receiptId,
            itemSourceIndex: 0,
          },
          store,
          opts
        );
        return {
          i,
          merchantProductId: r.link.merchantProductId,
          canonicalProductId: r.link.canonicalProductId,
          identityLevel: r.link.identityLevel,
          identityConfidence: r.link.identityConfidence,
          identitySource: r.link.identitySource,
        };
      });
    expect(map(lazyStore, LAZY)).toEqual(map(eagerStore, EAGER));
  });

  it('Repeat consumer + groups + profiles equal on independent stores', () => {
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

    // Eager vs lazy at resolver layer (consumer has no options seam).
    const eagerStore = createMemoryProductIdentityStore();
    const lazyStore = createMemoryProductIdentityStore();
    for (const obs of observations) {
      const eager = resolveReceiptItemIdentity(
        {
          rawName: obs.rawName,
          merchantKey: obs.merchantKey,
          receiptId: obs.receiptId,
          itemSourceIndex: obs.itemSourceIndex,
          quantity: obs.quantity,
          lineTotal: obs.lineTotal,
        },
        eagerStore,
        EAGER
      );
      const lazy = resolveReceiptItemIdentity(
        {
          rawName: obs.rawName,
          merchantKey: obs.merchantKey,
          receiptId: obs.receiptId,
          itemSourceIndex: obs.itemSourceIndex,
          quantity: obs.quantity,
          lineTotal: obs.lineTotal,
        },
        lazyStore,
        LAZY
      );
      expect(resultCore(lazy)).toEqual(resultCore(eager));
    }

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

  it('Product Detail-style rawName||displayName: eager vs lazy equal', () => {
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
    const eagerStore = createMemoryProductIdentityStore();
    const lazyStore = createMemoryProductIdentityStore();
    for (const obs of observations) {
      const name = obs.rawName || obs.displayName;
      const eager = resolveReceiptItemIdentity(
        {
          rawName: name,
          merchantKey: obs.merchantKey,
          receiptId: obs.receiptId,
          itemSourceIndex: obs.itemSourceIndex,
          quantity: obs.quantity,
          lineTotal: obs.lineTotal,
        },
        eagerStore,
        EAGER
      );
      const lazy = resolveReceiptItemIdentity(
        {
          rawName: name,
          merchantKey: obs.merchantKey,
          receiptId: obs.receiptId,
          itemSourceIndex: obs.itemSourceIndex,
          quantity: obs.quantity,
          lineTotal: obs.lineTotal,
        },
        lazyStore,
        LAZY
      );
      expect(resultCore(lazy)).toEqual(resultCore(eager));
    }

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

  it('PI inventory identity fields stable across independent stores', () => {
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
    const receipts = [receipt('r1', DAY_MS), receipt('r2', 2 * DAY_MS)];
    const baseline = buildPersonalProductEndpointInventory({
      ownerKey: 'user:h82',
      sourceRows,
      receipts,
      decisionRows: [],
      store: createMemoryProductIdentityStore(),
    });
    const lazy = buildPersonalProductEndpointInventory({
      ownerKey: 'user:h82',
      sourceRows,
      receipts,
      decisionRows: [],
      store: createMemoryProductIdentityStore(),
    });
    expect(baseline.status).toBe('ready');
    expect(lazy.status).toBe('ready');
    if (baseline.status !== 'ready' || lazy.status !== 'ready') return;
    const mapItems = (inv: typeof baseline.inventory) =>
      [...inv.itemsByRowKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => ({
          key,
          merchantProductId: item.merchantProductId,
          identityLevel: item.identityLevel,
        }));
    expect(mapItems(lazy.inventory)).toEqual(mapItems(baseline.inventory));
  });
});

describe('H8.2 H8.1 preservation smoke', () => {
  it('stem index insertion order and clearDerived unchanged', () => {
    const store = createMemoryProductIdentityStore();
    upsertMp(store, {
      id: 'mp-a',
      merchantKey: 'm',
      comparisonKey: 'a',
      normalizedName: 'コーラ500ml',
    });
    upsertMp(store, {
      id: 'mp-b',
      merchantKey: 'm',
      comparisonKey: 'b',
      normalizedName: 'コーラ 500ml',
    });
    const stem = buildIdentityNameStem('コーラ500ml');
    expect(store.findMerchantProductsByNameStem('m', stem).map((r) => r.id)).toEqual([
      'mp-a',
      'mp-b',
    ]);
    store.clearDerived();
    expect(store.listMerchantProducts('m')).toEqual([]);
    expect(store.findMerchantProductsByNameStem('m', stem)).toEqual([]);
  });
});
