/**
 * Analysis V1 — Phase C2 correctness tests.
 */
import {
  buildFiveReceiptMilestone,
  buildTenReceiptMilestone,
  buildShoppingFrequency,
  frequentProductGroups,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';
import { buildInsights } from './buildInsights';
import { calculateStats } from './statsCalculator';
import {
  applyUserLineAmountEdit,
  itemAmountForAnalytics,
} from './receiptDiscountAllocation';
import {
  merchantAnalyticsKey,
  aggregateV1MerchantSpend,
} from './merchantAnalytics';
import { jstCalendarDayStartMs, jstCalendarDayKey } from './dateParser';
import { categoryCompositionPercent } from './analysisPresentation';
import type { ReceiptRow } from './db';
import * as fs from 'fs';
import * as path from 'path';

const DAY_MS = 24 * 60 * 60 * 1000;

function item(name: string, category: string, lineTotal: number, quantity = 1) {
  return { name, category, lineTotal, quantity, classification_status: 'ok' };
}

function engagementReceipt(
  id: string,
  overrides: Partial<EngagementReceipt> = {}
): EngagementReceipt {
  const numericId = Number(String(id).replace(/\D/g, '')) || 1;
  return {
    id,
    created_at: numericId * DAY_MS,
    transaction_at: numericId * DAY_MS,
    merchant_raw: `Store ${id}`,
    merchant_normalized: `store ${id}`,
    merchant_type: 'supermarket',
    total: 100,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: [] }),
    final_total: null,
    user_items_json: null,
    ...overrides,
  };
}

function productRow(
  receiptId: string,
  itemId: string,
  overrides: Partial<EngagementProductRow> = {}
): EngagementProductRow {
  const numericId = Number(String(receiptId).replace(/\D/g, '')) || 1;
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    occurredAt: numericId * DAY_MS,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    merchant_type: 'supermarket',
    analysis_json: '{}',
    displayName: itemId,
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    canonicalProductName: null,
    productFamilyKey: null,
    skuKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    ...overrides,
  };
}

function statsReceipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  const t = Date.now();
  return {
    id: '1',
    created_at: t,
    transaction_at: t,
    image_uri: '',
    total: 1000,
    tax: 0,
    currency: 'JPY',
    analysis_json: '{}',
    merchant_raw: null,
    merchant_normalized: null,
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    ...overrides,
  };
}

describe('Phase C2 — purchase occurrence contract', () => {
  it('1 — qty=4 on one receipt is one occurrence (not four)', () => {
    const receipts = [engagementReceipt('r1')];
    const rows = [
      productRow('r1', 'milk', {
        canonicalProductName: '明治おいしい牛乳',
        purchaseQuantity: 4,
      }),
    ];
    const { frequentProducts } = frequentProductGroups(receipts, {
      rows,
      queryFailed: false,
    });
    expect(frequentProducts).toEqual([]);
  });

  it('2 — same canonical product on 3 receipts → frequency = 3', () => {
    const receipts = [1, 2, 3].map((n) => engagementReceipt(`r${n}`));
    const rows = [1, 2, 3].map((n) =>
      productRow(`r${n}`, `milk-${n}`, {
        canonicalProductName: '明治おいしい牛乳',
        purchaseQuantity: n === 1 ? 4 : 1,
      })
    );
    const { frequentProducts } = frequentProductGroups(receipts, {
      rows,
      queryFailed: false,
    });
    expect(frequentProducts).toHaveLength(1);
    expect(frequentProducts[0].purchaseOccurrenceCount).toBe(3);
    expect(frequentProducts[0].totalPurchaseQuantity).toBe(6);
  });

  it('3 — unresolved products are not fuzzy-merged into frequent list', () => {
    const receipts = [1, 2, 3, 4].map((n) => engagementReceipt(`r${n}`));
    const rows = [
      productRow('r1', 'a1', { displayName: '謎商品A' }),
      productRow('r2', 'a2', { displayName: '謎商品A' }),
      productRow('r3', 'b1', { displayName: '謎商品B' }),
      productRow('r4', 'b2', { displayName: '謎商品B' }),
    ];
    const { frequentProducts } = frequentProductGroups(receipts, {
      rows,
      queryFailed: false,
    });
    expect(frequentProducts).toEqual([]);
  });
});

