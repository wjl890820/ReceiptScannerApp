import {
  normalizeIdentityText,
  parseProductSpecification,
} from './productSpecification';

describe('normalizeIdentityText', () => {
  it('normalizes Unicode while retaining specification and model numbers', () => {
    expect(normalizeIdentityText(' 明治ｵｲｼｲ牛乳９００ＭＬ ')).toBe(
      '明治オイシイ牛乳900ml'
    );
    expect(normalizeIdentityText('ＬＧ２１ １１２ｇ')).toBe('lg21 112g');
    expect(normalizeIdentityText('500ML X 6')).toBe('500ml×6');
  });
});

describe('parseProductSpecification', () => {
  it.each([
    ['牛乳900ml', 900, 'ml', 900],
    ['牛乳900ML', 900, 'ml', 900],
    ['牛乳900ｍｌ', 900, 'ml', 900],
    ['牛乳1L', 1, 'l', 1000],
    ['牛乳1l', 1, 'l', 1000],
    ['牛乳1.0L', 1, 'l', 1000],
  ] as const)('%s → volume specification', (raw, sizeValue, unit, baseMl) => {
    const spec = parseProductSpecification(raw);
    expect(spec.dimension).toBe('volume');
    expect(spec.sizeValue).toBe(sizeValue);
    expect(spec.sizeUnit).toBe(unit);
    expect(spec.packCount).toBe(1);
    expect(spec.volumeBaseMl).toBe(baseMl);
  });

  it.each([
    ['商品500g', 500, 'g', 500],
    ['商品500G', 500, 'g', 500],
    ['商品1kg', 1, 'kg', 1000],
  ] as const)('%s → weight specification', (raw, sizeValue, unit, baseG) => {
    const spec = parseProductSpecification(raw);
    expect(spec.dimension).toBe('weight');
    expect(spec.sizeValue).toBe(sizeValue);
    expect(spec.sizeUnit).toBe(unit);
    expect(spec.packCount).toBe(1);
    expect(spec.weightBaseG).toBe(baseG);
  });

  it.each([
    ['水 500ml×6', 500, 'ml', 6, 3000],
    ['水 500ml×6本', 500, 'ml', 6, 3000],
    ['水 500ml x 6', 500, 'ml', 6, 3000],
    ['水 500ML X 6', 500, 'ml', 6, 3000],
    ['水 2L×6本', 2, 'l', 6, 12000],
  ] as const)(
    '%s → volume multipack',
    (raw, sizeValue, unit, packCount, volumeBaseMl) => {
      const spec = parseProductSpecification(raw);
      expect(spec.dimension).toBe('volume');
      expect(spec.sizeValue).toBe(sizeValue);
      expect(spec.sizeUnit).toBe(unit);
      expect(spec.packCount).toBe(packCount);
      expect(spec.volumeBaseMl).toBe(volumeBaseMl);
    }
  );

  it('450g×2 keeps internal size and computes package total', () => {
    const spec = parseProductSpecification('商品 450g×2');
    expect(spec.dimension).toBe('weight');
    expect(spec.sizeValue).toBe(450);
    expect(spec.sizeUnit).toBe('g');
    expect(spec.packCount).toBe(2);
    expect(spec.weightBaseG).toBe(900);
  });

  it.each([
    ['卵10個', 10],
    ['3個入', 3],
    ['6本', 6],
    ['12枚', 12],
  ] as const)('%s → count specification', (raw, countBase) => {
    const spec = parseProductSpecification(raw);
    expect(spec.dimension).toBe('count');
    expect(spec.sizeValue).toBe(countBase);
    expect(spec.sizeUnit).toBe('count');
    expect(spec.packCount).toBe(1);
    expect(spec.countBase).toBe(countBase);
  });

  it('does not confuse model numbers with the explicit trailing weight', () => {
    expect(parseProductSpecification('LG21 112g').weightBaseG).toBe(112);
    expect(parseProductSpecification('R-1 112g').weightBaseG).toBe(112);
  });

  it.each([
    '午後の紅茶 500',
    'BOSS 185',
    'R-1',
    'LG21',
    '7プレミアム',
    '4901234567890',
    '12345678',
    '2025',
    '2026',
  ])('%s remains unknown without an explicit unit', (raw) => {
    expect(parseProductSpecification(raw)).toMatchObject({
      dimension: 'unknown',
      sizeValue: null,
      sizeUnit: null,
      packCount: null,
      volumeBaseMl: null,
      weightBaseG: null,
      countBase: null,
    });
  });

  it('keeps explicit BOSS candidates without deciding price compatibility', () => {
    expect(parseProductSpecification('BOSS 185ml')).toMatchObject({
      dimension: 'volume',
      sizeValue: 185,
      sizeUnit: 'ml',
      volumeBaseMl: 185,
    });
    expect(parseProductSpecification('BOSS 185g')).toMatchObject({
      dimension: 'weight',
      sizeValue: 185,
      sizeUnit: 'g',
      weightBaseG: 185,
    });
  });
});
