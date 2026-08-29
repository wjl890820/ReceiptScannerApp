import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import type { ProductPriceHistoryPoint } from './productPriceHistory';
import {
  formatProductPriceAmount,
  resolveProductPriceChangePresentation,
  resolveProductPriceKindLabel,
  resolveProductPriceVisualMode,
} from './productPricePresentation';

function availableInterpretation(
  overrides: Partial<Extract<ProductPriceChangeInterpretation, { status: 'available' }>> = {}
): Extract<ProductPriceChangeInterpretation, { status: 'available' }> {
  return {
    status: 'available',
    identityAuthority: { kind: 'sku', skuKey: 'sku-1' },
    previous: {
      receiptId: 'receipt-1',
      occurredAt: 1,
      priceValue: 439,
      grossLineAmount: 439,
      purchaseQuantity: 1,
      currency: 'JPY',
      priceKind: 'purchase_unit',
      amountBasis: 'tax_included',
      promoContext: 'explicit_discount',
      promoState: 'explicit_discount',
      discountAllocated: -33,
      effectiveLineAmount: 406,
    },
    current: {
      receiptId: 'receipt-2',
      occurredAt: 2,
      priceValue: 439,
      grossLineAmount: 439,
      purchaseQuantity: 1,
      currency: 'JPY',
      priceKind: 'purchase_unit',
      amountBasis: 'tax_included',
      promoContext: 'none_observed',
      promoState: 'none_observed',
      discountAllocated: 0,
      effectiveLineAmount: 439,
    },
    grossDirection: 'unchanged',
    grossDelta: 0,
    promoTransition: 'ended',
    previousPromo: 'explicit_discount',
    currentPromo: 'none_observed',
    previousDiscountAllocated: -33,
    currentDiscountAllocated: 0,
    ...overrides,
  };
}

function point(itemId: string, priceValue: number): ProductPriceHistoryPoint {
  return {
    receiptId: `receipt-${itemId}`,
    itemId,
    sourceIndex: 0,
    occurredAt: itemId.charCodeAt(0),
    merchantRaw: 'Merchant',
    merchantNormalized: 'merchant',
    displayName: 'Product',
    currency: 'JPY',
    lineTotal: priceValue,
    purchaseQuantity: 1,
    priceValue,
    priceKind: 'purchase_unit',
    seriesKind: 'gross',
    grossLineAmount: priceValue,
    amountBasis: 'tax_included',
  };
}

describe('Build 55 product price presentation', () => {
  it('never appends an internal unit key to a displayed amount', () => {
    expect(formatProductPriceAmount(698, 'JPY')).toBe('¥698');
    expect(formatProductPriceAmount(12.5, 'USD')).toBe('USD 12.5');
    expect(formatProductPriceAmount(698, 'JPY')).not.toContain('purchase_unit');
  });

  it('hides an absent translation instead of rendering its raw key', () => {
    expect(
      resolveProductPriceKindLabel('purchase_unit', (key) => key)
    ).toBeNull();
    expect(
      resolveProductPriceKindLabel(
        'purchase_unit',
        () => '成交单价'
      )
    ).toBe('成交单价');
  });

  it('uses a compact state for two equal price observations', () => {
    expect(
      resolveProductPriceVisualMode('ready', [point('a', 698), point('b', 698)])
    ).toBe('flat_pair');
  });

  it('keeps one point out of the full chart and 3+ points on it', () => {
    expect(
      resolveProductPriceVisualMode('not_enough_points', [point('a', 698)])
    ).toBe('single');
    expect(
      resolveProductPriceVisualMode('ready', [
        point('a', 698),
        point('b', 710),
        point('c', 680),
      ])
    ).toBe('chart');
  });
});

describe('G3-2B-2 product price change presentation', () => {
  it('A. unavailable interpretation yields no exact change or promo copy', () => {
    expect(
      resolveProductPriceChangePresentation({
        status: 'unavailable',
        reasonCodes: ['identity_not_exact'],
      })
    ).toEqual({ change: null, promo: null });
  });

  it('B. available unchanged yields unchanged presentation', () => {
    expect(
      resolveProductPriceChangePresentation(
        availableInterpretation({
          grossDirection: 'unchanged',
          grossDelta: 0,
          promoTransition: 'none',
        })
      )
    ).toEqual({
      change: {
        key: 'priceHistory.change.unchanged',
        deltaAmount: null,
      },
      promo: null,
    });
  });

  it('C. available increased yields increased plus absolute delta', () => {
    expect(
      resolveProductPriceChangePresentation(
        availableInterpretation({
          grossDirection: 'increased',
          grossDelta: 33,
          promoTransition: 'none',
        })
      )
    ).toEqual({
      change: {
        key: 'priceHistory.change.increased',
        deltaAmount: 33,
      },
      promo: null,
    });
  });

  it('D. available decreased yields decreased plus absolute delta', () => {
    expect(
      resolveProductPriceChangePresentation(
        availableInterpretation({
          previous: {
            ...availableInterpretation().previous,
            priceValue: 397,
          },
          current: {
            ...availableInterpretation().current,
            priceValue: 298,
          },
          grossDirection: 'decreased',
          grossDelta: -99,
          promoTransition: 'none',
        })
      )
    ).toEqual({
      change: {
        key: 'priceHistory.change.decreased',
        deltaAmount: 99,
      },
      promo: null,
    });
  });

  it('E. gross unchanged with promo ended stays unchanged and never maps to increased', () => {
    const presentation = resolveProductPriceChangePresentation(
      availableInterpretation({
        grossDirection: 'unchanged',
        grossDelta: 0,
        promoTransition: 'ended',
      })
    );
    expect(presentation).toEqual({
      change: {
        key: 'priceHistory.change.unchanged',
        deltaAmount: null,
      },
      promo: { key: 'priceHistory.promo.ended' },
    });
    expect(presentation.change?.key).not.toBe('priceHistory.change.increased');
    expect(presentation.change?.deltaAmount).toBeNull();
  });

  it('F. promo started yields promo-started copy', () => {
    expect(
      resolveProductPriceChangePresentation(
        availableInterpretation({
          grossDirection: 'unchanged',
          grossDelta: 0,
          promoTransition: 'started',
          previousPromo: 'none_observed',
          currentPromo: 'explicit_discount',
        })
      )
    ).toEqual({
      change: {
        key: 'priceHistory.change.unchanged',
        deltaAmount: null,
      },
      promo: { key: 'priceHistory.promo.started' },
    });
  });

  it('G. promo unknown yields no promo transition copy', () => {
    expect(
      resolveProductPriceChangePresentation(
        availableInterpretation({
          grossDirection: 'decreased',
          grossDelta: -99,
          promoTransition: 'unknown',
        })
      )
    ).toEqual({
      change: {
        key: 'priceHistory.change.decreased',
        deltaAmount: 99,
      },
      promo: null,
    });
  });

  it('does not let flat_pair visual mode authorize flatUnchanged copy in the chart', () => {
    const chartSource = readFileSync(
      join(process.cwd(), 'components/ProductPriceHistoryChart.tsx'),
      'utf8'
    );
    expect(chartSource).not.toContain("t('priceHistory.flatUnchanged')");
    expect(
      resolveProductPriceVisualMode('ready', [point('a', 698), point('b', 698)])
    ).toBe('flat_pair');
  });
});
