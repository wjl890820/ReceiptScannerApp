/**
 * Product Identity Batch 5B — quality gate + consumer unit tests.
 */

import {
  evaluateMerchantProductHistoryEligibility,
  evaluatePriceObservationQuality,
} from './productIdentityPriceObservationQuality';
import {
  buildIdentityFrequentProductGroups,
  resolveIdentityConsumerObservations,
  tryBuildIdentityPriceHistoryForRows,
} from './productIdentityConsumer';
import { resolvePricePresentation } from './productIdentityPresentationContract';
import { computeNormalizedUnitPrice } from './productIdentityPriceComparison';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';

describe('Product Identity Batch 5B — price quality gate', () => {
  it('397,397,794 → 794 suspected quantity OCR anomaly; excluded from trend', () => {
    const anomalous = evaluatePriceObservationQuality({
      lineTotal: 794,
      quantity: 1,
      peerPurchaseUnitPrices: [397, 397, 398],
      rawName: '横浜家系',
    });
    expect(anomalous.quality).toBe('suspected_anomaly');
    expect(anomalous.includeInTrend).toBe(false);
    expect(anomalous.includeInHistory).toBe(false);
    expect(anomalous.suspectedIntegerMultiple).toBe(2);
  });

  it('legit jump 200→220→300 is not auto-excluded solely for magnitude', () => {
    const jump = evaluatePriceObservationQuality({
      lineTotal: 300,
      quantity: 1,
      peerPurchaseUnitPrices: [200, 220, 210],
      rawName: '普通商品',
    });
    expect(jump.quality).not.toBe('suspected_anomaly');
    expect(jump.includeInHistory).toBe(true);
  });

  it('singleton: not priceHistoryEligible', () => {
    const e = evaluateMerchantProductHistoryEligibility({
      merchantProductId: 'mp1',
      observations: [{ occurredAt: 1, quality: 'trusted' }],
    });
    expect(e.priceHistoryEligible).toBe(false);
    expect(e.trendInsightEligible).toBe(false);
  });

  it('3 trusted on 2+ days → history + trend eligible', () => {
    const e = evaluateMerchantProductHistoryEligibility({
      merchantProductId: 'mp1',
      observations: [
        { occurredAt: Date.parse('2026-01-01'), quality: 'trusted' },
        { occurredAt: Date.parse('2026-02-01'), quality: 'trusted' },
        { occurredAt: Date.parse('2026-03-01'), quality: 'trusted' },
      ],
    });
    expect(e.priceHistoryEligible).toBe(true);
    expect(e.simpleDeltaEligible).toBe(true);
    expect(e.trendInsightEligible).toBe(true);
  });

  it('presentation: same_merchant_product forbids cross-merchant claim', () => {
    const copy = resolvePricePresentation('same_merchant_product');
    expect(copy.allowsCrossMerchantClaim).toBe(false);
    expect(copy.strength).toBe('merchant_local');
  });
});

