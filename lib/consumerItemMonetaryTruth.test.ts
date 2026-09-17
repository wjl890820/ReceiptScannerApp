/**
 * Consumer item monetary trust projection (Receipt074 Round 5).
 */

import {
  aggregateTrustedProductSpend,
  projectTrustedConsumerItemAmount,
  projectTrustedConsumerItemAmounts,
} from './consumerItemMonetaryTruth';

describe('projectTrustedConsumerItemAmount', () => {
  it('blocks OCR spend when product coupon ownership is unresolved', () => {
    const analysisJson = JSON.stringify({
      merchant: 'コストコ',
      items: [
        {
          name: 'ケージフリータマゴ 20',
          lineTotal: 758,
          discountAllocated: 0,
          effectiveLineTotal: 758,
        },
      ],
      discounts: [
        {
          label: 'CAGE FREE EGG CPN',
          amount: -160,
          ownershipStatus: 'unbound',
          boundItemIndex: null,
          ownershipReason: 'no_deterministic_ownership',
        },
      ],
      tax: 466,
      total: 6292,
      tax_is_known: true,
    });
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 758,
      analysisJson,
      receiptTotal: 6292,
      receiptTax: 466,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: 'ケージフリータマゴ 20',
    });
    expect(proj).toEqual({
      amount: null,
      trusted: false,
      reason: 'discount_ownership_unresolved',
    });
  });

  it('does not grant trust from user_items_json alone when coupon unresolved', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 900,
      analysisJson: JSON.stringify({
        items: [{ name: 'x', lineTotal: 758 }],
        discounts: [{ label: 'CAGE FREE EGG CPN', amount: -160 }],
        tax: 0,
        total: 598,
        tax_is_known: true,
      }),
      userItemsJson: JSON.stringify([{ name: 'x', lineTotal: 900 }]),
      receiptTotal: 598,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
    });
    expect(proj.trusted).toBe(false);
    expect(proj.amount).toBeNull();
  });

  it('missing analysis_json fails closed', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson: null,
      currency: 'JPY',
      sourceIndex: 0,
    });
    expect(proj).toEqual({
      amount: null,
      trusted: false,
      reason: 'analysis_json_missing',
    });
  });

  it('missing sourceIndex fails closed', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson: JSON.stringify({
        items: [{ name: 'A', lineTotal: 1000 }],
        tax: 0,
        total: 1000,
        tax_is_known: true,
        reconciliation: { ok: true },
        amount_mismatch: false,
      }),
      receiptTotal: 1000,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
    });
    expect(proj.reason).toBe('source_index_invalid');
    expect(proj.amount).toBeNull();
  });

  it('projectTrustedConsumerItemAmounts nulls untrusted row amounts', () => {
    const analysisJson = JSON.stringify({
      items: [{ name: 'ケージフリータマゴ', lineTotal: 758 }],
      discounts: [{ label: 'CAGE FREE EGG CPN', amount: -160 }],
      tax: 0,
      total: 598,
      tax_is_known: true,
    });
    const rows = projectTrustedConsumerItemAmounts([
      {
        receiptId: 'r1',
        lineTotal: 758,
        sourceIndex: 0,
        currency: 'JPY',
        receiptAnalysisJson: analysisJson,
        receiptTotal: 598,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
      },
    ]);
    expect(rows[0].lineTotal).toBeNull();
    expect(rows[0].monetaryTrusted).toBe(false);
  });

  it('aggregateTrustedProductSpend nulls when UNKNOWN currency present', () => {
    const agg = aggregateTrustedProductSpend([
      { lineTotal: 500, monetaryTrusted: true, currency: 'JPY' },
      { lineTotal: 100, monetaryTrusted: true, currency: 'UNKNOWN' },
    ]);
    expect(agg.totalSpend).toBeNull();
    expect(agg.monetaryCoverageComplete).toBe(false);
  });
});
