import {
  buildSkuKey,
  isSpecificationCompatibleWithFamily,
  resolveProductIdentity,
} from './productIdentity';
import { normalizeReceiptItemName } from './productNormalizer';

describe('resolveProductIdentity', () => {
  it('明治半角片假名商品保留 full identity，并解析 900ml/milk', () => {
    const identity = resolveProductIdentity({
      rawName: '明治ｵｲｼｲ牛乳900ML',
    });

    expect(identity.normalizedFullName).toBe('明治オイシイ牛乳900ml');
    expect(identity.specification).toMatchObject({
      dimension: 'volume',
      sizeValue: 900,
      sizeUnit: 'ml',
      packCount: 1,
      volumeBaseMl: 900,
    });
    expect(identity.productFamilyKey).toBe('milk');
    expect(identity.canonicalProductName).toBe('明治 おいしい牛乳');
    expect(identity.brand).toBe('明治');
    expect(identity.identitySource).toBe('high_confidence_rule');
    expect(identity.identityVersion).toBe(1);
  });

  it('明治 900ml 与 450ml 是同 canonical、不同 spec 和 SKU', () => {
    const large = resolveProductIdentity({
      rawName: '明治 おいしい牛乳 900ml',
    });
    const small = resolveProductIdentity({
      rawName: '明治 おいしい牛乳 450ml',
    });

    expect(large.productFamilyKey).toBe('milk');
    expect(small.productFamilyKey).toBe('milk');
    expect(large.canonicalProductName).toBe('明治 おいしい牛乳');
    expect(small.canonicalProductName).toBe(large.canonicalProductName);
    expect(large.specification.volumeBaseMl).toBe(900);
    expect(small.specification.volumeBaseMl).toBe(450);
    expect(buildSkuKey(large)).not.toBeNull();
    expect(buildSkuKey(small)).not.toBeNull();
    expect(buildSkuKey(large)).not.toBe(buildSkuKey(small));
  });

  it('雪印与 TOPVALU 同 family，但 canonical 和 SKU 不同', () => {
    const snow = resolveProductIdentity({
      rawName: '雪印メグミルク 1L',
    });
    const topvalu = resolveProductIdentity({
      rawName: 'TOPVALU 牛乳 1000ml',
    });

    expect(snow.productFamilyKey).toBe('milk');
    expect(topvalu.productFamilyKey).toBe('milk');
    expect(snow.canonicalProductName).toBe('雪印 メグミルク');
    expect(topvalu.canonicalProductName).toBe('TOPVALU 牛乳');
    expect(snow.canonicalProductName).not.toBe(topvalu.canonicalProductName);
    expect(buildSkuKey(snow)).not.toBe(buildSkuKey(topvalu));
  });

  it('FamilyMart 水由商品名决定 water，不会变成 onigiri', () => {
    const identity = resolveProductIdentity({
      rawName: '水 500ml×6本',
      merchantName: 'FamilyMart',
    });
    expect(identity.productFamilyKey).toBe('water');
    expect(identity.specification).toMatchObject({
      sizeValue: 500,
      sizeUnit: 'ml',
      packCount: 6,
      volumeBaseMl: 3000,
    });
  });

  it('没有高置信 canonical evidence 时不以 normalizedName 冒充 canonical', () => {
    const identity = resolveProductIdentity({
      rawName: 'なぞ商品 500ml',
    });
    expect(identity.normalizedName).toBeTruthy();
    expect(identity.canonicalProductName).toBeNull();
    expect(identity.identitySource).toBe('legacy_fallback');
    expect(buildSkuKey(identity)).toBeNull();
  });

  it('LG21/R-1 型号保留，规格只取明确的 112g', () => {
    const lg = resolveProductIdentity({ rawName: 'LG21 112g' });
    const r1 = resolveProductIdentity({ rawName: 'R-1 112g' });

    expect(lg.normalizedFullName).toContain('lg21');
    expect(r1.normalizedFullName).toContain('r-1');
    expect(lg.specification.weightBaseG).toBe(112);
    expect(r1.specification.weightBaseG).toBe(112);
  });

  it('BOSS weight candidate is retained but incompatible with coffee price basis', () => {
    const noUnit = resolveProductIdentity({ rawName: 'BOSS 185' });
    const volume = resolveProductIdentity({ rawName: 'BOSS 185ml' });
    const weight = resolveProductIdentity({ rawName: 'BOSS 185g' });

    expect(noUnit.specification.dimension).toBe('unknown');
    expect(volume.productFamilyKey).toBe('coffee');
    expect(volume.specification.dimension).toBe('volume');
    expect(
      isSpecificationCompatibleWithFamily(
        volume.specification,
        volume.productFamilyKey
      )
    ).toBe(true);
    expect(weight.productFamilyKey).toBe('coffee');
    expect(weight.specification.dimension).toBe('weight');
    expect(
      isSpecificationCompatibleWithFamily(
        weight.specification,
        weight.productFamilyKey
      )
    ).toBe(false);
  });
});

describe('legacy normalized_name compatibility', () => {
  it.each([
    '明治ｵｲｼｲ牛乳900ML',
    '水500ml',
    '卵10個',
  ])('%s keeps normalizeReceiptItemName output exactly unchanged', (rawName) => {
    const before = normalizeReceiptItemName(rawName).normalized_name;
    const identity = resolveProductIdentity({ rawName });
    expect(identity.normalizedName).toBe(before);
  });
});
