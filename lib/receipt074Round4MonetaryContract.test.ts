/**
 * Receipt074 Round 4 — monetary authority contract (A1–A4, T1–T11, Proofs A–G).
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import { resolveDiscountOwnership } from './analysisFoundation/discountOwnership';
import {
  applyReceiptDiscountsToItems,
  findDiscountItemIndex,
  hasUnresolvedProductAffectingCoupons,
  itemAmountForAnalytics,
} from './receiptDiscountAllocation';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
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

describe('Receipt074 Round 4 A1 allocation equality', () => {
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

  it('P1 / Proof A: persisted -100 vs coupon -160 → unresolved', () => {
    expect(
      hasUnresolvedProductAffectingCoupons(
        [
          {
            ...eggItem,
            discountAllocated: -100,
            effectiveLineTotal: 658,
          },
        ],
        [boundMeta]
      )
    ).toBe(true);
  });

  it('P2: persisted -160 matches recomputation → resolved', () => {
    expect(hasUnresolvedProductAffectingCoupons([eggItem], [boundMeta])).toBe(
      false
    );
  });

  it('P3: persisted -200 vs coupon -160 → unresolved', () => {
    expect(
      hasUnresolvedProductAffectingCoupons(
        [
          {
            ...eggItem,
            discountAllocated: -200,
            effectiveLineTotal: 558,
          },
        ],
        [boundMeta]
      )
    ).toBe(true);
  });

  it('P4: gross/effective arithmetic inconsistent → unresolved', () => {
    expect(
      hasUnresolvedProductAffectingCoupons(
        [
          {
            ...eggItem,
            discountAllocated: -160,
            effectiveLineTotal: 700,
          },
        ],
        [boundMeta]
      )
    ).toBe(true);
  });

  it('P5: two discounts on same item evaluate independently', () => {
    const items = [
      {
        name: 'CAGE FREE EGGS 20',
        lineTotal: 758,
        discountAllocated: -188,
        effectiveLineTotal: 570,
      },
    ];
    // Ordinary 値引 + matching CPN allocation agrees with probe.
    const ok = hasUnresolvedProductAffectingCoupons(items, [
      {
        label: '値引',
        amount: -28,
        adjacentPrecedingItemIndex: 0,
      },
      {
        ...boundMeta,
        amount: -160,
      },
    ]);
    expect(ok).toBe(false);

    // Coupon-specific attribution wrong while aggregate looks nonzero → unresolved.
    expect(
      hasUnresolvedProductAffectingCoupons(
        [
          {
            name: 'CAGE FREE EGGS 20',
            lineTotal: 758,
            discountAllocated: -100,
            effectiveLineTotal: 658,
          },
        ],
        [
          {
            label: '値引',
            amount: -28,
            adjacentPrecedingItemIndex: 0,
          },
          boundMeta,
        ]
      )
    ).toBe(true);
  });

  it('P6: invalid/fractional/out-of-range bound index → unresolved', () => {
    for (const bad of [999, -1, 1.5, Number.NaN]) {
      expect(
        hasUnresolvedProductAffectingCoupons([eggItem], [
          { ...boundMeta, boundItemIndex: bad as number },
        ])
      ).toBe(true);
    }
  });

  it('T11 / Proof A allocation mismatch', () => {
    expect(
      hasUnresolvedProductAffectingCoupons(
        [
          {
            name: 'CAGE FREE EGGS 20',
            lineTotal: 758,
            discountAllocated: -100,
            effectiveLineTotal: 658,
          },
        ],
        [boundMeta]
      )
    ).toBe(true);
  });
});

describe('Receipt074 Round 4 A2 multi-token lexical', () => {
  const singleTokenCases: Array<[string, string]> = [
    ['BANANA CAKE', 'BANANA CPN'],
    ['CHICKEN SOUP', 'CHICKEN CPN'],
    ['BREAD CRUMBS', 'BREAD CPN'],
    ['YOGURT DRINK', 'YOGURT CPN'],
    ['牛乳プリン', '牛乳 CPN'],
    ['ORGANIC MILK', 'ORGANIC EGG CPN'],
  ];

  it.each(singleTokenCases)(
    'T9 / Proof B: %s vs %s → unbound',
    (itemName, coupon) => {
      expect(
        findDiscountItemIndex([{ name: itemName, lineTotal: 500 }], {
          label: coupon,
          amount: -50,
        })
      ).toBe(-1);
    }
  );

  it('T10: CAGE FREE EGGS + CAGE FREE EGG CPN → resolved', () => {
    const result = applyReceiptDiscountsToItems(
      [{ name: 'CAGE FREE EGGS 20', lineTotal: 758, quantity: 1 }],
      [{ label: 'CAGE FREE EGG CPN', amount: -160 }]
    );
    expect(result.boundCount).toBe(1);
    expect(itemAmountForAnalytics(result.items[0]!)).toBe(598);
  });
});

describe('Receipt074 Round 4 A3/A4 consumer spend contract', () => {
  it('T1: no discount → consumer spend 1000', () => {
    const analysisJson = analysisPayload({
      items: [{ name: 'A', lineTotal: 1000, quantity: 1 }],
      total: 1000,
    });
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson,
      receiptTotal: 1000,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
    });
    expect(proj).toEqual({
      amount: 1000,
      trusted: true,
      reason: 'trusted_product_spend',
    });
  });

  it('T2 / Proof F: resolved item coupon → spend 598, PPH gross 758', () => {
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
    expect(normalized.items[0]!.discountAllocated).toBe(-160);
    expect(itemAmountForAnalytics(normalized.items[0]!)).toBe(598);

    const analysisJson = analysisPayload({
      items: normalized.items,
      discounts: normalized.discounts,
      total: 598,
    });
    const spend = projectTrustedConsumerItemAmount({
      lineTotal: 598,
      analysisJson,
      receiptTotal: 598,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
    });
    expect(spend.amount).toBe(598);
    expect(spend.trusted).toBe(true);

    // Separation: attributable spend ≠ raw gross shelf line.
    expect(Number(normalized.items[0]!.lineTotal)).toBe(758);
    expect(itemAmountForAnalytics(normalized.items[0]!)).toBe(598);
    expect(spend.amount).not.toBe(Number(normalized.items[0]!.lineTotal));
  });

  it('T3: unresolved product coupon → spend null', () => {
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
    });
    expect(proj.trusted).toBe(false);
    expect(proj.amount).toBeNull();
  });

  it('T4 / Proof E: store coupon → product spend unavailable', () => {
    const analysisJson = analysisPayload({
      items: [
        { name: 'A', lineTotal: 1000, quantity: 1 },
        { name: 'B', lineTotal: 500, quantity: 1 },
      ],
      discounts: [{ label: '店舗クーポン共通', amount: -200 }],
      total: 1300,
    });
    const ownership = resolveDiscountOwnership({
      ocrItems: [
        { name: 'A', lineTotal: 1000 },
        { name: 'B', lineTotal: 500 },
      ],
      ocrDiscounts: [{ label: '店舗クーポン共通', amount: -200 }],
    });
    expect(ownership.status).not.toBe('unresolved');
    expect(ownership.genuineReceiptLevelRemainder).toBe(-200);

    for (const idx of [0, 1]) {
      const proj = projectTrustedConsumerItemAmount({
        lineTotal: idx === 0 ? 1000 : 500,
        analysisJson,
        receiptTotal: 1300,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
      currency: 'JPY',
        sourceIndex: idx,
      });
      expect(proj.trusted).toBe(false);
      expect(proj.amount).toBeNull();
      expect(proj.reason).toBe('receipt_level_discount_unallocated_for_spend');
    }
  });

  it('T5: arithmetic incoherent → spend null', () => {
    const analysisJson = analysisPayload({
      items: [{ name: 'A', lineTotal: 1000, quantity: 1 }],
      total: 500,
    });
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson,
      receiptTotal: 500,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
    });
    expect(proj.trusted).toBe(false);
    expect(proj.amount).toBeNull();
  });

  it('T6 / Proof D: missing analysis → spend null', () => {
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson: null,
      receiptTotal: 1000,
    });
    expect(proj).toEqual({
      amount: null,
      trusted: false,
      reason: 'analysis_json_missing',
    });
  });

  it('T7 / Proof C: user_items present + unresolved coupon → spend null', () => {
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

    for (const userItems of [
      [{ name: 'ケージフリータマゴ 20', lineTotal: 758, category: 'food' }],
      [{ name: 'edited name', lineTotal: 758 }],
      [{ name: 'ケージフリータマゴ 20', lineTotal: 758, quantity: 3 }],
    ]) {
      const proj = projectTrustedConsumerItemAmount({
        lineTotal: 758,
        analysisJson,
        userItemsJson: JSON.stringify(userItems),
        receiptTotal: out.total,
        receiptTax: out.tax,
        receiptTaxIsKnown: 1,
      currency: 'JPY',
        sourceIndex: 0,
      });
      expect(proj.trusted).toBe(false);
      expect(proj.amount).toBeNull();
    }
  });

  it('T8 / Proof G: mixed history → totalSpend unavailable, occurrences preserved', () => {
    const trustedAnalysis = analysisPayload({
      items: [{ name: 'Milk', lineTotal: 500, quantity: 1 }],
      total: 500,
    });
    const unresolvedAnalysis = analysisPayload({
      items: [
        {
          name: 'ケージフリータマゴ',
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
        },
      ],
      total: 598,
    });
    const rows = projectTrustedConsumerItemAmounts([
      {
        receiptId: 'trusted',
        lineTotal: 500,
        sourceIndex: 0,
        currency: 'JPY',
        receiptAnalysisJson: trustedAnalysis,
        receiptTotal: 500,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
      },
      {
        receiptId: 'unknown',
        lineTotal: 758,
        sourceIndex: 0,
        currency: 'JPY',
        receiptAnalysisJson: unresolvedAnalysis,
        receiptTotal: 598,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.lineTotal).toBe(500);
    expect(rows[1]!.lineTotal).toBeNull();

    const agg = aggregateTrustedProductSpend(rows);
    expect(agg.monetaryCoverageComplete).toBe(false);
    expect(agg.totalSpend).toBeNull();
  });
});

describe('Receipt074 Round 4 freezes', () => {
  it('Receipt073 resolved ordinary discount → consumer spend 252', () => {
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
    expect(out.items[0]!.effectiveLineTotal).toBe(252);
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
    });
    expect(proj.amount).toBe(252);
    expect(proj.trusted).toBe(true);
  });

  it('Sample007 JP Ferrero → unresolved / spend unavailable', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 8351,
      tax: 619,
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
      items: [
        {
          name: 'フェレロロシェオリジンズ*36コ',
          quantity: 1,
          unitPrice: 2988,
          lineTotal: 2988,
        },
        {
          name: 'CPN ROCHER ORIGINS CPN',
          quantity: 1,
          unitPrice: -600,
          lineTotal: -600,
        },
      ],
    });
    const ownership = resolveDiscountOwnership({
      ocrItems: out.items,
      ocrDiscounts: out.discounts ?? [],
      analysis: { items: out.items, discounts: out.discounts },
    });
    expect(ownership.status).toBe('unresolved');
    const analysisJson = analysisPayload({
      items: out.items,
      discounts: out.discounts,
      total: out.total,
      tax: out.tax,
    });
    const proj = projectTrustedConsumerItemAmount({
      lineTotal: 2988,
      analysisJson,
      receiptTotal: out.total,
      receiptTax: out.tax,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
    });
    expect(proj.amount).toBeNull();
    expect(proj.trusted).toBe(false);
  });
});