describe('Phase C2 — frequent merchants', () => {
  it('4 — same merchant 3 receipts → visits = 3', () => {
    const receipts = [
      statsReceipt({
        id: 'a',
        merchant_raw: 'イオン古川店',
        merchant_normalized: 'イオン',
        total: 1000,
        user_items_json: JSON.stringify([
          item('x', 'food_ingredients', 100),
          item('y', 'food_ingredients', 200),
          item('z', 'snacks_drinks', 300),
        ]),
      }),
      statsReceipt({
        id: 'b',
        merchant_raw: 'イオン',
        merchant_normalized: 'イオン',
        total: 2000,
      }),
      statsReceipt({
        id: 'c',
        merchant_raw: 'イオン',
        merchant_normalized: 'イオン',
        total: 500,
      }),
    ];
    const stats = calculateStats(receipts, 'all');
    expect(stats.topMerchants[0].count).toBe(3);
    expect(stats.topMerchants[0].total).toBe(3500);
  });

  it('5 — unsupported merchant excluded from frequent merchant analytics', () => {
    const receipts = [
      statsReceipt({
        id: 's',
        merchant_type: 'supermarket',
        merchant_normalized: 'ヨークベニマル',
        merchant_raw: 'ヨークベニマル',
        total: 100,
      }),
      statsReceipt({
        id: 'd',
        merchant_type: 'other',
        merchant_normalized: 'マツキヨ',
        merchant_raw: 'マツキヨ',
        total: 99999,
      }),
    ];
    const stats = calculateStats(receipts, 'all');
    expect(stats.topMerchants).toHaveLength(1);
    expect(aggregateV1MerchantSpend(receipts)).toHaveLength(1);
  });

  it('10 — deterministic merchant tie: count → spend → name', () => {
    const receipts = [
      statsReceipt({
        id: '1',
        merchant_normalized: 'bbb',
        merchant_raw: 'bbb',
        total: 100,
      }),
      statsReceipt({
        id: '2',
        merchant_normalized: 'aaa',
        merchant_raw: 'aaa',
        total: 500,
      }),
      statsReceipt({
        id: '3',
        merchant_normalized: 'bbb',
        merchant_raw: 'bbb',
        total: 100,
      }),
      statsReceipt({
        id: '4',
        merchant_normalized: 'aaa',
        merchant_raw: 'aaa',
        total: 100,
      }),
    ];
    const stats = calculateStats(receipts, 'all');
    expect(stats.topMerchants[0].merchant).toBe(
      merchantAnalyticsKey({ merchant_normalized: 'aaa' })
    );
    expect(stats.mostFrequentMerchant?.merchant).toBe(
      stats.topMerchants[0].merchant
    );
  });
});

