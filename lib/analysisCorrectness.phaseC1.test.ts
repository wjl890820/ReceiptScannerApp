/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

/**
 * Analysis V1 — Phase C1
 * Merchant / product family / price-history correctness
 */
import type { ReceiptRow } from './db';
import { calculateStats } from './statsCalculator';
import {
  applyUserLineAmountEdit,
  applyReceiptDiscountsToItems,
  itemAmountForAnalytics,
} from './receiptDiscountAllocation';
import {
  aggregateV1MerchantSpend,
  merchantAnalyticsKey,
} from './merchantAnalytics';
import { canonicalizeMerchantChain } from './receiptOcrNormalize';
import { normalizeMerchantName } from './productNormalizer';
import { buildTrustedProductPriceHistoryForTests as buildTrustedProductPriceHistory } from './productPriceHistory.testFixtures';
import type { ProductPriceHistoryRow } from './productPriceHistory';
import { buildReceiptItemIndexRows } from './receiptItemIndex';

function receipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  const t = Date.now();
  return {
    id: '1',
    created_at: t,
    transaction_at: t,
    image_uri: '',
    total: 0,
    tax: 0,
    currency: 'JPY',
    analysis_json: '{}',
    merchant_raw: null,
    merchant_normalized: null,
    merchant_type: null,
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    ...overrides,
  };
}

function priceRow(
  id: string,
  overrides: Partial<ProductPriceHistoryRow> = {}
): ProductPriceHistoryRow {
  return {
    receiptId: `receipt-${id}`,
    itemId: `item-${id}`,
    sourceIndex: 0,
    occurredAt: Number(String(id).replace(/\D/g, '')) || 1,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    displayName: `Product ${id}`,
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    productFamilyKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    ...overrides,
  };
}

describe('Phase C1 — merchant analytics', () => {
  it('1 — known OCR variants collapse to one merchant identity', () => {
    const a = canonicalizeMerchantChain('セブンイレブン 渋谷店');
    const b = canonicalizeMerchantChain('7-Eleven');
    const c = canonicalizeMerchantChain('セブン-イレブン');
    expect(a).toBe('セブン-イレブン');
    expect(b).toBe(a);
    expect(c).toBe(a);

    const keyA = merchantAnalyticsKey({
      merchant_raw: 'セブンイレブン 渋谷店',
      merchant_normalized: a,
    });
    const keyB = merchantAnalyticsKey({
      merchant_raw: '7-Eleven',
      merchant_normalized: b,
    });
    expect(keyA).toBe(keyB);
    expect(keyA).toBe(normalizeMerchantName('セブン-イレブン'));
  });

  it('2 — different chains/stores are not accidentally merged', () => {
    const seven = merchantAnalyticsKey({
      merchant_normalized: canonicalizeMerchantChain('セブン-イレブン'),
    });
    const lawson = merchantAnalyticsKey({
      merchant_normalized: canonicalizeMerchantChain('ローソン'),
    });
    const gyomuA = merchantAnalyticsKey({
      merchant_raw: '業務スーパー古川店',
      merchant_normalized: '業務スーパー古川店',
    });
    const gyomuB = merchantAnalyticsKey({
      merchant_raw: '業務スーパー仙台店',
      merchant_normalized: '業務スーパー仙台店',
    });
    expect(seven).not.toBe(lawson);
    expect(gyomuA).not.toBe(gyomuB);
  });

  it('3 — unsupported merchants excluded from V1 core merchant analytics', () => {
    const receipts = [
      receipt({
        id: 'sup',
        merchant_type: 'supermarket',
        merchant_raw: 'ヨークベニマル',
        merchant_normalized: 'ヨークベニマル',
        total: 1000,
      }),
      receipt({
        id: 'drug',
        merchant_type: 'other',
        merchant_raw: 'マツキヨ',
        merchant_normalized: 'マツキヨ',
        total: 9999,
      }),
    ];
    const stats = calculateStats(receipts, 'all');
    expect(stats.supportedSpend).toBe(1000);
    expect(stats.topMerchants.map((m) => m.merchant)).toEqual([
      normalizeMerchantName('ヨークベニマル'),
    ]);
    expect(stats.topMerchants[0].total).toBe(1000);
    expect(stats.highestSingleReceipt?.amount).toBe(1000);
    expect(aggregateV1MerchantSpend(receipts)).toHaveLength(1);
  });

  it('4 — merchant spend uses receipt.total, not item sum', () => {
    const receipts = [
      receipt({
        id: 'r1',
        merchant_type: 'supermarket',
        merchant_raw: 'イオン',
        merchant_normalized: 'イオン',
        total: 2846,
        user_items_json: JSON.stringify([
          {
            name: '麦茶',
            lineTotal: 70,
            category: 'beverages',
            classification_status: 'ok',
          },
          {
            name: '卵',
            lineTotal: 200,
            category: 'food_ingredients',
            classification_status: 'ok',
          },
        ]),
      }),
    ];
    const stats = calculateStats(receipts, 'all');
    expect(stats.topMerchants[0].total).toBe(2846);
    expect(stats.supportedSpend).toBe(2846);
    // item sum is much smaller — merchant total must NOT follow it
    expect(stats.categoryCompositionTotal).toBeLessThan(2846);
  });
});

