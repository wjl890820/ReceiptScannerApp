/**
 * Receipt074 Round 6 — variant-safe ownership + currency end-to-end closure.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  applyReceiptDiscountsToItems,
  findDiscountItemIndex,
  itemAmountForAnalytics,
  ownershipBaseIdentityKey,
  ownershipBaseIdentityTokens,
  ownershipPackageEvidenceKeys,
} from './receiptDiscountAllocation';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import {
  projectTrustedConsumerItemAmount,
  aggregateTrustedProductSpend,
} from './consumerItemMonetaryTruth';
import {
  isTrustedReceiptCurrency,
  normalizeReceiptCurrency,
} from './receiptCurrency';
import { formatProductPriceAmount } from './productPricePresentation';

describe('Receipt074 Round 6 A1 variant-safe ownership', () => {
  it('V1 / Proof A: count conflict 20 vs 30 → unbound', () => {
    expect(
      findDiscountItemIndex(
        [{ name: 'CAGE FREE EGGS 20', lineTotal: 758 }],
        { label: 'CAGE FREE EGG 30 CPN', amount: -160 }
      )
    ).toBe(-1);
  });

  it('V2 / Proof B: LARGE qualifier on coupon only → unbound', () => {
    expect(
      findDiscountItemIndex(
        [{ name: 'CAGE FREE EGGS', lineTotal: 758 }],
        { label: 'LARGE CAGE FREE EGG CPN', amount: -160 }
      )
    ).toBe(-1);
  });

  it('V3: ORIGINAL qualifier on coupon only → unbound', () => {
    expect(
      findDiscountItemIndex(
        [{ name: 'GREEK YOGURT', lineTotal: 300 }],
        { label: 'ORIGINAL GREEK YOGURT CPN', amount: -50 }
      )
    ).toBe(-1);
  });

  it('V4: ORGANIC qualifier on coupon only → unbound', () => {
    expect(
      findDiscountItemIndex(
        [{ name: 'ACME MILK', lineTotal: 200 }],
        { label: 'ORGANIC ACME MILK CPN', amount: -40 }
      )
    ).toBe(-1);
  });

  it('V5 / Proof D: positive count omission → 758/-160/598', () => {
    const result = applyReceiptDiscountsToItems(
      [{ name: 'CAGE FREE EGGS 20', lineTotal: 758 }],
      [{ label: 'CAGE FREE EGG CPN', amount: -160 }]
    );
    expect(result.boundCount).toBe(1);
    expect(Number(result.items[0]!.lineTotal)).toBe(758);
    expect(
      Number((result.items[0] as { discountAllocated?: number }).discountAllocated)
    ).toBe(-160);
    expect(itemAmountForAnalytics(result.items[0]!)).toBe(598);
  });

  it('V6: exact ORIGINAL variant may resolve', () => {
    expect(
      findDiscountItemIndex(
        [{ name: 'ORIGINAL GREEK YOGURT', lineTotal: 300 }],
        { label: 'ORIGINAL GREEK YOGURT CPN', amount: -50 }
      )
    ).toBe(0);
  });

  it('V7 / Proof C: ACME COFFEE preserves COFFEE (no off substring corruption)', () => {
    const tokens = ownershipBaseIdentityTokens('ACME COFFEE CPN');
    expect(tokens).toEqual(expect.arrayContaining(['acme', 'coffee']));
    expect(tokens.join(' ')).not.toMatch(/\bee\b/);
    expect(ownershipBaseIdentityKey('ACME COFFEE')).toBe('acme coffee');
    expect(ownershipBaseIdentityKey('ACME COFFEE CPN')).toBe('acme coffee');
  });

  it('keeps Round 5 derivative negatives unbound', () => {
    const cases: Array<[string, string]> = [
      ['CHOCOLATE MILK BREAD', 'CHOCOLATE MILK CPN'],
      ['GREEK YOGURT DRINK', 'GREEK YOGURT CPN'],
      ['BANANA CAKE', 'BANANA CPN'],
      ['MILKSHAKE', 'MILK CPN'],
      ['BREAD CRUMBS', 'BREAD CPN'],
      ['牛乳プリン', '牛乳 CPN'],
    ];
    for (const [item, coupon] of cases) {
      expect(
        findDiscountItemIndex([{ name: item, lineTotal: 400 }], {
          label: coupon,
          amount: -40,
        })
      ).toBe(-1);
    }
  });

  it('package evidence: coupon asserts count, item omits → unbound', () => {
    expect(ownershipPackageEvidenceKeys('CAGE FREE EGG 30 CPN')).toEqual([
      'count:30',
    ]);
    expect(ownershipPackageEvidenceKeys('CAGE FREE EGGS')).toEqual([]);
    expect(
      findDiscountItemIndex(
        [{ name: 'CAGE FREE EGGS', lineTotal: 758 }],
        { label: 'CAGE FREE EGG 30 CPN', amount: -160 }
      )
    ).toBe(-1);
  });
});

describe('Receipt074 Round 6 A2 currency contract', () => {
  it('C1/C7: JPY and lowercase jpy normalize', () => {
    expect(normalizeReceiptCurrency('JPY')).toBe('JPY');
    expect(normalizeReceiptCurrency('jpy')).toBe('JPY');
    expect(isTrustedReceiptCurrency('JPY')).toBe(true);
  });

  it('C2: USD trusted and formatted without JPY', () => {
    expect(normalizeReceiptCurrency('usd')).toBe('USD');
    const label = formatProductPriceAmount(10, 'USD');
    expect(label).toContain('USD');
    expect(label).not.toContain('¥');
    expect(label).not.toMatch(/^¥/);
  });

  it('C3–C6 / Proof E: UNKNOWN / blank / null / ??? → spend null', () => {
    const analysisJson = JSON.stringify({
      items: [{ name: 'A', lineTotal: 1000, quantity: 1 }],
      tax: 0,
      total: 1000,
      tax_is_known: true,
      reconciliation: { ok: true },
      amount_mismatch: false,
    });
    for (const currency of ['UNKNOWN', '', null, '???'] as const) {
      const proj = projectTrustedConsumerItemAmount({
        lineTotal: 1000,
        analysisJson,
        receiptTotal: 1000,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        currency,
        sourceIndex: 0,
        displayName: 'A',
      });
      expect(proj.trusted).toBe(false);
      expect(proj.amount).toBeNull();
      expect(proj.reason).toBe('currency_unknown');
    }
    expect(formatProductPriceAmount(10, '???')).toBe('—');
  });

  it('C8: unsupported 3-letter XYZ → not trusted', () => {
    expect(normalizeReceiptCurrency('XYZ')).toBeNull();
    expect(isTrustedReceiptCurrency('XYZ')).toBe(false);
  });

  it('Proof F: USD History formatting path', () => {
    expect(formatProductPriceAmount(10, 'USD')).toBe('USD 10');
    expect(formatProductPriceAmount(1000, 'JPY')).toMatch(/¥/);
  });

  it('mixed currencies coverage preserved', () => {
    const agg = aggregateTrustedProductSpend([
      { lineTotal: 500, monetaryTrusted: true, currency: 'JPY' },
      { lineTotal: 10, monetaryTrusted: true, currency: 'USD' },
    ]);
    expect(agg.monetaryCoverageComplete).toBe(true);
    expect(agg.totalSpend).toBeNull();
    expect(agg.currencyTotals).toEqual(
      expect.arrayContaining([
        { currency: 'JPY', totalSpend: 500 },
        { currency: 'USD', totalSpend: 10 },
      ])
    );
  });

  it('malformed currency occurrence → coverage incomplete', () => {
    const agg = aggregateTrustedProductSpend([
      { lineTotal: 500, monetaryTrusted: true, currency: 'JPY' },
      { lineTotal: 10, monetaryTrusted: true, currency: '???' },
    ]);
    expect(agg.monetaryCoverageComplete).toBe(false);
    expect(agg.totalSpend).toBeNull();
  });
});

describe('Receipt074 Round 6 freezes', () => {
  it('Proof G: Receipt074 cross-script unresolved / spend null', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 6292,
      tax: 466,
      items: [
        { name: 'ケージフリータマゴ 20', quantity: 1, unitPrice: 758, lineTotal: 758 },
        { name: 'CAGE FREE EGG CPN', quantity: 1, unitPrice: -160, lineTotal: -160 },
      ],
    });
    expect(out.discounts?.[0]?.ownershipStatus).toBe('unbound');
    const analysisJson = JSON.stringify({
      items: out.items,
      discounts: out.discounts,
      tax: out.tax,
      total: out.total,
      tax_is_known: true,
      reconciliation: { ok: true },
      amount_mismatch: false,
    });
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 758,
      analysisJson,
      receiptTotal: out.total,
      receiptTax: out.tax,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: 'ケージフリータマゴ 20',
    });
    expect(proj.amount).toBeNull();
  });
});
