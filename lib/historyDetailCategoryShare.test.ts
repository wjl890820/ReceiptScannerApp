import {
  categoryDisplayPercent,
  sumCategoryDisplayAmounts,
} from './historyDetailCategoryShare';

const EXTERNAL_TAX_ROWS = [
  { category: 'snacks_drinks', amount: 1418 },
  { category: 'ready_to_eat', amount: 350 },
  { category: 'food_ingredients', amount: 208 },
];

describe('history detail category share denominator', () => {
  it('uses the classified merchandise sum, not the tax-inclusive receipt total', () => {
    const receiptTotal = 2134;
    const categoryDisplayTotal = sumCategoryDisplayAmounts(EXTERNAL_TAX_ROWS);
    expect(categoryDisplayTotal).toBe(1976);
    expect(categoryDisplayTotal).not.toBe(receiptTotal);

    const snacks = categoryDisplayPercent(1418, categoryDisplayTotal);
    const ready = categoryDisplayPercent(350, categoryDisplayTotal);
    const ingredients = categoryDisplayPercent(208, categoryDisplayTotal);
    expect(snacks).toBeCloseTo((1418 / 1976) * 100, 5);
    expect(ready).toBeCloseTo((350 / 1976) * 100, 5);
    expect(ingredients).toBeCloseTo((208 / 1976) * 100, 5);
    expect(Math.round(snacks)).toBe(72);
    expect(Math.round(ready)).toBe(18);
    expect(Math.round(ingredients)).toBe(11);
    expect((1418 / receiptTotal) * 100).not.toBeCloseTo(snacks, 1);
  });

  it('is unchanged when category amounts already equal the receipt total', () => {
    const rows = [
      { amount: 700 },
      { amount: 300 },
    ];
    const receiptTotal = 1000;
    const categoryDisplayTotal = sumCategoryDisplayAmounts(rows);
    expect(categoryDisplayTotal).toBe(receiptTotal);
    expect(categoryDisplayPercent(700, categoryDisplayTotal)).toBe(70);
    expect(categoryDisplayPercent(300, categoryDisplayTotal)).toBe(30);
  });

  it('keeps a receipt-level discount out of the category denominator', () => {
    const rows = [
      { amount: 800 },
      { amount: 200 },
    ];
    const receiptTotalAfterDiscount = 900;
    const categoryDisplayTotal = sumCategoryDisplayAmounts(rows);
    expect(categoryDisplayTotal).toBe(1000);
    expect(categoryDisplayTotal).not.toBe(receiptTotalAfterDiscount);
    expect(categoryDisplayPercent(800, categoryDisplayTotal)).toBe(80);
    expect(categoryDisplayPercent(200, categoryDisplayTotal)).toBe(20);
    expect(categoryDisplayPercent(800, receiptTotalAfterDiscount)).not.toBe(80);
  });

  it('does not divide by zero when no category amount is rendered', () => {
    expect(sumCategoryDisplayAmounts([])).toBe(0);
    expect(categoryDisplayPercent(100, 0)).toBe(0);
    expect(Number.isNaN(categoryDisplayPercent(100, 0))).toBe(false);
    expect(categoryDisplayPercent(Number.NaN, 100)).toBe(0);
  });

  it('follows the rendered category rows regardless of item source', () => {
    const fromAnalysis = [{ amount: 1418 }, { amount: 350 }, { amount: 208 }];
    const fromUserItems = [{ amount: 1418 }, { amount: 350 }, { amount: 208 }];
    expect(sumCategoryDisplayAmounts(fromAnalysis)).toBe(
      sumCategoryDisplayAmounts(fromUserItems)
    );
    expect(sumCategoryDisplayAmounts(fromUserItems)).toBe(1976);
  });
});
