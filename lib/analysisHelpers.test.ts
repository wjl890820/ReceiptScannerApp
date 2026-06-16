jest.mock('./groceryDetector', () => ({
  filterGroceryReceipts: jest.fn((rs: unknown[]) => rs),
}));

jest.mock('./priceRadar', () => {
  const actual = jest.requireActual('./priceRadar');
  return {
    ...actual,
    extractProductPrices: jest.fn(),
    computeCheapestMerchants: jest.fn(),
    getTopCheapestProducts: jest.fn(),
    computeCategoryPriceIndex: jest.fn(),
  };
});

import type { ReceiptRow } from './db';
import {
  buildPriceRadarData,
  buildCategoryIndexData,
} from './analysisHelpers';
import {
  extractProductPrices,
  computeCheapestMerchants,
  getTopCheapestProducts,
  computeCategoryPriceIndex,
} from './priceRadar';
import { filterGroceryReceipts } from './groceryDetector';

describe('buildPriceRadarData', () => {
  it('returns null for empty or non-array input', () => {
    expect(buildPriceRadarData([])).toBeNull();
    // @ts-expect-error intentional wrong type
    expect(buildPriceRadarData(undefined)).toBeNull();
  });

  it('returns null when fewer than 5 grocery receipts', () => {
    const now = Date.now();
    const receipts: ReceiptRow[] = [
      {
        id: '1',
        created_at: now,
        transaction_at: now,
        image_uri: '',
        total: 0,
        tax: 0,
        currency: 'JPY',
        analysis_json: '',
        merchant_raw: null,
        merchant_normalized: null,
        user_edited: 0,
        final_total: null,
        final_category: null,
        note: null,
        user_items_json: null,
      },
    ];
    expect(buildPriceRadarData(receipts)).toBeNull();
  });

  it('returns data when dependencies succeed', () => {
    const now = Date.now();
    const receipts: ReceiptRow[] = Array.from({ length: 5 }).map((_, i) => ({
      id: String(i + 1),
      created_at: now,
      transaction_at: now,
      image_uri: '',
      total: 100,
      tax: 10,
      currency: 'JPY',
      analysis_json: '{}',
      merchant_raw: 'Test Super',
      merchant_normalized: 'test super',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    }));

    (filterGroceryReceipts as jest.Mock).mockReturnValue(receipts);
    (extractProductPrices as jest.Mock).mockReturnValue([{ normalizedName: 'apple', merchantKey: 'm1', unitPrice: 100, date: now, receiptId: '1' }]);
    const cheapestMap = new Map();
    cheapestMap.set('apple', { normalizedName: 'apple', minUnitPrice: 80, merchantKey: 'm1', date: now, frequency: 3 });
    (computeCheapestMerchants as jest.Mock).mockReturnValue(cheapestMap);
    (getTopCheapestProducts as jest.Mock).mockReturnValue([{ normalizedName: 'apple', minUnitPrice: 80, merchantKey: 'm1', date: now, frequency: 3 }]);

    const result = buildPriceRadarData(receipts);
    expect(result).not.toBeNull();
    expect(result?.records.length).toBe(1);
    expect(result?.cheapestMap.size).toBe(1);
    expect(result?.topProducts.length).toBe(1);
  });
});

describe('buildCategoryIndexData', () => {
  it('returns null for empty receipts', () => {
    expect(buildCategoryIndexData([])).toBeNull();
  });

  it('returns null when fewer than 10 grocery receipts', () => {
    const now = Date.now();
    const receipts: ReceiptRow[] = Array.from({ length: 5 }).map((_, i) => ({
      id: String(i + 1),
      created_at: now,
      transaction_at: now,
      image_uri: '',
      total: 0,
      tax: 0,
      currency: 'JPY',
      analysis_json: '',
      merchant_raw: null,
      merchant_normalized: null,
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    }));
    expect(buildCategoryIndexData(receipts)).toBeNull();
  });

  it('returns category index when dependencies succeed', () => {
    const now = Date.now();
    const receipts: ReceiptRow[] = Array.from({ length: 10 }).map((_, i) => ({
      id: String(i + 1),
      created_at: now,
      transaction_at: now,
      image_uri: '',
      total: 100,
      tax: 10,
      currency: 'JPY',
      analysis_json: '{}',
      merchant_raw: 'Test Super',
      merchant_normalized: 'test super',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    }));

    (filterGroceryReceipts as jest.Mock).mockReturnValue(receipts);
    const mockIndex = { category: 'produce', merchantAverages: [{ merchantKey: 'm1', averagePrice: 100, itemCount: 5 }] };
    (computeCategoryPriceIndex as jest.Mock).mockReturnValue(mockIndex);

    const result = buildCategoryIndexData(receipts);
    expect(result).toEqual(mockIndex);
    expect(computeCategoryPriceIndex).toHaveBeenCalled();
  });
});


