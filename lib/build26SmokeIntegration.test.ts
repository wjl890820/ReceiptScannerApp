/**
 * Integration regressions for Build 26 smoke gaps (051 merchant/tax, 058 bundle).
 * Exercises normalize → merchant_type gating → History-facing amounts — not helpers alone.
 */

import { detectCostcoReceiptSignals } from './groceryDetector';
import { detectMerchantTypeFromReceipt, isV1SupportedMerchantType } from './merchantType';
import { normalizeOcrAnalysis, resolveReceiptTax } from './receiptOcrNormalize';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { classifyItemByName } from './productCategory';
import { buildHistoryMetaLine } from './receiptListHelpers';
import { formatDate } from './formatDate';

jest.mock('./i18n', () => ({
  t: (key: string) => key,
}));

describe('Build 26 Sample 051 — cropped Costco merchant + tax unknown', () => {
  it('WHOLESALE alone is not Costco', () => {
    expect(detectCostcoReceiptSignals({ merchant: 'WHOLESALE', items: [] }).isCostco).toBe(false);
  });

  it('BIZ/GOLD alone is not Costco', () => {
    expect(detectCostcoReceiptSignals({ merchant: 'BIZ/GOLD', items: [] }).isCostco).toBe(false);
  });

  it('WHOLESALE + BIZ/GOLD multi-signal → Costco', () => {
    const hit = detectCostcoReceiptSignals({
      merchant: 'WHOLESALE',
      items: [],
      rawText: 'BIZ/GOLD MEMBER',
    });
    expect(hit.isCostco).toBe(true);
    expect(hit.score).toBeGreaterThanOrEqual(2);
  });

  it('WHOLESALE + structural signals → merchant コストコ, supported, total 18229, tax unknown', () => {
    const normalized = normalizeOcrAnalysis({
      merchant: 'WHOLESALE',
      currency: 'JPY',
      total: 11227,
      tax: 0,
      items: [
        { name: '123456 WATER E', quantity: 1, unitPrice: 6000, lineTotal: 6000 },
        { name: '234567 BANANA E', quantity: 1, unitPrice: 6000, lineTotal: 6000 },
        { name: '345678 CHICKEN T', quantity: 1, unitPrice: 6229, lineTotal: 6229 },
        { name: '御買上げ点数 3', quantity: 1, unitPrice: 0, lineTotal: 0 },
        { name: 'プリカ/リワード', quantity: 1, unitPrice: 7002, lineTotal: 7002 },
        { name: '現金', quantity: 1, unitPrice: 11227, lineTotal: 11227 },
      ],
      ocr_raw_text: 'WHOLESALE\nBIZ/GOLD',
    } as any);

    expect(normalized.merchant).toBe('コストコ');
    expect(normalized.merchant_normalized).toBe('コストコ');
    expect(normalized.total).toBe(18229);
    expect(normalized.tax).toBe(0);
    expect(normalized.tax_is_known).toBe(false);

    const mt = detectMerchantTypeFromReceipt({
      merchant: normalized.merchant,
      merchant_normalized: normalized.merchant_normalized,
      items: normalized.items,
      rawText: 'WHOLESALE\nBIZ/GOLD',
    });
    expect(mt).toBe('supermarket');
    expect(isV1SupportedMerchantType(mt)).toBe(true);

    // Supported path: name rules actually classify (not forced uncategorized by merchant gate).
    const sampleCats = [
      classifyItemByName('ジョージア ブラック 500'),
      classifyItemByName('ロティサリーチキン'),
      classifyItemByName('ケール'),
    ];
    expect(sampleCats).toEqual(['snacks_drinks', 'ready_to_eat', 'food_ingredients']);
  });

  it('bare Edge tax:0 without evidence → tax_is_known=0 and History 待确认', () => {
    expect(
      resolveReceiptTax({
        tax: 0,
        taxBreakdown: null as any,
        total: 18229,
        items: [],
        currency: 'JPY',
      } as any)
    ).toEqual({ tax: 0, taxIsKnown: false });

    const line = buildHistoryMetaLine(
      1700000000000,
      1700000000000,
      '税',
      0,
      formatDate,
      '—',
      '待确认',
      0
    );
    expect(line).toContain('税 待确认');
    expect(line).not.toMatch(/税 0(?!\d)/);
  });

  it('explicit known tax=0 → History 税 0', () => {
    expect(
      resolveReceiptTax({
        tax: 0,
        tax_is_known: true,
        total: 100,
        items: [],
        currency: 'JPY',
      } as any)
    ).toEqual({ tax: 0, taxIsKnown: true });
    expect(
      buildHistoryMetaLine(1700000000000, 1700000000000, '税', 0, formatDate, '—', '待确认', 1)
    ).toContain('税 0');
  });
});

describe('Build 26 Sample 058 — Edge-only まとめ売り into category totals', () => {
  it('discounts[]-only bundle allocates and category sum equals receipt.total 2296', () => {
    const normalized = normalizeOcrAnalysis({
      merchant: 'ヨークベニマル',
      currency: 'JPY',
      total: 2296,
      tax: null as any,
      discounts: [{ label: '▲まとめ売り値引', amount: -7 }],
      items: [
        { name: '即食A', quantity: 1, unitPrice: 1191, lineTotal: 1191 },
        { name: '食材B', quantity: 1, unitPrice: 648, lineTotal: 648 },
        { name: 'ファンタオレ70', quantity: 1, unitPrice: 210, lineTotal: 210 },
        { name: 'スナック他', quantity: 1, unitPrice: 254, lineTotal: 254 },
        { name: '2個¥203 × 1組', quantity: 1, unitPrice: 0, lineTotal: 0 },
      ],
    } as any);

    const fanta = normalized.items.find((i) => String(i.name).includes('ファンタオレ'))!;
    expect(fanta.lineTotal).toBe(210);
    expect(fanta.effectiveLineTotal).toBe(203);
    expect(fanta.discountAllocated).toBe(-7);

    const categorySum = normalized.items.reduce((s, i) => s + itemAmountForAnalytics(i), 0);
    expect(categorySum).toBe(2296);
    expect(normalized.total).toBe(2296);
  });
});

describe('Build 26 Sample 051 product semantics (Costco restored)', () => {
  it('maps smoke-test item names to expected V1 categories', () => {
    expect(classifyItemByName('ジョージア ブラック 500')).toBe('snacks_drinks');
    expect(classifyItemByName('フジサンノミズ 2LX6')).toBe('snacks_drinks');
    expect(classifyItemByName('ダイエットジンジャーエール')).toBe('snacks_drinks');
    expect(classifyItemByName('ダイエットドクターペッパー')).toBe('snacks_drinks');
    expect(classifyItemByName('ロティサリーチキン')).toBe('ready_to_eat');
    expect(classifyItemByName('ケール')).toBe('food_ingredients');
    expect(classifyItemByName('さつまいも')).toBe('food_ingredients');
    expect(classifyItemByName('ラクノウギュウニュウ')).toBe('food_ingredients');
    expect(classifyItemByName('ラム肩切落')).toBe('food_ingredients');
    expect(classifyItemByName('USプライムカタロース')).toBe('food_ingredients');
    expect(classifyItemByName('EGG MIX SIZE 20CT')).toBe('food_ingredients');
  });
});

describe('Build 26 already-PASS regressions', () => {
  it('055 eclair remains snacks_drinks', () => {
    expect(classifyItemByName('がぶっとエクレアミルククリーム')).toBe('snacks_drinks');
  });
  it('060 ale remains snacks_drinks', () => {
    expect(classifyItemByName('SVジャパンエール')).toBe('snacks_drinks');
  });
});
