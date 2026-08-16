/**
 * Samples 061 / 062 / 065 — tax base vs amount, included tax, metadata + classification.
 */

import {
  classifyLineKind,
  harvestActualTaxFromItems,
  isTaxableBaseLabel,
  isActualTaxAmountLabel,
  normalizeOcrAnalysis,
  resolveReceiptTax,
} from './receiptOcrNormalize';
import { classifyItemByName } from './productCategory';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { buildHistoryMetaLine } from './receiptListHelpers';
import { formatDate } from './formatDate';
import { detectCostcoReceiptSignals } from './groceryDetector';

jest.mock('./i18n', () => ({
  t: (key: string) => key,
}));

describe('Sample 061 — mixed rate: taxable base must not enter tax', () => {
  it('対象額 labels are not actual tax', () => {
    expect(isTaxableBaseLabel('税率10%対象 ¥3')).toBe(true);
    expect(isTaxableBaseLabel('外税10%対象額 ¥3')).toBe(true);
    expect(isActualTaxAmountLabel('税率10%対象 ¥3')).toBe(false);
    expect(isActualTaxAmountLabel('消費税等 8% ¥72')).toBe(true);
    expect(classifyLineKind('税率10%対象', 3)).toBe('subtotal');
  });

  it('taxBreakdown with mistaken 10% base ¥3 → tax=72 known (not 75)', () => {
    const resolved = resolveReceiptTax({
      tax: 75,
      taxBreakdown: [
        { rate: 8, amount: 72 },
        { rate: 10, amount: 3 },
      ],
      total: 985,
      items: [
        { name: 'ドーナツ', quantity: 1, unitPrice: 128, lineTotal: 128 },
        { name: 'スムージー', quantity: 1, unitPrice: 306, lineTotal: 306 },
        { name: 'クレープ', quantity: 1, unitPrice: 178, lineTotal: 178 },
        { name: 'チョコ', quantity: 1, unitPrice: 298, lineTotal: 298 },
        { name: 'レジ袋', quantity: 1, unitPrice: 3, lineTotal: 3 },
        { name: '消費税等 8%', quantity: 1, unitPrice: 72, lineTotal: 72 },
        { name: '税率10%対象', quantity: 1, unitPrice: 3, lineTotal: 3 },
      ],
      currency: 'JPY',
    } as any);
    expect(resolved).toEqual({ tax: 72, taxIsKnown: true });
    expect(resolved.tax).not.toBe(75);
  });

  it('normalize Sample 061 fixture → tax 72 known, total 985', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'セブン-イレブン',
      currency: 'JPY',
      total: 985,
      tax: 75,
      taxBreakdown: [
        { rate: 8, amount: 72 },
        { rate: 10, amount: 3 },
      ],
      items: [
        { name: '7Pツイストドーナツ3個入', quantity: 1, unitPrice: 128, lineTotal: 128 },
        { name: 'イチゴバナナスムージー', quantity: 1, unitPrice: 306, lineTotal: 306 },
        { name: 'ヒトクチクレープチョコ', quantity: 1, unitPrice: 178, lineTotal: 178 },
        { name: 'ダブルナッツチョコ', quantity: 1, unitPrice: 298, lineTotal: 298 },
        { name: 'レジ袋', quantity: 1, unitPrice: 3, lineTotal: 3 },
        { name: '消費税等8%', quantity: 1, unitPrice: 72, lineTotal: 72 },
        { name: '税率10%対象', quantity: 1, unitPrice: 3, lineTotal: 3 },
      ],
    } as any);
    expect(out.tax).toBe(72);
    expect(out.tax_is_known).toBe(true);
    expect(out.total).toBe(985);
    expect(out.items.every((i) => !/対象|消費税/.test(String(i.name)))).toBe(true);
  });
});

