/**
 * G3 / Product Price History gross comparison amount-basis trust.
 * Narrow exception for resolved receipt-level unallocated discount.
 */
/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from '../db';
import {
  assessReceiptAmountBasis,
  isGrossPriceComparisonAmountBasisTrusted,
} from './amountBasis';
import type { ReceiptAmountBasisAssessment } from './types';
import {
  buildProductPriceHistory,
  buildReceiptEvidenceCache,
} from '../productPriceHistory';
import { makeTrustedG3TestRow } from '../productPriceHistory.testFixtures';

function makeReceipt(args: {
  id: string;
  tax: number;
  taxIsKnown: number;
  total: number;
  items: Array<{ name: string; lineTotal: number; quantity?: number }>;
  discounts?: Array<{ label: string; amount: number }>;
  analysisExtras?: Record<string, unknown>;
}): ReceiptRow {
  const analysis = {
    items: args.items,
    tax: args.tax,
    total: args.total,
    discounts: args.discounts ?? [],
    reconciliation: { ok: true },
    amount_mismatch: false,
    ...args.analysisExtras,
  };
  return {
    id: args.id,
    created_at: Date.now(),
    transaction_at: Date.parse('2024-06-01T12:00:00+09:00'),
    image_uri: '',
    total: args.total,
    tax: args.tax,
    tax_is_known: args.taxIsKnown,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    recognition_snapshot_json: null,
  } as ReceiptRow;
}

function fakeAssessment(
  overrides: Partial<ReceiptAmountBasisAssessment>
): ReceiptAmountBasisAssessment {
  return {
    receiptId: 'fake',
    basis: 'tax_excluded',
    receiptTotal: 1000,
    receiptTax: 80,
    analyticsItemSum: 1000,
    unallocatedDiscountTotal: 0,
    expectedTotalIfTaxIncluded: 1000,
    expectedTotalIfTaxExcluded: 1080,
    confidence: 'high',
    taxProvenance: 'trusted',
    exactComparisonTrusted: true,
    evidence: [],
    reasonCodes: [],
    ...overrides,
  };
}

function couponClosingRow(
  id: string,
  occurredAt: number,
  gross: number
): ReturnType<typeof makeTrustedG3TestRow> {
  // items gross, receipt-level coupon unbound, tax-excluded unique close:
  // analyticsItemSum=gross, unallocated=-100, +tax → total
  const tax = 72;
  const coupon = -100;
  const total = gross + coupon + tax;
  const analysis = {
    items: [{ name: '牛乳', lineTotal: gross, quantity: 1 }],
    discounts: [{ label: '店舗クーポン共通', amount: coupon }],
    tax,
    total,
    reconciliation: { ok: true },
    amount_mismatch: false,
  };
  return makeTrustedG3TestRow(id, {
    receiptId: id,
    occurredAt,
    displayName: '牛乳',
    grossLineAmount: gross,
    lineTotal: gross,
    purchaseQuantity: 1,
    receiptTotal: total,
    receiptTax: tax,
    receiptTaxIsKnown: 1,
    receiptAnalysisJson: JSON.stringify(analysis),
    skuKey: 'sku-milk',
    volumeBaseMl: 1000,
    productFamilyKey: 'milk',
    identitySource: 'normalized_exact',
    identityConfidence: 1,
  });
}

