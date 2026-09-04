/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { deriveHomeShoppingListState } from './homeShoppingListState';
import { runHomeShoppingListRefresh } from './homeShoppingListRefresh';
import { createMemoryShoppingIntentDatabase } from './shoppingIntentRepository';
import {
  addManualShoppingListItemWithDb,
  addOrIncrementShoppingListItemFromNextPurchaseWithDb,
  addShoppingListItemFromNextPurchaseWithDb,
  decrementShoppingListItemQuantityWithDb,
  effectiveShoppingListQuantity,
  incrementShoppingListItemQuantityWithDb,
  listShoppingListItemsWithDb,
  mapShoppingIntentRowToListItem,
  shoppingListIdentityKey,
  SHOPPING_LIST_QUANTITY_MAX,
  toggleShoppingListItemCompletedWithDb,
} from './shoppingList';

const FIXED_NOW = () => new Date('2026-09-04T12:00:00.000Z');
const LATER = () => new Date('2026-09-04T13:00:00.000Z');
const EVEN_LATER = () => new Date('2026-09-04T14:00:00.000Z');

function candidate(
  overrides: Partial<{
    displayName: string;
    identityKind: 'merchant_product' | 'personal_product';
    identityKey: string;
  }> = {}
) {
  return {
    displayName: overrides.displayName ?? '鶏砂肝',
    identityKind: overrides.identityKind ?? ('merchant_product' as const),
    identityKey: overrides.identityKey ?? 'mp:chicken-liver',
  };
}

