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

  it('structured OCR qty unrelated to package count is preserved', () => {
    expect(resolvePurchaseQuantity('牛乳 900ml', 2)).toBe(2);
  });
});
