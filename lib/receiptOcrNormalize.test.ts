/**
 * OCR 确定性后处理测试：
 *  - 店铺类型词不能成为商品分类。
 *  - 折扣行（値引 -50）被归为 discount，不进入 items。
 *  - 711 等便利店店铺名归一化。
 *  - items + discount (+tax) ≈ total 金额对账。
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

import {
  normalizeMerchant,
  canonicalizeMerchantChain,
  classifyLineKind,
  sanitizeOcrCategoryKey,
  reconcileReceiptTotals,
  normalizeOcrAnalysis,
  resolveReceiptTax,
  persistReceiptTaxFields,
  isCostcoConnectionNonMerchandiseLine,
} from './receiptOcrNormalize';
import type { ReceiptAnalysis } from './receiptAnalyzer';

describe('sanitizeOcrCategoryKey: 店铺类型词不能成为商品分类', () => {
  it('合法枚举原样保留', () => {
    expect(sanitizeOcrCategoryKey('snack')).toBe('snack');
    expect(sanitizeOcrCategoryKey('drink')).toBe('drink');
  });

  it('店铺类型 / 非法值返回 undefined', () => {
    expect(sanitizeOcrCategoryKey('非超市')).toBeUndefined();
    expect(sanitizeOcrCategoryKey('便利店')).toBeUndefined();
    expect(sanitizeOcrCategoryKey('コンビニ')).toBeUndefined();
    expect(sanitizeOcrCategoryKey('スーパー')).toBeUndefined();
    expect(sanitizeOcrCategoryKey('non_grocery')).toBeUndefined();
    expect(sanitizeOcrCategoryKey('')).toBeUndefined();
    expect(sanitizeOcrCategoryKey(123 as any)).toBeUndefined();
  });
});

describe('classifyLineKind: 折扣 / 税 / 小计行识别', () => {
  it('値引 -50 归为 discount（关键字或负金额）', () => {
    expect(classifyLineKind('値引', -50)).toBe('discount');
    expect(classifyLineKind('クーポン', -100)).toBe('discount');
    expect(classifyLineKind('普通の商品', -50)).toBe('discount'); // 负金额
    expect(classifyLineKind('割引', 0)).toBe('discount');
  });

  it('税 / 小计 / 合计行识别', () => {
    expect(classifyLineKind('消費税', 40)).toBe('tax');
    expect(classifyLineKind('軽減税率対象', 0)).toBe('tax');
    expect(classifyLineKind('小計', 500)).toBe('subtotal');
    expect(classifyLineKind('合計', 540)).toBe('subtotal');
  });

  it('普通商品为 item', () => {
    expect(classifyLineKind('おにぎり 鮭', 150)).toBe('item');
    expect(classifyLineKind('コーヒー', 120)).toBe('item');
  });
});

describe('normalizeMerchant: 便利店归一化', () => {
  it('セブン-イレブン 各种写法归一', () => {
    expect(normalizeMerchant('セブンーイレブン')).toBe('セブン-イレブン');
    expect(normalizeMerchant('セブンイレブン 渋谷店')).toBe('セブン-イレブン');
    expect(normalizeMerchant('7-Eleven')).toBe('セブン-イレブン');
    expect(normalizeMerchant('7ELEVEN')).toBe('セブン-イレブン');
  });

  it('其他便利店归一', () => {
    expect(normalizeMerchant('ファミマ')).toBe('ファミリーマート');
    expect(normalizeMerchant('LAWSON')).toBe('ローソン');
    expect(normalizeMerchant('ミニストップ')).toBe('ミニストップ');
  });

  it('未知店铺保持原样；AEON 门店 display 与 chain 分离', () => {
    expect(normalizeMerchant('なぞの店XYZ')).toBe('なぞの店XYZ');
    expect(normalizeMerchant('イオン大森店')).toBe('イオン');
    expect(normalizeMerchant('イオン古川店')).toBe('イオン');
    expect(canonicalizeMerchantChain('イオン古川店')).toBe('イオン');
    expect(normalizeMerchant('')).toBe('');
  });
});

describe('reconcileReceiptTotals: 金额对账', () => {
  it('外税口径一致 (items + discount + tax = total)', () => {
    // items 500, discount -50, tax 40, total 490
    const r = reconcileReceiptTotals(500, -50, 40, 490);
    expect(r.ok).toBe(true);
    expect(r.diff).toBeLessThanOrEqual(2);
  });

  it('内税口径一致 (items + discount = total)', () => {
    // items 540, discount 0, tax 40(含在内), total 540
    const r = reconcileReceiptTotals(540, 0, 40, 540);
    expect(r.ok).toBe(true);
  });

  it('允许 1~2 日元误差', () => {
    expect(reconcileReceiptTotals(499, 0, 0, 500).ok).toBe(true);
    expect(reconcileReceiptTotals(498, 0, 0, 500).ok).toBe(true);
    expect(reconcileReceiptTotals(497, 0, 0, 500).ok).toBe(false);
  });

  it('明显不一致标记 warning', () => {
    const r = reconcileReceiptTotals(300, 0, 0, 540);
    expect(r.ok).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('total 缺失时不报错', () => {
    expect(reconcileReceiptTotals(300, 0, 0, 0).ok).toBe(true);
  });
  it('内税 + product coupon: gross+disc=total → ok; never overwrites total', () => {
    // Sample 007 shape: 8951 - 600 = 8351, tax 619 included
    const r = reconcileReceiptTotals(8951, -600, 619, 8351);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(8351);
  });

  it('外税: items + tax = total → ok', () => {
    // Sample 003 shape
    const r = reconcileReceiptTotals(2442, 0, 195, 2637);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2637);
  });
});

describe('normalizeOcrAnalysis: 整体后处理', () => {
  it('折扣/税/小计行剔除出 items，折扣进入 discounts；店铺名归一', () => {
    const analysis: ReceiptAnalysis = {
      merchant: 'セブンイレブン 大森北一丁目店',
      items: [
        { name: 'おにぎり 鮭', quantity: 1, unitPrice: 150, lineTotal: 150, categoryKey: 'other' },
        { name: 'コーヒー', quantity: 1, unitPrice: 120, lineTotal: 120, categoryKey: '非超市' as any },
        { name: '値引', quantity: 1, unitPrice: 0, lineTotal: -50 },
        { name: '小計', quantity: 1, unitPrice: 0, lineTotal: 220 },
        { name: '消費税', quantity: 1, unitPrice: 0, lineTotal: 20 },
      ],
      total: 240,
      tax: 20,
      currency: 'JPY',
    };

    const out = normalizeOcrAnalysis(analysis);
    expect(out.items.map((i) => i.name)).toEqual(['おにぎり 鮭', 'コーヒー']);
    // 店铺类型词被清洗为 undefined
    expect(out.items[1].categoryKey).toBeUndefined();
    expect(out.discounts).toEqual([
      { label: '値引', amount: -50, adjacentPrecedingItemIndex: 1 },
    ]);
    expect(out.merchant_normalized).toBe('セブン-イレブン');
    // items 270 + discount -50 + tax 20 = 240 == total
    expect(out.amount_mismatch).toBe(false);
  });

  it('金额明显不一致时 amount_mismatch=true，但不改 items 结构', () => {
    const analysis: ReceiptAnalysis = {
      merchant: 'ローソン',
      items: [{ name: 'パン', quantity: 1, unitPrice: 100, lineTotal: 100 }],
      total: 999,
      tax: 0,
      currency: 'JPY',
    };
    const out = normalizeOcrAnalysis(analysis);
    expect(out.items).toHaveLength(1);
    expect(out.amount_mismatch).toBe(true);
  });

  it('explicit discounts[] + same negative item collapses to one discount', () => {
    const out = normalizeOcrAnalysis({
      items: [
        { name: 'FERRERO ROCHER ORIGINS', quantity: 1, unitPrice: 2988, lineTotal: 2988 },
        { name: 'CPN ROCHER ORIGINS CPN', quantity: 1, unitPrice: -600, lineTotal: -600 },
      ],
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
      total: 2388,
      tax: 0,
      currency: 'JPY',
    });
    expect(out.discounts).toHaveLength(1);
    expect(out.discounts![0].amount).toBe(-600);
    expect(out.items).toHaveLength(1);
    expect(out.amount_mismatch).toBe(false);
  });

  it('Sample 027: package 4個 in name does not become purchase quantity', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'イオン古川店',
      items: [{ name: '電池単3 4個', quantity: 4, unitPrice: 393, lineTotal: 393 }],
      total: 393,
      tax: 0,
      currency: 'JPY',
    });
    expect(out.items[0].quantity).toBe(1);
    expect(out.merchant_normalized).toBe('イオン');
  });

  it('Sample 076: explicit 4個 × @439 in name → purchase quantity 4', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'イオン',
      items: [{ name: '正宗生煎包 4個 × @439', quantity: 1, unitPrice: 439, lineTotal: 1756 }],
      total: 1756,
      tax: 0,
      currency: 'JPY',
    });
    expect(out.items[0].quantity).toBe(4);
  });

  it('Sample 081: Costco Connection lines are not merchandise items', () => {
    expect(isCostcoConnectionNonMerchandiseLine('コストコ コネクション')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('コストコ コネクション ムリョウ')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('MR コストコ コネクション')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('MP コストコ コネクション ムリョウ')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('mrコストコ コネクション')).toBe(true);
    // Must not drop ordinary Costco merchandise merely containing コストコ.
    expect(isCostcoConnectionNonMerchandiseLine('コストコ 無料試食')).toBe(false);
    expect(isCostcoConnectionNonMerchandiseLine('コストコホットドッグ')).toBe(false);
    expect(isCostcoConnectionNonMerchandiseLine('MR カークランド')).toBe(false);

    const out = normalizeOcrAnalysis({
      merchant: 'COSTCO WHOLESALE',
      currency: 'JPY',
      total: 9534,
      tax: 706,
      items: [
        { name: 'ITEM A', quantity: 1, unitPrice: 5000, lineTotal: 5000 },
        { name: 'ITEM B', quantity: 1, unitPrice: 4534, lineTotal: 4534 },
        { name: 'MR コストコ コネクション', quantity: 1, unitPrice: 1, lineTotal: 1 },
        { name: 'MP コストコ コネクション ムリョウ', quantity: 1, unitPrice: 1, lineTotal: 1 },
      ],
    });
    expect(out.items.map((i) => i.name)).toEqual(['ITEM A', 'ITEM B']);
    expect(out.items.reduce((s, i) => s + i.lineTotal, 0)).toBe(9534);
    expect(out.total).toBe(9534);
    expect(out.tax).toBe(706);
  });

  it('rejects legacy personal_care OCR categoryKey on sanitize', () => {
    expect(sanitizeOcrCategoryKey('personal_care')).toBeUndefined();
    expect(sanitizeOcrCategoryKey('pet_care')).toBeUndefined();
    expect(sanitizeOcrCategoryKey('snacks_drinks')).toBe('snacks_drinks');
  });
});

describe('resolveReceiptTax', () => {
  it('explicit tax=305 → known', () => {
    expect(resolveReceiptTax({ tax: 305, total: 4000, items: [], currency: 'JPY' })).toEqual({
      tax: 305,
      taxIsKnown: true,
    });
  });

  it('sums explicit taxBreakdown when top-level tax missing', () => {
    expect(
      resolveReceiptTax({
        tax: null as any,
        taxBreakdown: [
          { rate: 8, amount: 240 },
          { rate: 10, amount: 71 },
        ],
        total: 3000,
        items: [],
        currency: 'JPY',
      } as any)
    ).toEqual({ tax: 311, taxIsKnown: true });
  });

  it('bare tax=0 without known marker → unknown (OCR padding)', () => {
    expect(resolveReceiptTax({ tax: 0, total: 1000, items: [], currency: 'JPY' })).toEqual({
      tax: 0,
      taxIsKnown: false,
    });
  });

  it('explicit known tax=0 → known zero', () => {
    expect(
      resolveReceiptTax({
        tax: 0,
        tax_is_known: true,
        total: 1000,
        items: [],
        currency: 'JPY',
      } as any)
    ).toEqual({
      tax: 0,
      taxIsKnown: true,
    });
  });

  it('no tax evidence → storage 0 + unknown', () => {
    expect(resolveReceiptTax({ tax: null as any, total: 1000, items: [], currency: 'JPY' })).toEqual(
      {
        tax: 0,
        taxIsKnown: false,
      }
    );
  });

  it('persistReceiptTaxFields respects tax_is_known=false', () => {
    expect(
      persistReceiptTaxFields({
        tax: 0,
        tax_is_known: false,
        total: 100,
        items: [],
        currency: 'JPY',
      } as any)
    ).toEqual({ tax: 0, taxIsKnown: 0 });
  });

  it('normalizeOcrAnalysis stores tax_is_known metadata', () => {
    const known = normalizeOcrAnalysis({
      merchant: 'イオン',
      items: [{ name: '牛乳', quantity: 1, unitPrice: 200, lineTotal: 200 }],
      total: 220,
      tax: 20,
      currency: 'JPY',
    });
    expect(known.tax).toBe(20);
    expect(known.tax_is_known).toBe(true);

    const unknown = normalizeOcrAnalysis({
      merchant: 'イオン',
      items: [{ name: '牛乳', quantity: 1, unitPrice: 200, lineTotal: 200 }],
      total: 200,
      tax: null as any,
      currency: 'JPY',
    });
    expect(unknown.tax).toBe(0);
    expect(unknown.tax_is_known).toBe(false);
  });
});
