/**
 * Phase 2：V1 supported analytics（supermarket + convenience）统计口径。
 */
import type { ReceiptRow } from './db';
import { calculateStats } from './statsCalculator';

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

describe('calculateStats V1 supported analytics', () => {
  it('supportedSpend = supermarket + convenience；grocerySpend 仅 supermarket', () => {
    const receipts: ReceiptRow[] = [
      receipt({
        id: 'york',
        merchant_type: 'supermarket',
        merchant_raw: 'ヨークベニマル',
        total: 1000,
        user_items_json: JSON.stringify([
          { name: '豆腐', lineTotal: 1000, category: 'food_ingredients', classification_status: 'ok' },
        ]),
      }),
      receipt({
        id: 'fm',
        merchant_type: 'convenience',
        merchant_raw: 'ファミリーマート',
        total: 500,
        user_items_json: JSON.stringify([
          { name: 'おにぎり', lineTotal: 500, category: 'ready_to_eat', classification_status: 'ok' },
        ]),
      }),
    ];

    const stats = calculateStats(receipts, 'all');
    expect(stats.supportedSpend).toBe(1500);
    expect(stats.supportedReceiptCount).toBe(2);
    expect(stats.grocerySpend).toBe(1000);
    expect(stats.topCategories.map((c) => c.category).sort()).toEqual(
      ['food_ingredients', 'ready_to_eat'].sort()
    );
  });

  it('other / unknown 小票不进入 supported category analytics', () => {
    const receipts: ReceiptRow[] = [
      receipt({
        id: 'drug',
        merchant_type: 'other',
        merchant_raw: 'マツキヨ',
        total: 800,
        user_items_json: JSON.stringify([
          { name: 'シャンプー', lineTotal: 800, category: 'household', classification_status: 'ok' },
        ]),
      }),
      receipt({
        id: 'unk',
        merchant_type: 'unknown',
        merchant_raw: 'なぞの店',
        total: 300,
        user_items_json: JSON.stringify([
          { name: '商品', lineTotal: 300, category: 'snacks_drinks', classification_status: 'ok' },
        ]),
      }),
    ];

    const stats = calculateStats(receipts, 'all');
    expect(stats.supportedSpend).toBe(0);
    expect(stats.supportedReceiptCount).toBe(0);
    expect(stats.topCategories).toEqual([]);
  });

  it('legacy receipt 无 merchant_type 时 runtime fallback 识别 supermarket', () => {
    const receipts: ReceiptRow[] = [
      receipt({
        merchant_type: null,
        merchant_raw: 'ヨークベニマル',
        total: 600,
        user_items_json: JSON.stringify([
          { name: '野菜', lineTotal: 600, category: 'food_ingredients', classification_status: 'ok' },
        ]),
      }),
    ];

    const stats = calculateStats(receipts, 'all');
    expect(stats.supportedSpend).toBe(600);
    expect(stats.grocerySpend).toBe(600);
  });
});
