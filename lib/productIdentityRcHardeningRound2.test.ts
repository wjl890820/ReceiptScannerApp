/**
 * RC Hardening Round 2 — targeted correctness regressions.
 */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
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
jest.mock('./deviceId', () => ({ getDeviceId: async () => 'test-device' }));
jest.mock('./i18n', () => ({ getCurrentLocale: () => 'ja' }));

import type { ReceiptRow } from './db';
import {
  auditKnownStructuralCostco9534Case,
  evaluateReconciledStructuralExactPair,
  hasExactTransactionTime,
  summarizeReceiptForDuplicateAudit,
} from './analysisDDuplicateAudit';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  applySemanticEnrichmentEvidence,
  buildSemanticCacheRecord,
  buildSemanticInputFingerprint,
} from './productIdentitySemanticContract';
import {
  invalidateStaleSemanticCacheOnItem,
  selectBatchSemanticItems,
} from './productIdentitySemanticBatch';
import {
  evaluateSemanticSufficiency,
  needsSemanticEnrichment,
  PRODUCT_IDENTITY_SEMANTIC_VERSION,
} from './productIdentitySemanticGate';
import { evaluatePriceObservationQuality } from './productIdentityPriceObservationQuality';
import {
  gateIdentityHistoryCurrencies,
  loadProductPriceHistoryWithDb,
  type ProductPriceHistoryDatabase,
  type ProductPriceHistoryRow,
} from './productPriceHistory';
import {
  buildReceiptItemIndexRows,
  projectMinimalReceiptItemIndexFromSoT,
  resolveIndexPurchaseQuantity,
  type ReceiptItemIndexDatabase,
  type ReceiptItemIndexReceipt,
} from './receiptItemIndex';
import { buildProductAttributes } from './productIdentityContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';

describe('Round2 — identity price-history currency completeness', () => {
  it('JPY + JPY → eligible', () => {
    expect(gateIdentityHistoryCurrencies(['JPY', 'JPY'])).toEqual({
      status: 'ok',
      currency: 'JPY',
    });
  });

  it('JPY + USD → rejected', () => {
    expect(gateIdentityHistoryCurrencies(['JPY', 'USD']).status).toBe(
      'mixed_currency'
    );
  });

  it('JPY + null → rejected', () => {
    expect(gateIdentityHistoryCurrencies(['JPY', null]).status).toBe(
      'unknown_currency'
    );
  });

  it('null + null → rejected', () => {
    expect(gateIdentityHistoryCurrencies([null, null]).status).toBe(
      'unknown_currency'
    );
  });

  it('never defaults unknown to JPY', () => {
    const g = gateIdentityHistoryCurrencies([null, 'unknown', '']);
    expect(g.currency).toBeNull();
    expect(g.status).toBe('unknown_currency');
  });
});

describe('Round2 — merchant_product never falls through to broad legacy', () => {
  it('identity loader exception cannot return another product history', async () => {
    jest.resetModules();
    jest.doMock('./productIdentityConsumer', () => ({
      tryBuildIdentityPriceHistoryForRows: () => {
        throw new Error('injected identity failure');
      },
    }));
    jest.doMock('./env', () => ({
      isProductIdentityPriceHistoryV1Enabled: () => true,
    }));

    const { loadProductPriceHistoryWithDb: load } = await import(
      './productPriceHistory'
    );

    const otherProductPrice = 99999;
    const db: ProductPriceHistoryDatabase = {
      async getAllAsync<T>() {
        const rows: ProductPriceHistoryRow[] = [
          {
            receiptId: 'r-other',
            itemId: 'i-other',
            sourceIndex: 0,
            occurredAt: 1,
            merchantRaw: 'X',
            merchantNormalized: 'x',
            displayName: 'Other Product',
            currency: 'JPY',
            lineTotal: otherProductPrice,
            purchaseQuantity: 1,
            productFamilyKey: 'milk',
            volumeBaseMl: 1000,
            weightBaseG: null,
            countBase: null,
          },
          {
            receiptId: 'r-other-2',
            itemId: 'i-other-2',
            sourceIndex: 0,
            occurredAt: 2,
            merchantRaw: 'X',
            merchantNormalized: 'x',
            displayName: 'Other Product',
            currency: 'JPY',
            lineTotal: otherProductPrice + 1,
            purchaseQuantity: 1,
            productFamilyKey: 'milk',
            volumeBaseMl: 1000,
            weightBaseG: null,
            countBase: null,
          },
        ];
        return rows as T[];
      },
    };

    const result = await load(db, {
      type: 'merchant_product',
      key: 'mp_target_should_not_leak',
    });

    expect(result.points).toEqual([]);
    expect(result.points.some((p) => p.priceValue === otherProductPrice)).toBe(
      false
    );
    expect(result.status).toBe('not_enough_points');

    jest.dontMock('./productIdentityConsumer');
    jest.resetModules();
  });
});

