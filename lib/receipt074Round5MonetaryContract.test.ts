/**
 * Receipt074 Round 5 — fail-closed authority completion (A1–A5).
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  applyReceiptDiscountsToItems,
  findDiscountItemIndex,
  hasUnresolvedProductAffectingCoupons,
  itemAmountForAnalytics,
  productCoreOwnershipKey,
} from './receiptDiscountAllocation';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { resolveDiscountOwnership } from './analysisFoundation/discountOwnership';
import {
  aggregateTrustedProductSpend,
  projectTrustedConsumerItemAmount,
  projectTrustedConsumerItemAmounts,
} from './consumerItemMonetaryTruth';

function analysisPayload(args: {
  items: unknown[];
  discounts?: unknown[];
  total: number;
  tax?: number | null;
}) {
  return JSON.stringify({
    merchant: 'テスト',
    items: args.items,
    discounts: args.discounts ?? [],
    tax: args.tax ?? 0,
    total: args.total,
    tax_is_known: true,
    reconciliation: { ok: true },
    amount_mismatch: false,
  });
}

describe('Receipt074 Round 5 A1 exact allocation', () => {
  const eggItem = {
    name: 'CAGE FREE EGGS 20',
    lineTotal: 758,
    discountAllocated: -160,
    effectiveLineTotal: 598,
  };
  const boundMeta = {
    label: 'CAGE FREE EGG CPN',
    amount: -160,
    ownershipStatus: 'bound' as const,
    boundItemIndex: 0,
    ownershipReason: 'strong_lexical_token_coverage',
  };

  it('Proof A: persisted -158 vs coupon -160 → unresolved', () => {
    expect(
      hasUnresolvedProductAffectingCoupons(
        [
          {
            ...eggItem,
            discountAllocated: -158,
            effectiveLineTotal: 600,
          },
        ],
        [boundMeta]
      )
    ).toBe(true);
  });

  it.each([-159, -161, -100, -200])(
    'exact inequality %p → unresolved',
    (alloc) => {
      expect(
        hasUnresolvedProductAffectingCoupons(
          [
            {
              ...eggItem,
              discountAllocated: alloc,
              effectiveLineTotal: 758 + alloc,
            },
          ],
          [boundMeta]
        )
      ).toBe(true);
    }
  );

  it('exact -160 → resolved', () => {
    expect(hasUnresolvedProductAffectingCoupons([eggItem], [boundMeta])).toBe(
      false
    );
  });
});

describe('Receipt074 Round 5 A2 product-core equality', () => {
  it('Proof C: CAGE FREE EGGS 20 + CAGE FREE EGG CPN → 758/-160/598', () => {
    expect(productCoreOwnershipKey('CAGE FREE EGGS 20')).toBe(
      productCoreOwnershipKey('CAGE FREE EGG CPN')
    );
    const result = applyReceiptDiscountsToItems(
      [{ name: 'CAGE FREE EGGS 20', lineTotal: 758 }],
      [{ label: 'CAGE FREE EGG CPN', amount: -160 }]
    );
    expect(result.boundCount).toBe(1);
    expect(Number((result.items[0] as { discountAllocated?: number }).discountAllocated)).toBe(-160);
    expect(itemAmountForAnalytics(result.items[0]!)).toBe(598);
  });

  it('Proof B: CHOCOLATE MILK CPN vs CHOCOLATE MILK BREAD → unbound', () => {
    expect(
      findDiscountItemIndex(
        [{ name: 'CHOCOLATE MILK BREAD', lineTotal: 400 }],
        { label: 'CHOCOLATE MILK CPN', amount: -50 }
      )
    ).toBe(-1);
  });

  const derivatives: Array<[string, string]> = [
    ['GREEK YOGURT DRINK', 'GREEK YOGURT CPN'],
    ['BANANA CAKE', 'BANANA CPN'],
    ['MILKSHAKE', 'MILK CPN'],
    ['BREAD CRUMBS', 'BREAD CPN'],
    ['牛乳プリン', '牛乳 CPN'],
    ['CHOCOLATE MILK BREAD', 'CHOCOLATE MILK CPN'],
  ];

  it.each(derivatives)('%s vs %s → unbound', (item, coupon) => {
    expect(
      findDiscountItemIndex([{ name: item, lineTotal: 500 }], {
        label: coupon,
        amount: -40,
      })
    ).toBe(-1);
  });
});

describe('Receipt074 Round 5 A3 correspondence', () => {
  const coherent = analysisPayload({
    items: [
      { name: 'A', lineTotal: 1000, quantity: 1 },
      { name: 'B', lineTotal: 500, quantity: 1 },
    ],
    total: 1500,
  });

  it('C1 / Proof D: missing sourceIndex → spend null', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson: coherent,
      receiptTotal: 1500,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
    });
    expect(proj.trusted).toBe(false);
    expect(proj.amount).toBeNull();
    expect(proj.reason).toBe('source_index_invalid');
  });

  it('C2/C3: invalid sourceIndex → spend null', () => {
    for (const bad of [999, -1, 1.5, Number.NaN]) {
      const proj = projectTrustedConsumerItemAmount({
        lineTotal: 1000,
        analysisJson: coherent,
        receiptTotal: 1500,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        currency: 'JPY',
        sourceIndex: bad as number,
      });
      expect(proj.amount).toBeNull();
      expect(proj.reason).toBe('source_index_invalid');
    }
  });

  it('C4: indexed 999 vs mapped 1000 → spend null', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 999,
      analysisJson: coherent,
      receiptTotal: 1500,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: 'A',
    });
    expect(proj.amount).toBeNull();
    expect(proj.reason).toBe('item_correspondence_mismatch');
  });

  it('C5 / Proof E: B row with sourceIndex=0 → not A amount, not B raw', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 500,
      analysisJson: coherent,
      receiptTotal: 1500,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: 'B',
      rawName: 'B',
    });
    expect(proj.amount).toBeNull();
    expect(proj.trusted).toBe(false);
  });

  it('C6: correct mapping → spend available', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson: coherent,
      receiptTotal: 1500,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: 'A',
    });
    expect(proj).toEqual({
      amount: 1000,
      trusted: true,
      reason: 'trusted_product_spend',
    });
  });
});

describe('Receipt074 Round 5 A4 final_total evidence', () => {
  it('Proof F: conflicting final_total → consumer null', () => {
    const analysisJson = analysisPayload({
      items: [{ name: 'A', lineTotal: 1000, quantity: 1 }],
      total: 1000,
    });
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson,
      userItemsJson: JSON.stringify([{ name: 'A', lineTotal: 1000 }]),
      receiptTotal: 1000,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      finalTotal: 800,
      userEdited: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: 'A',
    });
    expect(proj.trusted).toBe(false);
    expect(proj.amount).toBeNull();
  });
});

describe('Receipt074 Round 5 A5 coverage aggregation', () => {
  it('M1 / Proof G: trusted JPY + untrusted UNKNOWN → coverage false', () => {
    const trustedAnalysis = analysisPayload({
      items: [{ name: 'Milk', lineTotal: 500, quantity: 1 }],
      total: 500,
    });
    const rows = projectTrustedConsumerItemAmounts([
      {
        receiptId: 'jpy',
        lineTotal: 500,
        sourceIndex: 0,
        currency: 'JPY',
        displayName: 'Milk',
        receiptAnalysisJson: trustedAnalysis,
        receiptTotal: 500,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
      },
      {
        receiptId: 'unk',
        lineTotal: 300,
        sourceIndex: 0,
        currency: 'UNKNOWN',
        displayName: 'Milk',
        receiptAnalysisJson: trustedAnalysis,
        receiptTotal: 300,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
      },
    ]);
    const agg = aggregateTrustedProductSpend(rows);
    expect(agg.monetaryCoverageComplete).toBe(false);
    expect(agg.totalSpend).toBeNull();
  });

  it('M2: trusted JPY + trusted UNKNOWN currency → coverage false', () => {
    const agg = aggregateTrustedProductSpend([
      { lineTotal: 500, monetaryTrusted: true, currency: 'JPY' },
      { lineTotal: 300, monetaryTrusted: true, currency: 'UNKNOWN' },
    ]);
    expect(agg.monetaryCoverageComplete).toBe(false);
    expect(agg.totalSpend).toBeNull();
  });

  it('M3: two trusted JPY → total 800', () => {
    const agg = aggregateTrustedProductSpend([
      { lineTotal: 500, monetaryTrusted: true, currency: 'JPY' },
      { lineTotal: 300, monetaryTrusted: true, currency: 'JPY' },
    ]);
    expect(agg.monetaryCoverageComplete).toBe(true);
    expect(agg.totalSpend).toBe(800);
  });

  it('M4: JPY + USD → no cross-currency sum; per-currency totals', () => {
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

  it('M5: trusted + untrusted JPY → coverage false', () => {
    const agg = aggregateTrustedProductSpend([
      { lineTotal: 500, monetaryTrusted: true, currency: 'JPY' },
      { lineTotal: null, monetaryTrusted: false, currency: 'JPY' },
    ]);
    expect(agg.monetaryCoverageComplete).toBe(false);
    expect(agg.totalSpend).toBeNull();
  });
});

describe('Receipt074 Round 5 receipt-level / controls', () => {
  it('Proof H: store coupon -1 → product spend unavailable', () => {
    const analysisJson = analysisPayload({
      items: [
        { name: 'A', lineTotal: 1000, quantity: 1 },
        { name: 'B', lineTotal: 500, quantity: 1 },
      ],
      discounts: [{ label: '店舗クーポン共通', amount: -1 }],
      total: 1499,
    });
    const ownership = resolveDiscountOwnership({
      ocrItems: [
        { name: 'A', lineTotal: 1000 },
        { name: 'B', lineTotal: 500 },
      ],
      ocrDiscounts: [{ label: '店舗クーポン共通', amount: -1 }],
    });
    expect(ownership.status).not.toBe('unresolved');
    expect(ownership.genuineReceiptLevelRemainder).toBe(-1);

    for (const idx of [0, 1] as const) {
      const proj = projectTrustedConsumerItemAmount({
        lineTotal: idx === 0 ? 1000 : 500,
        analysisJson,
        receiptTotal: 1499,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        currency: 'JPY',
        sourceIndex: idx,
        displayName: idx === 0 ? 'A' : 'B',
      });
      expect(proj.amount).toBeNull();
      expect(proj.reason).toBe('receipt_level_discount_unallocated_for_spend');
    }
  });

  it('no-discount control: A=1000 B=500', () => {
    const analysisJson = analysisPayload({
      items: [
        { name: 'A', lineTotal: 1000, quantity: 1 },
        { name: 'B', lineTotal: 500, quantity: 1 },
      ],
      total: 1500,
    });
    expect(
      projectTrustedConsumerItemAmount({
        lineTotal: 1000,
        analysisJson,
        receiptTotal: 1500,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        currency: 'JPY',
        sourceIndex: 0,
        displayName: 'A',
      }).amount
    ).toBe(1000);
    expect(
      projectTrustedConsumerItemAmount({
        lineTotal: 500,
        analysisJson,
        receiptTotal: 1500,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        currency: 'JPY',
        sourceIndex: 1,
        displayName: 'B',
      }).amount
    ).toBe(500);
  });

  it('resolved item coupon → spend 598', () => {
    const normalized = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 598,
      tax: 0,
      items: [
        { name: 'CAGE FREE EGGS 20', quantity: 1, unitPrice: 758, lineTotal: 758 },
        { name: 'CAGE FREE EGG CPN', quantity: 1, unitPrice: -160, lineTotal: -160 },
      ],
    });
    const analysisJson = analysisPayload({
      items: normalized.items,
      discounts: normalized.discounts,
      total: 598,
    });
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 598,
      analysisJson,
      receiptTotal: 598,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: String(normalized.items[0]!.name),
    });
    expect(proj.amount).toBe(598);
    expect(Number(normalized.items[0]!.lineTotal)).toBe(758);
  });

  it('Receipt074 cross-script remains unresolved / spend null', () => {
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
    const analysisJson = analysisPayload({
      items: out.items,
      discounts: out.discounts,
      total: out.total,
      tax: out.tax,
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

  it('Receipt073 spend 252', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'イオン',
      currency: 'JPY',
      total: 252,
      tax: 0,
      items: [
        { name: 'パン*', quantity: 1, unitPrice: 280, lineTotal: 280 },
        { name: '値引', quantity: 1, unitPrice: -28, lineTotal: -28 },
      ],
    });
    const analysisJson = analysisPayload({
      items: out.items,
      discounts: out.discounts,
      total: 252,
    });
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 252,
      analysisJson,
      receiptTotal: 252,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: String(out.items[0]!.name),
    });
    expect(proj.amount).toBe(252);
  });

  it('missing currency → spend null', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson: analysisPayload({
        items: [{ name: 'A', lineTotal: 1000 }],
        total: 1000,
      }),
      receiptTotal: 1000,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      sourceIndex: 0,
    });
    expect(proj.reason).toBe('currency_unknown');
    expect(proj.amount).toBeNull();
  });
});