describe('Sample 065 — included tax known', () => {
  it('harvests （内消費税等 8%）¥129', () => {
    expect(isActualTaxAmountLabel('（内消費税等 8%）')).toBe(true);
    expect(
      harvestActualTaxFromItems([
        { name: '内税率 8% 対象額', lineTotal: 1752 },
        { name: '（内消費税等 8%）', lineTotal: 129 },
      ])
    ).toBe(129);
  });

  it('does not double-count top + breakdown + harvested (still 129, not 258)', () => {
    expect(
      resolveReceiptTax({
        tax: 129,
        taxBreakdown: [{ rate: 8, amount: 129 }],
        total: 1752,
        items: [
          { name: '商品A', lineTotal: 1752 },
          { name: '（内消費税等 8%）', lineTotal: 129 },
        ],
        currency: 'JPY',
      } as any)
    ).toEqual({ tax: 129, taxIsKnown: true });
  });

  it('normalize → tax 129 known; History shows 税 129', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'ヨークベニマル',
      currency: 'JPY',
      total: 1752,
      tax: null as any,
      items: [
        { name: '商品A', quantity: 1, unitPrice: 1752, lineTotal: 1752 },
        { name: '内税率 8% 対象額', quantity: 1, unitPrice: 1752, lineTotal: 1752 },
        { name: '（内消費税等 8%）', quantity: 1, unitPrice: 129, lineTotal: 129 },
      ],
    } as any);
    expect(out.tax).toBe(129);
    expect(out.tax_is_known).toBe(true);
    expect(out.total).toBe(1752);
    expect(
      buildHistoryMetaLine(1700000000000, 1700000000000, '税', out.tax, formatDate, '—', '待确认', 1)
    ).toContain('税 129');
  });
});

describe('Sample 062 — metadata + classification', () => {
  it('買上点数 is not a product item', () => {
    expect(classifyLineKind('買上点数 5点', 0)).toBe('subtotal');
    const out = normalizeOcrAnalysis({
      merchant: '業務スーパー古川店',
      currency: 'JPY',
      total: 1732,
      tax: 139,
      items: [
        { name: '正宗生煎包', quantity: 2, unitPrice: 388, lineTotal: 776 },
        { name: '大盛讃岐うどん', quantity: 1, unitPrice: 213, lineTotal: 213 },
        { name: '炭化竹箸天削（袋無）', quantity: 1, unitPrice: 376, lineTotal: 376 },
        {
          name: 'ニューショッピングバッグ ナチュラル',
          quantity: 1,
          unitPrice: 228,
          lineTotal: 228,
        },
        { name: '買上点数 5点', quantity: 5, unitPrice: 0, lineTotal: 0 },
        { name: '外税8%', quantity: 1, unitPrice: 79, lineTotal: 79 },
        { name: '外税10%', quantity: 1, unitPrice: 60, lineTotal: 60 },
      ],
    } as any);
    expect(out.items.some((i) => String(i.name).includes('買上点数'))).toBe(false);
    expect(out.items).toHaveLength(4);
    expect(out.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0)).toBe(5);
  });

  it('正宗生煎包 → ready_to_eat; 竹箸 / バッグ → household', () => {
    expect(classifyItemByName('正宗生煎包')).toBe('ready_to_eat');
    expect(classifyItemByName('炭化竹箸天削（袋無）')).toBe('household');
    expect(classifyItemByName('ニューショッピングバッグ ナチュラル')).toBe('household');
    expect(classifyItemByName('大盛讃岐うどん')).toBe('ready_to_eat');
  });

  it('category amounts: RTE 989, household 604, tax 139, total 1732', () => {
    const out = normalizeOcrAnalysis({
      merchant: '業務スーパー古川店',
      currency: 'JPY',
      total: 1732,
      tax: null as any,
      items: [
        { name: '正宗生煎包', quantity: 2, unitPrice: 388, lineTotal: 776 },
        { name: '大盛讃岐うどん', quantity: 1, unitPrice: 213, lineTotal: 213 },
        { name: '炭化竹箸天削（袋無）', quantity: 1, unitPrice: 376, lineTotal: 376 },
        {
          name: 'ニューショッピングバッグ ナチュラル',
          quantity: 1,
          unitPrice: 228,
          lineTotal: 228,
        },
        { name: '買上点数 5点', quantity: 5, unitPrice: 0, lineTotal: 0 },
        { name: '外税額 8%', quantity: 1, unitPrice: 79, lineTotal: 79 },
        { name: '外税額 10%', quantity: 1, unitPrice: 60, lineTotal: 60 },
      ],
    } as any);

    const withCat = out.items.map((it) => ({
      ...it,
      category: classifyItemByName(String(it.name)),
    }));
    const sumCat = (c: string) =>
      withCat
        .filter((i) => i.category === c)
        .reduce((s, i) => s + itemAmountForAnalytics(i), 0);

    expect(sumCat('ready_to_eat')).toBe(989);
    expect(sumCat('household')).toBe(604);
    expect(sumCat('ready_to_eat') + sumCat('household')).toBe(1593);
    expect(out.tax).toBe(139);
    expect(out.tax_is_known).toBe(true);
    expect(out.total).toBe(1732);
  });
});

