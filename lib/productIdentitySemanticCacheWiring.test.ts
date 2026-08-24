/**
 * Final semantic-cache production wiring:
 * 1) classify-items modelVersion → cache write → HIT/MISS vs ACTIVE SEMANTIC model
 * 2) rename/spec edit rebuilds deterministic attrs; AI never feeds deterministic snapshot
 */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));
jest.mock('./i18n', () => ({
  getCurrentLocale: () => 'ja',
  t: (k: string) => k,
}));
jest.mock('./deviceId', () => ({ getDeviceId: async () => 'test-device' }));
jest.mock('./env', () => ({
  getSupabaseUrl: () => 'https://example.supabase.co',
  getSupabaseAnonKey: () => 'eyJhbGciOi.fake.payload',
  isJwtLike: () => true,
  getCategoryBatchAiTimeoutMs: () => 9000,
  getCategoryBatchAiMaxItems: () => 40,
  getOcrGeminiModel: () => 'gemini-3.5-flash-lite',
  getSemanticGeminiModel: () => 'gemini-3.5-flash',
  DEFAULT_SEMANTIC_GEMINI_MODEL: 'gemini-3.5-flash',
  isProductIdentityPriceHistoryV1Enabled: () => true,
}));

import {
  applyBatchAiResults,
  applySemanticFieldsToItem,
  classifyItemsBatch,
  runBatchAiFallback,
} from './categoryBatchAi';
import { getOcrGeminiModel, getSemanticGeminiModel } from './env';
import {
  buildSemanticInputFingerprint,
  getActiveSemanticModelVersion,
  isSemanticModelVersionCompatible,
  semanticCacheMatchesInput,
} from './productIdentitySemanticContract';
import {
  invalidateStaleSemanticCacheOnItem,
  parseDeterministicProductAttributesFromCurrentName,
  refreshDeterministicProductAttributesFromCurrentName,
} from './productIdentitySemanticBatch';
import { PRODUCT_IDENTITY_SEMANTIC_VERSION } from './productIdentitySemanticGate';
import { getAttributeValue } from './universalProductSpecParser';

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('semantic modelVersion production wiring', () => {
  it('SSOT is semantic model, not OCR model', () => {
    expect(getOcrGeminiModel()).toBe('gemini-3.5-flash-lite');
    expect(getSemanticGeminiModel()).toBe('gemini-3.5-flash');
    expect(getActiveSemanticModelVersion()).toBe('gemini-3.5-flash');
    expect(getActiveSemanticModelVersion()).not.toBe(getOcrGeminiModel());
  });

  it('classify-items response model → cache write → HIT with active semantic model', async () => {
    (global as any).fetch = jest.fn(async () =>
      fakeResponse(200, {
        success: true,
        modelVersion: 'gemini-3.5-flash',
        model: 'gemini-3.5-flash',
        results: [
          {
            index: 0,
            categoryId: 'snacks_drinks',
            confidence: 0.95,
            brand: 'Coca-Cola',
            brandConfidence: 0.95,
            canonicalName: 'コーラ',
            canonicalNameConfidence: 0.9,
            attributes: [{ dimension: 'flavor', value: 'cola', confidence: 0.9 }],
          },
        ],
      })
    );

    const items: any[] = [
      {
        name: 'コーラ 500ml',
        category: 'uncategorized',
        merchant_key: 'aeon',
        semantic_status: 'needs_enrichment',
      },
    ];

    const outcome = await classifyItemsBatch(
      [{ index: 0, rawName: 'コーラ 500ml', merchantName: 'aeon' }],
      {}
    );
    expect(outcome?.modelVersion).toBe('gemini-3.5-flash');

    await runBatchAiFallback(items, {}, {
      classify: async () => outcome,
    });

    expect(items[0].semantic_json?.modelVersion).toBe('gemini-3.5-flash');
    expect(items[0].semantic_status).toMatch(/enriched|sufficient|partial/);

    // Unchanged deterministic input + active semantic model → HIT
    expect(
      invalidateStaleSemanticCacheOnItem(items[0], {
        activeModelVersion: 'gemini-3.5-flash',
      })
    ).toBe(false);
    expect(items[0].semantic_status).not.toBe('needs_enrichment');

    const fp = items[0].semantic_json?.inputFingerprint as string;
    expect(
      semanticCacheMatchesInput(
        items[0].semantic_json,
        fp,
        PRODUCT_IDENTITY_SEMANTIC_VERSION,
        'gemini-3.5-flash'
      )
    ).toBe(true);
  });

  it('cached semantic model != active semantic model → MISS', () => {
    const item: any = {
      name: 'コーラ 500ml',
      merchant_key: 'aeon',
      category: 'beverages',
      semantic_status: 'enriched',
    };
    applySemanticFieldsToItem(
      item,
      {
        index: 0,
        category: 'beverages',
        confidence: 0.95,
        brand: 'Coca-Cola',
        brandConfidence: 0.95,
        canonicalName: 'コーラ',
        canonicalNameConfidence: 0.9,
      },
      { modelVersion: 'gemini-3.5-flash' }
    );
    expect(item.semantic_json.modelVersion).toBe('gemini-3.5-flash');
    expect(isSemanticModelVersionCompatible('gemini-3.5-flash', 'future-model')).toBe(
      false
    );
    expect(
      invalidateStaleSemanticCacheOnItem(item, { activeModelVersion: 'future-model' })
    ).toBe(true);
    expect(item.semantic_status).toBe('needs_enrichment');
    expect(item.semantic_json).toBeNull();
  });
});