describe('Phase C2 — delete / restore / edit', () => {
  it('6 — delete one receipt decrements merchant visit exactly once', () => {
    const base = [
      statsReceipt({
        id: '1',
        merchant_normalized: 'イオン',
        merchant_raw: 'イオン',
        total: 100,
      }),
      statsReceipt({
        id: '2',
        merchant_normalized: 'イオン',
        merchant_raw: 'イオン',
        total: 200,
      }),
      statsReceipt({
        id: '3',
        merchant_normalized: 'イオン',
        merchant_raw: 'イオン',
        total: 300,
      }),
    ];
    expect(calculateStats(base, 'all').topMerchants[0].count).toBe(3);
    expect(
      calculateStats(
        base.filter((r) => r.id !== '2'),
        'all'
      ).topMerchants[0].count
    ).toBe(2);
  });

  it('7 — restore/rebuild counts unique receipt ids once', () => {
    const restored = [
      statsReceipt({
        id: '1',
        merchant_normalized: 'イオン',
        merchant_raw: 'イオン',
        total: 100,
      }),
      statsReceipt({
        id: '1',
        merchant_normalized: 'イオン',
        merchant_raw: 'イオン',
        total: 100,
      }),
    ];
    const unique = Array.from(new Map(restored.map((r) => [r.id, r])).values());
    expect(calculateStats(unique, 'all').topMerchants[0].count).toBe(1);
  });

  it('8 — user amount edit does not inflate frequency', () => {
    const edited = applyUserLineAmountEdit(
      {
        name: '麦茶',
        lineTotal: 69,
        effectiveLineTotal: 69,
        quantity: 1,
      },
      70
    );
    expect(itemAmountForAnalytics(edited)).toBe(70);
    const receipts = [engagementReceipt('r1'), engagementReceipt('r2')];
    const rows = [
      productRow('r1', 'i1', { canonicalProductName: '麦茶', lineTotal: 70 }),
      productRow('r2', 'i2', { canonicalProductName: '麦茶', lineTotal: 70 }),
    ];
    const { frequentProducts } = frequentProductGroups(receipts, {
      rows,
      queryFailed: false,
    });
    expect(frequentProducts[0].purchaseOccurrenceCount).toBe(2);
  });

  it('9 — canonical identity change updates frequent grouping', () => {
    const receipts = [engagementReceipt('r1'), engagementReceipt('r2')];
    const before = frequentProductGroups(receipts, {
      rows: [
        productRow('r1', 'i1', { canonicalProductName: 'A' }),
        productRow('r2', 'i2', { canonicalProductName: 'A' }),
      ],
      queryFailed: false,
    }).frequentProducts;
    const after = frequentProductGroups(receipts, {
      rows: [
        productRow('r1', 'i1', { canonicalProductName: 'B' }),
        productRow('r2', 'i2', { canonicalProductName: 'B' }),
      ],
      queryFailed: false,
    }).frequentProducts;
    expect(before[0].key).toBe('A');
    expect(after[0].key).toBe('B');
  });
});

describe('Phase C2 — ties / JST / null dates', () => {
  it('11 — deterministic product tie: occurrence → qty → recent → key', () => {
    const receipts = [1, 2, 3, 4].map((n) => engagementReceipt(`r${n}`));
    const rows = [
      productRow('r1', 'a1', {
        canonicalProductName: 'BBB',
        purchaseQuantity: 1,
      }),
      productRow('r2', 'a2', {
        canonicalProductName: 'BBB',
        purchaseQuantity: 1,
      }),
      productRow('r3', 'b1', {
        canonicalProductName: 'AAA',
        purchaseQuantity: 5,
      }),
      productRow('r4', 'b2', {
        canonicalProductName: 'AAA',
        purchaseQuantity: 1,
      }),
    ];
    const { frequentProducts } = frequentProductGroups(receipts, {
      rows,
      queryFailed: false,
    });
    expect(frequentProducts[0].key).toBe('AAA');
  });

  it('12 — JST month boundary: 2026-08-01 00:30 JST is August', () => {
    const ms = Date.parse('2026-07-31T15:30:00.000Z');
    expect(jstCalendarDayKey(ms)).toBe('2026-08-01');
    const start = jstCalendarDayStartMs(ms)!;
    expect(jstCalendarDayKey(start)).toBe('2026-08-01');
  });

  it('13 — same JST shopping day near UTC midnight counts once', () => {
    const t1 = Date.parse('2026-07-31T15:10:00.000Z');
    const t2 = Date.parse('2026-07-31T16:10:00.000Z');
    const t3 = Date.parse('2026-08-01T15:10:00.000Z');
    const freq = buildShoppingFrequency([
      engagementReceipt('a', { transaction_at: t1, created_at: t1 }),
      engagementReceipt('b', { transaction_at: t2, created_at: t2 }),
      engagementReceipt('c', { transaction_at: t3, created_at: t3 }),
    ]);
    expect(freq).not.toBeNull();
    expect(freq!.intervalCount).toBe(1);
  });

  it('14 — invalid transaction date excluded from frequency days', () => {
    const freq = buildShoppingFrequency([
      engagementReceipt('a', { transaction_at: 0, created_at: 0 }),
      engagementReceipt('b', {
        transaction_at: DAY_MS,
        created_at: DAY_MS,
      }),
    ]);
    expect(freq).toBeNull();
  });
});

