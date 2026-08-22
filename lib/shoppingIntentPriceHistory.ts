/**
 * ShoppingIntent ↔ existing product price history bridge (M1-D).
 *
 * Kept separate from the domain module so ShoppingIntent core stays free of
 * SQLite / price-history runtime imports.
 */

import {
  buildProductPriceHistory,
  type ProductPriceHistoryResult,
  type ProductPriceHistoryRow,
} from './productPriceHistory';
import {
  shoppingIntentToPriceHistoryTarget,
  type ShoppingIntent,
} from './shoppingIntent';

/**
 * Prove reuse of existing price-history builder without shopping-specific math.
 * Does not persist prices onto the intent.
 */
export function loadPriceHistoryForShoppingIntentFromRows(
  intent: Pick<ShoppingIntent, 'resolution'>,
  rows: ProductPriceHistoryRow[]
): ProductPriceHistoryResult | null {
  const target = shoppingIntentToPriceHistoryTarget(intent);
  if (!target) return null;
  return buildProductPriceHistory(target, rows);
}
