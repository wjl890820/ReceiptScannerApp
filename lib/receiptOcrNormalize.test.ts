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
  isLoyaltyRedemptionLabel,
  sanitizeOcrCategoryKey,
  reconcileReceiptTotals,
  normalizeOcrAnalysis,
  resolveReceiptTax,
  persistReceiptTaxFields,
  isCostcoConnectionNonMerchandiseLine,
  isPostAdjustmentActualTaxLabel,
  harvestActualTaxFromItems,
  harvestActualTaxFromItemsPartitioned,
} from './receiptOcrNormalize';
import type { ReceiptAnalysis } from './receiptAnalyzer';
import { receiptLevelUnallocatedDiscountSum } from './receiptDiscountAllocation';
import { assessReceiptAmountBasis } from './analysisFoundation/amountBasis';

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

describe('Receipt065 loyalty redemption classification', () => {
  it.each([
    '楽天ポイント(税込)',
    '楽天ポイント（税込）',
    'ポイント利用',
    '利用ポイント',
    'ポイント支払',
    'ポイント値引',
    'ポイント割',
  ])('%s → discount for +13 and -13', (label) => {
    expect(isLoyaltyRedemptionLabel(label)).toBe(true);
    expect(classifyLineKind(label, 13)).toBe('discount');
    expect(classifyLineKind(label, -13)).toBe('discount');
  });

  it.each([
    '利用可能ポイント',
    'ポイント対象金額',
    '獲得予定ポイント',
    '獲得予定ポイント数',
    'ポイント残高',
    '楽天ポイント明細',
    'ポイントカード',
    '楽天ポイント利用可能',
    '楽天ポイント対象金額',
    '楽天ポイント残高',
    '利用可能楽天ポイント',
    '獲得予定楽天ポイント',
    '楽天ポイントカード',
  ])('%s is metadata — NOT discount (incl. DISCOUNT_KEYWORDS substring traps)', (label) => {
    expect(isLoyaltyRedemptionLabel(label)).toBe(false);
    expect(classifyLineKind(label, 13)).toBe('subtotal');
    expect(classifyLineKind(label, 13)).not.toBe('discount');
  });

  it('negative OCR amount cannot turn metadata into redemption', () => {
    expect(classifyLineKind('楽天ポイント利用可能', -13)).toBe('subtotal');
    expect(classifyLineKind('利用可能ポイント', -13)).toBe('subtotal');
    expect(classifyLineKind('ポイント残高', -13)).toBe('subtotal');
  });

  it('genuine tax labels remain tax despite 税 markers', () => {
    expect(classifyLineKind('消費税', 113)).toBe('tax');
    expect(classifyLineKind('消費税額', 113)).toBe('tax');
    expect(classifyLineKind('消費税額(値引後)', 113)).toBe('tax');
    expect(classifyLineKind('内消費税', 113)).toBe('tax');
    expect(classifyLineKind('税込消費税', 113)).toBe('tax');
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
      {
        label: '値引',
        amount: -50,
        adjacentPrecedingItemIndex: 1,
        ownershipStatus: 'bound',
        boundItemIndex: 1,
        ownershipReason: 'ordinary_adjacent_product_discount',
      },
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

  it('Receipt061-like: 2個 × 単108 in name overrides OCR qty=1; keeps unitPrice/lineTotal', () => {
    const outQty1 = normalizeOcrAnalysis({
      merchant: 'イオン',
      items: [
        {
          name: '世界TEAチャイラテ 2個 × 単108',
          quantity: 1,
          unitPrice: 108,
          lineTotal: 216,
        },
      ],
      total: 216,
      tax: 0,
      currency: 'JPY',
    });
    expect(outQty1.items[0].quantity).toBe(2);
    expect(outQty1.items[0].unitPrice).toBe(108);
    expect(outQty1.items[0].lineTotal).toBe(216);

    const outQty2 = normalizeOcrAnalysis({
      merchant: 'イオン',
      items: [
        {
          name: '世界TEAチャイラテ 2個 × 単108',
          quantity: 2,
          unitPrice: 108,
          lineTotal: 216,
        },
      ],
      total: 216,
      tax: 0,
      currency: 'JPY',
    });
    expect(outQty2.items[0].quantity).toBe(2);
    expect(outQty2.items[0].unitPrice).toBe(108);
    expect(outQty2.items[0].lineTotal).toBe(216);
  });

  it('Receipt061-like clean structured item qty=2/unit108/total216 passes through', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'イオン',
      items: [
        {
          name: '世界TEAチャイラテ',
          quantity: 2,
          unitPrice: 108,
          lineTotal: 216,
        },
      ],
      total: 216,
      tax: 0,
      currency: 'JPY',
    });
    expect(out.items[0].quantity).toBe(2);
    expect(out.items[0].unitPrice).toBe(108);
    expect(out.items[0].lineTotal).toBe(216);
  });

  it('Receipt065: 楽天ポイント(税込)+13 → receipt-level -13; reconcile ok; unallocated', () => {
    const amounts = [189, 119, 239, 299, 119, 109, 109, 99, 149];
    const merchandise = amounts.map((lineTotal, i) => ({
      name: `item-${i}`,
      quantity: 1,
      unitPrice: lineTotal,
      lineTotal,
    }));
    const out = normalizeOcrAnalysis({
      merchant: 'SEIYU',
      items: [
        ...merchandise,
        {
          name: '楽天ポイント(税込)',
          quantity: 1,
          unitPrice: 13,
          lineTotal: 13,
        },
      ],
      total: 1532,
      tax: 113,
      currency: 'JPY',
    });

    expect(out.items).toHaveLength(9);
    expect(out.items.reduce((s, it) => s + it.lineTotal, 0)).toBe(1431);
    expect(out.items.every((it) => !String(it.name).includes('ポイント'))).toBe(true);
    expect(out.items.every((it) => (it as any).discountAllocated == null || it.discountAllocated === 0)).toBe(
      true
    );

    const loyalty = (out.discounts ?? []).filter((d) =>
      String(d.label).includes('楽天ポイント')
    );
    expect(loyalty).toHaveLength(1);
    expect(loyalty[0]?.amount).toBe(-13);
    expect(
      (loyalty[0] as { adjacentPrecedingItemIndex?: number | null })
        ?.adjacentPrecedingItemIndex == null
    ).toBe(true);
    expect(receiptLevelUnallocatedDiscountSum(out.items as any, out.discounts as any)).toBe(
      -13
    );

    expect(out.tax).toBe(113);
    expect(out.total).toBe(1532);
    expect(out.reconciliation?.ok).toBe(true);
    expect(out.amount_mismatch).toBe(false);

    // Amount-basis shape mirrors existing unallocated-discount fixtures.
    const analysisJson = JSON.stringify({
      items: out.items,
      discounts: out.discounts,
      tax: out.tax,
      total: out.total,
      tax_is_known: true,
    });
    const basis = assessReceiptAmountBasis({
      id: 'receipt065-fixture',
      total: out.total,
      tax: out.tax,
      tax_is_known: 1,
      analysis_json: analysisJson,
      items: out.items,
      discounts: out.discounts,
    } as any);
    expect(basis.basis).toBe('tax_excluded');
    expect(basis.confidence).toBe('medium');
    expect(basis.analyticsItemSum).toBe(1431);
    expect(basis.unallocatedDiscountTotal).toBe(-13);
    expect(basis.receiptTotal).toBe(1532);
    expect(basis.expectedTotalIfTaxExcluded).toBe(1531);
    expect(basis.evidence).toEqual(
      expect.arrayContaining(['unallocated_discount_present'])
    );
  });

  it('Receipt065: dual discounts[] + item row does not double to -26', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'SEIYU',
      items: [
        { name: 'A', quantity: 1, unitPrice: 1431, lineTotal: 1431 },
        {
          name: '楽天ポイント(税込)',
          quantity: 1,
          unitPrice: 13,
          lineTotal: 13,
        },
      ],
      discounts: [{ label: '楽天ポイント(税込)', amount: -13 }],
      total: 1532,
      tax: 113,
      currency: 'JPY',
    });
    const loyaltyAmounts = (out.discounts ?? [])
      .filter((d) => String(d.label).includes('楽天ポイント'))
      .map((d) => d.amount);
    expect(loyaltyAmounts).toEqual([-13]);
    expect(
      (out.discounts ?? []).reduce(
        (s, d) => s + (d.amount < 0 ? d.amount : -Math.abs(d.amount)),
        0
      )
    ).toBe(-13);
    for (const d of out.discounts ?? []) {
      if (String(d.label).includes('楽天ポイント')) {
        expect(
          (d as { adjacentPrecedingItemIndex?: number | null })
            .adjacentPrecedingItemIndex == null
        ).toBe(true);
      }
    }
    for (const it of out.items) {
      expect(Number((it as any).discountAllocated) || 0).toBe(0);
    }
    expect(receiptLevelUnallocatedDiscountSum(out.items as any, out.discounts as any)).toBe(
      -13
    );
  });

  it('Receipt065: metadata 楽天ポイント利用可能 is not a phantom discount', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'SEIYU',
      items: [
        { name: 'A', quantity: 1, unitPrice: 100, lineTotal: 100 },
        {
          name: '楽天ポイント利用可能',
          quantity: 1,
          unitPrice: 13,
          lineTotal: 13,
        },
      ],
      total: 100,
      tax: 0,
      currency: 'JPY',
    });
    expect(out.items).toHaveLength(1);
    expect(out.discounts ?? []).toEqual([]);
  });

  it('Sample 081: Costco Connection lines are not merchandise items', () => {
    expect(isCostcoConnectionNonMerchandiseLine('コストコ コネクション')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('コストコ コネクション ムリョウ')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('MR コストコ コネクション')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('MP コストコ コネクション ムリョウ')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('mrコストコ コネクション')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('1-Z コストコ コネクション ムリョウ')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('1 - Z コストコ コネクション ムリョウ')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('1Z コストコ コネクション ムリョウ')).toBe(true);
    expect(isCostcoConnectionNonMerchandiseLine('コストコ コネクションムリョウ')).toBe(true);
    // Must not drop ordinary Costco merchandise merely containing コストコ.
    expect(isCostcoConnectionNonMerchandiseLine('コストコ 無料試食')).toBe(false);
    expect(isCostcoConnectionNonMerchandiseLine('コストコホットドッグ')).toBe(false);
    expect(isCostcoConnectionNonMerchandiseLine('MR カークランド')).toBe(false);

    const out = normalizeOcrAnalysis({
      merchant: 'COSTCO WHOLESALE',
      currency: 'JPY',
      total: 9534,
      tax: 708,
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
    expect(out.tax).toBe(708);
  });

  it('Receipt080: 11 merchandise + 1-Z Connection ¥1 → 11 items / tax 708 / mismatch-safe', () => {
    const merch = [418, 698, 428, 899, 488, 298, 998, 698, 777, 3484, 348].map(
      (lineTotal, i) => ({
        name: `MERCH${i + 1}`,
        quantity: 1,
        unitPrice: lineTotal,
        lineTotal,
      })
    );
    const out = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 9534,
      tax: 708,
      transactionDate: '07/05/2023 11:44:46',
      items: [
        ...merch,
        {
          name: '1-Z コストコ コネクション ムリョウ',
          quantity: 1,
          unitPrice: 1,
          lineTotal: 1,
        },
      ],
    });
    expect(out.items).toHaveLength(11);
    expect(out.items.reduce((s, i) => s + i.lineTotal, 0)).toBe(9534);
    expect(out.tax).toBe(708);
    expect(out.total).toBe(9534);
    expect(out.amount_mismatch).toBe(false);
    expect(out.reconciliation?.ok).toBe(true);
    expect(out.items.some((i) => String(i.name).includes('コネクション'))).toBe(
      false
    );
  });

  it('Receipt080: unexplained +1 merchandise overage is unsafe (not ±2-safe)', () => {
    const r = reconcileReceiptTotals(9535, 0, 706, 9534);
    expect(r.ok).toBe(false);
    expect(r.diff).toBe(1);
    expect(r.warnings.some((w) => w.includes('unexplained_positive_merchandise_overage'))).toBe(
      true
    );
  });

  it('accepts personal_care/pet_care OCR categoryKey as active V1 spending', () => {
    expect(sanitizeOcrCategoryKey('personal_care')).toBe('personal_care');
    expect(sanitizeOcrCategoryKey('pet_care')).toBe('pet_care');
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

  const jpy = { currency: 'JPY' as const, total: 1532 };

  it('Case A — top=114, no item tax rows → 114/known', () => {
    expect(resolveReceiptTax({ tax: 114, items: [], ...jpy })).toEqual({
      tax: 114,
      taxIsKnown: true,
    });
  });

  it('Case B — top=113 beats unlabeled pre-state item 114 → 113/known', () => {
    expect(
      resolveReceiptTax({
        tax: 113,
        items: [{ name: '消費税額', lineTotal: 114 }],
        ...jpy,
      } as ReceiptAnalysis)
    ).toEqual({ tax: 113, taxIsKnown: true });
  });

  it('Case C — post-adjustment item 113 beats stale top=114 → 113/known', () => {
    expect(
      resolveReceiptTax({
        tax: 114,
        items: [{ name: '消費税額(値引後)', lineTotal: 113 }],
        ...jpy,
      } as ReceiptAnalysis)
    ).toEqual({ tax: 113, taxIsKnown: true });
  });

  it('Case D — post-adjustment 113 wins over pre 114 when top=113', () => {
    expect(
      resolveReceiptTax({
        tax: 113,
        items: [
          { name: '消費税額', lineTotal: 114 },
          { name: '消費税額(値引後)', lineTotal: 113 },
        ],
        ...jpy,
      } as ReceiptAnalysis)
    ).toEqual({ tax: 113, taxIsKnown: true });
  });

  it('Case E — post-adjustment 113 wins over pre 114 when top=114', () => {
    expect(
      resolveReceiptTax({
        tax: 114,
        items: [
          { name: '消費税額', lineTotal: 114 },
          { name: '消費税額(値引後)', lineTotal: 113 },
        ],
        ...jpy,
      } as ReceiptAnalysis)
    ).toEqual({ tax: 113, taxIsKnown: true });
  });

  it('Case F — post-adjustment 113 when top=null and both tax rows present', () => {
    expect(
      resolveReceiptTax({
        tax: null as any,
        items: [
          { name: '消費税額', lineTotal: 114 },
          { name: '消費税額(値引後)', lineTotal: 113 },
        ],
        ...jpy,
      } as ReceiptAnalysis)
    ).toEqual({ tax: 113, taxIsKnown: true });
  });

  it('ordinary multi-rate fallback when no post state and top missing → 100/known', () => {
    expect(
      resolveReceiptTax({
        tax: null as any,
        items: [
          { name: '8% 消費税額', lineTotal: 80 },
          { name: '10% 消費税額', lineTotal: 20 },
        ],
        total: 1000,
        currency: 'JPY',
      } as ReceiptAnalysis)
    ).toEqual({ tax: 100, taxIsKnown: true });
  });

  it('post-state multi-rate harvest sums final rates only → 99/known', () => {
    expect(
      resolveReceiptTax({
        tax: 100,
        items: [
          { name: '8% 消費税額', lineTotal: 80 },
          { name: '10% 消費税額', lineTotal: 20 },
          { name: '8% 消費税額(値引後)', lineTotal: 79 },
          { name: '10% 消費税額(値引後)', lineTotal: 20 },
        ],
        total: 999,
        currency: 'JPY',
      } as ReceiptAnalysis)
    ).toEqual({ tax: 99, taxIsKnown: true });
  });

  it('top-final 99 beats stale pre-state item rows 80+20', () => {
    expect(
      resolveReceiptTax({
        tax: 99,
        items: [
          { name: '8% 消費税額', lineTotal: 80 },
          { name: '10% 消費税額', lineTotal: 20 },
        ],
        total: 999,
        currency: 'JPY',
      } as ReceiptAnalysis)
    ).toEqual({ tax: 99, taxIsKnown: true });
  });

  it('stale top=100 loses to explicit post-state multi-rate items → 99/known', () => {
    expect(
      resolveReceiptTax({
        tax: 100,
        items: [
          { name: '8% 消費税額', lineTotal: 80 },
          { name: '10% 消費税額', lineTotal: 20 },
          { name: '8% 消費税額(値引後)', lineTotal: 79 },
          { name: '10% 消費税額(値引後)', lineTotal: 20 },
        ],
        total: 999,
        currency: 'JPY',
      } as ReceiptAnalysis)
    ).toEqual({ tax: 99, taxIsKnown: true });
  });

  it('taxable-base contamination guard still resolves Sample 061 → 72/known', () => {
    expect(
      resolveReceiptTax({
        tax: 75,
        taxBreakdown: [
          { rate: 8, amount: 72 },
          { rate: 10, amount: 3 },
        ],
        total: 985,
        items: [{ name: '消費税等 8%', lineTotal: 72 }],
        currency: 'JPY',
      } as ReceiptAnalysis)
    ).toEqual({ tax: 72, taxIsKnown: true });
  });

  it('priorKnown=true keeps top tax even when post-adjustment item exists', () => {
    expect(
      resolveReceiptTax({
        tax: 114,
        tax_is_known: true,
        items: [{ name: '消費税額(値引後)', lineTotal: 113 }],
        ...jpy,
      } as ReceiptAnalysis)
    ).toEqual({ tax: 114, taxIsKnown: true });
  });

  it('isPostAdjustmentActualTaxLabel recognizes 値引後 on actual tax rows only', () => {
    expect(isPostAdjustmentActualTaxLabel('消費税額(値引後)')).toBe(true);
    expect(isPostAdjustmentActualTaxLabel('消費税額')).toBe(false);
    expect(isPostAdjustmentActualTaxLabel('税抜金額対象(値引後)')).toBe(false);
  });

  it('harvestActualTaxFromItemsPartitioned separates settlement states', () => {
    expect(
      harvestActualTaxFromItemsPartitioned([
        { name: '消費税額', lineTotal: 114 },
        { name: '消費税額(値引後)', lineTotal: 113 },
      ])
    ).toEqual({ postAdjustment: 113, ordinary: 114 });
    expect(harvestActualTaxFromItems([{ name: '消費税額(値引後)', lineTotal: 113 }])).toBe(113);
  });
});

