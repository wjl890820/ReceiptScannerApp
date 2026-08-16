import {
  isPaymentAllocationLabel,
  resolveAuthoritativeReceiptTotal,
} from './receiptTotalResolve';
import { classifyLineKind, normalizeOcrAnalysis, resolveReceiptTax } from './receiptOcrNormalize';

describe('payment vs authoritative total', () => {
  it('treats cash / prepaid / reward as payment allocation labels', () => {
    expect(isPaymentAllocationLabel('現金')).toBe(true);
    expect(isPaymentAllocationLabel('プリカ/リワード')).toBe(true);
    expect(isPaymentAllocationLabel('クオ・カード支払')).toBe(true);
    expect(isPaymentAllocationLabel('お買上計')).toBe(false);
    expect(isPaymentAllocationLabel('合計')).toBe(false);
    expect(isPaymentAllocationLabel('クオ・カード預り')).toBe(false);
    expect(isPaymentAllocationLabel('残高')).toBe(false);
  });

  it('Sample 051: split prepaid+cash must not override purchase total', () => {
    const total = resolveAuthoritativeReceiptTotal({
      ocrTotal: 11227,
      itemsPositiveSum: 18229,
      discountsSum: 0,
      payments: [
        { label: 'プリカ/リワード', amount: 7002 },
        { label: '現金', amount: 11227 },
      ],
    });
    expect(total).toBe(18229);

    const normalized = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 11227,
      tax: null as any,
      items: [
        { name: '商品A', quantity: 1, unitPrice: 18229, lineTotal: 18229 },
        { name: 'プリカ/リワード', quantity: 1, unitPrice: 7002, lineTotal: 7002 },
        { name: '現金', quantity: 1, unitPrice: 11227, lineTotal: 11227 },
      ],
    });
    expect(normalized.total).toBe(18229);
    expect(normalized.items).toHaveLength(1);
    expect(normalized.items[0].lineTotal).toBe(18229);
    expect(classifyLineKind('現金', 11227)).toBe('payment');
  });

  it('Sample 053 QUO: total stays 814 when payment equals total', () => {
    const normalized = normalizeOcrAnalysis({
      merchant: 'セブン-イレブン',
      currency: 'JPY',
      total: 814,
      tax: null as any,
      items: [
        { name: 'おにぎり', quantity: 1, unitPrice: 814, lineTotal: 814 },
        { name: 'クオ・カード預り', quantity: 1, unitPrice: 1001, lineTotal: 1001 },
        { name: 'クオ・カード支払', quantity: 1, unitPrice: 814, lineTotal: 814 },
        { name: '残高', quantity: 1, unitPrice: 187, lineTotal: 187 },
      ],
    });
    expect(normalized.total).toBe(814);
    expect(normalized.items.map((i) => i.lineTotal)).toEqual([814]);
  });

  it('Sample 054 QUO: total stays 591', () => {
    const normalized = normalizeOcrAnalysis({
      merchant: 'セブン-イレブン',
      currency: 'JPY',
      total: 591,
      tax: null as any,
      items: [
        { name: 'パン', quantity: 1, unitPrice: 591, lineTotal: 591 },
        { name: 'クオ・カード預り', quantity: 1, unitPrice: 1592, lineTotal: 1592 },
        { name: 'クオ・カード支払', quantity: 1, unitPrice: 591, lineTotal: 591 },
        { name: '残高', quantity: 1, unitPrice: 1001, lineTotal: 1001 },
      ],
    });
    expect(normalized.total).toBe(591);
  });

  it('does not invent total from a lone payment when authoritative total missing', () => {
    expect(
      resolveAuthoritativeReceiptTotal({
        ocrTotal: 0,
        itemsPositiveSum: 5000,
        discountsSum: 0,
        payments: [{ label: '現金', amount: 5000 }],
      })
    ).toBe(0);

    expect(
      resolveAuthoritativeReceiptTotal({
        ocrTotal: null,
        itemsPositiveSum: 5000,
        discountsSum: 0,
        payments: [
          { label: '現金', amount: 3000 },
          { label: 'クレジット', amount: 2000 },
        ],
      })
    ).toBe(0);
  });
});

describe('tax provenance', () => {
  it('missing tax → storage 0 + unknown', () => {
    expect(resolveReceiptTax({ tax: null as any, total: 1000, items: [], currency: 'JPY' })).toEqual({
      tax: 0,
      taxIsKnown: false,
    });
    const normalized = normalizeOcrAnalysis({
      merchant: 'コストコ',
      items: [{ name: '商品', quantity: 1, unitPrice: 100, lineTotal: 100 }],
      total: 100,
      tax: null as any,
      currency: 'JPY',
    });
    expect(normalized.tax).toBe(0);
    expect(normalized.tax_is_known).toBe(false);
  });

  it('bare OCR tax=0 without known marker → unknown', () => {
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
    ).toEqual({ tax: 0, taxIsKnown: true });
  });
});