describe('Phase C2 — trends / insights / denominators', () => {
  it('15 — all-range with tiny history does not emit period trend changes', () => {
    const now = Date.now();
    const receipts = [
      statsReceipt({
        id: 'only',
        transaction_at: now - 2 * DAY_MS,
        merchant_normalized: 'イオン',
        merchant_raw: 'イオン',
        total: 1000,
        user_items_json: JSON.stringify([
          item('牛乳', 'food_ingredients', 200),
        ]),
      }),
    ];
    const insights = buildInsights(receipts, 'all');
    expect(insights.changes).toEqual([]);
  });

  it('16 — zero receipts / zero denominator safe', () => {
    const stats = calculateStats([], 'all');
    expect(stats.supportedSpend).toBe(0);
    expect(stats.topMerchants).toEqual([]);
    expect(categoryCompositionPercent(10, 0)).toBeNull();
    const insights = buildInsights([], 'week');
    expect(insights.changes).toEqual([]);
    expect(insights.tips).toEqual([]);
  });

  it('17 — tips source uses V1 active category keys', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'buildInsights.ts'),
      'utf8'
    );
    expect(src).toContain("pct('ready_to_eat')");
    expect(src).toContain("pct('snacks_drinks')");
    expect(src).not.toMatch(/pct\('quick_meals'\)/);
    expect(src).not.toMatch(/pct\('snacks_sweets'\)/);
  });

  it('18 — low-sample insight suppressed (<3 supported receipts)', () => {
    const now = Date.now();
    const receipts = [
      statsReceipt({
        id: '1',
        transaction_at: now - 1000,
        merchant_normalized: 'イオン',
        total: 5000,
        user_items_json: JSON.stringify([item('x', 'ready_to_eat', 5000)]),
      }),
    ];
    const insights = buildInsights(receipts, 'week');
    expect(insights.changes).toEqual([]);
    expect(insights.tips).toEqual([]);
  });

  it('19 — category-share denominator remains Phase B composition total', () => {
    const now = Date.now();
    const receipts = [1, 2, 3].map((n) =>
      statsReceipt({
        id: String(n),
        transaction_at: now - n * 1000,
        merchant_normalized: 'イオン',
        total: 2846,
        user_items_json: JSON.stringify([
          item('牛乳', 'food_ingredients', 2000),
          item('お茶', 'snacks_drinks', 500),
        ]),
      })
    );
    const stats = calculateStats(receipts, 'all');
    expect(stats.supportedSpend).toBe(2846 * 3);
    expect(stats.categoryCompositionTotal).toBe(2500 * 3);
    const pct = categoryCompositionPercent(
      stats.topCategories[0].amount,
      stats.categoryCompositionTotal
    );
    expect(pct).toBe(Math.round((100 * 2000 * 3) / (2500 * 3)));
  });

  it('20 — unsupported-only dataset contributes nothing to V1 merchant/spend', () => {
    const unsupportedOnly = [
      statsReceipt({
        id: 'u',
        merchant_type: 'other',
        merchant_normalized: 'マツキヨ',
        total: 8000,
      }),
    ];
    const stats = calculateStats(unsupportedOnly, 'all');
    expect(stats.supportedSpend).toBe(0);
    expect(stats.topMerchants).toEqual([]);
    expect(stats.mostFrequentMerchant).toBeNull();
  });
});

describe('Phase C2 — milestone windows use latest receipts', () => {
  it('five/ten milestones select the latest N supported receipts', () => {
    const receipts = Array.from({ length: 12 }, (_, i) =>
      engagementReceipt(`r${i + 1}`, {
        merchant_normalized: 'イオン',
        merchant_raw: 'イオン',
        total: 1000,
      })
    );
    const rows = receipts.map((r, index) =>
      productRow(r.id, `milk-${index}`, {
        canonicalProductName: '明治おいしい牛乳',
        occurredAt: (index + 1) * DAY_MS,
      })
    );
    const five = buildFiveReceiptMilestone(receipts, {
      rows,
      queryFailed: false,
    });
    const ten = buildTenReceiptMilestone(receipts, {
      rows,
      queryFailed: false,
    });
    expect(five).not.toBeNull();
    expect(ten).not.toBeNull();
    expect(five!.frequentProducts[0].purchaseOccurrenceCount).toBe(5);
    expect(ten!.frequentProducts[0].purchaseOccurrenceCount).toBe(10);
  });
});
