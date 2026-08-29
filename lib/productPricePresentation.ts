import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import type {
  ProductPriceHistoryPoint,
  ProductPriceHistoryStatus,
  ProductPriceKind,
} from './productPriceHistory';

export type ProductPriceChangePresentation = {
  change:
    | null
    | {
        key:
          | 'priceHistory.change.unchanged'
          | 'priceHistory.change.increased'
          | 'priceHistory.change.decreased';
        deltaAmount: number | null;
      };
  promo:
    | null
    | {
        key: 'priceHistory.promo.started' | 'priceHistory.promo.ended';
      };
};

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

export function resolveProductPriceChangePresentation(
  interpretation: ProductPriceChangeInterpretation
): ProductPriceChangePresentation {
  if (interpretation.status === 'unavailable') {
    return { change: null, promo: null };
  }

  const { grossDirection, grossDelta, promoTransition } = interpretation;

  let change: ProductPriceChangePresentation['change'];
  if (grossDirection === 'unchanged') {
    change = {
      key: 'priceHistory.change.unchanged',
      deltaAmount: null,
    };
  } else if (grossDirection === 'increased') {
    change = {
      key: 'priceHistory.change.increased',
      deltaAmount: Math.abs(grossDelta),
    };
  } else {
    change = {
      key: 'priceHistory.change.decreased',
      deltaAmount: Math.abs(grossDelta),
    };
  }

  let promo: ProductPriceChangePresentation['promo'] = null;
  if (promoTransition === 'started') {
    promo = { key: 'priceHistory.promo.started' };
  } else if (promoTransition === 'ended') {
    promo = { key: 'priceHistory.promo.ended' };
  }

  return { change, promo };
}
