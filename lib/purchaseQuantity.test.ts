import {
  extractExplicitPurchaseQuantity,
  extractPackageCountFromName,
  resolvePurchaseQuantity,
} from './purchaseQuantity';
import { parseProductSpecification } from './productSpecification';

describe('Sample 027 package count ≠ purchase quantity', () => {
  it.each(['電池単3 4個', '電池単4 4個'])('%s → purchase qty 1, package count 4', (name) => {
    expect(extractPackageCountFromName(name)).toBe(4);
    expect(resolvePurchaseQuantity(name, 4)).toBe(1);
    expect(resolvePurchaseQuantity(name, 1)).toBe(1);
    expect(parseProductSpecification(name).countBase).toBe(4);
  });

  it('10PC / 3PK are package counts, not purchase qty', () => {
    expect(extractPackageCountFromName('Battery 10PC')).toBe(10);
    expect(resolvePurchaseQuantity('Battery 10PC', 10)).toBe(1);
    expect(parseProductSpecification('Battery 10PC').countBase).toBe(10);

    expect(extractPackageCountFromName('Snack 3PK')).toBe(3);
    expect(resolvePurchaseQuantity('Snack 3PK', 3)).toBe(1);
    expect(parseProductSpecification('Snack 3PK').countBase).toBe(3);
  });

  it('explicit (¥108 × 3個) keeps purchase qty=3', () => {
    const name = 'おにぎり (¥108 × 3個)';
    expect(extractExplicitPurchaseQuantity(name)).toBe(3);
    expect(resolvePurchaseQuantity(name, 1)).toBe(3);
    expect(resolvePurchaseQuantity(name, 3)).toBe(3);
  });

  it('Sample 076: 正宗生煎包 4個 × @439 → purchase qty 4 (not package count)', () => {
    const name = '正宗生煎包 4個 × @439';
    expect(extractExplicitPurchaseQuantity(name)).toBe(4);
    expect(resolvePurchaseQuantity(name, 1)).toBe(4);
    expect(resolvePurchaseQuantity(name, 4)).toBe(4);
  });

  it('Sample 076 alt: @439 × 4個 → purchase qty 4', () => {
    expect(extractExplicitPurchaseQuantity('正宗生煎包 @439 × 4個')).toBe(4);
    expect(resolvePurchaseQuantity('正宗生煎包 @439 × 4個', 1)).toBe(4);
  });

  it('数量 N × 単価 N remains explicit', () => {
    expect(extractExplicitPurchaseQuantity('商品 数量4 × 単価439')).toBe(4);
    expect(resolvePurchaseQuantity('商品 数量4 × 単価439', 1)).toBe(4);
  });

  it('structured OCR qty unrelated to package count is preserved', () => {
    expect(resolvePurchaseQuantity('牛乳 900ml', 2)).toBe(2);
  });
});

describe('Receipt061 Japanese explicit purchase multiplier', () => {
  it.each([
    ['2個 × 単108', 2],
    ['2点 × 単108', 2],
    ['2本 × 単108', 2],
    ['2コ × @108', 2],
    ['2 × ¥108', 2],
    ['3個 @108円', 3],
    ['3点×108円', 3],
    ['2本＊単価150', 2],
    ['2袋*￥120', 2],
  ] as const)(
    '%s → explicit %i (overrides OCR qty=1 / missing)',
    (fragment, n) => {
      const name = `商品 ${fragment}`;
      expect(extractExplicitPurchaseQuantity(name)).toBe(n);
      expect(resolvePurchaseQuantity(name, n)).toBe(n);
      expect(resolvePurchaseQuantity(name, 1)).toBe(n);
      expect(resolvePurchaseQuantity(name, undefined)).toBe(n);
      expect(resolvePurchaseQuantity(name, null)).toBe(n);
    }
  );

  it('Receipt061 contrast: 2個 × 単108 vs 2個パック', () => {
    expect(
      resolvePurchaseQuantity('世界TEAチャイラテ 2個 × 単108', 2)
    ).toBe(2);
    expect(
      resolvePurchaseQuantity('世界TEAチャイラテ 2個 × 単108', 1)
    ).toBe(2);
    expect(resolvePurchaseQuantity('ヨーグルト 2個パック', 2)).toBe(1);
  });

  it('package / content negatives stay non-explicit (qty 1 when OCR echoes pack)', () => {
    const negatives = [
      '10個入',
      '4個パック',
      '12PC',
      '2個セット',
      '20本入り',
      '3本組',
      '牛乳 2本',
      '電池 4個',
    ];
    for (const name of negatives) {
      expect(extractExplicitPurchaseQuantity(name)).toBeNull();
    }
    expect(resolvePurchaseQuantity('10個入', 10)).toBe(1);
    expect(resolvePurchaseQuantity('4個パック', 4)).toBe(1);
    expect(resolvePurchaseQuantity('12PC', 12)).toBe(1);
    expect(resolvePurchaseQuantity('2個セット', 2)).toBe(1);
    expect(resolvePurchaseQuantity('20本入り', 20)).toBe(1);
    expect(resolvePurchaseQuantity('3本組', 3)).toBe(1);
    expect(resolvePurchaseQuantity('牛乳 2本', 2)).toBe(1);
    expect(resolvePurchaseQuantity('電池 4個', 4)).toBe(1);
  });

  it('bare N × size/spec is NOT purchase evidence', () => {
    for (const name of ['2 × 500ml', '2 x 3pack', '2 × 10cm']) {
      expect(extractExplicitPurchaseQuantity(name)).toBeNull();
      expect(resolvePurchaseQuantity(name, 1)).toBe(1);
    }
  });

  it('clean structured OCR qty=2 with product name only is preserved', () => {
    expect(resolvePurchaseQuantity('世界TEAチャイラテ', 2)).toBe(2);
    expect(extractExplicitPurchaseQuantity('世界TEAチャイラテ')).toBeNull();
  });
});
