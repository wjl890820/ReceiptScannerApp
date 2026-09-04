import type { ShoppingListItem } from './shoppingList';
import { getActiveShoppingListIdentitySetFromItems } from './shoppingList';

export type HomeShoppingListDerivedState = {
  incompleteCount: number;
  activeIdentities: ReadonlySet<string>;
};

/**
 * Derive Home Shopping List presentation state from one persisted list snapshot.
 * Count and active identity Set always share the same truth.
 */
export function deriveHomeShoppingListState(
  items: readonly ShoppingListItem[]
): HomeShoppingListDerivedState {
  return {
    incompleteCount: items.filter((item) => !item.isCompleted).length,
    activeIdentities: getActiveShoppingListIdentitySetFromItems(items),
  };
}

export function isTrustedIdentityActive(
  activeIdentities: ReadonlySet<string>,
  identityKey: string
): boolean {
  return activeIdentities.has(identityKey);
}