describe('Shopping List Quantity V0 domain', () => {
  it('A — null desired_quantity ⇒ quantity 1', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, '牛乳', {
      idFactory: () => 'null-q',
      now: FIXED_NOW,
    });
    // Simulate legacy null column.
    const row = db.rows.get('null-q')!;
    db.rows.set('null-q', { ...row, desired_quantity: null });
    const item = mapShoppingIntentRowToListItem(db.rows.get('null-q')!);
    expect(item?.quantity).toBe(1);
    expect(effectiveShoppingListQuantity(null)).toBe(1);
  });

  it('B — new manual persists effective quantity 1', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const result = await addManualShoppingListItemWithDb(db, '牛奶', {
      idFactory: () => 'man-1',
      now: FIXED_NOW,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.item.quantity).toBe(1);
    expect(db.rows.get('man-1')?.desired_quantity).toBe(1);
  });

  it('C — increment 1→2→3', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, '鶏砂肝', {
      idFactory: () => 'inc',
      now: FIXED_NOW,
    });
    const a = await incrementShoppingListItemQuantityWithDb(db, 'inc', LATER);
    const b = await incrementShoppingListItemQuantityWithDb(
      db,
      'inc',
      EVEN_LATER
    );
    expect(a.status).toBe('updated');
    expect(b.status).toBe('updated');
    if (a.status === 'updated') expect(a.item.quantity).toBe(2);
    if (b.status === 'updated') expect(b.item.quantity).toBe(3);
  });

  it('D/E — decrement floors at 1', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, '鶏砂肝', {
      idFactory: () => 'dec',
      now: FIXED_NOW,
    });
    await incrementShoppingListItemQuantityWithDb(db, 'dec', LATER);
    await incrementShoppingListItemQuantityWithDb(db, 'dec', EVEN_LATER);
    const d1 = await decrementShoppingListItemQuantityWithDb(
      db,
      'dec',
      () => new Date('2026-09-04T15:00:00.000Z')
    );
    const d2 = await decrementShoppingListItemQuantityWithDb(
      db,
      'dec',
      () => new Date('2026-09-04T16:00:00.000Z')
    );
    const d3 = await decrementShoppingListItemQuantityWithDb(
      db,
      'dec',
      () => new Date('2026-09-04T17:00:00.000Z')
    );
    expect(d1.status).toBe('updated');
    expect(d2.status).toBe('updated');
    expect(d3.status).toBe('min_reached');
    if (d2.status === 'updated') expect(d2.item.quantity).toBe(1);
    if (d3.status === 'min_reached') expect(d3.item.quantity).toBe(1);
  });

  it('F — maximum 99', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, '鶏砂肝', {
      idFactory: () => 'max',
      now: FIXED_NOW,
    });
    db.rows.set('max', {
      ...db.rows.get('max')!,
      desired_quantity: SHOPPING_LIST_QUANTITY_MAX,
    });
    const result = await incrementShoppingListItemQuantityWithDb(
      db,
      'max',
      LATER
    );
    expect(result.status).toBe('max_reached');
    if (result.status === 'max_reached') {
      expect(result.item.quantity).toBe(99);
    }
  });

  it('legacy ±Infinity / NaN: memory normalize-then-step matches read helper', async () => {
    for (const raw of [Infinity, -Infinity, Number.NaN] as const) {
      const db = createMemoryShoppingIntentDatabase();
      const id = `inf-${String(raw)}`;
      await addManualShoppingListItemWithDb(db, '鶏砂肝', {
        idFactory: () => id,
        now: FIXED_NOW,
      });
      db.rows.set(id, {
        ...db.rows.get(id)!,
        desired_quantity: raw,
      });
      expect(effectiveShoppingListQuantity(raw)).toBe(1);
      expect(mapShoppingIntentRowToListItem(db.rows.get(id)!)?.quantity).toBe(1);
      const inc = await incrementShoppingListItemQuantityWithDb(db, id, LATER);
      expect(inc.status).toBe('updated');
      if (inc.status === 'updated') expect(inc.item.quantity).toBe(2);

      const db2 = createMemoryShoppingIntentDatabase();
      const id2 = `${id}-dec`;
      await addManualShoppingListItemWithDb(db2, '鶏砂肝', {
        idFactory: () => id2,
        now: FIXED_NOW,
      });
      db2.rows.set(id2, {
        ...db2.rows.get(id2)!,
        desired_quantity: raw,
      });
      const dec = await decrementShoppingListItemQuantityWithDb(
        db2,
        id2,
        LATER
      );
      expect(dec.status).toBe('min_reached');
      if (dec.status === 'min_reached') expect(dec.item.quantity).toBe(1);
      expect(db2.rows.get(id2)!.desired_quantity).toBe(1);
    }
  });

  it('legacy normalize-then-step: increment from raw NULL/0/-1/1.5/2.75/100/999', async () => {
    const cases: Array<{
      raw: number | null;
      id: string;
      expectedStatus: 'updated' | 'max_reached';
      expectedQty: number;
      expectedPersisted: number;
    }> = [
      {
        raw: null,
        id: 'leg-inc-null',
        expectedStatus: 'updated',
        expectedQty: 2,
        expectedPersisted: 2,
      },
      {
        raw: 0,
        id: 'leg-inc-0',
        expectedStatus: 'updated',
        expectedQty: 2,
        expectedPersisted: 2,
      },
      {
        raw: -1,
        id: 'leg-inc-neg',
        expectedStatus: 'updated',
        expectedQty: 2,
        expectedPersisted: 2,
      },
      {
        raw: 1.5,
        id: 'leg-inc-1.5',
        expectedStatus: 'updated',
        expectedQty: 2,
        expectedPersisted: 2,
      },
      {
        raw: 2.75,
        id: 'leg-inc-2.75',
        expectedStatus: 'updated',
        expectedQty: 3,
        expectedPersisted: 3,
      },
      {
        raw: 100,
        id: 'leg-inc-100',
        expectedStatus: 'max_reached',
        expectedQty: 99,
        expectedPersisted: 99,
      },
      {
        raw: 999,
        id: 'leg-inc-999',
        expectedStatus: 'max_reached',
        expectedQty: 99,
        expectedPersisted: 99,
      },
    ];
    for (const c of cases) {
      const db = createMemoryShoppingIntentDatabase();
      await addManualShoppingListItemWithDb(db, '鶏砂肝', {
        idFactory: () => c.id,
        now: FIXED_NOW,
      });
      db.rows.set(c.id, {
        ...db.rows.get(c.id)!,
        desired_quantity: c.raw,
      });
      expect(mapShoppingIntentRowToListItem(db.rows.get(c.id)!)?.quantity).toBe(
        effectiveShoppingListQuantity(c.raw)
      );
      const result = await incrementShoppingListItemQuantityWithDb(
        db,
        c.id,
        LATER
      );
      expect(result.status).toBe(c.expectedStatus);
      if (result.status === 'updated' || result.status === 'max_reached') {
        expect(result.item.quantity).toBe(c.expectedQty);
      }
      expect(db.rows.get(c.id)!.desired_quantity).toBe(c.expectedPersisted);
      expect(
        Number.isInteger(db.rows.get(c.id)!.desired_quantity as number)
      ).toBe(true);
    }
  });

  it('legacy normalize-then-step: decrement from raw NULL/0/-1/1.5/2.75/100/999', async () => {
    const cases: Array<{
      raw: number | null;
      id: string;
      expectedStatus: 'updated' | 'min_reached';
      expectedQty: number;
      expectedPersisted: number;
    }> = [
      {
        raw: null,
        id: 'leg-dec-null',
        expectedStatus: 'min_reached',
        expectedQty: 1,
        expectedPersisted: 1,
      },
      {
        raw: 0,
        id: 'leg-dec-0',
        expectedStatus: 'min_reached',
        expectedQty: 1,
        expectedPersisted: 1,
      },
      {
        raw: -1,
        id: 'leg-dec-neg',
        expectedStatus: 'min_reached',
        expectedQty: 1,
        expectedPersisted: 1,
      },
      {
        raw: 1.5,
        id: 'leg-dec-1.5',
        expectedStatus: 'min_reached',
        expectedQty: 1,
        expectedPersisted: 1,
      },
      {
        raw: 2.75,
        id: 'leg-dec-2.75',
        expectedStatus: 'updated',
        expectedQty: 1,
        expectedPersisted: 1,
      },
      {
        raw: 100,
        id: 'leg-dec-100',
        expectedStatus: 'updated',
        expectedQty: 98,
        expectedPersisted: 98,
      },
      {
        raw: 999,
        id: 'leg-dec-999',
        expectedStatus: 'updated',
        expectedQty: 98,
        expectedPersisted: 98,
      },
    ];
    for (const c of cases) {
      const db = createMemoryShoppingIntentDatabase();
      await addManualShoppingListItemWithDb(db, '鶏砂肝', {
        idFactory: () => c.id,
        now: FIXED_NOW,
      });
      db.rows.set(c.id, {
        ...db.rows.get(c.id)!,
        desired_quantity: c.raw,
      });
      expect(mapShoppingIntentRowToListItem(db.rows.get(c.id)!)?.quantity).toBe(
        effectiveShoppingListQuantity(c.raw)
      );
      const result = await decrementShoppingListItemQuantityWithDb(
        db,
        c.id,
        LATER
      );
      expect(result.status).toBe(c.expectedStatus);
      if (result.status === 'updated' || result.status === 'min_reached') {
        expect(result.item.quantity).toBe(c.expectedQty);
      }
      expect(db.rows.get(c.id)!.desired_quantity).toBe(c.expectedPersisted);
      expect(
        Number.isInteger(db.rows.get(c.id)!.desired_quantity as number)
      ).toBe(true);
    }
  });

  it('G — concurrent increments have no lost update', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, '鶏砂肝', {
      idFactory: () => 'conc',
      now: FIXED_NOW,
    });
    await Promise.all([
      incrementShoppingListItemQuantityWithDb(db, 'conc'),
      incrementShoppingListItemQuantityWithDb(db, 'conc'),
      incrementShoppingListItemQuantityWithDb(db, 'conc'),
      incrementShoppingListItemQuantityWithDb(db, 'conc'),
    ]);
    const listed = await listShoppingListItemsWithDb(db);
    expect(listed[0]?.quantity).toBe(5);
  });

  it('H — first-add race → one row quantity 2', async () => {
    const db = createMemoryShoppingIntentDatabase();
    let seq = 0;
    const results = await Promise.all([
      addOrIncrementShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
        idFactory: () => `h-${++seq}`,
        now: FIXED_NOW,
      }),
      addOrIncrementShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
        idFactory: () => `h-${++seq}`,
        now: LATER,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'created',
      'incremented',
    ]);
    expect(db.rows.size).toBe(1);
    const item = [...db.rows.values()][0]!;
    expect(effectiveShoppingListQuantity(item.desired_quantity)).toBe(2);
  });

  it('I — three rapid first adds → quantity 3', async () => {
    const db = createMemoryShoppingIntentDatabase();
    let seq = 0;
    await Promise.all([
      addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
        idFactory: () => `i-${++seq}`,
      }),
      addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
        idFactory: () => `i-${++seq}`,
      }),
      addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
        idFactory: () => `i-${++seq}`,
      }),
    ]);
    expect(db.rows.size).toBe(1);
    expect(
      effectiveShoppingListQuantity([...db.rows.values()][0]!.desired_quantity)
    ).toBe(3);
  });

  it('J — different trusted identities independent quantities', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate({ identityKey: 'mp:a', displayName: 'A' }),
      { idFactory: () => 'ja' }
    );
    await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate({ identityKey: 'mp:b', displayName: 'B' }),
      { idFactory: () => 'jb' }
    );
    await incrementShoppingListItemQuantityWithDb(db, 'ja');
    const listed = await listShoppingListItemsWithDb(db);
    expect(listed.find((i) => i.id === 'ja')?.quantity).toBe(2);
    expect(listed.find((i) => i.id === 'jb')?.quantity).toBe(1);
  });

  it('K — manual duplicates remain independent', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, '牛奶', { idFactory: () => 'k1' });
    await addManualShoppingListItemWithDb(db, '牛奶', { idFactory: () => 'k2' });
    await incrementShoppingListItemQuantityWithDb(db, 'k1');
    const listed = await listShoppingListItemsWithDb(db);
    expect(listed).toHaveLength(2);
    expect(listed.find((i) => i.id === 'k1')?.quantity).toBe(2);
    expect(listed.find((i) => i.id === 'k2')?.quantity).toBe(1);
  });

  it('L/M — complete/uncomplete preserves quantity', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, '鶏砂肝', {
      idFactory: () => 'lm',
      now: FIXED_NOW,
    });
    await incrementShoppingListItemQuantityWithDb(db, 'lm', LATER);
    await incrementShoppingListItemQuantityWithDb(db, 'lm', EVEN_LATER);
    const completed = await toggleShoppingListItemCompletedWithDb(
      db,
      'lm',
      () => new Date('2026-09-04T18:00:00.000Z')
    );
    expect(completed.status).toBe('toggled');
    if (completed.status === 'toggled') {
      expect(completed.item.isCompleted).toBe(true);
      expect(completed.item.quantity).toBe(3);
    }
    const active = await toggleShoppingListItemCompletedWithDb(
      db,
      'lm',
      () => new Date('2026-09-04T19:00:00.000Z')
    );
    expect(active.status).toBe('toggled');
    if (active.status === 'toggled') {
      expect(active.item.isCompleted).toBe(false);
      expect(active.item.quantity).toBe(3);
    }
  });

  it('N — complete ×3 then re-add → new active ×1', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'n-old',
      now: FIXED_NOW,
    });
    await incrementShoppingListItemQuantityWithDb(db, 'n-old', LATER);
    await incrementShoppingListItemQuantityWithDb(db, 'n-old', EVEN_LATER);
    await toggleShoppingListItemCompletedWithDb(
      db,
      'n-old',
      () => new Date('2026-09-04T18:00:00.000Z')
    );
    const again = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate(),
      {
        idFactory: () => 'n-new',
        now: () => new Date('2026-09-04T19:00:00.000Z'),
      }
    );
    expect(again.status).toBe('created');
    if (again.status !== 'created') return;
    expect(again.item.quantity).toBe(1);
    expect(db.rows.get('n-old')?.status).toBe('completed');
    expect(
      effectiveShoppingListQuantity(db.rows.get('n-old')!.desired_quantity)
    ).toBe(3);
  });
});

