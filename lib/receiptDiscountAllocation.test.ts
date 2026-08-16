import {
  applyReceiptDiscountsToItems,
  findDiscountItemIndex,
  itemAmountForAnalytics,
  receiptLevelUnallocatedDiscountSum,
} from './receiptDiscountAllocation';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { buildReceiptAnalysisV1 } from './growthAnalysisEngineV1';
import { authoritativeReceiptTotal } from './scanReviewPresentation';

function signalValue(
  analysis: ReturnType<typeof buildReceiptAnalysisV1>,
  key: string
): number | string | undefined {
  return analysis.shopping_signals.find((s) => s.key === key)?.value;
}

describe('coupon / discount allocation', () => {
  it('Case 1: binds Ferrero ROCHER CPN -600 to gross 2988 → effective 2388', () => {
    const items = [
      { name: 'ITEM A', lineTotal: 1128, quantity: 1 },
      { name: 'ITEM B', lineTotal: 1128, quantity: 1 },
      { name: 'ITEM C', lineTotal: 1680, quantity: 1 },
      { name: 'ITEM D', lineTotal: 899, quantity: 1 },
      { name: 'ITEM E', lineTotal: 1128, quantity: 1 },
      { name: 'FERRERO ROCHER ORIGINS', lineTotal: 2988, quantity: 1 },
    ];
    const discounts = [{ label: 'ROCHER ORIGINS CPN', amount: -600 }];
    const result = applyReceiptDiscountsToItems(items, discounts);
    expect(result.boundCount).toBe(1);
    expect(result.unboundDiscounts).toEqual([]);
    const rocher = result.items.find((i) => String(i.name).includes('ROCHER'))!;
    expect(Number(rocher.lineTotal)).toBe(2988);
    expect(Number((rocher as { effectiveLineTotal?: number }).effectiveLineTotal)).toBe(2388);
    expect(Number((rocher as { discountAllocated?: number }).discountAllocated)).toBe(-600);
    const analyticsSum = result.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0);
    expect(analyticsSum).toBe(8351);
  });

  it('Case 2: binds シーフード CPN -340 and keeps receipt discounts', () => {
    const normalized = normalizeOcrAnalysis({
      items: [
        { name: 'シーフードミックス', quantity: 1, unitPrice: 1980, lineTotal: 1980 },
        { name: 'その他', quantity: 1, unitPrice: 24053, lineTotal: 24053 },
        { name: 'シーフード CPN', quantity: 1, unitPrice: -340, lineTotal: -340 },
      ],
      total: 25693,
      tax: 0,
      currency: 'JPY',
    });
    expect(normalized.discounts?.some((d) => d.amount === -340)).toBe(true);
    const seafood = normalized.items.find((i) =>
      String(i.name).includes('シーフードミックス')
    )!;
    expect(seafood.lineTotal).toBe(1980);
    expect(seafood.effectiveLineTotal).toBe(1640);
    const analyticsSum = normalized.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0);
    expect(analyticsSum).toBe(25693);
  });

  it('Case 3: external tax is not treated as discount mismatch force-fit', () => {
    const normalized = normalizeOcrAnalysis({
      items: [
        { name: '牛乳', quantity: 1, unitPrice: 2442, lineTotal: 2442 },
        { name: '外税', quantity: 1, unitPrice: 195, lineTotal: 195 },
      ],
      total: 2637,
      tax: 195,
      currency: 'JPY',
    });
    expect(normalized.items.map((i) => i.lineTotal)).toEqual([2442]);
    const merchandise = normalized.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0);
    expect(merchandise).toBe(2442);
    expect(normalized.tax).toBe(195);
    expect(normalized.total).toBe(2637);
    expect(normalized.discounts ?? []).toEqual([]);
  });

  it('Case 4: no coupon leaves amounts unchanged', () => {
    const normalized = normalizeOcrAnalysis({
      items: [
        { name: 'パン', quantity: 1, unitPrice: 120, lineTotal: 120 },
        { name: '牛乳', quantity: 1, unitPrice: 200, lineTotal: 200 },
      ],
      total: 320,
      tax: 0,
      currency: 'JPY',
    });
    expect(normalized.items).toHaveLength(2);
    expect(normalized.discounts ?? []).toEqual([]);
    expect(normalized.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0)).toBe(320);
  });

  it('does not guess when coupon binding is ambiguous', () => {
    const idx = findDiscountItemIndex(
      [
        { name: 'MILK A', lineTotal: 100 },
        { name: 'MILK B', lineTotal: 200 },
      ],
      { label: 'MILK CPN', amount: -50 }
    );
    expect(idx).toBe(-1);
  });

  it('Sample 048/058: adjacent まとめ売り値引 allocates to preceding item', () => {
    const normalized = normalizeOcrAnalysis({
      merchant: 'ヨークベニマル',
      currency: 'JPY',
      total: 2296,
      tax: null as any,
      items: [
        { name: 'その他A', quantity: 1, unitPrice: 2093, lineTotal: 2093 },
        { name: 'ファンタオレ70', quantity: 1, unitPrice: 210, lineTotal: 210 },
        { name: '▲まとめ売り値引', quantity: 1, unitPrice: -7, lineTotal: -7 },
      ],
    });
    const fanta = normalized.items.find((i) => String(i.name).includes('ファンタオレ'))!;
    expect(fanta.lineTotal).toBe(210);
    expect(fanta.effectiveLineTotal).toBe(203);
    expect(fanta.discountAllocated).toBe(-7);
    const analyticsSum = normalized.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0);
    expect(analyticsSum).toBe(2296);
    expect(normalized.total).toBe(2296);
  });

  it('ambiguous Costco-style coupon remains receipt-level (no adjacent force-fit)', () => {
    const result = applyReceiptDiscountsToItems(
      [
        { name: 'ITEM A', lineTotal: 1000 },
        { name: 'ITEM B', lineTotal: 2000 },
      ],
      [{ label: 'メーカークーポン', amount: -100, adjacentPrecedingItemIndex: 1 }]
    );
    expect(result.boundCount).toBe(0);
    expect(result.unboundDiscounts).toEqual([{ label: 'メーカークーポン', amount: -100 }]);
    expect(itemAmountForAnalytics(result.items[1])).toBe(2000);
  });
});

