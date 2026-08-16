/**
 * Build 27 Sample 058 double-count regression.
 * Closest-real Edge payload: discounts[] label includes group price while
 * items[] also has ▲まとめ売り値引 — must allocate once (203), not twice (196).
 */

import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import {
  applyReceiptDiscountsToItems,
  itemAmountForAnalytics,
} from './receiptDiscountAllocation';
import { classifyItemByName } from './productCategory';
import { detectCostcoReceiptSignals } from './groceryDetector';

describe('Build 27 Sample 058 — まとめ売り must not double-count', () => {
  const sample058ClosestReal = {
    merchant: 'ヨークベニマル',
    currency: 'JPY' as const,
    total: 2296,
    tax: null as any,
    // Edge prompt may embed group price into discounts[].label
    discounts: [{ label: 'まとめ売り値引 2個¥203', amount: -7 }],
    items: [
      { name: 'ブロッコリー', quantity: 1, unitPrice: 192, lineTotal: 192 },
      { name: 'にんにく', quantity: 1, unitPrice: 105, lineTotal: 105 },
      { name: 'スープ', quantity: 1, unitPrice: 246, lineTotal: 246 },
      { name: 'お酢', quantity: 1, unitPrice: 105, lineTotal: 105 },
      { name: 'FAピーチ', quantity: 1, unitPrice: 254, lineTotal: 254 },
      { name: '横浜家系', quantity: 1, unitPrice: 1191, lineTotal: 1191 },
      { name: 'ファンタオレ70', quantity: 1, unitPrice: 210, lineTotal: 210 },
      { name: '▲まとめ売り値引', quantity: 1, unitPrice: -7, lineTotal: -7 },
      { name: '2個¥203 × 1組', quantity: 1, unitPrice: 0, lineTotal: 0 },
    ],
  };

  it('diagnoses dual representation: one logical discount after normalize', () => {
    const out = normalizeOcrAnalysis(sample058ClosestReal as any);
    expect(out.discounts).toHaveLength(1);
    expect(out.discounts![0].amount).toBe(-7);

    const fanta = out.items.find((i) => String(i.name).includes('ファンタオレ'))!;
    expect(fanta.lineTotal).toBe(210);
    expect(fanta.discountAllocated).toBe(-7);
    expect(fanta.effectiveLineTotal).toBe(203);
    expect(fanta.effectiveLineTotal).not.toBe(196);
  });

  it('category sum uses effective once: Fant contributes 203 → total 2296 (not 2289)', () => {
    const out = normalizeOcrAnalysis(sample058ClosestReal as any);
    const fanta = out.items.find((i) => String(i.name).includes('ファンタオレ'))!;
    expect(itemAmountForAnalytics(fanta)).toBe(203);

    // Build 27 gross snacks bucket was 464 (=254+210). After one -7 → 457.
    const peach = out.items.find((i) => String(i.name).includes('ピーチ'))!;
    const snacksEffective =
      itemAmountForAnalytics(peach) + itemAmountForAnalytics(fanta);
    expect(snacksEffective).toBe(457);
    expect(snacksEffective).not.toBe(464);
    expect(snacksEffective).not.toBe(450);

    const yokohama = out.items.find((i) => String(i.name).includes('横浜'))!;
    expect(itemAmountForAnalytics(yokohama)).toBe(1191);

    const ingredients = out.items
      .filter((i) =>
        ['ブロッコリー', 'にんにく', 'スープ', 'お酢'].some((n) =>
          String(i.name).includes(n)
        )
      )
      .reduce((s, i) => s + itemAmountForAnalytics(i), 0);
    expect(ingredients).toBe(648);

    const categoryTotal = 1191 + 648 + snacksEffective;
    expect(categoryTotal).toBe(2296);
    expect(out.total).toBe(2296);
    expect(out.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0)).toBe(2296);
  });

  it('allocation guard: even if two discount rows survive, Fant is not double-bound', () => {
    const result = applyReceiptDiscountsToItems(
      [
        { name: 'FAピーチ', lineTotal: 254 },
        { name: 'ファンタオレ70', lineTotal: 210 },
      ],
      [
        { label: 'まとめ売り値引 2個¥203', amount: -7 },
        { label: '▲まとめ売り値引', amount: -7, adjacentPrecedingItemIndex: 1 },
      ],
      { evidenceTexts: ['2個¥203 × 1組'] }
    );
    const fanta = result.items[1] as {
      discountAllocated?: number;
      effectiveLineTotal?: number;
    };
    expect(fanta.discountAllocated).toBe(-7);
    expect(fanta.effectiveLineTotal).toBe(203);
  });
});

describe('Build 27 already-PASS regressions', () => {
  it('051 Costco multi-signal still holds', () => {
    expect(
      detectCostcoReceiptSignals({
        merchant: 'WHOLESALE',
        items: [],
        rawText: 'BIZ/GOLD',
      }).isCostco
    ).toBe(true);
  });
  it('055 / 060 classification still holds', () => {
    expect(classifyItemByName('がぶっとエクレアミルククリーム')).toBe('snacks_drinks');
    expect(classifyItemByName('SVジャパンエール')).toBe('snacks_drinks');
  });
});
