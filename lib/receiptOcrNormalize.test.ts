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
  classifyLineKind,
  sanitizeOcrCategoryKey,
  reconcileReceiptTotals,
  normalizeOcrAnalysis,
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

  it('未知店铺保持原样', () => {
    expect(normalizeMerchant('イオン大森店')).toBe('イオン大森店');
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
    expect(out.discounts).toEqual([{ label: '値引', amount: -50 }]);
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
});