describe('Sample 007 Costco: receipt-level discount semantics (A4)', () => {
  const sample007Jp = {
    merchant: 'コストコ',
    currency: 'JPY',
    total: 8351,
    tax: 619,
    discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
    items: [
      {
        name: 'SNACK A',
        quantity: 1,
        unitPrice: 1128,
        lineTotal: 1128,
        categoryKey: 'snacks_drinks' as const,
      },
      {
        name: 'SNACK B',
        quantity: 1,
        unitPrice: 1128,
        lineTotal: 1128,
        categoryKey: 'snacks_drinks' as const,
      },
      {
        name: 'INGREDIENT A',
        quantity: 1,
        unitPrice: 1680,
        lineTotal: 1680,
        categoryKey: 'food_ingredients' as const,
      },
      {
        name: 'READY A',
        quantity: 1,
        unitPrice: 899,
        lineTotal: 899,
        categoryKey: 'ready_to_eat' as const,
      },
      {
        name: 'INGREDIENT B',
        quantity: 1,
        unitPrice: 1128,
        lineTotal: 1128,
        categoryKey: 'food_ingredients' as const,
      },
      {
        // Real Costco JP OCR name — Latin coupon tokens do not bind (A4).
        name: 'フェレロロシェオリジンズ*36コ',
        quantity: 1,
        unitPrice: 2988,
        lineTotal: 2988,
        categoryKey: 'snacks_drinks' as const,
      },
      {
        name: 'CPN ROCHER ORIGINS CPN',
        quantity: 1,
        unitPrice: -600,
        lineTotal: -600,
      },
    ],
  };

  it('dedupes explicit discounts[] + identical negative coupon item to one discount', () => {
    const out = normalizeOcrAnalysis(sample007Jp);
    expect(out.discounts).toHaveLength(1);
    expect(out.discounts![0].amount).toBe(-600);
    expect(out.items).toHaveLength(6);
  });

  it('keeps two genuinely different coupons', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 2000,
      tax: 0,
      discounts: [{ label: 'APPLE CPN', amount: -600 }],
      items: [
        { name: 'APPLE PIE', quantity: 1, unitPrice: 1600, lineTotal: 1600 },
        { name: 'BANANA CHIPS', quantity: 1, unitPrice: 1000, lineTotal: 1000 },
        { name: 'BANANA CPN', quantity: 1, unitPrice: -600, lineTotal: -600 },
      ],
    });
    expect(out.discounts).toHaveLength(2);
  });

  it('leaves JP Ferrero coupon receipt-level; categories stay gross; total_amount uses receipt.total', () => {
    const out = normalizeOcrAnalysis(sample007Jp);
    const ferrero = out.items.find((i) => String(i.name).includes('フェレロ'))!;
    expect(ferrero.lineTotal).toBe(2988);
    expect(ferrero.discountAllocated).toBe(0);
    expect(ferrero.effectiveLineTotal).toBe(2988);
    expect(receiptLevelUnallocatedDiscountSum(out.items, out.discounts)).toBe(-600);

    const analyticItems = out.items.map((it) => ({ ...it, category: it.categoryKey }));
    const analysis = buildReceiptAnalysisV1({
      items: analyticItems,
      total: out.total,
      discounts: out.discounts,
    });

    expect(signalValue(analysis, 'total_amount')).toBe(8351);
    expect(signalValue(analysis, 'merchandise_amount')).toBe(8951);
    expect(signalValue(analysis, 'receipt_level_discount')).toBe(-600);

    const byCat = Object.fromEntries(
      analysis.top_categories.map((c) => [c.category_main, c.amount])
    );
    expect(byCat.snacks_drinks).toBe(5244);
    expect(byCat.food_ingredients).toBe(2808);
    expect(byCat.ready_to_eat).toBe(899);

    // Category % must use merchandise denominator 8951, not net 8351.
    const snacks = analysis.top_categories.find((c) => c.category_main === 'snacks_drinks')!;
    expect(snacks.pct).toBeCloseTo((5244 / 8951) * 100, 5);
    expect(snacks.pct).not.toBeCloseTo((5244 / 8351) * 100, 5);

    // Unallocated discount is not assigned into any category bucket.
    expect(Object.values(byCat).reduce((a, b) => a + b, 0)).toBe(8951);
  });

  it('product-level allocated discount still reduces analytics item amount', () => {
    const result = applyReceiptDiscountsToItems(
      [{ name: 'FERRERO ROCHER ORIGINS', lineTotal: 2988, category: 'snacks_drinks' }],
      [{ label: 'ROCHER ORIGINS CPN', amount: -600 }]
    );
    expect(itemAmountForAnalytics(result.items[0])).toBe(2388);
    expect(receiptLevelUnallocatedDiscountSum(result.items, [{ label: 'ROCHER ORIGINS CPN', amount: -600 }])).toBe(
      0
    );
    const analysis = buildReceiptAnalysisV1({
      items: result.items,
      total: 2388,
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
    });
    expect(signalValue(analysis, 'merchandise_amount')).toBe(2388);
    expect(signalValue(analysis, 'receipt_level_discount')).toBe(0);
    expect(signalValue(analysis, 'total_amount')).toBe(2388);
  });

  it('Sample 007 mismatch validator: tax-included 8951-600=8351 → no warning', () => {
    const out = normalizeOcrAnalysis(sample007Jp);
    expect(out.amount_mismatch).toBe(false);
    expect(out.total).toBe(8351);
  });

  it('Sample 003 external tax: total_amount 2637; category merchandise 2442', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'イオン',
      currency: 'JPY',
      total: 2637,
      tax: 195,
      items: [
        {
          name: '牛乳',
          quantity: 1,
          unitPrice: 2442,
          lineTotal: 2442,
          categoryKey: 'food_ingredients',
        },
      ],
    });
    expect(out.amount_mismatch).toBe(false);
    expect(out.total).toBe(2637);
    expect(out.tax).toBe(195);
    const analysis = buildReceiptAnalysisV1({
      items: out.items.map((it) => ({ ...it, category: it.categoryKey })),
      total: out.total,
      discounts: out.discounts,
    });
    expect(signalValue(analysis, 'total_amount')).toBe(2637);
    expect(signalValue(analysis, 'merchandise_amount')).toBe(2442);
    expect(signalValue(analysis, 'receipt_level_discount')).toBe(0);
    expect(out.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0)).toBe(2442);
  });

  it('Review authoritative total ignores informational tax', () => {
    expect(authoritativeReceiptTotal({ total: 8351, tax: 619 })).toBe(8351);
    expect(authoritativeReceiptTotal({ total: 2637, tax: 195 })).toBe(2637);
  });
});