describe('rename rebuilds deterministic attrs + semantic invalidation', () => {
  it('500ml → 1500ml rename rebuilds volume and invalidates semantic cache', () => {
    const item: any = {
      name: 'コーラ 500ml',
      merchant_key: 'aeon',
      category: 'beverages',
      // Stale snapshot that must NOT survive rename.
      deterministic_product_attributes: parseDeterministicProductAttributesFromCurrentName({
        name: 'コーラ 500ml',
      }),
    };
    applySemanticFieldsToItem(
      item,
      {
        index: 0,
        category: 'beverages',
        confidence: 0.95,
        brand: 'Coca-Cola',
        brandConfidence: 0.95,
        canonicalName: 'コーラ',
        canonicalNameConfidence: 0.9,
      },
      { modelVersion: 'gemini-3.5-flash' }
    );
    expect(getAttributeValue(item.deterministic_product_attributes, 'volume')).toBe(500);
    const fpBefore = item.semantic_json.inputFingerprint as string;

    // Simulate scan-review spread of old deterministic snapshot + edited name.
    item.name = 'コーラ 1500ml';
    item.deterministic_product_attributes = parseDeterministicProductAttributesFromCurrentName({
      name: 'コーラ 500ml',
    });
    refreshDeterministicProductAttributesFromCurrentName(item);
    expect(getAttributeValue(item.deterministic_product_attributes, 'volume')).toBe(1500);

    const fpAfter = buildSemanticInputFingerprint({
      rawName: item.name,
      merchantKey: item.merchant_key,
      attributes: item.deterministic_product_attributes,
      semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    });
    expect(fpAfter).not.toBe(fpBefore);

    expect(
      invalidateStaleSemanticCacheOnItem(item, {
        activeModelVersion: 'gemini-3.5-flash',
      })
    ).toBe(true);
    expect(item.semantic_status).toBe('needs_enrichment');
    expect(item.semantic_json).toBeNull();
    expect(getAttributeValue(item.deterministic_product_attributes, 'volume')).toBe(1500);
  });

  it('unchanged name + AI-added attributes → deterministic fingerprint stable → HIT', () => {
    const item: any = {
      name: '牛乳 1L',
      merchant_key: 'aeon',
      category: 'beverages',
    };
    applySemanticFieldsToItem(
      item,
      {
        index: 0,
        category: 'beverages',
        confidence: 0.95,
        brand: 'Meiji',
        brandConfidence: 0.95,
        canonicalName: '明治おいしい牛乳',
        canonicalNameConfidence: 0.9,
        attributes: [{ dimension: 'flavor', value: 'plain', confidence: 0.9 }],
      },
      { modelVersion: 'gemini-3.5-flash' }
    );
    const fp = item.semantic_json.inputFingerprint as string;
    // AI attrs land on product_attributes only.
    expect(getAttributeValue(item.product_attributes, 'flavor')).toBe('plain');
    expect(getAttributeValue(item.deterministic_product_attributes, 'flavor')).toBeNull();

    // Mutate AI-only fields — deterministic fingerprint must stay stable.
    item.product_attributes = {
      ...item.product_attributes,
      entries: [
        ...(item.product_attributes.entries ?? []),
        { dimension: 'brand_hint', value: 'Meiji', unit: null, source: 'ai' },
      ],
    };
    expect(
      invalidateStaleSemanticCacheOnItem(item, {
        activeModelVersion: 'gemini-3.5-flash',
      })
    ).toBe(false);
    expect(item.semantic_json.inputFingerprint).toBe(fp);
  });

  it('non-structural unrelated edit → no unnecessary semantic invalidation', () => {
    const item: any = {
      name: '牛乳 1L',
      merchant_key: 'aeon',
      category: 'beverages',
    };
    applySemanticFieldsToItem(
      item,
      {
        index: 0,
        category: 'beverages',
        confidence: 0.95,
        brand: 'Meiji',
        brandConfidence: 0.95,
        canonicalName: '明治おいしい牛乳',
        canonicalNameConfidence: 0.9,
      },
      { modelVersion: 'gemini-3.5-flash' }
    );
    item.lineTotal = 198;
    item.quantity = 2;
    item.notes = 'user note';
    expect(
      invalidateStaleSemanticCacheOnItem(item, {
        activeModelVersion: 'gemini-3.5-flash',
      })
    ).toBe(false);
    expect(item.semantic_status).not.toBe('needs_enrichment');
  });

  it('AI output cannot become deterministic_product_attributes', () => {
    const item: any = {
      name: 'コーラ 500ml',
      merchant_key: 'aeon',
      category: 'uncategorized',
      // Poisoned AI attrs must not become the deterministic snapshot.
      product_attributes: {
        version: 1,
        entries: [
          { dimension: 'volume', value: 9999, unit: 'ml', source: 'ai' },
          { dimension: 'flavor', value: 'poison', unit: null, source: 'ai' },
        ],
      },
      deterministic_product_attributes: {
        version: 1,
        entries: [
          { dimension: 'volume', value: 9999, unit: 'ml', source: 'ai' },
        ],
      },
    };
    applySemanticFieldsToItem(
      item,
      {
        index: 0,
        category: 'beverages',
        confidence: 0.95,
        brand: 'Coca-Cola',
        brandConfidence: 0.95,
        attributes: [
          { dimension: 'flavor', value: 'cola', confidence: 0.9 },
          { dimension: 'volume', value: 7777, unit: 'ml', confidence: 0.9 },
        ],
      },
      { modelVersion: 'gemini-3.5-flash' }
    );
    expect(getAttributeValue(item.deterministic_product_attributes, 'volume')).toBe(500);
    expect(getAttributeValue(item.deterministic_product_attributes, 'flavor')).toBeNull();
    // AI volume must not overwrite deterministic 500.
    expect(getAttributeValue(item.product_attributes, 'volume')).toBe(500);
  });

  it('applyBatchAiResults retains response modelVersion into cache', () => {
    const items: any[] = [
      {
        name: 'コーラ 500ml',
        category: 'uncategorized',
        merchant_key: 'aeon',
        semantic_status: 'needs_enrichment',
      },
    ];
    applyBatchAiResults(
      items,
      [
        {
          index: 0,
          category: 'snacks_drinks',
          confidence: 0.95,
          brand: 'Coca-Cola',
          brandConfidence: 0.9,
          canonicalName: 'コーラ',
          canonicalNameConfidence: 0.9,
        },
      ],
      { modelVersion: 'gemini-3.5-flash' }
    );
    expect(items[0].semantic_json?.modelVersion).toBe('gemini-3.5-flash');
  });
});