describe('Phase C1 — price history amounts / quantity / dates', () => {
  it('5 — user-edited 69→70 is reflected via analytics resolver + index', () => {
    const stale = {
      name: 'コカ・コーラやかんの麦茶 特',
      lineTotal: 70,
      line_total: 69,
      effectiveLineTotal: 69,
      quantity: 1,
    };
    expect(itemAmountForAnalytics(stale)).toBe(70);

    const edited = applyUserLineAmountEdit(
      {
        name: 'コカ・コーラやかんの麦茶 特',
        lineTotal: 69,
        line_total: 69,
        effectiveLineTotal: 69,
        quantity: 1,
      },
      70
    );
    expect(itemAmountForAnalytics(edited)).toBe(70);

    const rows = buildReceiptItemIndexRows(
      {
        id: 'r-mugicha',
        user_items_json: JSON.stringify([stale]),
        analysis_json: JSON.stringify({
          items: [
            {
              name: 'コカ・コーラやかんの麦茶 特',
              lineTotal: 69,
              effectiveLineTotal: 69,
            },
          ],
        }),
      } as any,
      { indexedAt: 1 }
    );
    expect(rows[0].line_total).toBe(70);

    const history = buildTrustedProductPriceHistory(
      { type: 'sku', key: 'sku-mugicha' },
      [
        priceRow('1', { lineTotal: rows[0].line_total, occurredAt: 100 }),
        priceRow('2', { lineTotal: 72, occurredAt: 200 }),
      ]
    );
    expect(history.points[0].lineTotal).toBe(70);
    expect(history.points[0].priceValue).toBe(70);
  });

  it('6 — unedited discounted item keeps effective discounted amount', () => {
    const result = applyReceiptDiscountsToItems(
      [{ name: 'FERRERO ROCHER', lineTotal: 2988, quantity: 1 }],
      [{ label: 'ROCHER CPN', amount: -600 }]
    );
    const item = result.items[0];
    expect(itemAmountForAnalytics(item)).toBe(2388);

    const rows = buildReceiptItemIndexRows(
      {
        id: 'r-disc',
        user_items_json: JSON.stringify([item]),
        analysis_json: '{}',
      } as any,
      { indexedAt: 1 }
    );
    expect(rows[0].line_total).toBe(2388);
  });

  it('7 — quantity > 1 does not double-multiply line total', () => {
    const history = buildTrustedProductPriceHistory(
      { type: 'sku', key: 'eggs' },
      [
        priceRow('1', { lineTotal: 220, purchaseQuantity: 2 }),
        priceRow('2', { lineTotal: 110, purchaseQuantity: 1 }),
      ]
    );
    expect(history.points.map((p) => p.priceValue)).toEqual([110, 110]);
  });

  it('8 — deleted purchase excluded (no receipt join → absent from input rows)', () => {
    const history = buildTrustedProductPriceHistory(
      { type: 'sku', key: 'sku' },
      [priceRow('kept', { lineTotal: 100, occurredAt: 1 })]
    );
    // Only one remaining point after delete → not enough for trend
    expect(history.status).toBe('not_enough_points');
    expect(history.comparableOccurrenceCount ?? history.points.length).toBeLessThan(2);
  });

  it('9 — restore/rebuild does not duplicate purchase occurrence (unique receipt+index)', () => {
    const rows = buildReceiptItemIndexRows(
      {
        id: 'r-once',
        user_items_json: JSON.stringify([
          { name: '牛乳', lineTotal: 200, quantity: 1 },
        ]),
        analysis_json: '{}',
      } as any,
      { indexedAt: 1 }
    );
    const again = buildReceiptItemIndexRows(
      {
        id: 'r-once',
        user_items_json: JSON.stringify([
          { name: '牛乳', lineTotal: 200, quantity: 1 },
        ]),
        analysis_json: '{}',
      } as any,
      { indexedAt: 2 }
    );
    expect(rows).toHaveLength(1);
    expect(again).toHaveLength(1);
    expect(rows[0].id).toBe(again[0].id);
  });

  it('13 — transaction date ordering survives restore (occurredAt sort)', () => {
    const history = buildTrustedProductPriceHistory(
      { type: 'sku', key: 'sku' },
      [
        priceRow('late', { occurredAt: 300, lineTotal: 130 }),
        priceRow('early', { occurredAt: 100, lineTotal: 110 }),
        priceRow('mid', { occurredAt: 200, lineTotal: 120 }),
      ]
    );
    expect(history.points.map((p) => p.occurredAt)).toEqual([100, 200, 300]);
  });

  it('14 — null/invalid date degrades safely (excluded, no fake now)', () => {
    const history = buildTrustedProductPriceHistory(
      { type: 'sku', key: 'sku' },
      [
        priceRow('ok1', { occurredAt: 100, lineTotal: 100 }),
        priceRow('bad', { occurredAt: 0 as any, lineTotal: 999 }),
        priceRow('ok2', { occurredAt: 200, lineTotal: 110 }),
      ]
    );
    expect(history.points.map((p) => p.lineTotal)).toEqual([100, 110]);
    expect(history.points.every((p) => p.occurredAt > 0)).toBe(true);
  });
});