describe('Receipt065 final tax normalization', () => {
  const amounts = [189, 119, 239, 299, 119, 109, 109, 99, 149];
  const merchandise = amounts.map((lineTotal, i) => ({
    name: `item-${i}`,
    quantity: 1,
    unitPrice: lineTotal,
    lineTotal,
  }));

  it.each([114, 113])('top tax=%i with dual tax rows → normalized tax=113', (topTax) => {
    const out = normalizeOcrAnalysis({
      merchant: 'SEIYU',
      items: [
        ...merchandise,
        { name: '消費税額', quantity: 1, unitPrice: 114, lineTotal: 114 },
        { name: '消費税額(値引後)', quantity: 1, unitPrice: 113, lineTotal: 113 },
        {
          name: '楽天ポイント(税込)',
          quantity: 1,
          unitPrice: 13,
          lineTotal: 13,
        },
      ],
      tax: topTax,
      total: 1532,
      currency: 'JPY',
    });

    expect(out.items).toHaveLength(9);
    expect(out.items.reduce((s, it) => s + it.lineTotal, 0)).toBe(1431);
    expect(out.tax).toBe(113);
    expect(out.tax_is_known).toBe(true);
    expect(out.total).toBe(1532);
    expect(out.reconciliation?.ok).toBe(true);
    expect(out.amount_mismatch).toBe(false);
    expect(
      (out.discounts ?? []).filter((d) => String(d.label).includes('楽天ポイント'))
    ).toEqual([expect.objectContaining({ amount: -13 })]);
    expect(out.items.every((it) => (it as any).discountAllocated == null || (it as any).discountAllocated === 0)).toBe(
      true
    );
    expect(receiptLevelUnallocatedDiscountSum(out.items as any, out.discounts as any)).toBe(-13);
  });
});
