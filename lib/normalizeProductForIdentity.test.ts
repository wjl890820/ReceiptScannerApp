import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import { parseProductSpecification } from './productSpecification';
import { normalizeProductText } from './universalProductNormalizer';
import {
  getAttributeValue,
  parseStructuralProductAttributes,
} from './universalProductSpecParser';

function dims(raw: string): string[] {
  return normalizeProductForIdentity(raw).attributes.entries.map((e) => e.dimension);
}

function num(raw: string, dimension: string): number | null {
  const v = getAttributeValue(
    parseStructuralProductAttributes(raw).attributes,
    dimension
  );
  return typeof v === 'number' ? v : null;
}

describe('universalProductNormalizer (Batch 2)', () => {
  it('NFKC + full-width digits/units; keeps distinguishing tokens', () => {
    const a = normalizeProductText('東北恵　牛乳１０００ＭＬ');
    const b = normalizeProductText('東北恵牛乳 1L');
    expect(a.normalized).toMatch(/1000ml/i);
    expect(a.normalized).toContain('東北恵');
    expect(b.normalized.toLowerCase()).toContain('1l');
    // comparison keys should be punctuation/space-insensitive cousins
    expect(a.comparisonKey).toContain('1000ml');
    expect(normalizeProductText('ＡＢＣ　500ｍｌ').normalized).toMatch(/ABC.*500ml/i);
  });

  it('does not strip flavor / fat / EX tokens', () => {
    const n = normalizeProductText('無糖ミルクティー EX 低脂肪');
    expect(n.normalized).toContain('無糖');
    expect(n.normalized).toContain('ミルクティー');
    expect(n.normalized.toUpperCase()).toContain('EX');
    expect(n.normalized).toContain('低脂肪');
  });
});