describe('Round2 — preserve explicit invalid quantities on index path', () => {
  it('resolveIndexPurchaseQuantity distinguishes missing vs explicit invalid', () => {
    expect(resolveIndexPurchaseQuantity(null)).toBe(1);
    expect(resolveIndexPurchaseQuantity(undefined)).toBe(1);
    expect(resolveIndexPurchaseQuantity('')).toBe(1);
    expect(resolveIndexPurchaseQuantity(0)).toBeNull();
    expect(resolveIndexPurchaseQuantity(-2)).toBeNull();
    expect(resolveIndexPurchaseQuantity(Number.NaN)).toBeNull();
    expect(resolveIndexPurchaseQuantity(Number.POSITIVE_INFINITY)).toBeNull();
    expect(resolveIndexPurchaseQuantity(3)).toBe(3);
  });

  it('buildReceiptItemIndexRows preserves invalid qty and nulls unit price', () => {
    // Prefer user_items_json so we can pass non-JSON-native invalids via string forms.
    // (JSON.stringify(Number.NaN) becomes null and would incorrectly default to 1.)
    const receipt = {
      id: 'r-qty',
      user_items_json: JSON.stringify([
        { name: 'A', quantity: null, lineTotal: 100 },
        { name: 'B', quantity: 0, lineTotal: 200 },
        { name: 'C', quantity: -1, lineTotal: 300 },
        { name: 'D', quantity: 'NaN', lineTotal: 400 },
        { name: 'E', quantity: 'Infinity', lineTotal: 500 },
      ]),
    } as ReceiptItemIndexReceipt;

    const rows = buildReceiptItemIndexRows(receipt, { indexedAt: 1 });
    expect(rows[0]!.purchase_quantity).toBe(1);
    expect(rows[0]!.purchase_unit_price).toBe(100);
    expect(rows[1]!.purchase_quantity).toBeNull();
    expect(rows[1]!.purchase_unit_price).toBeNull();
    expect(rows[2]!.purchase_quantity).toBeNull();
    expect(rows[2]!.purchase_unit_price).toBeNull();
    expect(rows[3]!.purchase_quantity).toBeNull();
    expect(rows[3]!.purchase_unit_price).toBeNull();
    expect(rows[4]!.purchase_quantity).toBeNull();
    expect(rows[4]!.purchase_unit_price).toBeNull();

    const invalidGate = evaluatePriceObservationQuality({
      lineTotal: 200,
      quantity: rows[1]!.purchase_quantity,
      peerPurchaseUnitPrices: [200, 200],
      rawName: 'B',
    });
    expect(invalidGate.quality).toBe('invalid');
    expect(invalidGate.includeInHistory).toBe(false);
  });
});

describe('Round2 — reciprocal promo vs qty OCR anomaly', () => {
  it('400,400,400,200 legitimate promo keeps 200 in history; trend caution', () => {
    const q = evaluatePriceObservationQuality({
      lineTotal: 200,
      quantity: 1,
      peerPurchaseUnitPrices: [400, 400, 400],
      rawName: '常備品',
    });
    expect(q.includeInHistory).toBe(true);
    expect(q.quality).toBe('usable_with_caution');
    expect(q.includeInTrend).toBe(false);
  });

  it('400,400,400 with qty OCR corroboration producing 200 → anomaly', () => {
    const q = evaluatePriceObservationQuality({
      lineTotal: 200,
      quantity: 1,
      peerPurchaseUnitPrices: [400, 400, 400],
      rawName: '常備品',
      quantityOcrCorroborated: true,
    });
    expect(q.quality).toBe('suspected_anomaly');
    expect(q.includeInHistory).toBe(false);
  });

  it('high-side integer multiple 400→800 remains suspected anomaly', () => {
    const q = evaluatePriceObservationQuality({
      lineTotal: 800,
      quantity: 1,
      peerPurchaseUnitPrices: [400, 400, 400],
      rawName: '常備品',
    });
    expect(q.quality).toBe('suspected_anomaly');
    expect(q.includeInHistory).toBe(false);
  });
});

describe('Round2 — failed receipt_item rebuild SoT fallback', () => {
  it('projects edited SoT rows so index consumers still see the receipt', async () => {
    const inserted: Array<{ sql: string; params: unknown }> = [];
    const db: ReceiptItemIndexDatabase = {
      async execAsync() {},
      async runAsync(sql, params) {
        inserted.push({ sql, params });
        return {};
      },
      async getAllAsync() {
        return [];
      },
      async withTransactionAsync(task) {
        await task();
      },
    };

    const receipt = {
      id: 'r-edit',
      analysis_json: JSON.stringify({
        items: [{ name: '編集後ミルク', quantity: 2, lineTotal: 396 }],
      }),
    } as ReceiptItemIndexReceipt;

    await projectMinimalReceiptItemIndexFromSoT(db, receipt, { indexedAt: 42 });

    expect(inserted.some((c) => /DELETE FROM receipt_items/i.test(c.sql))).toBe(
      true
    );
    const insert = inserted.find((c) => /INSERT INTO receipt_items/i.test(c.sql));
    expect(insert).toBeTruthy();
    const params = insert!.params as unknown[];
    expect(params[1]).toBe('r-edit');
    expect(params[5]).toBe('編集後ミルク');
    expect(params[12]).toBe(2);
    expect(params[13]).toBe(396);
    expect(params[14]).toBe(198);
  });
});

