/**
 * 最小单测：首页分类聚合与未分类汇总。
 */
import type { ReceiptRow } from './db';
import {
  aggregateCategoryData,
  computeUncategorizedSummary,
  computeTopCategory,
  computeIndulgenceShare,
  type CategoryData,
} from './homeMetricsHelpers';

jest.mock('./groceryDetector', () => ({
  isGroceryMerchant: jest.fn(() => true),
}));

jest.mock('./categories', () => ({
  isGroceryCategory: jest.fn((cat: string) => cat !== 'uncategorized' && cat.length > 0),
  isExcludedFromAnalytics: jest.fn(() => false),
}));

function minimalReceipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  const t = Date.now();
  return {
    id: '1',
    created_at: t,
    transaction_at: t,
    image_uri: '',
    total: 100,
    tax: 10,
    currency: 'JPY',
    analysis_json: '{}',
    merchant_raw: 'Store',
    merchant_normalized: 'store',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    ...overrides,
  };
}

describe('aggregateCategoryData', () => {
  it('returns empty array for empty receipts', () => {
    expect(aggregateCategoryData([])).toEqual([]);
  });

  it('aggregates one grocery category from user_items_json', () => {
    const receipts: ReceiptRow[] = [
      minimalReceipt({
        user_items_json: JSON.stringify([
          // 旧 enum 'produce' 经 normalizeProductCategory 归一为 'food_ingredients'
          { name: 'A', lineTotal: 100, category: 'produce', classification_status: 'ok' },
        ]),
      }),
    ];
    const got = aggregateCategoryData(receipts);
    expect(got).toHaveLength(1);
    expect(got[0].category).toBe('food_ingredients');
    expect(got[0].amount).toBe(100);
    expect(got[0].percentage).toBe(100);
  });
});

describe('computeUncategorizedSummary', () => {
  it('returns zero for empty receipts', () => {
    expect(computeUncategorizedSummary([])).toEqual({ count: 0, total: 0 });
  });

  it('counts items without valid category', () => {
    const receipts: ReceiptRow[] = [
      minimalReceipt({
        user_items_json: JSON.stringify([
          { name: 'X', lineTotal: 50, category: '', classification_status: 'failed' },
        ]),
      }),
    ];
    const got = computeUncategorizedSummary(receipts);
    expect(got.count).toBe(1);
    expect(got.total).toBe(50);
  });

  // F.3 / D：只统计最终分类为 uncategorized 的商品，count/amount 精确（如 1件 / ¥322）。
  it('counts only items whose final category is uncategorized (count + amount)', () => {
    const receipts: ReceiptRow[] = [
      minimalReceipt({
        user_items_json: JSON.stringify([
          { name: '豆腐', lineTotal: 100, category: 'food_ingredients', classification_status: 'ok' },
          { name: '???', lineTotal: 322, category: 'uncategorized', classification_status: 'fallback' },
        ]),
      }),
    ];
    const got = computeUncategorizedSummary(receipts);
    expect(got.count).toBe(1);
    expect(got.total).toBe(322);
  });

  // F.4：所有商品都有真实分类（即使 classification_status='fallback'），待分类应为 0，
  //       不再出现“30 个商品待分类”假象（对应 missing_item_category_count=0）。
  it('does not count fallback items that have a real category (no "30 pending" illusion)', () => {
    const receipts: ReceiptRow[] = [
      minimalReceipt({
        user_items_json: JSON.stringify([
          { name: '豆腐', lineTotal: 100, category: 'food_ingredients', classification_status: 'fallback' },
          { name: 'クラフトボス', lineTotal: 200, category: 'snacks_drinks', classification_status: 'fallback' },
          { name: 'チキンカツサンド', lineTotal: 300, category: 'ready_to_eat', classification_status: 'fallback' },
        ]),
      }),
    ];
    const got = computeUncategorizedSummary(receipts);
    expect(got.count).toBe(0);
    expect(got.total).toBe(0);
  });
});

describe('computeIndulgenceShare (嗜好消费 = 仅 snacks_drinks)', () => {
  const data: CategoryData[] = [
    { category: 'food_ingredients', amount: 600, percentage: 60 },
    { category: 'snacks_drinks', amount: 300, percentage: 30 },
    { category: 'ready_to_eat', amount: 100, percentage: 10 },
  ];

  // F.1：ready_to_eat 不计入 nonEssential / indulgence。
  it('excludes ready_to_eat from indulgence', () => {
    // 仅 snacks_drinks 300 / 总 1000 = 30%（若错误地包含 ready_to_eat 会是 40%）。
    expect(computeIndulgenceShare(data)).toBeCloseTo(30, 5);
  });

  // F.2：snacks_drinks 计入 indulgence。
  it('counts snacks_drinks as indulgence', () => {
    const onlySnacks: CategoryData[] = [
      { category: 'food_ingredients', amount: 500, percentage: 50 },
      { category: 'snacks_drinks', amount: 500, percentage: 50 },
    ];
    expect(computeIndulgenceShare(onlySnacks)).toBeCloseTo(50, 5);
  });

  it('returns 0 for empty data', () => {
    expect(computeIndulgenceShare([])).toBe(0);
  });
});

describe('computeTopCategory (最大支出)', () => {
  // F.5：top category 的 category/percent/amount 正确。
  it('returns the largest non-uncategorized category with amount/percentage', () => {
    const data: CategoryData[] = [
      { category: 'snacks_drinks', amount: 8882, percentage: 45 },
      { category: 'food_ingredients', amount: 6000, percentage: 30 },
      { category: 'ready_to_eat', amount: 4000, percentage: 20 },
    ];
    const top = computeTopCategory(data);
    expect(top).toEqual({ category: 'snacks_drinks', amount: 8882, percentage: 45 });
  });

  it('skips uncategorized even if it is the largest bucket', () => {
    const data: CategoryData[] = [
      { category: 'uncategorized', amount: 5000, percentage: 50 },
      { category: 'snacks_drinks', amount: 3000, percentage: 30 },
      { category: 'food_ingredients', amount: 2000, percentage: 20 },
    ];
    const top = computeTopCategory(data);
    expect(top?.category).toBe('snacks_drinks');
  });

  it('returns null for empty data', () => {
    expect(computeTopCategory([])).toBeNull();
  });
});
