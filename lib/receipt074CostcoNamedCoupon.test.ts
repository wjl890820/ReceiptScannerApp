/**
 * Receipt074 Round 3 — persisted binding revalidation, strong lexical, consumer gate.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import { resolveDiscountOwnership } from './analysisFoundation/discountOwnership';
import {
  assessReceiptAmountBasis,
  isGrossPriceComparisonAmountBasisTrusted,
} from './analysisFoundation/amountBasis';
import { resolveReceiptMonetarySourceBundle } from './analysisFoundation/monetarySourceBundle';
import {
  applyReceiptDiscountsToItems,
  findDiscountItemIndex,
  hasUnresolvedProductAffectingCoupons,
  invalidateProductCouponOwnershipMetadata,
  isValidBoundItemIndex,
} from './receiptDiscountAllocation';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { buildPriceObservationTruth } from './priceObservationTruth';
import { buildReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/monetaryCoherenceEvidence';
import {
  projectTrustedConsumerItemAmount,
  projectTrustedConsumerItemAmounts,
} from './consumerItemMonetaryTruth';
import {
  buildProductPriceHistory,
  buildReceiptEvidenceCache,
} from './productPriceHistory';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';

const RECEIPT074_CJK_LATIN = {
  merchant: 'コストコ',
  currency: 'JPY',
  total: 6292,
  tax: 466,
  items: [
    { name: '商品ア', quantity: 1, unitPrice: 998, lineTotal: 998 },
    { name: '商品イ', quantity: 1, unitPrice: 1280, lineTotal: 1280 },
    { name: '商品ウ', quantity: 1, unitPrice: 648, lineTotal: 648 },
    { name: '商品エ', quantity: 1, unitPrice: 1198, lineTotal: 1198 },
    { name: '商品オ', quantity: 1, unitPrice: 890, lineTotal: 890 },
    { name: '商品カ', quantity: 1, unitPrice: 680, lineTotal: 680 },
    { name: 'ケージフリータマゴ 20', quantity: 1, unitPrice: 758, lineTotal: 758 },
    { name: 'CAGE FREE EGG CPN', quantity: 1, unitPrice: -160, lineTotal: -160 },
  ],
};

describe('Receipt074 Round 3 A3 strong lexical', () => {
  it('L4 / P1 strong multi-token: CAGE FREE EGGS + CAGE FREE EGG CPN → 758/-160/598', () => {
    const result = applyReceiptDiscountsToItems(
      [{ name: 'CAGE FREE EGGS 20', lineTotal: 758, quantity: 1 }],
      [{ label: 'CAGE FREE EGG CPN', amount: -160 }]
    );
    expect(result.boundCount).toBe(1);
    expect(Number((result.items[0] as any).discountAllocated)).toBe(-160);
    expect(Number((result.items[0] as any).effectiveLineTotal)).toBe(598);
    expect(result.bindings[0]?.reason).toBe('strong_lexical_token_coverage');
  });

  it('L1 FREE incidental: GLUTEN FREE BREAD must not own CAGE FREE EGG CPN', () => {
    expect(
      findDiscountItemIndex(
        [{ name: 'GLUTEN FREE BREAD', lineTotal: 500 }],
        { label: 'CAGE FREE EGG CPN', amount: -160 }
      )
    ).toBe(-1);
    const result = applyReceiptDiscountsToItems(
      [
        { name: 'ケージフリータマゴ 20', lineTotal: 758 },
        { name: 'GLUTEN FREE BREAD', lineTotal: 500 },
      ],
      [{ label: 'CAGE FREE EGG CPN', amount: -160, adjacentPrecedingItemIndex: 1 }]
    );
    expect(result.boundCount).toBe(0);
  });

  it('L2 one weak token: ORGANIC MILK vs ORGANIC EGG CPN → unresolved', () => {
    expect(
      findDiscountItemIndex([{ name: 'ORGANIC MILK', lineTotal: 300 }], {
        label: 'ORGANIC EGG CPN',
        amount: -50,
      })
    ).toBe(-1);
  });

  it('L3 partial shared tokens across products → unresolved', () => {
    expect(
      findDiscountItemIndex(
        [
          { name: 'CAGE FREE BREAD', lineTotal: 400 },
          { name: 'FREE RANGE CHICKEN', lineTotal: 600 },
        ],
        { label: 'CAGE FREE EGG CPN', amount: -160 }
      )
    ).toBe(-1);
  });

  it('L5 cross-script CJK egg + Latin CPN → unresolved', () => {
    const out = normalizeOcrAnalysis(RECEIPT074_CJK_LATIN);
    const egg = out.items.find((i) => String(i.name).includes('ケージフリータマゴ'))!;
    expect(egg.discountAllocated).toBe(0);
    expect(out.discounts![0].ownershipStatus).toBe('unbound');
  });
});

describe('Receipt074 Round 3 A1 persisted binding revalidation', () => {
  it('rejects invalid/out-of-range/fractional boundItemIndex', () => {
    expect(isValidBoundItemIndex(999, 2)).toBe(false);
    expect(isValidBoundItemIndex(-1, 2)).toBe(false);
    expect(isValidBoundItemIndex(1.5, 2)).toBe(false);
    expect(isValidBoundItemIndex(Number.NaN, 2)).toBe(false);
    expect(isValidBoundItemIndex(0, 2)).toBe(true);

    const items = [
      {
        name: 'CAGE FREE EGGS 20',
        lineTotal: 758,
        discountAllocated: -160,
        effectiveLineTotal: 598,
      },
    ];
    for (const bad of [999, -1, 1.5, Number.NaN]) {
      expect(
        hasUnresolvedProductAffectingCoupons(items, [
          {
            label: 'CAGE FREE EGG CPN',
            amount: -160,
            ownershipStatus: 'bound',
            boundItemIndex: bad as number,
            ownershipReason: 'strong_lexical_token_coverage',
          },
        ])
      ).toBe(true);
    }
  });

  it('rejects bound metadata pointing at wrong product / deleted item', () => {
    const afterDelete = [
      { name: 'OTHER ITEM', lineTotal: 500, discountAllocated: 0, effectiveLineTotal: 500 },
    ];
    expect(
      hasUnresolvedProductAffectingCoupons(afterDelete, [
        {
          label: 'CAGE FREE EGG CPN',
          amount: -160,
          ownershipStatus: 'bound',
          boundItemIndex: 0,
          ownershipReason: 'strong_lexical_token_coverage',
        },
      ])
    ).toBe(true);

    const renamed = [
      {
        name: 'COMPLETELY DIFFERENT',
        lineTotal: 758,
        discountAllocated: -160,
        effectiveLineTotal: 598,
      },
    ];
    expect(
      hasUnresolvedProductAffectingCoupons(renamed, [
        {
          label: 'CAGE FREE EGG CPN',
          amount: -160,
          ownershipStatus: 'bound',
          boundItemIndex: 0,
          ownershipReason: 'strong_lexical_token_coverage',
        },
      ])
    ).toBe(true);
  });

  it('accepts unchanged valid deterministic binding', () => {
    const items = [
      {
        name: 'CAGE FREE EGGS 20',
        lineTotal: 758,
        discountAllocated: -160,
        effectiveLineTotal: 598,
      },
    ];
    const discounts = [
      {
        label: 'CAGE FREE EGG CPN',
        amount: -160,
        ownershipStatus: 'bound' as const,
        boundItemIndex: 0,
        ownershipReason: 'strong_lexical_token_coverage',
      },
    ];
    expect(hasUnresolvedProductAffectingCoupons(items, discounts)).toBe(false);
    const ownership = resolveDiscountOwnership({
      ocrItems: items,
      ocrDiscounts: discounts,
    });
    expect(ownership.status).toBe('persisted_resolved');
  });

  it('JSON round-trip + delete-bound-item → unresolved (Proof A)', () => {
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
    expect(normalized.items[0].discountAllocated).toBe(-160);
    expect(normalized.discounts![0].ownershipStatus).toBe('bound');

    const stored = JSON.parse(JSON.stringify(normalized));
    // Review-like: delete bound merchandise row; invalidate coupon meta.
    stored.items = [];
    stored.discounts = invalidateProductCouponOwnershipMetadata(stored.discounts);

    const ownership = resolveDiscountOwnership({
      ocrItems: stored.items,
      ocrDiscounts: stored.discounts,
      analysis: stored,
    });
    expect(ownership.status).toBe('unresolved');

    const consumer = projectTrustedConsumerItemAmount({
      lineTotal: 758,
      analysisJson: JSON.stringify(stored),
      receiptTotal: 598,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
    });
    expect(consumer.trusted).toBe(false);
    expect(consumer.amount).toBeNull();
  });

  it('amount-mutated item that breaks allocation → unresolved', () => {
    const items = [
      {
        name: 'CAGE FREE EGGS 20',
        lineTotal: 50,
        discountAllocated: 0,
        effectiveLineTotal: 50,
      },
    ];
    expect(
      hasUnresolvedProductAffectingCoupons(items, [
        {
          label: 'CAGE FREE EGG CPN',
          amount: -160,
          ownershipStatus: 'bound',
          boundItemIndex: 0,
          ownershipReason: 'strong_lexical_token_coverage',
        },
      ])
    ).toBe(true);
  });
});

describe('Receipt074 Round 3 A2 consumer monetary boundary', () => {
  it('Proof D: unresolved Receipt074 excludes trusted spend / search amount', () => {
    const out = normalizeOcrAnalysis(RECEIPT074_CJK_LATIN);
    const analysisJson = JSON.stringify({
      merchant: 'コストコ',
      items: out.items,
      discounts: out.discounts,
      tax: out.tax,
      total: out.total,
      tax_is_known: true,
    });
    const egg = out.items.find((i) => String(i.name).includes('ケージフリータマゴ'))!;
    const detail = projectTrustedConsumerItemAmount({
      lineTotal: egg.lineTotal,
      analysisJson,
      receiptTotal: out.total,
      receiptTax: out.tax,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
    });
    expect(detail.trusted).toBe(false);
    expect(detail.amount).toBeNull();
    expect(detail.reason).toBe('discount_ownership_unresolved');

    const searchProjected = projectTrustedConsumerItemAmounts([
      {
        receiptId: 'r074',
        lineTotal: 758,
        receiptAnalysisJson: analysisJson,
        receiptTotal: out.total,
        receiptTax: out.tax,
        receiptTaxIsKnown: 1,
        currency: 'JPY',
      },
    ]);
    expect(searchProjected[0].lineTotal).toBeNull();
    expect(searchProjected[0].monetaryTrusted).toBe(false);

    // Occurrence identity still present (projection does not drop the row).
    expect(searchProjected).toHaveLength(1);
  });

  it('store-level coupon leaves ownership resolved but product spend unavailable', () => {
    const analysisJson = JSON.stringify({
      items: [
        { name: 'A', lineTotal: 1000, quantity: 1 },
        { name: 'B', lineTotal: 500, quantity: 1 },
      ],
      discounts: [{ label: '店舗クーポン共通', amount: -200 }],
      tax: 0,
      total: 1300,
      tax_is_known: true,
      reconciliation: { ok: true },
      amount_mismatch: false,
    });
    const ownership = resolveDiscountOwnership({
      ocrItems: [
        { name: 'A', lineTotal: 1000 },
        { name: 'B', lineTotal: 500 },
      ],
      ocrDiscounts: [{ label: '店舗クーポン共通', amount: -200 }],
    });
    expect(ownership.status).not.toBe('unresolved');

    const projA = projectTrustedConsumerItemAmount({
      lineTotal: 1000,
      analysisJson,
      receiptTotal: 1300,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: 'A',
    });
    expect(projA.trusted).toBe(false);
    expect(projA.amount).toBeNull();
    expect(projA.reason).toBe('receipt_level_discount_unallocated_for_spend');
  });
});

describe('Receipt074 Round 3 freezes', () => {
  it('P10 Receipt073 280/-28/252', () => {
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
    expect(out.items[0].lineTotal).toBe(280);
    expect(out.items[0].discountAllocated).toBe(-28);
    expect(out.items[0].effectiveLineTotal).toBe(252);
  });

  it('Sample007 JP Ferrero remains unresolved', () => {
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
    expect(out.items[0].discountAllocated).toBe(0);
    const ownership = resolveDiscountOwnership({
      ocrItems: out.items,
      ocrDiscounts: out.discounts ?? [],
      analysis: { merchant: 'コストコ', items: out.items, discounts: out.discounts },
    });
    expect(ownership.status).toBe('unresolved');
  });

  it('PPH still excludes unresolved Receipt074', () => {
    const out = normalizeOcrAnalysis(RECEIPT074_CJK_LATIN);
    const egg = out.items.find((i) => String(i.name).includes('ケージフリータマゴ'))!;
    const analysis = {
      merchant: 'コストコ',
      items: out.items,
      discounts: out.discounts,
      tax: out.tax,
      tax_is_known: true,
      total: out.total,
      reconciliation: { ok: true },
      amount_mismatch: false,
    };
    const row = makeTrustedG3TestRow('r074', {
      receiptId: 'r074',
      occurredAt: 1_000,
      displayName: String(egg.name),
      grossLineAmount: 758,
      lineTotal: 758,
      effectiveLineAmount: 758,
      discountAllocated: 0,
      purchaseQuantity: 1,
      receiptTotal: out.total,
      receiptTax: out.tax,
      receiptTaxIsKnown: 1,
        currency: 'JPY',
      receiptAnalysisJson: JSON.stringify(analysis),
      itemAmountEvidenceState: 'coherent',
    });
    const cache = buildReceiptEvidenceCache([row]);
    expect(cache.get('r074')!.monetaryCoherenceEvidence.discountOwnershipStatus).toBe(
      'unresolved'
    );
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'egg' },
      [row],
      { receiptEvidenceCache: cache }
    );
    expect(history.observations[0]?.level2Eligible).toBe(false);
  });
});