describe('Round2 — date-only reconciled duplicate gate', () => {
  function makeReceipt(args: {
    id: string;
    transactionAt: number | null;
    total: number;
    merchant: string;
    items: Array<{ name: string; lineTotal: number; quantity?: number }>;
    createdAt?: number;
  }): ReceiptRow {
    return {
      id: args.id,
      created_at: args.createdAt ?? 1000,
      transaction_at: args.transactionAt,
      image_uri: '',
      total: args.total,
      tax: 0,
      tax_is_known: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({ items: args.items }),
      merchant_raw: args.merchant,
      merchant_normalized: args.merchant,
      merchant_type: 'supermarket',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    } as ReceiptRow;
  }

  it('A — date-only midnight + trailing OCR artifact → two purchases', () => {
    const dateOnly = Date.parse('2023-07-06T00:00:00+09:00');
    expect(
      hasExactTransactionTime(
        makeReceipt({
          id: 'x',
          transactionAt: dateOnly,
          total: 500,
          merchant: 'イオン',
          items: [],
        })
      )
    ).toBe(false);

    const coreItems = [
      { name: '牛乳', lineTotal: 200, quantity: 1 },
      { name: 'パン', lineTotal: 300, quantity: 1 },
    ];
    const a = makeReceipt({
      id: 'date-a',
      transactionAt: dateOnly,
      total: 500,
      merchant: 'イオン',
      items: coreItems,
      createdAt: 1000,
    });
    const b = makeReceipt({
      id: 'date-b',
      transactionAt: dateOnly,
      total: 500,
      merchant: 'イオン',
      items: [
        ...coreItems,
        { name: 'ポイント残高', lineTotal: 0, quantity: 1 },
      ],
      createdAt: 2000,
    });

    const sa = summarizeReceiptForDuplicateAudit(a);
    const sb = summarizeReceiptForDuplicateAudit(b);
    expect(sa.hasExactTransactionTime).toBe(false);
    expect(sb.hasExactTransactionTime).toBe(false);
    expect(evaluateReconciledStructuralExactPair(sa, sb)).toBeNull();

    const selection = selectAnalyticsReceipts([a, b]);
    expect(selection.analyticsPurchaseCandidateCount).toBe(2);
  });

  it('B — Costco timed 4 scans → 1 purchase candidate remains green', () => {
    const txAt = Date.parse('2023-07-06T11:44:46+09:00');
    const coreItems = [
      { name: 'A', lineTotal: 418, quantity: 1 },
      { name: 'B', lineTotal: 698, quantity: 1 },
      { name: 'C', lineTotal: 428, quantity: 1 },
      { name: 'D', lineTotal: 899, quantity: 1 },
      { name: 'E', lineTotal: 488, quantity: 1 },
      { name: 'F', lineTotal: 298, quantity: 1 },
      { name: 'G', lineTotal: 998, quantity: 1 },
      { name: 'H', lineTotal: 698, quantity: 1 },
      { name: 'I', lineTotal: 777, quantity: 1 },
      { name: 'J', lineTotal: 3484, quantity: 1 },
      { name: 'K', lineTotal: 348, quantity: 1 },
    ];
    const trailing = [
      { name: 'コストコ コネクション', lineTotal: 1, quantity: 1 },
      { name: 'コストコ コネクション ムリョウ', lineTotal: 1, quantity: 1 },
    ];
    const receipts = [
      makeReceipt({
        id: '2bDvMWs3dkCKagyrYWyxA',
        transactionAt: txAt,
        total: 9534,
        merchant: 'コストコ',
        items: coreItems,
        createdAt: 2000,
      }),
      makeReceipt({
        id: 'C_aMA69ijcqNLhGI76Y5Q',
        transactionAt: txAt,
        total: 9534,
        merchant: 'コストコ',
        items: [...coreItems, ...trailing],
        createdAt: 1000,
      }),
      makeReceipt({
        id: 'n6_vGM5c8X255Psyiup4k',
        transactionAt: txAt,
        total: 9534,
        merchant: 'コストコ',
        items: coreItems.map((it, i) => ({ ...it, name: `${it.name}_b${i}` })),
        createdAt: 3000,
      }),
      makeReceipt({
        id: 'NEHGZCkqd8MiBCyKO-fWd',
        transactionAt: txAt,
        total: 9534,
        merchant: 'コストコ',
        items: coreItems.map((it, i) => ({ ...it, name: `${it.name}_c${i}` })),
        createdAt: 4000,
      }),
    ];

    const selection = selectAnalyticsReceipts(receipts);
    expect(selection.analyticsPurchaseCandidateCount).toBe(1);
    const known = auditKnownStructuralCostco9534Case(receipts)!;
    expect(known.storedScanCount).toBe(4);
    expect(known.purchaseCandidateCount).toBe(1);
  });
});

