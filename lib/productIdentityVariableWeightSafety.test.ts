/**
 * Variable-weight / random-weight meat safety for purchase-unit PPH.
 *
 * Broad lexicon (牛/切/…) remains a weak hint.
 * Strong meat+cut/block morphology may fail-close purchase-unit comparison.
 */

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptAmountBasisAssessment } from './analysisFoundation/types';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import {
  evaluatePriceObservationQuality,
  looksLikeStrongVariableWeightMeatCut,
  looksLikeVariableUnitPriceProduct,
  nameLooksLikeVariableWeightMeatOrCut,
} from './productIdentityPriceObservationQuality';
import {
  buildProductPriceHistory,
  type ProductPriceHistoryRow,
  type ReceiptEvidenceCache,
} from './productPriceHistory';
import type { ReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/types';

function trustedExcludedCache(receiptIds: readonly string[]): ReceiptEvidenceCache {
  const cache: ReceiptEvidenceCache = new Map();
  for (const receiptId of receiptIds) {
    const amountBasisAssessment: ReceiptAmountBasisAssessment = {
      receiptId,
      basis: 'tax_excluded',
      receiptTotal: 2954,
      receiptTax: 218,
      analyticsItemSum: 2736,
      unallocatedDiscountTotal: 0,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: 2954,
      confidence: 'high',
      taxProvenance: 'trusted',
      exactComparisonTrusted: true,
      evidence: [],
      reasonCodes: [],
    };
    const monetaryCoherenceEvidence: ReceiptMonetaryCoherenceEvidence = {
      receiptId,
      state: 'known_coherent',
      authoritativeLayer: 'ocr',
      discountOwnershipStatus: 'resolved',
      monetaryProvenanceSufficient: true,
      closureHypothesis: null,
      evidence: [],
      reasonCodes: [],
    };
    cache.set(receiptId, { amountBasisAssessment, monetaryCoherenceEvidence });
  }
  return cache;
}

function trustedIncludedCache(receiptIds: readonly string[]): ReceiptEvidenceCache {
  const cache: ReceiptEvidenceCache = new Map();
  for (const receiptId of receiptIds) {
    const amountBasisAssessment: ReceiptAmountBasisAssessment = {
      receiptId,
      basis: 'tax_included',
      receiptTotal: 238,
      receiptTax: 18,
      analyticsItemSum: 220,
      unallocatedDiscountTotal: 0,
      expectedTotalIfTaxIncluded: 238,
      expectedTotalIfTaxExcluded: null,
      confidence: 'high',
      taxProvenance: 'trusted',
      exactComparisonTrusted: true,
      evidence: [],
      reasonCodes: [],
    };
    const monetaryCoherenceEvidence: ReceiptMonetaryCoherenceEvidence = {
      receiptId,
      state: 'known_coherent',
      authoritativeLayer: 'ocr',
      discountOwnershipStatus: 'resolved',
      monetaryProvenanceSufficient: true,
      closureHypothesis: null,
      evidence: [],
      reasonCodes: [],
    };
    cache.set(receiptId, { amountBasisAssessment, monetaryCoherenceEvidence });
  }
  return cache;
}

function g3Row(
  partial: Partial<ProductPriceHistoryRow> &
    Pick<ProductPriceHistoryRow, 'receiptId' | 'sourceIndex' | 'displayName'>
): ProductPriceHistoryRow {
  const gross = partial.grossLineAmount ?? partial.lineTotal ?? 200;
  return {
    itemId: `${partial.receiptId}:${partial.sourceIndex}`,
    occurredAt: partial.occurredAt ?? 1_000,
    merchantRaw: partial.merchantRaw ?? 'Store',
    merchantNormalized: partial.merchantNormalized ?? 'store',
    currency: 'JPY',
    lineTotal: gross,
    purchaseQuantity: 1,
    productFamilyKey: partial.productFamilyKey ?? null,
    volumeBaseMl: partial.volumeBaseMl ?? null,
    weightBaseG: null,
    countBase: null,
    skuKey: partial.skuKey ?? `sku-${partial.displayName}`,
    grossLineAmount: gross,
    effectiveLineAmount: partial.effectiveLineAmount ?? gross,
    discountAllocated: partial.discountAllocated ?? 0,
    amountProvenance: 'ocr_observed',
    itemAmountEvidenceState: 'coherent',
    evidenceCaptureVersion: 1,
    priceObservationVersion: 1,
    receiptAnalysisJson: null,
    receiptUserItemsJson: null,
    receiptUserEdited: 0,
    receiptTotal: partial.receiptTotal ?? gross,
    receiptTax: partial.receiptTax ?? 0,
    receiptTaxIsKnown: 1,
    receiptCurrency: 'JPY',
    ...partial,
  };
}

describe('Strong variable-weight meat-cut gate (Receipt063 PPH safety v2)', () => {
  it('CASE A — ギュウカタキリオトシ is strong variable-weight risk', () => {
    expect(looksLikeStrongVariableWeightMeatCut('ギュウカタキリオトシ')).toBe(
      true
    );
    expect(
      looksLikeVariableUnitPriceProduct({ rawName: 'ギュウカタキリオトシ' })
    ).toBe(true);
  });

  it('CASE B/C/J — Receipt063-like item9 is NOT trusted purchase-unit PPH', () => {
    const attrs = normalizeProductForIdentity('ギュウカタキリオトシ').attributes;
    const quality = evaluatePriceObservationQuality({
      lineTotal: 690,
      quantity: 1,
      rawName: 'ギュウカタキリオトシ',
      attributes: attrs,
      peerPurchaseUnitPrices: [],
    });
    expect(quality.quality).not.toBe('trusted');
    expect(quality.quality).toBe('usable_with_caution');
    expect(quality.includeInTrend).toBe(false);
    expect(quality.reasons).toContain('high_variance_variable_price');
    expect(quality.reasons).toEqual(
      expect.arrayContaining([
        'insufficient_history_for_anomaly_check',
        'high_variance_variable_price',
      ])
    );

    const rows = [
      g3Row({
        receiptId: 'r-gyuu-a',
        sourceIndex: 9,
        displayName: 'ギュウカタキリオトシ',
        skuKey: 'sku-gyuu-kiri',
        occurredAt: 1,
        merchantRaw: 'SEIYU',
        merchantNormalized: 'seiyu',
        grossLineAmount: 690,
        effectiveLineAmount: 586,
        discountAllocated: -104,
        receiptTotal: 2954,
        receiptTax: 218,
      }),
      g3Row({
        receiptId: 'r-gyuu-b',
        sourceIndex: 9,
        displayName: 'ギュウカタキリオトシ',
        skuKey: 'sku-gyuu-kiri',
        occurredAt: 2,
        merchantRaw: 'SEIYU',
        merchantNormalized: 'seiyu',
        grossLineAmount: 700,
        effectiveLineAmount: 600,
        discountAllocated: -100,
        receiptTotal: 2954,
        receiptTax: 218,
      }),
      g3Row({
        receiptId: 'r-gyuu-c',
        sourceIndex: 9,
        displayName: 'ギュウカタキリオトシ',
        skuKey: 'sku-gyuu-kiri',
        occurredAt: 3,
        merchantRaw: 'SEIYU',
        merchantNormalized: 'seiyu',
        grossLineAmount: 680,
        effectiveLineAmount: 580,
        discountAllocated: -100,
        receiptTotal: 2954,
        receiptTax: 218,
      }),
    ];
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-gyuu-kiri' },
      rows,
      {
        canonicalDuplicateSelectionApplied: true,
        receiptEvidenceCache: trustedExcludedCache(
          rows.map((row) => row.receiptId)
        ),
      }
    );
    const obs = history.observations.find(
      (entry) => entry.receiptId === 'r-gyuu-a' && entry.sourceIndex === 9
    );
    expect(obs?.qualityLevel).toBe('usable_with_caution');
    expect(obs?.qualityLevel).not.toBe('trusted');
    expect(
      history.points.some(
        (point) =>
          point.receiptId === 'r-gyuu-a' && point.qualityLevel === 'trusted'
      )
    ).toBe(false);
    expect(
      history.points.some(
        (point) => point.receiptId === 'r-gyuu-a' && point.priceValue === 586
      )
    ).toBe(false);
  });

  it('CASE D — ブタカタブロック remains independently fail-closed', () => {
    expect(looksLikeStrongVariableWeightMeatCut('ブタカタブロック')).toBe(true);
    const q = evaluatePriceObservationQuality({
      lineTotal: 651,
      quantity: 1,
      rawName: 'ブタカタブロック',
      peerPurchaseUnitPrices: [],
    });
    expect(q.quality).toBe('usable_with_caution');
    expect(q.reasons).toContain('high_variance_variable_price');
    expect(q.includeInTrend).toBe(false);
  });

  it('CASE E/F — kanji cutdown/block variants remain strong', () => {
    for (const name of [
      '牛肩切り落とし',
      '牛肩切落し',
      '豚肉ブロック',
      '豚肩ブロック',
    ]) {
      expect(looksLikeStrongVariableWeightMeatCut(name)).toBe(true);
      const q = evaluatePriceObservationQuality({
        lineTotal: 500,
        quantity: 1,
        rawName: name,
        peerPurchaseUnitPrices: [],
      });
      expect(q.quality).toBe('usable_with_caution');
      expect(q.reasons).toContain('high_variance_variable_price');
    }
  });

  it('CASE prepared-food — ステーキ/ミンチ are NOT unconditional strong', () => {
    const prepared = [
      'ビーフステーキ弁当',
      'チキンステーキ弁当',
      'ポークステーキ弁当',
      'ミンチカツ',
      '牛肉ミンチカツ',
      'ビーフハンバーグステーキ',
    ];
    for (const name of prepared) {
      expect(looksLikeStrongVariableWeightMeatCut(name)).toBe(false);
      const q = evaluatePriceObservationQuality({
        lineTotal: 498,
        quantity: 1,
        rawName: name,
        peerPurchaseUnitPrices: [],
      });
      // May still be a broad lexical hint, but must not force strong caution.
      expect(q.quality).toBe('trusted');
      expect(q.reasons).not.toContain('high_variance_variable_price');
      expect(q.reasons).toEqual(['insufficient_history_for_anomaly_check']);
    }

    // Production quality path samples.
    for (const name of ['ビーフステーキ弁当', '牛肉ミンチカツ']) {
      const q = evaluatePriceObservationQuality({
        lineTotal: 498,
        quantity: 1,
        rawName: name,
        attributes: normalizeProductForIdentity(name).attributes,
        peerPurchaseUnitPrices: [],
      });
      expect(q.quality).toBe('trusted');
      expect(q.includeInTrend).toBe(true);
    }
  });

  it('CASE G/H/I — milk retains pre-patch trusted behavior (not forced caution)', () => {
    const milks = ['牛乳', '成分無調整牛乳', '明治おいしい牛乳'];
    for (const name of milks) {
      // Broad lexicon may still hit 牛, but must NOT be strong.
      expect(nameLooksLikeVariableWeightMeatOrCut(name)).toBe(true);
      expect(looksLikeStrongVariableWeightMeatCut(name)).toBe(false);

      const alone = evaluatePriceObservationQuality({
        lineTotal: 238,
        quantity: 1,
        rawName: name,
        peerPurchaseUnitPrices: [],
      });
      expect(alone.quality).toBe('trusted');
      expect(alone.reasons).toEqual(['insufficient_history_for_anomaly_check']);
      expect(alone.reasons).not.toContain('high_variance_variable_price');
      expect(alone.includeInTrend).toBe(true);

      const withPeers = evaluatePriceObservationQuality({
        lineTotal: 238,
        quantity: 1,
        rawName: name,
        peerPurchaseUnitPrices: [238, 240, 236],
      });
      // Broad lexicon → high_variance reason, but near-median stays trusted (pre-patch).
      expect(withPeers.reasons).toContain('high_variance_variable_price');
      expect(withPeers.quality).toBe('trusted');
      expect(withPeers.includeInTrend).toBe(true);
    }

    // Production PPH path for 明治おいしい牛乳.
    const rows = [
      g3Row({
        receiptId: 'milk-a',
        sourceIndex: 0,
        displayName: '明治おいしい牛乳',
        skuKey: 'sku-meiji-milk',
        occurredAt: 1,
        grossLineAmount: 238,
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
      }),
      g3Row({
        receiptId: 'milk-b',
        sourceIndex: 0,
        displayName: '明治おいしい牛乳',
        skuKey: 'sku-meiji-milk',
        occurredAt: 2,
        grossLineAmount: 240,
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
      }),
      g3Row({
        receiptId: 'milk-c',
        sourceIndex: 0,
        displayName: '明治おいしい牛乳',
        skuKey: 'sku-meiji-milk',
        occurredAt: 3,
        grossLineAmount: 236,
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
      }),
    ];
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-meiji-milk' },
      rows,
      {
        canonicalDuplicateSelectionApplied: true,
        receiptEvidenceCache: trustedIncludedCache(
          rows.map((row) => row.receiptId)
        ),
      }
    );
    expect(
      history.observations.every((obs) => obs.qualityLevel === 'trusted')
    ).toBe(true);
    expect(
      history.points.some(
        (point) => point.qualityLevel === 'trusted' && point.priceValue === 238
      )
    ).toBe(true);
  });

  it('CASE J — fixed-price animal/cut substrings are not strong signals', () => {
    const negatives = [
      '牛丼',
      '魚肉ソーセージ',
      '切り餅',
      '厚切りポテト',
      '切れてるチーズ',
      'カタログギフト',
      'キリシマ茶',
    ];
    for (const name of negatives) {
      expect(looksLikeStrongVariableWeightMeatCut(name)).toBe(false);
      const q = evaluatePriceObservationQuality({
        lineTotal: 198,
        quantity: 1,
        rawName: name,
        peerPurchaseUnitPrices: [],
      });
      expect(q.quality).toBe('trusted');
      expect(q.reasons).not.toContain('high_variance_variable_price');
    }
  });

  it('strong gate is purchase-unit scoped (spec path not forced)', () => {
    const q = evaluatePriceObservationQuality({
      lineTotal: 120,
      quantity: 1,
      rawName: 'ギュウカタキリオトシ',
      peerPurchaseUnitPrices: [],
      forPurchaseUnitComparison: false,
    });
    // Without purchase-unit strong gate: insufficient peers only → trusted.
    expect(q.quality).toBe('trusted');
    expect(q.reasons).toEqual(['insufficient_history_for_anomaly_check']);
  });
});
