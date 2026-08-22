import {
  SPEC_PARSER_VERSION,
  isReliableComparableSpec,
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
    expect(normalizeIdentityText('500mL*6')).toBe('500ml×6');
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
    ['牛乳1.5L', 1.5, 'l', 1500],
  ] as const)('%s → volume (A/B/C)', (raw, sizeValue, unit, baseMl) => {
    const spec = parseProductSpecification(raw);
    expect(spec.dimension).toBe('volume');
    expect(spec.sizeValue).toBe(sizeValue);
    expect(spec.sizeUnit).toBe(unit);
    expect(spec.packCount).toBe(1);
    expect(spec.volumeBaseMl).toBe(baseMl);
    expect(spec.reliability).toBe('exact');
    expect(spec.parserVersion).toBe(SPEC_PARSER_VERSION);
    expect(spec.rawText).toBe(raw);
  });

  it.each([
    ['商品500g', 500, 'g', 500],
    ['商品500G', 500, 'g', 500],
    ['商品1kg', 1, 'kg', 1000],
    ['商品5kg', 5, 'kg', 5000],
  ] as const)('%s → weight (D)', (raw, sizeValue, unit, baseG) => {
    const spec = parseProductSpecification(raw);
    expect(spec.dimension).toBe('weight');
    expect(spec.sizeValue).toBe(sizeValue);
    expect(spec.sizeUnit).toBe(unit);
    expect(spec.packCount).toBe(1);
    expect(spec.weightBaseG).toBe(baseG);
    expect(spec.reliability).toBe('exact');
  });

  it.each([
    ['水 500ml×6', 500, 'ml', 6, 3000],
    ['水 500ml×6本', 500, 'ml', 6, 3000],
    ['水 500ml x 6', 500, 'ml', 6, 3000],
    ['水 500ML X 6', 500, 'ml', 6, 3000],
    ['水 500mL*6', 500, 'ml', 6, 3000],
    ['水 6×500ml', 500, 'ml', 6, 3000],
    ['水 6 x 500ml', 500, 'ml', 6, 3000],
    ['水 2L×6本', 2, 'l', 6, 12000],
  ] as const)(
    '%s → volume multipack (F/G)',
    (raw, sizeValue, unit, packCount, volumeBaseMl) => {
      const spec = parseProductSpecification(raw);
      expect(spec.dimension).toBe('volume');
      expect(spec.sizeValue).toBe(sizeValue);
      expect(spec.sizeUnit).toBe(unit);
      expect(spec.packCount).toBe(packCount);
      expect(spec.volumeBaseMl).toBe(volumeBaseMl);
      expect(spec.reliability).toBe('exact');
      expect(isReliableComparableSpec(spec)).toBe(true);
    }
  );

  it('2×500g → total weight 1000g (I)', () => {
    const spec = parseProductSpecification('商品 2×500g');
    expect(spec.dimension).toBe('weight');
    expect(spec.sizeValue).toBe(500);
    expect(spec.packCount).toBe(2);
    expect(spec.weightBaseG).toBe(1000);
  });

  it('450g×2 keeps internal size and computes package total', () => {
    const spec = parseProductSpecification('商品 450g×2');
    expect(spec.dimension).toBe('weight');
    expect(spec.sizeValue).toBe(450);
    expect(spec.sizeUnit).toBe('g');
    expect(spec.packCount).toBe(2);
    expect(spec.weightBaseG).toBe(900);
  });

  it.each([
    ['卵10個', 10, 1, 10],
    ['3個入', 3, 1, 3],
    ['12枚', 12, 1, 12],
    ['10個×2', 10, 2, 20],
    ['2×10個', 10, 2, 20],
  ] as const)('%s → count (E/H)', (raw, perPack, packCount, total) => {
    const spec = parseProductSpecification(raw);
    expect(spec.dimension).toBe('count');
    expect(spec.sizeValue).toBe(perPack);
    expect(spec.sizeUnit).toBe('count');
    expect(spec.packCount).toBe(packCount);
    expect(spec.countBase).toBe(total);
    expect(spec.reliability).toBe('exact');
  });

  it.each([
    '3袋×2',
    '2×3袋',
    '6本',
    'ケース12',
    '2P',
    '3パック',
    '12入',
  ])('%s does not fabricate physical content (J)', (raw) => {
    const spec = parseProductSpecification(raw);
    expect(spec.dimension).toBe('unknown');
    expect(spec.volumeBaseMl).toBeNull();
    expect(spec.weightBaseG).toBeNull();
    expect(spec.countBase).toBeNull();
    expect(spec.reliability).toBe('unknown');
    expect(spec.rawText).toBe(raw);
    expect(isReliableComparableSpec(spec)).toBe(false);
  });

  it('purchase quantity is not encoded into packCount (K)', () => {
    // Spec parser sees only the product name. Quantity=2 is a line field.
    const spec = parseProductSpecification('牛乳 500ml');
    expect(spec.packCount).toBe(1);
    expect(spec.volumeBaseMl).toBe(500);
    expect(spec.sizeValue).toBe(500);
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
  ])('%s remains unknown without an explicit unit (N)', (raw) => {
    expect(parseProductSpecification(raw)).toMatchObject({
      dimension: 'unknown',
      sizeValue: null,
      sizeUnit: null,
      packCount: null,
      volumeBaseMl: null,
      weightBaseG: null,
      countBase: null,
      reliability: 'unknown',
      rawText: raw,
    });
  });

  it('keeps explicit BOSS candidates without deciding price compatibility', () => {
    expect(parseProductSpecification('BOSS 185ml')).toMatchObject({
      dimension: 'volume',
      sizeValue: 185,
      sizeUnit: 'ml',
      volumeBaseMl: 185,
      parserVersion: SPEC_PARSER_VERSION,
    });
    expect(parseProductSpecification('BOSS 185g')).toMatchObject({
      dimension: 'weight',
      sizeValue: 185,
      sizeUnit: 'g',
      weightBaseG: 185,
    });
  });

  it('raw source text survives normalization (O) and parserVersion is present (P)', () => {
    const raw = '水 ５００ｍｌ×６本';
    const spec = parseProductSpecification(raw);
    expect(spec.rawText).toBe(raw);
    expect(spec.sourceText).toContain('500ml');
    expect(spec.parserVersion).toBe(SPEC_PARSER_VERSION);
    expect(spec.volumeBaseMl).toBe(3000);
  });


  it('rebuild reproduces the same normalized spec without duplication (Q)', () => {
    const raw = '水 500ml×6';
    const a = parseProductSpecification(raw);
    const b = parseProductSpecification(a.rawText ?? raw);
    expect(b).toEqual(a);
    expect(b.volumeBaseMl).toBe(3000);
    expect(b.packCount).toBe(6);
  });
});