describe('universalProductSpecParser (Batch 2)', () => {
  describe('volume', () => {
    it.each([
      ['500ml', 500],
      ['500 ML', 500],
      ['1L', 1000],
      ['1.5L', 1500],
      ['1000ｍｌ', 1000],
    ])('%s → volume %s ml', (raw, ml) => {
      expect(num(raw, 'volume')).toBe(ml);
    });

    it('500ml×6本 keeps pack structure (not only total)', () => {
      const r = normalizeProductForIdentity('天然水 500ml×6本');
      expect(getAttributeValue(r.attributes, 'volume')).toBe(500);
      expect(getAttributeValue(r.attributes, 'pack_count')).toBe(6);
      expect(getAttributeValue(r.attributes, 'total_volume')).toBe(3000);
    });

    it('2L×6 and 6×500ml', () => {
      expect(num('炭酸水 2L×6本', 'volume')).toBe(2000);
      expect(num('炭酸水 2L×6本', 'pack_count')).toBe(6);
      expect(num('水 6×500ml', 'volume')).toBe(500);
      expect(num('水 6×500ml', 'pack_count')).toBe(6);
    });
  });

  describe('mass', () => {
    it.each([
      ['100g', 100],
      ['500 g', 500],
      ['1kg', 1000],
      ['1.5KG', 1500],
      ['1500ｇ', 1500],
    ])('%s → mass %s g', (raw, g) => {
      expect(num(raw, 'mass')).toBe(g);
    });

    it('200g×3袋 keeps pack structure', () => {
      const r = normalizeProductForIdentity('きなこ 200g×3袋');
      expect(getAttributeValue(r.attributes, 'mass')).toBe(200);
      expect(getAttributeValue(r.attributes, 'pack_count')).toBe(3);
      expect(getAttributeValue(r.attributes, 'total_mass')).toBe(600);
    });
  });

  describe('count', () => {
    it.each([
      ['卵10個', 10, '個'],
      ['電池8本', 8, '本'],
      ['マスク30枚', 30, '枚'],
      ['3食入', 3, '食'],
    ])('%s → count', (raw, value, unit) => {
      const r = parseStructuralProductAttributes(raw);
      const entry = r.attributes.entries.find((e) => e.dimension === 'count');
      expect(entry?.value).toBe(value);
      expect(String(entry?.unit)).toContain(unit.toLowerCase() === unit ? unit : unit);
    });
  });

  describe('roll_count / length', () => {
    it('トイレットペーパー12ロール', () => {
      expect(num('トイレットペーパー12ロール', 'roll_count')).toBe(12);
    });

    it('USB-Cケーブル2m and ラップ50m', () => {
      expect(num('USB-Cケーブル2m', 'length')).toBe(2000);
      expect(num('ラップ50m', 'length')).toBe(50_000);
      expect(num('テープ50cm', 'length')).toBe(500);
    });
  });

  describe('partial understanding', () => {
    it('Panasonic 単3 8本 → count only (no invented battery_size)', () => {
      const r = normalizeProductForIdentity('Panasonic 単3 8本');
      expect(getAttributeValue(r.attributes, 'count')).toBe(8);
      expect(dims('Panasonic 単3 8本')).not.toContain('battery_size');
    });

    it('name-only yields empty attributes', () => {
      expect(normalizeProductForIdentity('本日のおかず').attributes.entries).toEqual(
        []
      );
    });
  });

  describe('anti-false-positive edge cases', () => {
    it('does not treat M6×20 as a 20-pack', () => {
      const r = normalizeProductForIdentity('ビス M6×20 8本');
      expect(getAttributeValue(r.attributes, 'pack_count')).toBeNull();
      expect(getAttributeValue(r.attributes, 'volume')).toBeNull();
      expect(getAttributeValue(r.attributes, 'mass')).toBeNull();
      // 8本 may still be a valid count
      expect(getAttributeValue(r.attributes, 'count')).toBe(8);
    });

    it('ignores 30%OFF / iPhone 16 / USB 3.0 / No.5 / 2026 / 2+1', () => {
      expect(dims('セール30%OFF')).toEqual([]);
      expect(dims('iPhone 16 ケース')).toEqual([]);
      expect(dims('USB 3.0 ハブ')).toEqual([]);
      expect(dims('No.5 クリップ')).toEqual([]);
      expect(dims('カレンダー2026')).toEqual([]);
      expect(dims('弁当 2+1')).toEqual([]);
    });
  });
});

describe('Batch 2 freeze — live Analysis path unchanged', () => {
  it('does not alter parseProductSpecification outputs for grocery fixtures', () => {
    const fixtures = [
      '牛乳900ml',
      '水 500ml×6本',
      '商品 2×500g',
      '卵10個',
      'お茶500ml×6',
    ];
    for (const raw of fixtures) {
      const before = parseProductSpecification(raw);
      // Calling the new pipeline must not mutate / shadow the legacy parser.
      normalizeProductForIdentity(raw);
      const after = parseProductSpecification(raw);
      expect(after).toEqual(before);
    }
  });

  it('pipeline modules do not import Gemini / network / price engines', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    for (const file of [
      'universalProductNormalizer.ts',
      'universalProductSpecParser.ts',
      'normalizeProductForIdentity.ts',
    ]) {
      const code = fs
        .readFileSync(path.join(__dirname, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/from ['"].*(gemini|openai|ocrService|productPriceHistory)/i);
      expect(code).not.toMatch(/Levenshtein|embedding|fetch\(/i);
    }
  });
});

describe('Batch 2 performance sanity', () => {
  it('normalizes 1000 names quickly', () => {
    const samples = [
      '明治おいしい牛乳 1000ml',
      '電池アルカリ単3 8本',
      'USB-C ケーブル 2m',
      'ティッシュ 12ロール',
      '米 5kg',
      '水 500ml×6',
      'M6×20 ネジ',
      '無糖紅茶 500ml',
    ];
    const started = Date.now();
    for (let i = 0; i < 1000; i += 1) {
      normalizeProductForIdentity(samples[i % samples.length]!);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
