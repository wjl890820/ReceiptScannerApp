/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { isHomeRoutePath } from './homeRouteVisibility';
import {
  beginHomeRefresh,
  completeHomeRefresh,
  failHomeRefresh,
  holdHomeRefreshForRetry,
  INITIAL_HOME_REFRESH_STATE,
} from './homeRefreshState';
import {
  deriveHomeShoppingListState,
  isTrustedIdentityActive,
} from './homeShoppingListState';
import { createMemoryShoppingIntentDatabase } from './shoppingIntentRepository';
import {
  addShoppingListItemFromNextPurchaseWithDb,
  addShoppingListItemFromProductDetailWithDb,
  deleteShoppingListItemWithDb,
  listShoppingListItemsWithDb,
  shoppingListIdentityKey,
  toggleShoppingListItemCompletedWithDb,
} from './shoppingList';

const FIXED_NOW = () => new Date('2026-09-04T01:00:00.000Z');
const LATER = () => new Date('2026-09-04T02:00:00.000Z');

function candidate() {
  return {
    displayName: '鶏砂肝',
    identityKind: 'merchant_product' as const,
    identityKey: 'mp:chicken-liver',
  };
}

describe('B3C Home shopping-list refresh truth', () => {
  it('A — active trusted candidate ⇒ Home shows added', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'home-a',
      now: FIXED_NOW,
    });
    const derived = deriveHomeShoppingListState(
      await listShoppingListItemsWithDb(db)
    );
    const key = shoppingListIdentityKey(
      'merchant_product',
      'mp:chicken-liver'
    );
    expect(derived.incompleteCount).toBe(1);
    expect(isTrustedIdentityActive(derived.activeIdentities, key)).toBe(true);
  });

  it('B — complete item ⇒ Home re-read ⇒ candidate addable', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'home-b',
      now: FIXED_NOW,
    });
    await toggleShoppingListItemCompletedWithDb(db, 'home-b', LATER);
    // Simulate Home becoming visible again and re-reading SQLite.
    const derived = deriveHomeShoppingListState(
      await listShoppingListItemsWithDb(db)
    );
    const key = shoppingListIdentityKey(
      'merchant_product',
      'mp:chicken-liver'
    );
    expect(derived.incompleteCount).toBe(0);
    expect(isTrustedIdentityActive(derived.activeIdentities, key)).toBe(false);
  });

  it('C — delete active item ⇒ Home re-read ⇒ candidate addable', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'home-c',
      now: FIXED_NOW,
    });
    await deleteShoppingListItemWithDb(db, 'home-c');
    const derived = deriveHomeShoppingListState(
      await listShoppingListItemsWithDb(db)
    );
    const key = shoppingListIdentityKey(
      'merchant_product',
      'mp:chicken-liver'
    );
    expect(derived.incompleteCount).toBe(0);
    expect(isTrustedIdentityActive(derived.activeIdentities, key)).toBe(false);
  });

  it('D — Product Detail add ⇒ Home count + added-state refresh', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: '鶏砂肝',
        identityKind: 'merchant_product',
        identityKey: 'mp:chicken-liver',
      },
      { idFactory: () => 'home-d', now: FIXED_NOW }
    );
    const derived = deriveHomeShoppingListState(
      await listShoppingListItemsWithDb(db)
    );
    expect(derived.incompleteCount).toBe(1);
    expect(
      isTrustedIdentityActive(
        derived.activeIdentities,
        shoppingListIdentityKey('merchant_product', 'mp:chicken-liver')
      )
    ).toBe(true);
  });

  it('E — count and active Set refresh from the same persisted truth', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'home-e1',
      now: FIXED_NOW,
    });
    await addShoppingListItemFromNextPurchaseWithDb(
      db,
      {
        displayName: '牛乳',
        identityKind: 'merchant_product',
        identityKey: 'mp:milk',
      },
      { idFactory: () => 'home-e2', now: LATER }
    );
    await toggleShoppingListItemCompletedWithDb(db, 'home-e1', LATER);
    const items = await listShoppingListItemsWithDb(db);
    const derived = deriveHomeShoppingListState(items);
    expect(derived.incompleteCount).toBe(1);
    expect(derived.activeIdentities.size).toBe(1);
    expect(
      [...derived.activeIdentities][0]
    ).toBe(shoppingListIdentityKey('merchant_product', 'mp:milk'));
    // Same snapshot: completed identity must not appear in Set.
    expect(
      derived.activeIdentities.has(
        shoppingListIdentityKey('merchant_product', 'mp:chicken-liver')
      )
    ).toBe(false);
  });
});

