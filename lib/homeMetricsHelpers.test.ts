/**
 * 最小单测：首页分类聚合与未分类汇总。
 */
import type { ReceiptRow } from './db';
import { aggregateCategoryData, computeUncategorizedSummary } from './homeMetricsHelpers';

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
          { name: 'A', lineTotal: 100, category: 'vegetables', classification_status: 'ok' },
        ]),
      }),
    ];
    const got = aggregateCategoryData(receipts);
    expect(got).toHaveLength(1);
    expect(got[0].category).toBe('vegetables');
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
});
