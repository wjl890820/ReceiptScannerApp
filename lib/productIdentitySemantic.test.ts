/**
 * Product Identity Batch 4 — semantic gate / contract / selection / cache tests.
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('./env', () => ({
  getSupabaseUrl: () => 'https://example.supabase.co',
  getSupabaseAnonKey: () => 'eyJhbGciOi.fake.payload',
  isJwtLike: () => true,
  getCategoryBatchAiTimeoutMs: () => 9000,
  getCategoryBatchAiMaxItems: () => 40,
}));
jest.mock('./deviceId', () => ({ getDeviceId: async () => 'test-device' }));
jest.mock('./i18n', () => ({ getCurrentLocale: () => 'ja' }));

import {
  evaluateSemanticSufficiency,
  needsSemanticEnrichment,
} from './productIdentitySemanticGate';
import {
  applySemanticEnrichmentEvidence,
  buildSemanticCacheRecord,
  SEMANTIC_BRAND_APPLY_THRESHOLD,
  SEMANTIC_CANONICAL_NAME_APPLY_THRESHOLD,
} from './productIdentitySemanticContract';
import {
  selectBatchSemanticItems,
  emptySemanticBatchCostMetrics,
} from './productIdentitySemanticBatch';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import {
  applyBatchAiResults,
  runBatchAiFallback,
  selectBatchAiItems,
} from './categoryBatchAi';
import {
  emptyProductAttributes,
  buildProductAttributes,
} from './productIdentityContract';

describe('Product Identity Batch 4 — semantic gate', () => {
  it('existing MP + sufficient semantic → no AI', () => {
    const r = evaluateSemanticSufficiency({
      rawName: '東北恵牛乳 1L',
      normalizedName: '東北恵牛乳 1L',
      existingMerchantProductMatch: true,
      category: 'food_ingredients',
      categoryConfidence: 0.9,
      attributes: buildProductAttributes([
        { dimension: 'volume', value: 1000, unit: 'ml', source: 'parsed' },
      ]),
    });
    expect(r.needsEnrichment).toBe(false);
  });

  it('generic commodities skip AI when local category is strong (brand optional)', () => {
    const cases: Array<[string, string]> = [
      ['キャベツ', 'food_ingredients'],
      ['バナナ', 'food_ingredients'],
      ['卵10個', 'food_ingredients'],
      ['牛乳1L', 'food_ingredients'],
      ['ティッシュ5箱', 'household'],
    ];
    for (const [name, category] of cases) {
      expect(
        needsSemanticEnrichment({
          rawName: name,
          normalizedName: name,
          createdMerchantProduct: true,
          category,
          categoryConfidence: 0.9,
        })
      ).toBe(false);
    }
  });

  it('missing brand/canonical alone does not trigger AI', () => {
    expect(
      needsSemanticEnrichment({
        rawName: 'キッコーマンしょうゆ750ml',
        normalizedName: 'キッコーマンしょうゆ750ml',
        createdMerchantProduct: true,
        brand: null,
        category: 'food_ingredients',
        categoryConfidence: 0.9,
      })
    ).toBe(false);
  });

  it('short Japanese names are not opaque when categorized', () => {
    for (const name of ['卵', '米', '茶', '水']) {
      expect(
        needsSemanticEnrichment({
          rawName: name,
          normalizedName: name,
          createdMerchantProduct: true,
          category: 'food_ingredients',
          categoryConfidence: 0.9,
        })
      ).toBe(false);
    }
  });

  it('new MP + opaque name → AI candidate', () => {
    expect(
      needsSemanticEnrichment({
        rawName: 'TV BPさつま揚げ',
        normalizedName: 'TV BPさつま揚げ',
        createdMerchantProduct: true,
        category: 'uncategorized',
      })
    ).toBe(true);
  });

  it('semantic cache hit → no AI', () => {
    const fp = '午後t mlk 500\u001f\u001f\u001fmeruno-product-identity-semantic-v1.1\u001f';
    expect(
      needsSemanticEnrichment({
        rawName: '午後T MLK 500',
        cachedSemanticStatus: 'enriched',
        cachedSemanticInputFingerprint: fp,
        currentSemanticInputFingerprint: fp,
        cachedSemanticResolverVersion: 'meruno-product-identity-semantic-v1.1',
        createdMerchantProduct: true,
        category: 'uncategorized',
      })
    ).toBe(false);
  });

  it('semantic cache without fingerprint match is not a hit', () => {
    expect(
      needsSemanticEnrichment({
        rawName: '午後T MLK 500',
        cachedSemanticStatus: 'enriched',
        cachedSemanticInputFingerprint: 'old-fp',
        currentSemanticInputFingerprint: 'new-fp',
        createdMerchantProduct: true,
        category: 'uncategorized',
      })
    ).toBe(true);
  });
});

describe('Product Identity Batch 4 — sanitize / precedence', () => {
  it('code volume wins over AI volume and records conflict', () => {
    const code = buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml', source: 'parsed' },
    ]);
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        confidence: 0.95,
        attributes: [{ dimension: 'volume', value: 1500, unit: 'ml', confidence: 0.99 }],
      },
      code
    );
    const vol = applied.attributes.entries.find((e) => e.dimension === 'volume');
    expect(vol?.value).toBe(500);
    expect(applied.conflicts.some((c) => c.dimension === 'volume')).toBe(true);
  });

  it('low-confidence brand is suggested, not applied', () => {
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        brand: 'FakeBrand',
        brandConfidence: 0.55,
        confidence: 0.55,
      },
      emptyProductAttributes()
    );
    expect(applied.appliedBrand).toBe(false);
    expect(applied.brand).toBeNull();
    expect(applied.suggestedBrand).toBe('FakeBrand');
    expect(0.55).toBeLessThan(SEMANTIC_BRAND_APPLY_THRESHOLD);
  });

  it('canonicalName below threshold stays suggested only', () => {
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        canonicalName: '午後の紅茶 ミルクティー',
        canonicalNameConfidence: 0.8,
        confidence: 0.8,
      },
      emptyProductAttributes()
    );
    expect(applied.appliedCanonicalName).toBe(false);
    expect(applied.suggestedCanonicalName).toBe('午後の紅茶 ミルクティー');
    expect(0.8).toBeLessThan(SEMANTIC_CANONICAL_NAME_APPLY_THRESHOLD);
  });

  it('hallucinated JAN / sku / barcode are rejected', () => {
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        confidence: 0.99,
        brand: 'OK',
        brandConfidence: 0.95,
        janCode: '4901234567890',
        skuId: 'SKU-1',
        barcode: '123',
        attributes: [{ dimension: 'jan', value: '4901234567890', confidence: 0.99 }],
      },
      emptyProductAttributes()
    );
    expect(applied.rejectedJan).toBe(true);
    expect(
      applied.attributes.entries.some((e) => String(e.dimension).toLowerCase().startsWith('jan'))
    ).toBe(false);
  });

  it('variant tags can be saved as semantic evidence without merge', () => {
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        confidence: 0.95,
        semanticTags: ['ZERO', 'レモン', '低脂肪'],
        productType: 'soft_drink',
      },
      emptyProductAttributes()
    );
    expect(applied.semanticTags).toEqual(['ZERO', 'レモン', '低脂肪']);
    expect(applied.productType).toBe('soft_drink');
  });
});

describe('Product Identity Batch 4 — batch + cache', () => {
  it('multiple candidates → one batch call', async () => {
    const items = [
      {
        name: 'TV BPさつま揚げ',
        normalized_name: 'TV BPさつま揚げ',
        category: 'uncategorized',
        merchant_product_created: true,
      },
      {
        name: '午後T MLK 500',
        normalized_name: '午後T MLK 500',
        category: 'uncategorized',
        merchant_product_created: true,
      },
      {
        name: 'キャベツ',
        normalized_name: 'キャベツ',
        category: 'food_ingredients',
      },
    ];
    const classify = jest.fn(async (sent: any[]) =>
      sent.map((s) => ({
        index: s.index,
        category: 'ready_to_eat',
        confidence: 0.9,
        brand: null,
      }))
    );
    const r = await runBatchAiFallback(items, {}, { classify });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(r.called).toBe(true);
    expect(r.semantic.semanticBatchCalled).toBe(true);
  });

  it('cache hit on MerchantProduct → second observation does not need AI', () => {
    const store = createMemoryProductIdentityStore();
    const mp = store.upsertMerchantProduct({
      merchantKey: 'aeon',
      comparisonKey: 'tv_bp_satsuma',
      canonicalDisplayName: 'TV BPさつま揚げ',
      normalizedName: 'TV BPさつま揚げ',
      brand: null,
      attributes: emptyProductAttributes(),
    });
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        confidence: 0.95,
        brand: 'TOPVALU',
        brandConfidence: 0.95,
        canonicalName: 'トップバリュ さつま揚げ',
        canonicalNameConfidence: 0.95,
      },
      emptyProductAttributes()
    );
    const cache = buildSemanticCacheRecord(applied, 'gemini-3.5-flash');
    store.saveMerchantProductSemantic(mp.id, cache);

    const again = store.findMerchantProductByComparisonKey('aeon', 'tv_bp_satsuma');
    expect(again?.semanticStatus).toBe('enriched');
    expect(
      needsSemanticEnrichment({
        rawName: 'TV BPさつま揚げ',
        cachedSemanticStatus: again?.semanticStatus ?? null,
        existingMerchantProductMatch: true,
        category: 'ready_to_eat',
        categoryConfidence: 0.9,
      })
    ).toBe(false);
  });

  it('selectBatchAiItems unions uncategorized and needs_enrichment', () => {
    const items = [
      {
        name: 'キャベツ',
        normalized_name: 'キャベツ',
        category: 'food_ingredients',
      },
      {
        name: 'TV BPさつま揚げ',
        normalized_name: 'TV BPさつま揚げ',
        category: 'ready_to_eat',
        merchant_product_created: true,
      },
      {
        name: '謎商品',
        normalized_name: '謎商品',
        category: 'uncategorized',
      },
    ];
    const selected = selectBatchAiItems(items);
    const idxs = selected.map((s) => s.index);
    expect(idxs).toContain(1);
    expect(idxs).toContain(2);
    expect(idxs).not.toContain(0);
  });

  it('failure / empty AI result does not throw and keeps receipt flow safe', async () => {
    const items = [
      {
        name: '午後T MLK 500',
        normalized_name: '午後T MLK 500',
        category: 'uncategorized',
        merchant_product_created: true,
      },
    ];
    const r = await runBatchAiFallback(items, {}, { classify: async () => null });
    expect(r.called).toBe(true);
    expect(r.appliedCount).toBe(0);
    expect(items[0].category).toBe('uncategorized');
  });

  it('applyBatchAiResults strips invented JAN on items', () => {
    const items: any[] = [
      {
        name: 'ABCチョコ',
        category: 'uncategorized',
        product_attributes: emptyProductAttributes(),
      },
    ];
    applyBatchAiResults(items, [
      {
        index: 0,
        category: 'snacks_drinks',
        confidence: 0.9,
        brand: 'GuessBrand',
        brandConfidence: 0.95,
        janCode: '4900000000000',
      },
    ]);
    expect(items[0].jan_code).toBeNull();
    expect(items[0].sku_id).toBeNull();
  });

  it('emptySemanticBatchCostMetrics defaults', () => {
    expect(emptySemanticBatchCostMetrics().semanticBatchCalled).toBe(false);
    expect(selectBatchSemanticItems([]).length).toBe(0);
  });
});