describe('Round2 — semantic cache fingerprint gates hits', () => {
  function cachedItem(overrides: Record<string, unknown> = {}) {
    const rawName = String(overrides.name ?? '午後T MLK 500ml');
    const merchantKey = (overrides.merchant_key as string | null) ?? 'aeon';
    const attributes =
      (overrides.product_attributes as ReturnType<typeof buildProductAttributes>) ??
      (overrides.deterministic_product_attributes as ReturnType<
        typeof buildProductAttributes
      >) ??
      normalizeProductForIdentity(rawName).attributes;
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        brand: 'Kirin',
        brandConfidence: 0.95,
        confidence: 0.95,
        canonicalName: '午後の紅茶ミルク',
        canonicalNameConfidence: 0.95,
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
      // Categorized so selection is driven by needs_enrichment only (not uncategorized union).
      category: 'beverages',
      product_attributes: attributes,
      deterministic_product_attributes: attributes,
      semantic_status: 'enriched',
      semantic_json: cache,
      ...overrides,
    };
  }

  it('unchanged input → cache hit', () => {
    const item = cachedItem();
    expect(invalidateStaleSemanticCacheOnItem(item)).toBe(false);
    expect(item.semantic_status).toBe('enriched');
    expect(needsSemanticEnrichment({
      rawName: item.name as string,
      cachedSemanticStatus: 'enriched',
      cachedSemanticInputFingerprint: (item.semantic_json as { inputFingerprint: string }).inputFingerprint,
      currentSemanticInputFingerprint: (item.semantic_json as { inputFingerprint: string }).inputFingerprint,
      cachedSemanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
      category: 'beverages',
    })).toBe(false);
    expect(selectBatchSemanticItems([item])).toHaveLength(0);
  });

  it('rename → cache miss', () => {
    const item = cachedItem();
    item.name = '午後T MLK 1500';
    expect(invalidateStaleSemanticCacheOnItem(item)).toBe(true);
    expect(item.semantic_status).toBe('needs_enrichment');
  });

  it('merchant change → cache miss', () => {
    const item = cachedItem();
    item.merchant_key = 'costco';
    expect(invalidateStaleSemanticCacheOnItem(item)).toBe(true);
    expect(item.semantic_status).toBe('needs_enrichment');
  });

  it('name spec change 500ml→1500ml → cache miss', () => {
    const item = cachedItem({ name: 'コーラ 500ml' });
    // Rebuild fingerprint for 500ml name so cache matches pre-edit state.
    const attrs500 = buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml', source: 'parsed' },
    ]);
    item.deterministic_product_attributes = attrs500;
    item.product_attributes = attrs500;
    const fp = buildSemanticInputFingerprint({
      rawName: 'コーラ 500ml',
      merchantKey: 'aeon',
      attributes: attrs500,
      semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    });
    (item.semantic_json as { inputFingerprint: string }).inputFingerprint = fp;

    item.name = 'コーラ 1500ml';
    expect(invalidateStaleSemanticCacheOnItem(item)).toBe(true);
    expect(item.semantic_status).toBe('needs_enrichment');
    const vol = (item.deterministic_product_attributes as {
      entries?: Array<{ dimension: string; value: unknown }>;
    })?.entries?.find((e) => e.dimension === 'volume');
    expect(vol?.value).toBe(1500);
  });

  it('gate requires fingerprint match for enriched status', () => {
    expect(
      needsSemanticEnrichment({
        rawName: 'TV BP',
        cachedSemanticStatus: 'enriched',
        cachedSemanticInputFingerprint: 'a',
        currentSemanticInputFingerprint: 'b',
        category: 'uncategorized',
        createdMerchantProduct: true,
      })
    ).toBe(true);

    const hit = evaluateSemanticSufficiency({
      rawName: 'TV BP',
      cachedSemanticStatus: 'enriched',
      cachedSemanticInputFingerprint: 'same',
      currentSemanticInputFingerprint: 'same',
      cachedSemanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
      category: 'uncategorized',
      createdMerchantProduct: true,
    });
    expect(hit.needsEnrichment).toBe(false);
    expect(hit.reasons).toContain('semantic_cache_hit');
  });
});