describe('Product Identity Batch 5B — frequent + history consumers', () => {
  it('OCR name variants of same MP collapse to one frequent group', () => {
    const { groups } = buildIdentityFrequentProductGroups([
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        rawName: '東北恵牛乳1L',
        merchantKey: 'ヨークベニマル',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 200,
        quantity: 1,
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        rawName: '東北恵 牛乳1000ML',
        merchantKey: 'ヨークベニマル',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 210,
        quantity: 1,
      },
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.distinctReceiptCount).toBe(2);
  });

  it('ZERO vs original stay separate frequent groups', () => {
    const { groups } = buildIdentityFrequentProductGroups([
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        rawName: 'コカコーラZERO500ml',
        merchantKey: '店',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 150,
        quantity: 1,
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        rawName: 'コカコーラZERO500ml',
        merchantKey: '店',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 150,
        quantity: 1,
      },
      {
        receiptId: 'r3',
        itemSourceIndex: 0,
        rawName: 'コカコーラ500ml',
        merchantKey: '店',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 140,
        quantity: 1,
      },
      {
        receiptId: 'r4',
        itemSourceIndex: 0,
        rawName: 'コカコーラ500ml',
        merchantKey: '店',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 140,
        quantity: 1,
      },
    ]);
    expect(groups.length).toBe(2);
  });

  it('same text at different merchants → separate MP groups', () => {
    const { groups } = buildIdentityFrequentProductGroups([
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        rawName: '牛乳1L',
        merchantKey: 'ヨークベニマル',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 200,
        quantity: 1,
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        rawName: '牛乳1L',
        merchantKey: 'ヨークベニマル',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 200,
        quantity: 1,
      },
      {
        receiptId: 'r3',
        itemSourceIndex: 0,
        rawName: '牛乳1L',
        merchantKey: 'イオン',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 198,
        quantity: 1,
      },
      {
        receiptId: 'r4',
        itemSourceIndex: 0,
        rawName: '牛乳1L',
        merchantKey: 'イオン',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 198,
        quantity: 1,
      },
    ]);
    expect(groups.length).toBe(2);
    expect(new Set(groups.map((g) => g.merchantKey)).size).toBe(2);
  });

  it('identity history suppresses 794-style anomaly from trend points', () => {
    const rows = [
      {
        receiptId: 'r1',
        itemId: 'i1',
        sourceIndex: 0,
        occurredAt: Date.parse('2026-01-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        currency: 'JPY',
        lineTotal: 397,
        purchaseQuantity: 1,
      },
      {
        receiptId: 'r2',
        itemId: 'i2',
        sourceIndex: 0,
        occurredAt: Date.parse('2026-02-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        currency: 'JPY',
        lineTotal: 397,
        purchaseQuantity: 1,
      },
      {
        receiptId: 'r3',
        itemId: 'i3',
        sourceIndex: 0,
        occurredAt: Date.parse('2026-03-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        currency: 'JPY',
        lineTotal: 386,
        purchaseQuantity: 1,
      },
      {
        receiptId: 'r4',
        itemId: 'i4',
        sourceIndex: 0,
        occurredAt: Date.parse('2026-04-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        currency: 'JPY',
        lineTotal: 794,
        purchaseQuantity: 1,
      },
    ];
    const view = tryBuildIdentityPriceHistoryForRows(rows);
    expect(view).not.toBeNull();
    expect(view!.priceHistoryEligible).toBe(true);
    const trendPrices = view!.trendPoints.map((p) => p.purchaseUnitPrice);
    expect(trendPrices).not.toContain(794);
    expect(view!.stats.suspectedAnomalyCount).toBeGreaterThanOrEqual(1);
  });

  it('unit price volume/mass/count still works via attributes', () => {
    const volume = computeNormalizedUnitPrice(
      257,
      1,
      normalizeProductForIdentity('牛乳1L').attributes
    );
    expect(volume?.dimension).toBe('volume');
    const mass = computeNormalizedUnitPrice(
      500,
      1,
      normalizeProductForIdentity('砂糖500g').attributes
    );
    expect(mass?.dimension).toBe('mass');
    const count = computeNormalizedUnitPrice(
      300,
      1,
      normalizeProductForIdentity('卵10個').attributes
    );
    expect(count?.dimension).toBe('count');
  });

  it('duplicate receipt exclusion is upstream — consumer sees distinct receiptIds only', () => {
    const { qualified } = resolveIdentityConsumerObservations([
      {
        receiptId: 'kept',
        itemSourceIndex: 0,
        rawName: '商品A',
        merchantKey: '店',
        occurredAt: 1,
        lineTotal: 100,
        quantity: 1,
      },
      {
        receiptId: 'kept',
        itemSourceIndex: 1,
        rawName: '商品B',
        merchantKey: '店',
        occurredAt: 1,
        lineTotal: 200,
        quantity: 1,
      },
    ]);
    expect(new Set(qualified.map((q) => q.receiptId))).toEqual(new Set(['kept']));
  });

  it('Frequent group: 18 distinct purchases + cumulative qty 47 (横浜家系-style)', () => {
    const observations = Array.from({ length: 18 }, (_, i) => ({
      receiptId: `r${i + 1}`,
      itemSourceIndex: 0,
      rawName: '横浜家系',
      merchantKey: 'ラーメン店',
      occurredAt: Date.parse('2026-01-01') + i * 86_400_000,
      lineTotal: 800,
      // 17×1 + 1×30 = 47
      quantity: i === 0 ? 30 : 1,
    }));
    const { groups } = buildIdentityFrequentProductGroups(observations);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.distinctReceiptCount).toBe(18);
    expect(groups[0]!.totalPurchaseQuantity).toBe(47);
  });

  it('propagates resolver identity metadata through qualified observations', () => {
    const { qualified } = resolveIdentityConsumerObservations([
      {
        receiptId: 'r1',
        itemSourceIndex: 0,
        rawName: '東北恵牛乳1L',
        merchantKey: 'ヨークベニマル',
        occurredAt: 1,
        lineTotal: 238,
        quantity: 1,
      },
      {
        receiptId: 'r2',
        itemSourceIndex: 0,
        rawName: '東北恵 牛乳１０００ＭＬ',
        merchantKey: 'ヨークベニマル',
        occurredAt: 2,
        lineTotal: 248,
        quantity: 1,
      },
    ]);
    expect(qualified.length).toBeGreaterThan(0);
    for (const row of qualified) {
      expect(row.identityLevel).toBeTruthy();
      expect(typeof row.identityConfidence).toBe('number');
      expect(row.identitySource).toBeTruthy();
      expect(row.merchantScopeKey).toBeTruthy();
    }
    expect(qualified[0]!.merchantProductId).toBe(qualified[1]!.merchantProductId);
  });
});