describe('B3C first-launch Home loading', () => {
  it('F — no prior snapshot ⇒ initialLoading true', () => {
    expect(INITIAL_HOME_REFRESH_STATE.initialLoading).toBe(true);
    expect(INITIAL_HOME_REFRESH_STATE.hasCompleteSnapshot).toBe(false);
  });

  it('G — first local refresh pending ⇒ not treated as final empty', () => {
    const pending = beginHomeRefresh(INITIAL_HOME_REFRESH_STATE);
    expect(pending.initialLoading).toBe(true);
    expect(pending.hasCompleteSnapshot).toBe(false);
    // Progressive empty copy is gated by !initialLoading in ProgressiveHomeInsights.
    const insights = fs.readFileSync(
      path.resolve(__dirname, '../components/ProgressiveHomeInsights.tsx'),
      'utf8'
    );
    expect(insights).toMatch(
      /experience\.stage === 'empty' && !initialLoading/
    );
  });

  it('H — DB/init completes ⇒ Home resolves without tab switch', () => {
    const ready = completeHomeRefresh();
    expect(ready).toEqual({
      initialLoading: false,
      backgroundRefreshing: false,
      hasCompleteSnapshot: true,
    });
    const home = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    // Pathname visibility refresh — automatic when returning to Home route.
    expect(home).toContain('isHomeRoutePath(pathname)');
    expect(home).toContain('refreshShoppingListHomeState');
    expect(home).toContain('holdHomeRefreshForRetry');
    expect(home).toContain('runHomeShoppingListRefresh');
    expect(home).toContain('shoppingListRefreshGenerationRef');
  });

  it('I — first refresh transiently unavailable ⇒ safe one-shot retry', () => {
    expect(holdHomeRefreshForRetry()).toEqual({
      initialLoading: true,
      backgroundRefreshing: false,
      hasCompleteSnapshot: false,
    });
    const home = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    expect(home).toContain('coldStartRetryUsedRef');
    expect(home).toContain('isAutomaticRetry');
    expect(home).toContain('initIfNeeded');
  });

  it('J — real empty after successful init ⇒ not endless spinner', () => {
    const done = completeHomeRefresh();
    expect(done.initialLoading).toBe(false);
    expect(done.hasCompleteSnapshot).toBe(true);
    const terminal = failHomeRefresh({
      initialLoading: true,
      backgroundRefreshing: false,
      hasCompleteSnapshot: false,
    });
    expect(terminal.initialLoading).toBe(false);
    expect(terminal.hasCompleteSnapshot).toBe(false);
  });
});

describe('B3C blank manual input UX', () => {
  it('K/L — Add disabled for blank/whitespace; enabled for trimmed text', () => {
    const screen = fs.readFileSync(
      path.resolve(__dirname, '../app/shopping-list.tsx'),
      'utf8'
    );
    expect(screen).toContain('const canAddManual = draft.trim().length > 0');
    expect(screen).toContain('disabled={busy || !canAddManual}');
    expect(screen).toContain('if (busy || draft.trim().length === 0) return');
    expect(screen).toContain('addManualShoppingListItem(draft)');
  });
});

describe('B3C home route visibility helper', () => {
  it('recognizes Home paths and rejects stack overlays', () => {
    expect(isHomeRoutePath('/')).toBe(true);
    expect(isHomeRoutePath('/(tabs)')).toBe(true);
    expect(isHomeRoutePath('/(tabs)/index')).toBe(true);
    expect(isHomeRoutePath('/shopping-list')).toBe(false);
    expect(isHomeRoutePath('/product/merchant_product')).toBe(false);
    expect(isHomeRoutePath('/analysis')).toBe(false);
  });
});
