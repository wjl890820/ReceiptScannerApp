import type { ProductPriceHistoryPoint } from './productPriceHistory';

export type PriceChartCoordinate = { x: number; y: number };

export const PRODUCT_PRICE_CHART_HEIGHT = 170;
export const PRODUCT_PRICE_CHART_PADDING_X = 12;
export const PRODUCT_PRICE_CHART_PADDING_Y = 16;

export function buildPriceChartCoordinates(
  points: ProductPriceHistoryPoint[],
  width: number,
  height = PRODUCT_PRICE_CHART_HEIGHT
): PriceChartCoordinate[] {
  if (points.length === 0 || width <= PRODUCT_PRICE_CHART_PADDING_X * 2) {
    return [];
  }
  const values = points.map((point) => point.priceValue);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const valuePadding =
    minimum === maximum
      ? Math.max(1, Math.abs(minimum) * 0.05)
      : (maximum - minimum) * 0.12;
  const yMinimum = minimum - valuePadding;
  const yMaximum = maximum + valuePadding;
  const yRange = yMaximum - yMinimum;
  const firstTime = points[0].occurredAt;
  const lastTime = points[points.length - 1].occurredAt;
  const timeRange = lastTime - firstTime;
  const plotWidth = width - PRODUCT_PRICE_CHART_PADDING_X * 2;
  const plotHeight = height - PRODUCT_PRICE_CHART_PADDING_Y * 2;

  return points.map((point, index) => {
    const timeRatio =
      timeRange > 0
        ? (point.occurredAt - firstTime) / timeRange
        : points.length > 1
          ? index / (points.length - 1)
          : 0.5;
    return {
      x: PRODUCT_PRICE_CHART_PADDING_X + timeRatio * plotWidth,
      y:
        PRODUCT_PRICE_CHART_PADDING_Y +
        ((yMaximum - point.priceValue) / yRange) * plotHeight,
    };
  });
}
