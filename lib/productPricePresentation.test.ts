import type { ProductPriceHistoryPoint } from './productPriceHistory';
import {
  formatProductPriceAmount,
  resolveProductPriceKindLabel,
  resolveProductPriceVisualMode,
} from './productPricePresentation';

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
