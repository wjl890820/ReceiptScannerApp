/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import { buildShoppingIntent, shoppingIntentToPriceHistoryTarget } from './shoppingIntent';
import { loadPriceHistoryForShoppingIntentFromRows } from './shoppingIntentPriceHistory';
import {
  buildProductPriceHistory,
  type ProductPriceHistoryRow,
} from './productPriceHistory';

const FIXED_NOW = () => new Date('2026-08-22T05:00:00.000Z');

describe('ShoppingIntent price-history bridge (M1-D)', () => {
  it('O — ShoppingIntent reuses existing price-history service contract', () => {
    const intent = buildShoppingIntent({
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'price-1',
    });
    const target = shoppingIntentToPriceHistoryTarget(intent);
    expect(target).toEqual({ type: 'family', key: 'milk' });

    const rows: ProductPriceHistoryRow[] = [
      {
        receiptId: 'r1',
        itemId: 'i1',
        sourceIndex: 0,
        occurredAt: 1,
        merchantRaw: '業務スーパー',
        merchantNormalized: '業務スーパー',
        displayName: '牛乳 1L',
        currency: 'JPY',
        lineTotal: 218,
        purchaseQuantity: 1,
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
        weightBaseG: null,
        countBase: null,
      },
    ];
    const viaIntent = loadPriceHistoryForShoppingIntentFromRows(intent, rows);
    const viaDirect = buildProductPriceHistory(target!, rows);
    expect(viaIntent).toEqual(viaDirect);
    expect((viaIntent?.points ?? []).length).toBeGreaterThan(0);
  });
});
