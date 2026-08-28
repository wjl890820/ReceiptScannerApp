import { buildPriceChartCoordinates } from './productPriceChart';
import type { ProductPriceHistoryPoint } from './productPriceHistory';

function point(
  itemId: string,
  occurredAt: number,
  priceValue: number
): ProductPriceHistoryPoint {
  return {
    receiptId: `receipt-${itemId}`,
    itemId,
    sourceIndex: 0,
    occurredAt,
    merchantRaw: null,
    merchantNormalized: null,
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

describe('buildPriceChartCoordinates', () => {
  it('keeps equal-value points finite without forcing the Y range to zero', () => {
    const coordinates = buildPriceChartCoordinates(
      [point('a', 100, 238), point('b', 200, 238)],
      300
    );

    expect(coordinates).toHaveLength(2);
    expect(
      coordinates.every(
        ({ x, y }) => Number.isFinite(x) && Number.isFinite(y)
      )
    ).toBe(true);
    expect(coordinates[0].y).toBe(coordinates[1].y);
    expect(coordinates[0].x).toBeLessThan(coordinates[1].x);
  });

  it('uses stable occurrence spacing when timestamps are identical', () => {
    const coordinates = buildPriceChartCoordinates(
      [point('a', 100, 200), point('b', 100, 250), point('c', 100, 225)],
      300
    );

    expect(coordinates[0].x).toBeLessThan(coordinates[1].x);
    expect(coordinates[1].x).toBeLessThan(coordinates[2].x);
  });
});
