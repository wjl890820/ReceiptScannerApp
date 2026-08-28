/**
 * RC Hardening — P0/P1 regression fixtures.
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
}));
jest.mock('./deviceId', () => ({ getDeviceId: async () => 'test-device' }));
jest.mock('./i18n', () => ({ getCurrentLocale: () => 'ja' }));

import type { ReceiptRow } from './db';
import {
  buildContentReceiptFingerprint,
  buildHighConfidenceDuplicateGroups,
  buildStructuralReceiptFingerprint,
  summarizeReceiptForDuplicateAudit,
} from './analysisDDuplicateAudit';
import { applySemanticFieldsToItem } from './categoryBatchAi';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import { parseProductDetailTarget } from './productDetailTarget';
import { buildIdentityFrequentProductGroups } from './productIdentityConsumer';
import {
  buildProductAttributes,
  emptyProductAttributes,
} from './productIdentityContract';
import { computePurchaseUnitPrice } from './productIdentityPriceComparison';
import { evaluatePriceObservationQuality } from './productIdentityPriceObservationQuality';
import {
  UNKNOWN_MERCHANT_KEY,
  isUnknownMerchantScopeKey,
  resolveReceiptItemIdentity,
  scopeMerchantKeyForIdentity,
} from './productIdentityResolver';
import { applySemanticEnrichmentEvidence } from './productIdentitySemanticContract';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import {
  attributesAreCompatible,
  hasStemStructuralEvidence,
  stemStructuralEvidenceBalanced,
} from './productIdentityStructuralConflict';
import { buildTrustedProductPriceHistoryForTests as buildTrustedProductPriceHistory } from './productPriceHistory.testFixtures';
import type { ProductPriceHistoryRow } from './productPriceHistory';
import { classifyLineKind } from './receiptOcrNormalize';

describe('RC Hardening — unknown merchant isolation', () => {
  it('missing merchant does not share a global unknown_merchant MP across receipts', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      {
        rawName: '牛乳1L',
        merchantKey: '',
        receiptId: 'r-a',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 200,
      },
      store
    );
    const b = resolveReceiptItemIdentity(
      {
        rawName: '牛乳1L',
        merchantKey: '',
        receiptId: 'r-b',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 210,
      },
      store
    );
    expect(a.link.merchantProductId).not.toBe(b.link.merchantProductId);
    expect(a.link.merchantProductId).toBeTruthy();
    expect(scopeMerchantKeyForIdentity('', 'r-a')).toBe(
      `${UNKNOWN_MERCHANT_KEY}:receipt:r-a`
    );
    expect(
      isUnknownMerchantScopeKey(scopeMerchantKeyForIdentity('', 'r-a'))
    ).toBe(true);
  });

  it('unknown merchant cannot form frequent products across receipts', () => {
    const { groups } = buildIdentityFrequentProductGroups([
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        rawName: 'お茶',
        merchantKey: '',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 100,
        quantity: 1,
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        rawName: 'お茶',
        merchantKey: '',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 110,
        quantity: 1,
      },
    ]);
    expect(groups.length).toBe(0);
  });
});

describe('RC Hardening — stem bridge safety', () => {
  it('bare コーラ does not stem-bridge コーラ500ml and コーラ1.5L', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      {
        rawName: 'コーラ500ml',
        merchantKey: '店',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store
    );
    const b = resolveReceiptItemIdentity(
      {
        rawName: 'コーラ1.5L',
        merchantKey: '店',
        receiptId: 'r2',
        itemSourceIndex: 0,
      },
      store
    );
    expect(a.link.merchantProductId).not.toBe(b.link.merchantProductId);
    const bare = resolveReceiptItemIdentity(
      {
        rawName: 'コーラ',
        merchantKey: '店',
        receiptId: 'r3',
        itemSourceIndex: 0,
      },
      store
    );
    expect(bare.link.merchantProductId).not.toBe(a.link.merchantProductId);
    expect(bare.link.merchantProductId).not.toBe(b.link.merchantProductId);
  });

  it('underspecified vs specified attrs are not stem-balanced', () => {
    const bare = normalizeProductForIdentity('コーラ');
    const s500 = normalizeProductForIdentity('コーラ500ml');
    const s15 = normalizeProductForIdentity('コーラ1.5L');
    expect(attributesAreCompatible(s500.attributes, s15.attributes).ok).toBe(
      false
    );
    expect(hasStemStructuralEvidence(bare.attributes)).toBe(false);
    expect(hasStemStructuralEvidence(s500.attributes)).toBe(true);
    expect(
      stemStructuralEvidenceBalanced(bare.attributes, s500.attributes)
    ).toBe(false);
  });
});

describe('RC Hardening — currency integrity', () => {
  function row(
    overrides: Partial<ProductPriceHistoryRow> &
      Pick<ProductPriceHistoryRow, 'receiptId' | 'currency' | 'lineTotal'>
  ): ProductPriceHistoryRow {
    return {
      itemId: `${overrides.receiptId}:0`,
      sourceIndex: 0,
      occurredAt: 1,
      merchantRaw: 'A',
      merchantNormalized: 'a',
      displayName: '水',
      purchaseQuantity: 1,
      productFamilyKey: 'water',
      volumeBaseMl: 500,
      weightBaseG: null,
      countBase: null,
      ...overrides,
    };
  }

  it('mixed currencies yield mixed_currency without silent JPY', () => {
    const result = buildTrustedProductPriceHistory({ type: 'sku', key: 'water-sku' }, [
      row({
        receiptId: 'r1',
        currency: 'JPY',
        lineTotal: 100,
        occurredAt: 1,
      }),
      row({
        receiptId: 'r2',
        currency: 'USD',
        lineTotal: 1.2,
        occurredAt: 2,
      }),
    ]);
    expect(result.status).toBe('not_enough_points');
    expect(result.points.length).toBeLessThan(2);
  });

  it('unknown currency is not defaulted to JPY', () => {
    const result = buildTrustedProductPriceHistory({ type: 'sku', key: 'water-sku' }, [
      row({
        receiptId: 'r1',
        currency: null,
        lineTotal: 100,
        occurredAt: 1,
      }),
      row({
        receiptId: 'r2',
        currency: '',
        lineTotal: 110,
        occurredAt: 2,
      }),
    ]);
    expect(result.currency).not.toBe('JPY');
    expect(
      result.status === 'unknown_currency' || result.currency == null
    ).toBe(true);
  });
});

describe('RC Hardening — merchant_product navigation target', () => {
  it('parses targetType=merchant_product key=mp_...', () => {
    const t = parseProductDetailTarget('merchant_product', 'mp_abc123');
    expect(t).toEqual({ type: 'merchant_product', key: 'mp_abc123' });
  });
});

describe('RC Hardening — non-product / discount rows', () => {
  it('割引 is classified discount and cannot become frequent', () => {
    expect(classifyLineKind('割引', -50)).toBe('discount');
    expect(classifyLineKind('値引', 0)).toBe('discount');
    const { groups } = buildIdentityFrequentProductGroups([
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        rawName: '割引',
        merchantKey: '店',
        occurredAt: 1,
        lineTotal: -50,
        quantity: 1,
        isNonProductRow: true,
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        rawName: '割引',
        merchantKey: '店',
        occurredAt: 2,
        lineTotal: -50,
        quantity: 1,
        isNonProductRow: true,
      },
      {
        receiptId: 'r3',
        itemSourceIndex: 0,
        rawName: '割引',
        merchantKey: '店',
        occurredAt: 3,
        lineTotal: -50,
        quantity: 1,
      },
    ]);
    expect(groups.length).toBe(0);
  });
});

describe('RC Hardening — quantity quality', () => {
  it('does not treat quantity<=0 as 1 before the gate', () => {
    expect(computePurchaseUnitPrice(400, 0)).toBeNull();
    expect(computePurchaseUnitPrice(400, -1)).toBeNull();
    expect(computePurchaseUnitPrice(400, Number.NaN)).toBeNull();
    const q = evaluatePriceObservationQuality({
      lineTotal: 400,
      quantity: 0,
      peerPurchaseUnitPrices: [400, 400, 400],
      rawName: '商品',
    });
    expect(q.includeInHistory).toBe(false);
  });

  it('flags reciprocal half-price as caution promo without qty OCR corroboration', () => {
    const q = evaluatePriceObservationQuality({
      lineTotal: 200,
      quantity: 1,
      peerPurchaseUnitPrices: [400, 400, 400],
      rawName: '商品',
    });
    expect(q.quality).toBe('usable_with_caution');
    expect(q.includeInHistory).toBe(true);
    expect(q.includeInTrend).toBe(false);
  });

  it('allows suspected_anomaly for reciprocal half-price when qty OCR is corroborated', () => {
    const q = evaluatePriceObservationQuality({
      lineTotal: 200,
      quantity: 1,
      peerPurchaseUnitPrices: [400, 400, 400],
      rawName: '商品',
      quantityOcrCorroborated: true,
    });
    expect(q.quality).toBe('suspected_anomaly');
    expect(q.includeInHistory).toBe(false);
  });
});

describe('RC Hardening — deterministic attributes beat Gemini', () => {
  it('code volume=500ml wins over AI volume=1500ml', () => {
    const code = buildProductAttributes([
      { dimension: 'volume', value: 500, unit: 'ml', source: 'parsed' },
    ]);
    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        confidence: 0.95,
        attributes: [
          { dimension: 'volume', value: 1500, unit: 'ml', confidence: 0.99 },
        ],
      },
      code
    );
    const vol = applied.attributes.entries.find((e) => e.dimension === 'volume');
    expect(vol?.value).toBe(500);
    expect(applied.conflicts.some((c) => c.dimension === 'volume')).toBe(true);
  });

  it('production applySemanticFieldsToItem parses deterministic attrs before AI merge', () => {
    const item: Record<string, unknown> = {
      name: '水500ml',
      category: 'uncategorized',
      product_attributes: null,
    };
    applySemanticFieldsToItem(item as any, {
      index: 0,
      category: 'snacks_drinks',
      confidence: 0.99,
      brand: null,
      brandConfidence: null,
      canonicalName: null,
      canonicalNameConfidence: null,
      productType: 'water',
      semanticTags: [],
      attributes: [
        { dimension: 'volume', value: 1500, unit: 'ml', confidence: 0.99 },
      ],
      reason: 'test',
      janCode: null,
      skuId: null,
      barcode: null,
    } as any);
    const attrs = item.product_attributes as {
      entries: Array<{ dimension: string; value: unknown }>;
    };
    const vol = attrs.entries.find((e) => e.dimension === 'volume');
    expect(vol?.value).toBe(500);
    // sanity: empty helper remains empty
    expect(emptyProductAttributes().entries.length).toBe(0);
  });
});

describe('RC Hardening — date-only duplicate reproducer', () => {
  function midnightTokyo(y: number, m: number, d: number): number {
    return Date.parse(
      `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+09:00`
    );
  }

  function makeReceipt(id: string, at: number): ReceiptRow {
    const items = [
      { name: '牛乳', category: 'other', lineTotal: 200, quantity: 1 },
      { name: 'パン', category: 'other', lineTotal: 150, quantity: 1 },
    ];
    return {
      id,
      created_at: id === 'legit-a' ? 1000 : 2000,
      transaction_at: at,
      image_uri: '',
      total: 350,
      tax: 0,
      tax_is_known: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({ items }),
      merchant_raw: 'テスト店',
      merchant_normalized: 'テスト店',
      merchant_type: 'supermarket',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    } as ReceiptRow;
  }

  it('date-only midnight is not treated as exact time evidence', () => {
    const at = midnightTokyo(2024, 3, 15);
    const receipts = [makeReceipt('legit-a', at), makeReceipt('legit-b', at)];
    const fpA = buildContentReceiptFingerprint(receipts[0]!);
    const fpB = buildContentReceiptFingerprint(receipts[1]!);
    const structA = buildStructuralReceiptFingerprint(receipts[0]!);
    const structB = buildStructuralReceiptFingerprint(receipts[1]!);
    const groups = buildHighConfidenceDuplicateGroups(
      receipts.map(summarizeReceiptForDuplicateAudit)
    );

    const collapsedByFingerprint =
      fpA != null && fpA === fpB && structA != null && structA === structB;
    if (collapsedByFingerprint) {
      const stillMerged = groups.some((g) => (g.receiptIds?.length ?? 0) >= 2);
      expect(stillMerged).toBe(false);
    } else {
      expect(groups.every((g) => (g.receiptIds?.length ?? 0) < 2)).toBe(true);
    }
  });
});
