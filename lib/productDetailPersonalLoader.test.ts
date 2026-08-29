/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  getReceiptsDatabase: jest.fn(),
}));

import type { Locale } from './i18n';
import type { ProductHistorySummary } from './productHistory';
import type { ProductPriceHistoryResult } from './productPriceHistory';
import { loadPersonalProductDetailDataWithDb } from './productDetailPersonalLoader';

function historySummary(
  overrides: Partial<ProductHistorySummary> = {}
): ProductHistorySummary {
  return {
    target: { type: 'personal_product', key: 'mp-a' },
    title: 'Coke',
    purchaseOccurrenceCount: 2,
    totalPurchaseQuantity: 2,
    totalSpend: 300,
    currency: 'JPY',
    currencyTotals: [{ currency: 'JPY', totalSpend: 300 }],
    firstPurchasedAt: 1,
    lastPurchasedAt: 2,
    merchantCount: 2,
    canonicalProductCount: 1,
    skuCount: 0,
    specificationVariants: [],
    merchants: [],
    recentPurchases: [],
    ...overrides,
  };
}

function priceHistoryResult(
  overrides: Partial<ProductPriceHistoryResult> = {}
): ProductPriceHistoryResult {
  return {
    status: 'not_enough_points',
    target: { type: 'personal_product', key: 'mp-a' },
    points: [],
    observations: [],
    currency: null,
    priceKind: 'purchase_unit',
    totalOccurrenceCount: 2,
    comparableOccurrenceCount: 0,
    excludedOccurrenceCount: 0,
    ...overrides,
  } as ProductPriceHistoryResult;
}

describe('G4-2C productDetailPersonalLoader', () => {
  it('uses one resolved context for history and price loaders', async () => {
    const historyContexts: unknown[] = [];
    const priceContexts: unknown[] = [];
    const resolved = {
      requestedTarget: { type: 'personal_product' as const, key: 'mp-b' },
      canonicalTarget: { type: 'personal_product' as const, key: 'mp-a' },
      ownerKey: 'user:detail-owner',
      authority: {
        identityLevel: 'product_exact' as const,
        sourceTier: 'personal_manual' as const,
        authority: {
          kind: 'personal_product' as const,
          anchorMerchantProductId: 'mp-a',
          memberMerchantProductIds: ['mp-a', 'mp-b'],
        },
      },
      anchorMerchantProductId: 'mp-a',
      memberMerchantProductIds: ['mp-a', 'mp-b'],
      authorizedRowKeys: new Set<string>(),
      inventory: {} as never,
    };

    const result = await loadPersonalProductDetailDataWithDb(
      'mp-b',
      { locale: 'en' as Locale },
      {
        getDatabase: async () => ({} as never),
        resolveTarget: async () => ({ status: 'ready', resolved }),
        loadHistory: async (_db, _target, options) => {
          historyContexts.push(options?.personalProductContext);
          return historySummary();
        },
        loadPriceHistory: async (_db, _target, options) => {
          priceContexts.push(options?.personalProductContext);
          return priceHistoryResult();
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(historyContexts[0]).toBe(resolved);
    expect(priceContexts[0]).toBe(resolved);
    if (result.ok) {
      expect(result.history.target).toEqual({ type: 'personal_product', key: 'mp-a' });
    }
  });

  it('accepts old current member locator and returns canonical anchor', async () => {
    const resolved = {
      requestedTarget: { type: 'personal_product' as const, key: 'mp-seven' },
      canonicalTarget: { type: 'personal_product' as const, key: 'mp-aeon' },
      ownerKey: 'user:detail-owner',
      authority: {
        identityLevel: 'product_exact' as const,
        sourceTier: 'personal_manual' as const,
        authority: {
          kind: 'personal_product' as const,
          anchorMerchantProductId: 'mp-aeon',
          memberMerchantProductIds: ['mp-aeon', 'mp-seven'],
        },
      },
      anchorMerchantProductId: 'mp-aeon',
      memberMerchantProductIds: ['mp-aeon', 'mp-seven'],
      authorizedRowKeys: new Set<string>(),
      inventory: {} as never,
    };

    const result = await loadPersonalProductDetailDataWithDb(
      'mp-seven',
      { locale: 'en' as Locale },
      {
        getDatabase: async () => ({} as never),
        resolveTarget: async () => ({ status: 'ready', resolved }),
        loadHistory: async () =>
          historySummary({ target: { type: 'personal_product', key: 'mp-aeon' } }),
        loadPriceHistory: async () =>
          priceHistoryResult({ target: { type: 'personal_product', key: 'mp-aeon' } }),
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.canonicalTarget.key).toBe('mp-aeon');
      expect(result.history.target.key).toBe('mp-aeon');
    }
  });

  it('does not fallback when personal resolver fails', async () => {
    const result = await loadPersonalProductDetailDataWithDb(
      'missing',
      { locale: 'en' as Locale },
      {
        getDatabase: async () => ({} as never),
        resolveTarget: async () => ({ status: 'personal_product_not_authorized' }),
      }
    );
    expect(result).toEqual({ ok: false, reason: 'personal_product_not_authorized' });
  });
});