describe('Shopping List Quantity V0 Home / UI wiring', () => {
  it('Home NP uses add-or-increment + quantity map; count is rows not sum', () => {
    const home = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    const list = fs.readFileSync(
      path.resolve(__dirname, '../components/home/HomeNextPurchaseList.tsx'),
      'utf8'
    );
    const insights = fs.readFileSync(
      path.resolve(__dirname, '../components/ProgressiveHomeInsights.tsx'),
      'utf8'
    );
    expect(home).toContain('activeShoppingListQuantities');
    expect(home).toContain("result.status === 'incremented'");
    expect(home).not.toMatch(
      /if \(activeShoppingListIdentities\.has\(identity\)\) return/
    );
    expect(list).toContain('×${quantity}');
    expect(list).toContain('activeShoppingListQuantities');
    expect(insights).toContain('activeShoppingListQuantities');
  });

  it('quantity derives from same snapshot; latest-wins applies whole state', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'snap',
    });
    await incrementShoppingListItemQuantityWithDb(db, 'snap');
    const derived = deriveHomeShoppingListState(
      await listShoppingListItemsWithDb(db)
    );
    const key = shoppingListIdentityKey('merchant_product', 'mp:chicken-liver');
    expect(derived.incompleteCount).toBe(1);
    expect(derived.activeIdentities.has(key)).toBe(true);
    expect(derived.activeQuantities.get(key)).toBe(2);

    const generationRef = { current: 0 };
    let applied = derived;
    const r1 = (() => {
      let resolve!: (v: Awaited<ReturnType<typeof listShoppingListItemsWithDb>>) => void;
      const promise = new Promise<
        Awaited<ReturnType<typeof listShoppingListItemsWithDb>>
      >((res) => {
        resolve = res;
      });
      return { promise, resolve };
    })();
    let calls = 0;
    const p1 = runHomeShoppingListRefresh({
      generationRef,
      loadItems: () => {
        calls += 1;
        return calls === 1
          ? r1.promise
          : listShoppingListItemsWithDb(db);
      },
      apply: (state) => {
        applied = state;
      },
    });
    await toggleShoppingListItemCompletedWithDb(db, 'snap', LATER);
    const p2 = runHomeShoppingListRefresh({
      generationRef,
      loadItems: () => listShoppingListItemsWithDb(db),
      apply: (state) => {
        applied = state;
      },
    });
    await p2;
    expect(applied.incompleteCount).toBe(0);
    expect(applied.activeQuantities.size).toBe(0);
    r1.resolve([
      {
        id: 'stale',
        text: '鶏砂肝',
        quantity: 2,
        isCompleted: false,
        completedAt: null,
        createdAt: 1,
        updatedAt: 1,
        sourceType: 'next_purchase',
        sourceIdentityKind: 'merchant_product',
        sourceIdentityKey: 'mp:chicken-liver',
      },
    ]);
    await expect(p1).resolves.toBe('stale');
    expect(applied.incompleteCount).toBe(0);
    expect(applied.activeQuantities.size).toBe(0);
  });

  it('Shopping List screen exposes stepper; completed has no +/-', () => {
    const screen = fs.readFileSync(
      path.resolve(__dirname, '../app/shopping-list.tsx'),
      'utf8'
    );
    expect(screen).toContain('incrementShoppingListItemQuantity');
    expect(screen).toContain('decrementShoppingListItemQuantity');
    expect(screen).toContain('SHOPPING_LIST_QUANTITY_MIN');
    expect(screen).toContain('SHOPPING_LIST_QUANTITY_MAX');
    expect(screen).toContain('!item.isCompleted ? (');
    expect(screen).toContain('canAddManual');
    expect(screen).toContain('×${item.quantity}');
  });

  it('no schema migration / local-only quantity', () => {
    const schema = fs.readFileSync(
      path.resolve(__dirname, 'shoppingIntentSchema.ts'),
      'utf8'
    );
    const list = fs.readFileSync(
      path.resolve(__dirname, 'shoppingList.ts'),
      'utf8'
    );
    const repo = fs.readFileSync(
      path.resolve(__dirname, 'shoppingIntentRepository.ts'),
      'utf8'
    );
    expect(schema).toContain('desired_quantity REAL');
    expect(list).toMatch(/desiredQuantity: SHOPPING_LIST_QUANTITY_MIN/);
    expect(list).not.toMatch(/from ['"].*syncOutbox|enqueueSync/i);
    expect(repo).toContain("SHOPPING_LIST_QUANTITY_MAX_FINITE_DOUBLE_SQL = '1.7976931348623157e308'");
    expect(repo).toContain('WHEN desired_quantity IS NULL THEN ?');
    expect(repo).toContain(
      'WHEN desired_quantity > ${SHOPPING_LIST_QUANTITY_MAX_FINITE_DOUBLE_SQL} THEN ?'
    );
    expect(repo).toContain(
      'WHEN desired_quantity < -${SHOPPING_LIST_QUANTITY_MAX_FINITE_DOUBLE_SQL} THEN ?'
    );
    expect(repo).toContain('CAST(desired_quantity AS INTEGER)');
  });
});
