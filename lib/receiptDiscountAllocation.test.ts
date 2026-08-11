import {
  applyReceiptDiscountsToItems,
  findDiscountItemIndex,
  itemAmountForAnalytics,
} from './receiptDiscountAllocation';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';

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
    const rocher = result.items.find((i) =>
      String(i.name).includes('ROCHER')
    )!;
    expect(Number(rocher.lineTotal)).toBe(2988);
    expect(Number((rocher as { effectiveLineTotal?: number }).effectiveLineTotal)).toBe(
      2388
    );
    const analyticsSum = result.items.reduce(
      (s, i) => s + itemAmountForAnalytics(i),
      0
    );
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
    const analyticsSum = normalized.items.reduce(
      (s, i) => s + itemAmountForAnalytics(i),
      0
    );
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
    // Tax line removed from items; merchandise remains 2442
    expect(normalized.items.map((i) => i.lineTotal)).toEqual([2442]);
    const merchandise = normalized.items.reduce(
      (s, i) => s + itemAmountForAnalytics(i),
      0
    );
    expect(merchandise).toBe(2442);
    expect(normalized.tax).toBe(195);
    expect(normalized.total).toBe(2637);
    // Do not invent discounts for tax
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
    expect(
      normalized.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0)
    ).toBe(320);
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
});