describe('isGrossPriceComparisonAmountBasisTrusted', () => {
  it('1 — baseline high+exact remains trusted for gross', () => {
    const r = makeReceipt({
      id: 'base',
      tax: 80,
      taxIsKnown: 1,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.confidence).toBe('high');
    expect(a.exactComparisonTrusted).toBe(true);
    expect(isGrossPriceComparisonAmountBasisTrusted(a)).toBe(true);
  });

  it('2 — medium solely from unallocated discount → generic exact false, gross trust true', () => {
    const r = makeReceipt({
      id: 'coupon',
      tax: 72,
      taxIsKnown: 1,
      total: 972,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      discounts: [{ label: '店舗クーポン共通', amount: -100 }],
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('tax_excluded');
    expect(a.confidence).toBe('medium');
    expect(a.exactComparisonTrusted).toBe(false);
    expect(a.evidence).toContain('unallocated_discount_present');
    expect(Math.abs(a.unallocatedDiscountTotal)).toBeGreaterThan(2);
    expect(isGrossPriceComparisonAmountBasisTrusted(a)).toBe(true);
  });

  it('3 — medium without unallocated marker must NOT gross-trust', () => {
    const forged = fakeAssessment({
      confidence: 'medium',
      exactComparisonTrusted: false,
      unallocatedDiscountTotal: -100,
      evidence: ['some_other_medium_reason'],
    });
    expect(isGrossPriceComparisonAmountBasisTrusted(forged)).toBe(false);
  });

  it('4 — medium marker but unallocated within tolerance must NOT gross-trust', () => {
    const forged = fakeAssessment({
      confidence: 'medium',
      exactComparisonTrusted: false,
      unallocatedDiscountTotal: -1,
      evidence: ['unallocated_discount_present'],
    });
    expect(isGrossPriceComparisonAmountBasisTrusted(forged)).toBe(false);
  });

  it('5 — tax provenance untrusted → gross trust false', () => {
    const r = makeReceipt({
      id: 'tax-u',
      tax: 72,
      taxIsKnown: 0,
      total: 972,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      discounts: [{ label: '店舗クーポン共通', amount: -100 }],
      analysisExtras: { tax: 0 },
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.taxProvenance).toBe('untrusted');
    expect(isGrossPriceComparisonAmountBasisTrusted(a)).toBe(false);
  });

  it('6 — aggregate ambiguous → gross trust false', () => {
    const r = makeReceipt({
      id: 'ambig',
      tax: 152,
      taxIsKnown: 1,
      total: 2052,
      items: [{ name: '商品A', lineTotal: 2000 }],
      discounts: [
        { label: 'クーポンA', amount: -100 },
        { label: '値引合計', amount: -100 },
      ],
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('aggregate_discount_summary_ambiguous');
    expect(isGrossPriceComparisonAmountBasisTrusted(a)).toBe(false);
  });

  it('7 — both hypotheses close → gross trust false', () => {
    // Construct via forged unknown assessment (product path returns unknown)
    const forged = fakeAssessment({
      basis: 'unknown',
      confidence: 'unknown',
      exactComparisonTrusted: false,
      unallocatedDiscountTotal: -100,
      evidence: ['unallocated_discount_present', 'reason=ambiguous_both_hypotheses_close'],
      reasonCodes: ['ambiguous_both_hypotheses_close'],
    });
    expect(isGrossPriceComparisonAmountBasisTrusted(forged)).toBe(false);
  });

  it('8 — neither hypothesis closes → gross trust false', () => {
    const r = makeReceipt({
      id: 'neither',
      tax: 80,
      taxIsKnown: 1,
      total: 2000,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      discounts: [{ label: '店舗クーポン共通', amount: -100 }],
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('neither_hypothesis_closes');
    expect(isGrossPriceComparisonAmountBasisTrusted(a)).toBe(false);
  });

  it('9 — legacy recovered tax + resolved coupon: generic exact false, gross trust true', () => {
    const r = makeReceipt({
      id: 'legacy-coupon',
      tax: 72,
      taxIsKnown: 0,
      total: 972,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      discounts: [{ label: '店舗クーポン共通', amount: -100 }],
      analysisExtras: { tax: 72, tax_is_known: true },
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.taxProvenance).toBe('trusted');
    expect(a.confidence).toBe('medium');
    expect(a.exactComparisonTrusted).toBe(false);
    expect(isGrossPriceComparisonAmountBasisTrusted(a)).toBe(true);
  });
});

describe('Product Price History gross comparison with receipt-level coupon', () => {
  it('core — coupon medium path: no amount_basis_untrusted; priceValue stays gross/qty', () => {
    const rows = [
      couponClosingRow('r1', 1000, 1000),
      couponClosingRow('r2', 2000, 1100),
    ];
    const cache = buildReceiptEvidenceCache(rows);
    for (const row of rows) {
      const entry = cache.get(row.receiptId)!;
      expect(entry.amountBasisAssessment.confidence).toBe('medium');
      expect(entry.amountBasisAssessment.exactComparisonTrusted).toBe(false);
      expect(
        isGrossPriceComparisonAmountBasisTrusted(entry.amountBasisAssessment)
      ).toBe(true);
      expect(entry.monetaryCoherenceEvidence.state).toBe('known_coherent');
      expect(entry.monetaryCoherenceEvidence.monetaryProvenanceSufficient).toBe(
        true
      );
    }

    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-milk' },
      rows,
      { receiptEvidenceCache: cache }
    );

    expect(history.observations.length).toBeGreaterThanOrEqual(2);
    for (const observation of history.observations) {
      expect(observation.level2RejectReasons).not.toContain(
        'amount_basis_untrusted'
      );
      expect(observation.exactComparisonTrusted).toBe(false);
      expect(observation.level2Eligible).toBe(true);
      // series is gross; price points use gross/qty
      expect(observation.seriesKind).toBe('gross');
      expect(observation.grossLineAmount).toBeGreaterThan(0);
    }

    expect(history.points.length).toBeGreaterThanOrEqual(2);
    for (const point of history.points) {
      const row = rows.find((r) => r.receiptId === point.receiptId)!;
      const qty = row.purchaseQuantity!;
      expect(point.priceValue).toBe(row.grossLineAmount! / qty);
      // Coupon must not alter comparison price away from gross.
      expect(point.priceValue).not.toBe((row.grossLineAmount! - 100) / qty);
    }
  });

  it('ownership unresolved still Level-2 rejects (not saved by gross exception)', () => {
    // Bundle summary discount without evidence texts → ownership unresolved.
    const analysis = {
      items: [{ name: '牛乳', lineTotal: 1000, quantity: 1 }],
      discounts: [{ label: 'まとめ売り値引', amount: -100 }],
      tax: 80,
      tax_is_known: true,
      total: 980,
      reconciliation: { ok: true },
      amount_mismatch: false,
    };
    const row = makeTrustedG3TestRow('unres', {
      receiptId: 'unres',
      occurredAt: 1000,
      displayName: '牛乳',
      grossLineAmount: 1000,
      lineTotal: 1000,
      purchaseQuantity: 1,
      receiptTotal: 980,
      receiptTax: 80,
      receiptTaxIsKnown: 1,
      receiptAnalysisJson: JSON.stringify(analysis),
      skuKey: 'sku-milk',
      identitySource: 'normalized_exact',
      identityConfidence: 1,
    });
    const peer = couponClosingRow('peer', 2000, 1000);
    const cache = buildReceiptEvidenceCache([row, peer]);
    const assessment = cache.get('unres')!.amountBasisAssessment;
    expect(assessment.basis).toBe('unknown');
    expect(assessment.reasonCodes).toEqual(
      expect.arrayContaining([
        'discount_ownership_unresolved',
        'monetary_source_incoherent',
      ])
    );
    expect(isGrossPriceComparisonAmountBasisTrusted(assessment)).toBe(false);

    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-milk' },
      [row, peer],
      { receiptEvidenceCache: cache }
    );
    const obs = history.observations.find((o) => o.receiptId === 'unres');
    expect(obs?.level2Eligible).toBe(false);
    expect(
      obs?.level2RejectReasons.some(
        (r) =>
          r === 'amount_basis_untrusted' ||
          r === 'discount_ownership_unresolved' ||
          r === 'monetary_incoherent'
      )
    ).toBe(true);
  });

  it('true unknown tax remains Level-2 ineligible', () => {
    const row = makeTrustedG3TestRow('tu', {
      receiptId: 'tu',
      occurredAt: 1000,
      grossLineAmount: 1000,
      lineTotal: 1000,
      purchaseQuantity: 1,
      receiptTotal: 1000,
      receiptTax: 0,
      receiptTaxIsKnown: 0,
      receiptAnalysisJson: JSON.stringify({
        items: [{ name: '牛乳', lineTotal: 1000, quantity: 1 }],
        tax: 0,
        total: 1000,
        reconciliation: { ok: true },
        amount_mismatch: false,
      }),
      skuKey: 'sku-milk',
      identitySource: 'normalized_exact',
      identityConfidence: 1,
    });
    const peer = couponClosingRow('peer2', 2000, 1100);
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-milk' },
      [row, peer],
      { receiptEvidenceCache: buildReceiptEvidenceCache([row, peer]) }
    );
    const obs = history.observations.find((o) => o.receiptId === 'tu');
    expect(obs?.level2Eligible).toBe(false);
    expect(obs?.level2RejectReasons).toContain('amount_basis_untrusted');
  });

  it('resolveGrossLineAmount hierarchy: only positive grossLineAmount (no effective fallback)', () => {
    const withGross = makeTrustedG3TestRow('g1', {
      receiptId: 'g1',
      occurredAt: 1000,
      grossLineAmount: 1000,
      effectiveLineAmount: 900,
      purchaseQuantity: 1,
      receiptTax: 80,
      receiptTaxIsKnown: 1,
      receiptTotal: 1080,
      receiptAnalysisJson: JSON.stringify({
        items: [{ name: '牛乳', lineTotal: 1000, quantity: 1 }],
        tax: 80,
        total: 1080,
        reconciliation: { ok: true },
        amount_mismatch: false,
      }),
      skuKey: 'sku-milk',
      identitySource: 'normalized_exact',
      identityConfidence: 1,
    });
    const peer = makeTrustedG3TestRow('g2', {
      receiptId: 'g2',
      occurredAt: 2000,
      grossLineAmount: 1100,
      purchaseQuantity: 1,
      receiptTax: 88,
      receiptTaxIsKnown: 1,
      receiptTotal: 1188,
      receiptAnalysisJson: JSON.stringify({
        items: [{ name: '牛乳', lineTotal: 1100, quantity: 1 }],
        tax: 88,
        total: 1188,
        reconciliation: { ok: true },
        amount_mismatch: false,
      }),
      skuKey: 'sku-milk',
      identitySource: 'normalized_exact',
      identityConfidence: 1,
    });
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-milk' },
      [withGross, peer],
      {
        receiptEvidenceCache: buildReceiptEvidenceCache([withGross, peer]),
      }
    );
    const point = history.points.find((p) => p.receiptId === 'g1');
    expect(point?.priceValue).toBe(1000);
    expect(point?.priceValue).not.toBe(900);
  });
});
