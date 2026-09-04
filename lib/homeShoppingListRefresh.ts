import {
  deriveHomeShoppingListState,
  type HomeShoppingListDerivedState,
} from './homeShoppingListState';
import type { ShoppingListItem } from './shoppingList';

export type HomeShoppingListRefreshGenerationRef = {
  current: number;
};

export type RunHomeShoppingListRefreshResult =
  | 'applied'
  | 'stale'
  | 'error_stale'
  | 'error_current';

/**
 * Latest-wins Shopping List Home refresh.
 * Multiple overlapping reads may run; only the latest-started request may commit.
 */
export async function runHomeShoppingListRefresh(args: {
  generationRef: HomeShoppingListRefreshGenerationRef;
  loadItems: () => Promise<readonly ShoppingListItem[]>;
  apply: (state: HomeShoppingListDerivedState) => void;
  onError?: (error: unknown) => void;
}): Promise<RunHomeShoppingListRefreshResult> {
  const generation = ++args.generationRef.current;
  try {
    const items = await args.loadItems();
    if (generation !== args.generationRef.current) {
      return 'stale';
    }
    args.apply(deriveHomeShoppingListState(items));
    return 'applied';
  } catch (error) {
    if (generation !== args.generationRef.current) {
      return 'error_stale';
    }
    args.onError?.(error);
    return 'error_current';
  }
}
