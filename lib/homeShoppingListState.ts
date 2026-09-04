import type { ShoppingListItem } from './shoppingList';
import {
  getActiveShoppingListIdentitySetFromItems,
  getActiveShoppingListQuantityMapFromItems,
} from './shoppingList';

export type HomeShoppingListDerivedState = {
  /** Incomplete checklist ROWS (not sum of quantities). */
  incompleteCount: number;
  activeIdentities: ReadonlySet<string>;
  /** Active trusted identity → quantity from the same snapshot. */
  activeQuantities: ReadonlyMap<string, number>;
};

/**
 * Derive Home Shopping List presentation state from one persisted list snapshot.
 * Count, identity Set, and quantity map always share the same truth.
 */
export function deriveHomeShoppingListState(
  items: readonly ShoppingListItem[]
): HomeShoppingListDerivedState {
  return {
    incompleteCount: items.filter((item) => !item.isCompleted).length,
    activeIdentities: getActiveShoppingListIdentitySetFromItems(items),
    activeQuantities: getActiveShoppingListQuantityMapFromItems(items),
  };
}

export function isTrustedIdentityActive(
  activeIdentities: ReadonlySet<string>,
  identityKey: string
): boolean {
  return activeIdentities.has(identityKey);
}
