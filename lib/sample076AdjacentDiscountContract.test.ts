/**
 * Sample 076 production-shape adjacent-discount contract.
 * Starts from Edge-like OCR JSON (ordered kind=discount rows, real printed labels)
 * through normalize → category resolution → analytics/History amount boundary.
 */

import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { resolveProductCategoryRuntime } from './productCategory';

/** Edge-like Sample 076: ordered adjacent 割引 10% rows, no unlinked discounts[]. */
function sample076EdgeLikeAnalysis() {
  return {
    merchant: '業務スーパー古川店',
    currency: 'JPY' as const,
    total: 3393,
    tax: 251,
    items: [
      { name: '鶏肉', quantity: 1, unitPrice: 372, lineTotal: 372, categoryKey: 'food_ingredients' as const },
      {
        name: '割引 10%',
        quantity: 1,
        unitPrice: -38,
        lineTotal: -38,
        kind: 'discount' as const,
      },
      { name: '鶏肉', quantity: 1, unitPrice: 378, lineTotal: 378, categoryKey: 'food_ingredients' as const },
      {
        name: '割引 10%',
        quantity: 1,
        unitPrice: -38,
        lineTotal: -38,
        kind: 'discount' as const,
      },
      {
        name: 'ロッテモナ王クランキー',
        quantity: 1,
        unitPrice: 108,
        lineTotal: 108,
        categoryKey: 'snacks_drinks' as const,
      },
      {
        name: '鎮江香醋（ちんこうこう）',
        quantity: 1,
        unitPrice: 313,
        lineTotal: 313,
        categoryKey: 'food_ingredients' as const,
      },
      { name: 'むき甘栗', quantity: 1, unitPrice: 100, lineTotal: 100, categoryKey: 'snacks_drinks' as const },
      {
        name: 'うす皮付落花生（無塩）',
        quantity: 1,
        unitPrice: 103,
        lineTotal: 103,
        categoryKey: 'food_ingredients' as const,
      },
      {
        name: 'ココアピーナッツ',
        quantity: 1,
        unitPrice: 88,
        lineTotal: 88,
        categoryKey: 'snacks_drinks' as const,
      },
      {
        name: '正宗生煎包 4個 × @439',
        quantity: 1,
        unitPrice: 439,
        lineTotal: 1756,
        categoryKey: 'ready_to_eat' as const,
      },
    ],
  };
}

function sumByResolvedCategory(
  items: Array<{ name?: string; categoryKey?: string; category?: string }>
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const it of items) {
    const cat = resolveProductCategoryRuntime({
      itemName: typeof it.name === 'string' ? it.name : '',
      ocrKey: (it as { category?: string }).category ?? it.categoryKey,
    });
    map[cat] = (map[cat] ?? 0) + itemAmountForAnalytics(it);
  }
  return map;
}

describe('Sample 076 production adjacent-discount contract', () => {
  it('Edge-like JSON → normalize → category total 3142 (not gross 3218)', () => {
    const normalized = normalizeOcrAnalysis(sample076EdgeLikeAnalysis() as any);

    const chickens = normalized.items.filter((i) => i.name === '鶏肉');
    expect(chickens).toHaveLength(2);
    expect(chickens[0].lineTotal).toBe(372);
    expect(chickens[0].effectiveLineTotal).toBe(334);
    expect(chickens[1].lineTotal).toBe(378);
    expect(chickens[1].effectiveLineTotal).toBe(340);

    const bao = normalized.items.find((i) => String(i.name).includes('正宗生煎包'));
    expect(bao?.quantity).toBe(4);

    expect(normalized.tax).toBe(251);
    expect(normalized.total).toBe(3393);

    const byCat = sumByResolvedCategory(normalized.items as any[]);
    expect(byCat.food_ingredients).toBe(1090);
    expect(byCat.snacks_drinks).toBe(296);
    expect(byCat.ready_to_eat).toBe(1756);
    const categoryTotal = Object.values(byCat).reduce((s, n) => s + n, 0);
    expect(categoryTotal).toBe(3142);
    expect(normalized.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0)).toBe(3142);
  });
});
