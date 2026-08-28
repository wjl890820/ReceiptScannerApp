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
import {
  applyTrustedG3TestDefaults as withTrustedG3Defaults,
  createTrustedReceiptTestCache as createTrustedReceiptEvidenceCache,
} from './productPriceHistory.testFixtures';

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

    const rawRows: ProductPriceHistoryRow[] = [
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
      {
        receiptId: 'r2',
        itemId: 'i2',
        sourceIndex: 0,
        occurredAt: 2,
        merchantRaw: '業務スーパー',
        merchantNormalized: '業務スーパー',
        displayName: '牛乳 900ml',
        currency: 'JPY',
        lineTotal: 238,
        purchaseQuantity: 1,
        productFamilyKey: 'milk',
        volumeBaseMl: 900,
        weightBaseG: null,
        countBase: null,
      },
    ];
    const rows = rawRows.map(withTrustedG3Defaults);
    const cache = createTrustedReceiptEvidenceCache(rows);
    const viaIntent = loadPriceHistoryForShoppingIntentFromRows(intent, rows);
    const viaDirect = buildProductPriceHistory(target!, rows, {
      receiptEvidenceCache: cache,
    });
    expect(viaIntent?.target).toEqual(viaDirect.target);
    expect(viaIntent?.observations.length).toBeGreaterThan(0);
  });
});
