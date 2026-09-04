/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import { runHomeShoppingListRefresh } from './homeShoppingListRefresh';
import type { ShoppingListItem } from './shoppingList';
import { shoppingListIdentityKey } from './shoppingList';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function item(overrides: Partial<ShoppingListItem> & Pick<ShoppingListItem, 'id' | 'text' | 'isCompleted'>): ShoppingListItem {
  return {
    completedAt: overrides.isCompleted ? 1 : null,
    createdAt: 1,
    updatedAt: 1,
    sourceType: 'next_purchase',
    sourceIdentityKind: 'merchant_product',
    sourceIdentityKey: 'mp:x',
    ...overrides,
  };
}

const IDENTITY_X = shoppingListIdentityKey('merchant_product', 'mp:x');

describe('Home Shopping List refresh latest-wins', () => {
  it('out-of-order: stale R1 must not overwrite newer R2', async () => {
    const generationRef = { current: 0 };
    let incompleteCount = 1;
    let activeIdentities: ReadonlySet<string> = new Set([IDENTITY_X]);

    const r1 = deferred<readonly ShoppingListItem[]>();
    const r2 = deferred<readonly ShoppingListItem[]>();
    let loadCalls = 0;

    const loadItems = () => {
      loadCalls += 1;
      return loadCalls === 1 ? r1.promise : r2.promise;
    };

    const apply = (state: {
      incompleteCount: number;
      activeIdentities: ReadonlySet<string>;
    }) => {
      incompleteCount = state.incompleteCount;
      activeIdentities = state.activeIdentities;
    };

    const p1 = runHomeShoppingListRefresh({
      generationRef,
      loadItems,
      apply,
    });
    const p2 = runHomeShoppingListRefresh({
      generationRef,
      loadItems,
      apply,
    });

    // R2 finishes first with NEW truth (X completed → count 0).
    r2.resolve([]);
    await expect(p2).resolves.toBe('applied');
    expect(incompleteCount).toBe(0);
    expect(activeIdentities.size).toBe(0);

    // Stale R1 finishes afterward with OLD snapshot.
    r1.resolve([
      item({
        id: 'stale',
        text: 'X',
        isCompleted: false,
        sourceIdentityKind: 'merchant_product',
        sourceIdentityKey: 'mp:x',
      }),
    ]);
    await expect(p1).resolves.toBe('stale');
    expect(incompleteCount).toBe(0);
    expect(activeIdentities.size).toBe(0);
    expect(activeIdentities.has(IDENTITY_X)).toBe(false);
  });

  it('reverse order: later-started R2 still wins after R1', async () => {
    const generationRef = { current: 0 };
    let incompleteCount = -1;
    let activeIdentities: ReadonlySet<string> = new Set(['seed']);

    const r1 = deferred<readonly ShoppingListItem[]>();
    const r2 = deferred<readonly ShoppingListItem[]>();
    let loadCalls = 0;
    const loadItems = () => {
      loadCalls += 1;
      return loadCalls === 1 ? r1.promise : r2.promise;
    };

    const apply = (state: {
      incompleteCount: number;
      activeIdentities: ReadonlySet<string>;
    }) => {
      incompleteCount = state.incompleteCount;
      activeIdentities = state.activeIdentities;
    };

    const p1 = runHomeShoppingListRefresh({
      generationRef,
      loadItems,
      apply,
    });
    const p2 = runHomeShoppingListRefresh({
      generationRef,
      loadItems,
      apply,
    });

    r1.resolve([
      item({
        id: 'r1',
        text: 'X',
        isCompleted: false,
        sourceIdentityKind: 'merchant_product',
        sourceIdentityKey: 'mp:x',
      }),
    ]);
    await expect(p1).resolves.toBe('stale');
    // R1 completed first but must not apply (R2 already started).
    expect(incompleteCount).toBe(-1);
    expect(activeIdentities.has('seed')).toBe(true);

    r2.resolve([]);
    await expect(p2).resolves.toBe('applied');
    expect(incompleteCount).toBe(0);
    expect(activeIdentities.size).toBe(0);
  });

  it('old error after new success must not overwrite/reset fresh state', async () => {
    const generationRef = { current: 0 };
    let incompleteCount = 1;
    let activeIdentities: ReadonlySet<string> = new Set([IDENTITY_X]);
    let errorCount = 0;

    const r1 = deferred<readonly ShoppingListItem[]>();
    const r2 = deferred<readonly ShoppingListItem[]>();
    let loadCalls = 0;
    const loadItems = () => {
      loadCalls += 1;
      return loadCalls === 1 ? r1.promise : r2.promise;
    };

    const apply = (state: {
      incompleteCount: number;
      activeIdentities: ReadonlySet<string>;
    }) => {
      incompleteCount = state.incompleteCount;
      activeIdentities = state.activeIdentities;
    };

    const p1 = runHomeShoppingListRefresh({
      generationRef,
      loadItems,
      apply,
      onError: () => {
        errorCount += 1;
        incompleteCount = -1;
        activeIdentities = new Set(['CORRUPTED']);
      },
    });
    const p2 = runHomeShoppingListRefresh({
      generationRef,
      loadItems,
      apply,
      onError: () => {
        errorCount += 1;
      },
    });

    r2.resolve([]);
    await expect(p2).resolves.toBe('applied');
    expect(incompleteCount).toBe(0);
    expect(activeIdentities.size).toBe(0);

    r1.reject(new Error('stale failure'));
    await expect(p1).resolves.toBe('error_stale');
    expect(errorCount).toBe(0);
    expect(incompleteCount).toBe(0);
    expect(activeIdentities.size).toBe(0);
    expect(activeIdentities.has('CORRUPTED')).toBe(false);
  });
});
