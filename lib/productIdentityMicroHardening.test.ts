/**
 * Final RC micro-hardening — quantity corroboration + semantic fingerprint.
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

import { applySemanticFieldsToItem } from './categoryBatchAi';
import {
  resolveIdentityConsumerObservations,
  type IdentityConsumerObservation,
} from './productIdentityConsumer';
import { buildProductAttributes } from './productIdentityContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import {
  evaluatePriceObservationQuality,
  resolveQuantityOcrCorroboration,
} from './productIdentityPriceObservationQuality';
import {
  applySemanticEnrichmentEvidence,
  buildSemanticCacheRecord,
  buildSemanticInputFingerprint,
  isSemanticModelVersionCompatible,
  semanticCacheMatchesInput,
} from './productIdentitySemanticContract';
import {
  bindMerchantAndInvalidateSemanticCache,
  invalidateStaleSemanticCacheOnItem,
  selectBatchSemanticItems,
} from './productIdentitySemanticBatch';
import {
  needsSemanticEnrichment,
  PRODUCT_IDENTITY_SEMANTIC_VERSION,
} from './productIdentitySemanticGate';
import { createMemoryProductIdentityStore } from './productIdentityStore';

function obs(
  partial: Partial<IdentityConsumerObservation> &
    Pick<IdentityConsumerObservation, 'receiptId' | 'occurredAt' | 'lineTotal'>
): IdentityConsumerObservation {
  return {
    itemSourceIndex: 0,
    rawName: '常備品ミルク',
    merchantKey: 'aeon',
    quantity: 1,
    ...partial,
  };
}

describe('Micro — production quantity corroboration path', () => {
  it('A: 400/400/400 then promo 200 without qty evidence → history keeps 200, not trend', () => {
    const store = createMemoryProductIdentityStore();
    const rows: IdentityConsumerObservation[] = [
      obs({ receiptId: 'r1', occurredAt: 1, lineTotal: 400 }),
      obs({ receiptId: 'r2', occurredAt: 2, lineTotal: 400 }),
      obs({ receiptId: 'r3', occurredAt: 3, lineTotal: 400 }),
      obs({ receiptId: 'r4', occurredAt: 4, lineTotal: 200 }),
    ];
    const { qualified } = resolveIdentityConsumerObservations(rows, store);
    const last = qualified.find((q) => q.receiptId === 'r4')!;
    expect(last.purchaseUnitPrice).toBe(200);
    expect(last.includeInHistory).toBe(true);
    expect(last.quality).toBe('usable_with_caution');
    expect(last.includeInTrend).toBe(false);
  });

  it('B: lineTotal 400 + OCR qty 2 with independent mismatch evidence → suspected anomaly', () => {
    const store = createMemoryProductIdentityStore();
    const rows: IdentityConsumerObservation[] = [
      obs({ receiptId: 'r1', occurredAt: 1, lineTotal: 400, quantity: 1 }),
      obs({ receiptId: 'r2', occurredAt: 2, lineTotal: 400, quantity: 1 }),
      obs({ receiptId: 'r3', occurredAt: 3, lineTotal: 400, quantity: 1 }),
      obs({
        receiptId: 'r4',
        occurredAt: 4,
        lineTotal: 400,
        quantity: 2,
        quantitySource: 'ocr',
        quantityMismatchEvidence: true,
      }),
    ];
    const { qualified } = resolveIdentityConsumerObservations(rows, store);
    const last = qualified.find((q) => q.receiptId === 'r4')!;
    expect(last.purchaseUnitPrice).toBe(200);
    expect(last.quality).toBe('suspected_anomaly');
    expect(last.includeInHistory).toBe(false);
    expect(resolveQuantityOcrCorroboration(rows[3]!)).toBe(true);
  });

  it('C: same numeric 200 without corroboration MUST NOT become suspected solely from ratio', () => {
    expect(resolveQuantityOcrCorroboration({})).toBe(false);
    expect(
      resolveQuantityOcrCorroboration({
        quantitySource: 'ocr',
        quantityMismatchEvidence: false,
      })
    ).toBe(false);

    const q = evaluatePriceObservationQuality({
      lineTotal: 200,
      quantity: 1,
      peerPurchaseUnitPrices: [400, 400, 400],
      rawName: '常備品ミルク',
    });
    expect(q.quality).toBe('usable_with_caution');
    expect(q.includeInHistory).toBe(true);
  });
});

describe('Micro — semantic fingerprint canonical contract', () => {
  function enrichedItem(overrides: Record<string, unknown> = {}) {
    const rawName = String(overrides.name ?? '午後T MLK 500ml');
    const merchantKey = (overrides.merchant_key as string | null) ?? 'aeon';
    const attributes =
      (overrides.deterministic_product_attributes as ReturnType<
        typeof buildProductAttributes
      >) ?? normalizeProductForIdentity(rawName).attributes;
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        brand: 'Kirin',
        brandConfidence: 0.95,
        confidence: 0.95,
        canonicalName: '午後の紅茶ミルク',
        canonicalNameConfidence: 0.95,
        attributes: [
          { dimension: 'flavor', value: 'milk', unit: null, confidence: 0.9 },
        ],
      },
      attributes
    );
    const fp = buildSemanticInputFingerprint({
      rawName,
      merchantKey,
      attributes,
      semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    });
    const cache = buildSemanticCacheRecord(applied, 'gemini-3.5-flash', fp);
    return {
      name: rawName,
      merchant_key: merchantKey,
      category: 'beverages',
      deterministic_product_attributes: attributes,
      // AI-merged attrs differ from deterministic — must not affect fingerprint.
      product_attributes: applied.attributes,
      semantic_status: 'enriched' as const,
      semantic_json: cache,
      semantic_canonical_name: applied.canonicalName,
      ...overrides,
    };
  }

  it('unchanged item → cache hit', () => {
    const item = enrichedItem();
    expect(
      invalidateStaleSemanticCacheOnItem(item, { activeModelVersion: null })
    ).toBe(false);
    expect(item.semantic_status).toBe('enriched');
    expect(selectBatchSemanticItems([item])).toHaveLength(0);
  });

  it('rename → miss', () => {
    const item = enrichedItem();
    item.name = '午後T MLK 1500';
    expect(
      invalidateStaleSemanticCacheOnItem(item, { activeModelVersion: null })
    ).toBe(true);
    expect(item.semantic_status).toBe('needs_enrichment');
    expect(item.semantic_json).toBeNull();
    expect(item.semantic_canonical_name).toBeNull();
  });

  it('merchant change → miss', () => {
    const item = enrichedItem();
    expect(
      bindMerchantAndInvalidateSemanticCache(item, 'costco', {
        activeModelVersion: null,
      })
    ).toBe(true);
    expect(item.merchant_key).toBe('costco');
    expect(item.semantic_status).toBe('needs_enrichment');
  });

  it('deterministic 500ml → 1L → miss', () => {
    const item = enrichedItem({ name: '午後の紅茶ミルク 500ml' });
    // Align cache FP with 500ml name first.
    const attrs500 = buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml', source: 'parsed' },
    ]);
    item.deterministic_product_attributes = attrs500;
    const fp = buildSemanticInputFingerprint({
      rawName: '午後の紅茶ミルク 500ml',
      merchantKey: 'aeon',
      attributes: attrs500,
      semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    });
    (item.semantic_json as { inputFingerprint: string }).inputFingerprint = fp;

    item.name = '午後の紅茶ミルク 1L';
    expect(
      invalidateStaleSemanticCacheOnItem(item, { activeModelVersion: null })
    ).toBe(true);
    expect(item.semantic_status).toBe('needs_enrichment');
  });

  it('AI added semantic attribute but deterministic input unchanged → hit', () => {
    const item = enrichedItem();
    item.product_attributes = buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml', source: 'parsed' },
      { dimension: 'flavor', value: 'milk-tea', unit: null, source: 'ai' },
      { dimension: 'brand_hint', value: 'Kirin', unit: null, source: 'ai' },
    ]);
    expect(
      invalidateStaleSemanticCacheOnItem(item, { activeModelVersion: null })
    ).toBe(false);
    expect(item.semantic_status).toBe('enriched');
  });

  it('model/resolver version incompatibility → miss', () => {
    const item = enrichedItem();
    expect(
      invalidateStaleSemanticCacheOnItem(item, {
        activeModelVersion: 'gemini-other',
      })
    ).toBe(true);
    expect(item.semantic_status).toBe('needs_enrichment');

    const attrs = buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml', source: 'parsed' },
    ]);
    const fp = buildSemanticInputFingerprint({
      rawName: 'x',
      merchantKey: 'm',
      attributes: attrs,
      semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    });
    const cache = buildSemanticCacheRecord(
      applySemanticEnrichmentEvidence(
        { index: 0, confidence: 0.9, brand: 'A', brandConfidence: 0.9 },
        attrs
      ),
      'old-model',
      fp
    );
    expect(
      semanticCacheMatchesInput(
        cache,
        fp,
        PRODUCT_IDENTITY_SEMANTIC_VERSION,
        'new-model'
      )
    ).toBe(false);
    expect(isSemanticModelVersionCompatible('old-model', 'new-model')).toBe(
      false
    );
    expect(isSemanticModelVersionCompatible('old-model', null)).toBe(true);
  });

  it('production applySemanticFieldsToItem fingerprints deterministic attrs only', () => {
    const item: any = {
      name: '牛乳 500ml',
      merchant_key: 'aeon',
      category: 'uncategorized',
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
        canonicalNameConfidence: 0.95,
        attributes: [{ dimension: 'flavor', value: 'plain', confidence: 0.9 }],
      },
      { modelVersion: 'gemini-test' }
    );

    expect(item.deterministic_product_attributes).toBeTruthy();
    expect(item.semantic_json.inputFingerprint).toBe(
      buildSemanticInputFingerprint({
        rawName: '牛乳 500ml',
        merchantKey: 'aeon',
        attributes: item.deterministic_product_attributes,
        semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
      })
    );
    const fpUsingMerged = buildSemanticInputFingerprint({
      rawName: '牛乳 500ml',
      merchantKey: 'aeon',
      attributes: item.product_attributes,
      semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    });
    expect(item.semantic_json.inputFingerprint).not.toBe(fpUsingMerged);

    expect(
      invalidateStaleSemanticCacheOnItem(item, { activeModelVersion: null })
    ).toBe(false);
  });

  it('scan-review style merchant bind + rename invalidates carried semantic fields', () => {
    const item = enrichedItem({ name: '旧名 500ml' });
    item.name = '新名 500ml';
    bindMerchantAndInvalidateSemanticCache(item, 'aeon', {
      activeModelVersion: null,
    });
    expect(item.semantic_status).toBe('needs_enrichment');
    expect(item.semantic_json).toBeNull();
    expect(
      needsSemanticEnrichment({
        rawName: item.name,
        category: 'uncategorized',
        createdMerchantProduct: true,
        cachedSemanticStatus: item.semantic_status,
      })
    ).toBe(true);
  });
});
