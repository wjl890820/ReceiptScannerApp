import type {
  ProductPriceHistoryPoint,
  ProductPriceHistoryStatus,
  ProductPriceKind,
} from './productPriceHistory';

export type ProductPriceVisualMode =
  | 'status'
  | 'single'
  | 'flat_pair'
  | 'chart';

export function resolveProductPriceVisualMode(
  status: ProductPriceHistoryStatus,
  points: readonly ProductPriceHistoryPoint[]
): ProductPriceVisualMode {
  if (points.length === 0) return 'status';
  if (points.length === 1) return 'single';
  if (status !== 'ready') return 'status';
  if (
    points.length === 2 &&
    Number.isFinite(points[0]?.priceValue) &&
    points[0]?.priceValue === points[1]?.priceValue
  ) {
    return 'flat_pair';
  }
  return 'chart';
}

export function formatProductPriceAmount(
  value: number,
  currency: string
): string {
  const number = Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return currency === 'JPY' ? `¥${number}` : `${currency} ${number}`;
}

export function resolveProductPriceKindLabel(
  priceKind: ProductPriceKind,
  translate: (key: string) => string
): string | null {
  const key = `priceHistory.kind.${priceKind}`;
  const translated = translate(key).trim();
  return translated && translated !== key ? translated : null;
}