describe('Phase C1 — family / identity / comparable specs', () => {
  it('10 — known same-product family history aggregates with normalized unit', () => {
    const history = buildTrustedProductPriceHistory(
      { type: 'family', key: 'milk' },
      [
        priceRow('1', {
          lineTotal: 238,
          volumeBaseMl: 900,
          productFamilyKey: 'milk',
          occurredAt: 1,
        }),
        priceRow('2', {
          lineTotal: 248,
          volumeBaseMl: 1000,
          productFamilyKey: 'milk',
          occurredAt: 2,
        }),
      ]
    );
    expect(history.status).toBe('ready');
    expect(history.priceKind).toBe('per_liter');
    expect(history.points).toHaveLength(2);
  });

  it('11 — unrelated products remain separate (different family keys)', () => {
    const milk = buildTrustedProductPriceHistory(
      { type: 'family', key: 'milk' },
      [
        priceRow('1', {
          lineTotal: 200,
          volumeBaseMl: 1000,
          productFamilyKey: 'milk',
        }),
        priceRow('2', {
          lineTotal: 210,
          volumeBaseMl: 1000,
          productFamilyKey: 'milk',
        }),
      ]
    );
    const tea = buildTrustedProductPriceHistory(
      { type: 'family', key: 'tea' },
      [
        priceRow('3', {
          lineTotal: 100,
          volumeBaseMl: 500,
          productFamilyKey: 'tea',
        }),
        priceRow('4', {
          lineTotal: 110,
          volumeBaseMl: 500,
          productFamilyKey: 'tea',
        }),
      ]
    );
    expect(milk.points.every((p) => p.displayName.includes('Product'))).toBe(true);
    expect(tea.points).toHaveLength(2);
    expect(milk.points[0].receiptId).not.toBe(tea.points[0].receiptId);
  });

  it('12 — same-family incompatible specs do not produce misleading comparison', () => {
    const coffee = buildTrustedProductPriceHistory(
      { type: 'family', key: 'coffee' },
      [
        priceRow('1', {
          lineTotal: 120,
          volumeBaseMl: 185,
          productFamilyKey: 'coffee',
        }),
        priceRow('2', {
          lineTotal: 130,
          volumeBaseMl: 185,
          productFamilyKey: 'coffee',
        }),
        priceRow('3', {
          lineTotal: 140,
          weightBaseG: 185,
          productFamilyKey: 'coffee',
        }),
      ]
    );
    expect(coffee.status).toBe('ready');
    expect(coffee.points).toHaveLength(2);
    expect(coffee.excludedOccurrenceCount ?? coffee.totalOccurrenceCount - coffee.points.length).toBe(1);

    const tofu = buildTrustedProductPriceHistory(
      { type: 'family', key: 'tofu' },
      [
        priceRow('1', { lineTotal: 100, weightBaseG: 300 }),
        priceRow('2', { lineTotal: 110, weightBaseG: 300 }),
      ]
    );
    expect(tofu.status).toBe('unsupported_family');
    expect(tofu.points).toEqual([]);

    const riceMissingSpec = buildTrustedProductPriceHistory(
      { type: 'family', key: 'rice' },
      [
        priceRow('1', { lineTotal: 2000, productFamilyKey: 'rice' }),
        priceRow('2', { lineTotal: 2100, productFamilyKey: 'rice' }),
      ]
    );
    expect(riceMissingSpec.status).toBe('no_comparable_spec');
  });
});
