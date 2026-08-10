import { resolveProductFamily } from './productFamily';
import { normalizeIdentityText } from './productSpecification';

function family(rawName: string, merchantName?: string): string | null {
  return resolveProductFamily({
    rawName,
    normalizedFullName: normalizeIdentityText(rawName),
    merchantName,
  }).family;
}

describe('resolveProductFamily', () => {
  it.each([
    ['明治 おいしい牛乳 900ml', 'milk'],
    ['雪印メグミルク 1L', 'milk'],
    ['卵10個', 'eggs'],
    ['たまご', 'eggs'],
    ['玉子', 'eggs'],
    ['木綿豆腐', 'tofu'],
    ['とうふ', 'tofu'],
    ['LG21 ヨーグルト 112g', 'yogurt'],
    ['精米 5kg', 'rice'],
    ['食パン 6枚', 'bread'],
    ['BOSS 185ml', 'coffee'],
    ['珈琲', 'coffee'],
    ['午後の紅茶 500ml', 'tea'],
    ['天然水 2L', 'water'],
    ['コカ・コーラ 500ml', 'cola'],
    ['鮭おにぎり', 'onigiri'],
    ['幕の内弁当', 'bento'],
  ])('%s → %s', (rawName, expected) => {
    expect(family(rawName)).toBe(expected);
  });

  it('uses product text, never merchant, as family evidence', () => {
    expect(family('水 500ml×6本', 'FamilyMart')).toBe('water');
    expect(family('商品 500ml', 'FamilyMart')).toBeNull();
    expect(family('商品', 'Lawson')).toBeNull();
  });

  it('keeps broad or non-product パン matches conservative', () => {
    expect(family('パン粉')).toBeNull();
    expect(family('パンツ')).toBeNull();
  });

  it('uses category only as a negative compatibility constraint', () => {
    expect(
      resolveProductFamily({
        rawName: '牛乳',
        category: 'household',
      }).family
    ).toBeNull();
  });

  it('honors canonical evidence before conflicting raw-name evidence', () => {
    expect(
      resolveProductFamily({
        rawName: '紅茶',
        canonicalProductName: '天然水',
      }).family
    ).toBe('water');
  });
});