describe('Samples 063 / 064 — single 8% tax still known', () => {
  it('063: tax 52 known, total 708', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'セブン-イレブン',
      currency: 'JPY',
      total: 708,
      tax: 52,
      items: [
        { name: '弁当', quantity: 1, unitPrice: 478, lineTotal: 478 },
        { name: 'スイーツ', quantity: 1, unitPrice: 178, lineTotal: 178 },
        { name: '消費税等8%', quantity: 1, unitPrice: 52, lineTotal: 52 },
      ],
    } as any);
    expect(out.tax).toBe(52);
    expect(out.tax_is_known).toBe(true);
    expect(out.total).toBe(708);
  });

  it('064: tax 68 known, total 924', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'セブン-イレブン',
      currency: 'JPY',
      total: 924,
      tax: 68,
      items: [
        { name: 'サンド', quantity: 1, unitPrice: 558, lineTotal: 558 },
        { name: 'チョコ', quantity: 1, unitPrice: 298, lineTotal: 298 },
        { name: '消費税等8%', quantity: 1, unitPrice: 68, lineTotal: 68 },
      ],
    } as any);
    expect(out.tax).toBe(68);
    expect(out.tax_is_known).toBe(true);
    expect(out.total).toBe(924);
  });
});

describe('Build 28 core regressions still PASS', () => {
  it('051 Costco multi-signal', () => {
    expect(
      detectCostcoReceiptSignals({
        merchant: 'WHOLESALE',
        items: [],
        rawText: 'BIZ/GOLD',
      }).isCostco
    ).toBe(true);
  });
  it('055 / 060 categories', () => {
    expect(classifyItemByName('がぶっとエクレアミルククリーム')).toBe('snacks_drinks');
    expect(classifyItemByName('SVジャパンエール')).toBe('snacks_drinks');
  });
  it('058 Fant effective 203', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'ヨークベニマル',
      currency: 'JPY',
      total: 2296,
      tax: null as any,
      discounts: [{ label: 'まとめ売り値引 2個¥203', amount: -7 }],
      items: [
        { name: 'FAピーチ', quantity: 1, unitPrice: 254, lineTotal: 254 },
        { name: '横浜家系', quantity: 1, unitPrice: 1191, lineTotal: 1191 },
        { name: 'ファンタオレ70', quantity: 1, unitPrice: 210, lineTotal: 210 },
        { name: '▲まとめ売り値引', quantity: 1, unitPrice: -7, lineTotal: -7 },
        { name: '2個¥203 × 1組', quantity: 1, unitPrice: 0, lineTotal: 0 },
      ],
    } as any);
    const fanta = out.items.find((i) => String(i.name).includes('ファンタ'))!;
    expect(fanta.effectiveLineTotal).toBe(203);
    expect(out.total).toBe(2296);
  });
});
