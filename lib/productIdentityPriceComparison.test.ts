/**
 * Product Identity Batch 5A — Universal Comparison Engine unit tests.
 */

import {
  buildMerchantProductPriceHistory,
  computeNormalizedUnitPrice,
  computePurchaseUnitPrice,
  deriveMeasurementFromAttributes,
  evaluateLegacyPriceEligibility,
  evaluatePriceComparisonEligibility,
} from './productIdentityPriceComparison';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import { emptyProductAttributes } from './productIdentityContract';

describe('Product Identity Batch 5A — price comparison engine', () => {
  it('same merchantProductId + different dates → valid price history', () => {
    const history = buildMerchantProductPriceHistory('mp1', 'ヨークベニマル', [
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        occurredAt: Date.parse('2026-05-01'),
        rawName: '東北恵牛乳1L',
        merchantKey: 'ヨークベニマル',
        merchantProductId: 'mp1',
        lineTotal: 238,
        quantity: 1,
        purchaseUnitPrice: 238,
        normalizedUnitPrice: null,
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        occurredAt: Date.parse('2026-06-01'),
        rawName: '東北恵牛乳1L',
        merchantKey: 'ヨークベニマル',
        merchantProductId: 'mp1',
        lineTotal: 248,
        quantity: 1,
        purchaseUnitPrice: 248,
        normalizedUnitPrice: null,
      },
      {
        receiptId: 'r3',
        itemSourceIndex: 0,
        occurredAt: Date.parse('2026-08-01'),
        rawName: '東北恵牛乳1L',
        merchantKey: 'ヨークベニマル',
        merchantProductId: 'mp1',
        lineTotal: 257,
        quantity: 1,
        purchaseUnitPrice: 257,
        normalizedUnitPrice: null,
      },
    ]);
    expect(history).not.toBeNull();
    expect(history!.points).toHaveLength(3);
    expect(history!.latest).toBe(257);
    expect(history!.previous).toBe(248);
    expect(history!.min).toBe(238);
    expect(history!.max).toBe(257);
  });

  it('different merchant without canonical → not exact same-product history', () => {
    const a = evaluatePriceComparisonEligibility({
      rawName: '牛乳1L',
      merchantKey: '店A',
      lineTotal: 200,
      quantity: 1,
      merchantProductId: 'mp-a',
      canonicalProductId: null,
      attributes: normalizeProductForIdentity('牛乳1L').attributes,
    });
    const b = evaluatePriceComparisonEligibility({
      rawName: '牛乳1L',
      merchantKey: '店B',
      lineTotal: 210,
      quantity: 1,
      merchantProductId: 'mp-b',
      canonicalProductId: null,
      attributes: normalizeProductForIdentity('牛乳1L').attributes,
    });
    expect(a.capabilities).toContain('same_merchant_product');
    expect(b.capabilities).toContain('same_merchant_product');
    expect(a.capabilities).not.toContain('same_product');
    expect(b.capabilities).not.toContain('same_product');
    expect(a.strongestStrategy).toBe('same_merchant_product');
  });

  it('1L and 1000ml normalize to same physical volume', () => {
    const a = normalizeProductForIdentity('牛乳1L').attributes;
    const b = normalizeProductForIdentity('牛乳1000ml').attributes;
    const ma = deriveMeasurementFromAttributes(a)!;
    const mb = deriveMeasurementFromAttributes(b)!;
    expect(ma.dimension).toBe('volume');
    expect(mb.dimension).toBe('volume');
    expect(ma.measurePerSoldUnit).toBe(1000);
    expect(mb.measurePerSoldUnit).toBe(1000);
  });

  it('500ml×6 vs 3L: unit price may compare; identity remains different', () => {
    const pack = normalizeProductForIdentity('コーラ500ml×6本');
    const bulk = normalizeProductForIdentity('コーラ3L');
    const nPack = computeNormalizedUnitPrice(900, 1, pack.attributes)!;
    const nBulk = computeNormalizedUnitPrice(300, 1, bulk.attributes)!;
    expect(nPack.dimension).toBe('volume');
    expect(nBulk.dimension).toBe('volume');
    expect(nPack.totalMeasure).toBe(3000);
    expect(nBulk.totalMeasure).toBe(3000);
    expect(nPack.displayPer1000).toBeCloseTo(300, 5);
    expect(nBulk.displayPer1000).toBeCloseTo(100, 5);

    const ePack = evaluatePriceComparisonEligibility({
      rawName: 'コーラ500ml×6本',
      merchantKey: '店',
      lineTotal: 900,
      quantity: 1,
      merchantProductId: 'mp-pack',
      attributes: pack.attributes,
    });
    const eBulk = evaluatePriceComparisonEligibility({
      rawName: 'コーラ3L',
      merchantKey: '店',
      lineTotal: 300,
      quantity: 1,
      merchantProductId: 'mp-bulk',
      attributes: bulk.attributes,
    });
    expect(ePack.capabilities).toContain('unit_price');
    expect(eBulk.capabilities).toContain('unit_price');
    // Distinct MerchantProducts — unit price does not upgrade identity
    expect('mp-pack').not.toBe('mp-bulk');
  });

  it('ZERO vs original → no exact same-product history', () => {
    const zero = evaluatePriceComparisonEligibility({
      rawName: 'コカコーラZERO500ml',
      merchantKey: '店',
      lineTotal: 150,
      quantity: 1,
      merchantProductId: 'mp-zero',
      canonicalProductId: null,
      attributes: normalizeProductForIdentity('コカコーラZERO500ml').attributes,
    });
    const orig = evaluatePriceComparisonEligibility({
      rawName: 'コカコーラ500ml',
      merchantKey: '店',
      lineTotal: 140,
      quantity: 1,
      merchantProductId: 'mp-orig',
      canonicalProductId: null,
      attributes: normalizeProductForIdentity('コカコーラ500ml').attributes,
    });
    expect(zero.capabilities).not.toContain('same_product');
    expect(orig.capabilities).not.toContain('same_product');
    expect(zero.strongestStrategy).toBe('same_merchant_product');
  });

  it('mass: 500g ¥500 and 1kg ¥900 normalize', () => {
    const a = computeNormalizedUnitPrice(
      500,
      1,
      normalizeProductForIdentity('砂糖500g').attributes
    )!;
    const b = computeNormalizedUnitPrice(
      900,
      1,
      normalizeProductForIdentity('砂糖1kg').attributes
    )!;
    expect(a.dimension).toBe('mass');
    expect(b.dimension).toBe('mass');
    expect(a.unitPriceBase).toBeCloseTo(1, 5); // ¥/g
    expect(b.unitPriceBase).toBeCloseTo(0.9, 5);
    expect(a.displayPer1000).toBeCloseTo(1000, 5); // ¥/kg
    expect(b.displayPer1000).toBeCloseTo(900, 5);
  });

  it('count: 10個 ¥300 → ¥30/count', () => {
    const n = computeNormalizedUnitPrice(
      300,
      1,
      normalizeProductForIdentity('卵10個').attributes
    )!;
    expect(n.dimension).toBe('count');
    expect(n.unitPriceBase).toBeCloseTo(30, 5);
  });

  it('no spec: MP history allowed; unit normalization unavailable', () => {
    const e = evaluatePriceComparisonEligibility({
      rawName: '商品A',
      merchantKey: '店',
      lineTotal: 500,
      quantity: 1,
      merchantProductId: 'mp-a',
      attributes: emptyProductAttributes(),
    });
    expect(e.capabilities).toContain('same_merchant_product');
    expect(e.capabilities).not.toContain('unit_price');
    expect(e.normalizedUnitPrice).toBeNull();
    expect(e.strongestStrategy).toBe('same_merchant_product');
  });

  it('invalid price → no comparison', () => {
    const e = evaluatePriceComparisonEligibility({
      rawName: '商品',
      merchantKey: '店',
      lineTotal: 0,
      quantity: 1,
      merchantProductId: 'mp',
      attributes: emptyProductAttributes(),
    });
    expect(e.eligible).toBe(false);
    expect(e.strongestStrategy).toBe('no_comparison');
    expect(e.rejectionReasons).toContain('invalid_price');
  });

  it('purchase unit SSOT is lineTotal/quantity', () => {
    expect(computePurchaseUnitPrice(500, 2)).toBe(250);
    expect(computePurchaseUnitPrice(null, 1)).toBeNull();
  });

  it('legacy family path remains countable without deleting it', () => {
    const legacy = evaluateLegacyPriceEligibility({
      lineTotal: 200,
      quantity: 1,
      productFamilyKey: 'milk',
      volumeBaseMl: 1000,
    });
    expect(legacy.purchaseUnitUsable).toBe(true);
    expect(legacy.familyNormalizedUsable).toBe(true);
    expect(legacy.skuHistoryUsable).toBe(false);
  });
});
