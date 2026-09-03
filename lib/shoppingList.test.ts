/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

/**
 * Shopping List 1.0 domain/repository contract tests (B3B).
 */

import { createMemoryShoppingIntentDatabase } from './shoppingIntentRepository';
import {
  addManualShoppingListItemWithDb,
  addShoppingListItemFromNextPurchaseWithDb,
  addShoppingListItemFromProductDetailWithDb,
  clearCompletedShoppingListItemsWithDb,
  deleteShoppingListItemWithDb,
  getActiveShoppingListIdentitySetWithDb,
  listShoppingListItemsWithDb,
  mapShoppingIntentRowToListItem,
  shoppingListIdentityKey,
  sortShoppingListItems,
  toggleShoppingListItemCompletedWithDb,
  type ShoppingListItem,
} from './shoppingList';

const FIXED_NOW = () => new Date('2026-09-03T10:00:00.000Z');
const LATER = () => new Date('2026-09-03T11:00:00.000Z');
const EVEN_LATER = () => new Date('2026-09-03T12:00:00.000Z');

function candidate(
  overrides: Partial<{
    displayName: string;
    identityKind: 'merchant_product' | 'personal_product';
    identityKey: string;
  }> = {}
) {
  return {
    displayName: overrides.displayName ?? '牛乳1L',
    identityKind: overrides.identityKind ?? ('merchant_product' as const),
    identityKey: overrides.identityKey ?? 'mp:milk-1l',
  };
}

describe('Shopping List 1.0 domain', () => {
  it('A — manual add trims and persists', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const result = await addManualShoppingListItemWithDb(db, '  牛乳  ', {
      now: FIXED_NOW,
      idFactory: () => 'manual-1',
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.item.text).toBe('牛乳');
    expect(result.item.sourceType).toBe('manual');
    expect(result.item.sourceIdentityKind).toBeNull();
    expect(result.item.sourceIdentityKey).toBeNull();
    expect(result.item.isCompleted).toBe(false);
  });

  it('B — blank rejection', async () => {
    const db = createMemoryShoppingIntentDatabase();
    expect(
      (await addManualShoppingListItemWithDb(db, '')).status
    ).toBe('rejected');
    expect(
      (await addManualShoppingListItemWithDb(db, '   ')).status
    ).toBe('rejected');
    expect(db.rows.size).toBe(0);
  });

  it('C — manual duplicate text allowed', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const a = await addManualShoppingListItemWithDb(db, '牛乳', {
      idFactory: () => 'm1',
      now: FIXED_NOW,
    });
    const b = await addManualShoppingListItemWithDb(db, '牛乳', {
      idFactory: () => 'm2',
      now: LATER,
    });
    expect(a.status).toBe('created');
    expect(b.status).toBe('created');
    expect(db.rows.size).toBe(2);
  });

  it('D — reload persistence', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, 'えのき', {
      idFactory: () => 'persist-1',
      now: FIXED_NOW,
    });
    const listed = await listShoppingListItemsWithDb(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.text).toBe('えのき');
    expect(listed[0]?.id).toBe('persist-1');
  });

  it('E — complete sets completedAt', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, 'もやし', {
      idFactory: () => 'toggle-1',
      now: FIXED_NOW,
    });
    const toggled = await toggleShoppingListItemCompletedWithDb(
      db,
      'toggle-1',
      LATER
    );
    expect(toggled.status).toBe('toggled');
    if (toggled.status !== 'toggled') return;
    expect(toggled.item.isCompleted).toBe(true);
    expect(toggled.item.completedAt).toBe(Date.parse('2026-09-03T11:00:00.000Z'));
  });

  it('F — uncomplete clears completedAt', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, 'もやし', {
      idFactory: () => 'toggle-2',
      now: FIXED_NOW,
    });
    await toggleShoppingListItemCompletedWithDb(db, 'toggle-2', LATER);
    const toggled = await toggleShoppingListItemCompletedWithDb(
      db,
      'toggle-2',
      EVEN_LATER
    );
    expect(toggled.status).toBe('toggled');
    if (toggled.status !== 'toggled') return;
    expect(toggled.item.isCompleted).toBe(false);
    expect(toggled.item.completedAt).toBeNull();
  });

  it('G — delete removes only target', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, 'a', {
      idFactory: () => 'del-a',
      now: FIXED_NOW,
    });
    await addManualShoppingListItemWithDb(db, 'b', {
      idFactory: () => 'del-b',
      now: LATER,
    });
    expect(await deleteShoppingListItemWithDb(db, 'del-a')).toBe(true);
    const listed = await listShoppingListItemsWithDb(db);
    expect(listed.map((item) => item.id)).toEqual(['del-b']);
  });

  it('H — clear completed leaves incomplete', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, 'keep', {
      idFactory: () => 'keep-1',
      now: FIXED_NOW,
    });
    await addManualShoppingListItemWithDb(db, 'done', {
      idFactory: () => 'done-1',
      now: LATER,
    });
    await toggleShoppingListItemCompletedWithDb(db, 'done-1', EVEN_LATER);
    expect(await clearCompletedShoppingListItemsWithDb(db)).toBe(1);
    expect(await clearCompletedShoppingListItemsWithDb(db)).toBe(0);
    const listed = await listShoppingListItemsWithDb(db);
    expect(listed.map((item) => item.id)).toEqual(['keep-1']);
  });

  it('I — sorting incomplete ASC / completed DESC with id tie-break', () => {
    const items: ShoppingListItem[] = [
      {
        id: 'c-b',
        text: 'cb',
        isCompleted: true,
        completedAt: 200,
        createdAt: 1,
        updatedAt: 200,
        sourceType: 'manual',
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      },
      {
        id: 'c-a',
        text: 'ca',
        isCompleted: true,
        completedAt: 200,
        createdAt: 1,
        updatedAt: 200,
        sourceType: 'manual',
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      },
      {
        id: 'i-b',
        text: 'ib',
        isCompleted: false,
        completedAt: null,
        createdAt: 10,
        updatedAt: 10,
        sourceType: 'manual',
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      },
      {
        id: 'i-a',
        text: 'ia',
        isCompleted: false,
        completedAt: null,
        createdAt: 10,
        updatedAt: 10,
        sourceType: 'manual',
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      },
      {
        id: 'i-old',
        text: 'old',
        isCompleted: false,
        completedAt: null,
        createdAt: 5,
        updatedAt: 5,
        sourceType: 'manual',
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      },
      {
        id: 'c-new',
        text: 'cnew',
        isCompleted: true,
        completedAt: 300,
        createdAt: 1,
        updatedAt: 300,
        sourceType: 'manual',
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      },
    ];
    expect(sortShoppingListItems(items).map((item) => item.id)).toEqual([
      'i-old',
      'i-a',
      'i-b',
      'c-new',
      'c-a',
      'c-b',
    ]);
  });

  it('J — Next Purchase trusted add persists snapshot + provenance', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const result = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate({ displayName: '牛乳1L' }),
      { idFactory: () => 'np-1', now: FIXED_NOW }
    );
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.item.text).toBe('牛乳1L');
    expect(result.item.sourceType).toBe('next_purchase');
    expect(result.item.sourceIdentityKind).toBe('merchant_product');
    expect(result.item.sourceIdentityKey).toBe('mp:milk-1l');
  });

  it('K — Next Purchase duplicate active trusted identity is no-op', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const first = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate(),
      { idFactory: () => 'np-dup-1', now: FIXED_NOW }
    );
    const second = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate({ displayName: '牛乳1L（別名）' }),
      { idFactory: () => 'np-dup-2', now: LATER }
    );
    expect(first.status).toBe('created');
    expect(second.status).toBe('already_exists');
    if (second.status !== 'already_exists') return;
    expect(second.item.id).toBe('np-dup-1');
    expect(db.rows.size).toBe(1);
  });

  it('L — completed same identity allows new active row', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'np-old',
      now: FIXED_NOW,
    });
    await toggleShoppingListItemCompletedWithDb(db, 'np-old', LATER);
    const again = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate(),
      { idFactory: () => 'np-new', now: EVEN_LATER }
    );
    expect(again.status).toBe('created');
    if (again.status !== 'created') return;
    expect(again.item.id).toBe('np-new');
    expect(db.rows.size).toBe(2);
  });

  it('M — spec isolation: 1L != 500ml', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const a = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate({
        displayName: '牛乳1L',
        identityKey: 'mp:milk-1l',
      }),
      { idFactory: () => 'spec-1l', now: FIXED_NOW }
    );
    const b = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate({
        displayName: '牛乳500ml',
        identityKey: 'mp:milk-500ml',
      }),
      { idFactory: () => 'spec-500', now: LATER }
    );
    expect(a.status).toBe('created');
    expect(b.status).toBe('created');
    expect(db.rows.size).toBe(2);
  });

  it('N — personal_product provenance + exact dedupe', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const first = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate({
        displayName: '我家牛奶',
        identityKind: 'personal_product',
        identityKey: 'pp:milk-home',
      }),
      { idFactory: () => 'pp-1', now: FIXED_NOW }
    );
    const second = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate({
        displayName: '我家牛奶',
        identityKind: 'personal_product',
        identityKey: 'pp:milk-home',
      }),
      { idFactory: () => 'pp-2', now: LATER }
    );
    expect(first.status).toBe('created');
    expect(second.status).toBe('already_exists');
    if (first.status !== 'created') return;
    expect(first.item.sourceIdentityKind).toBe('personal_product');
    expect(first.item.sourceIdentityKey).toBe('pp:milk-home');
  });

  it('O — Product Detail trusted identity uses history + provenance', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const result = await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: '明治牛乳',
        identityKind: 'merchant_product',
        identityKey: 'mp:meiji',
      },
      { idFactory: () => 'pd-1', now: FIXED_NOW }
    );
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.item.sourceType).toBe('history');
    expect(result.item.sourceIdentityKind).toBe('merchant_product');
    expect(result.item.sourceIdentityKey).toBe('mp:meiji');
  });

  it('P — Product Detail unsafe identity stores text-only null provenance', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const result = await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: '牛奶家族',
        identityKind: null,
        identityKey: null,
      },
      { idFactory: () => 'pd-unsafe', now: FIXED_NOW }
    );
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.item.text).toBe('牛奶家族');
    expect(result.item.sourceType).toBe('history');
    expect(result.item.sourceIdentityKind).toBeNull();
    expect(result.item.sourceIdentityKey).toBeNull();
  });

  it('Q — source deletion independence: persisted text still maps', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: '历史商品快照',
        identityKind: 'merchant_product',
        identityKey: 'mp:gone',
      },
      { idFactory: () => 'src-indep', now: FIXED_NOW }
    );
    // Simulate source receipt/product disappearance: list still renders from row.
    const listed = await listShoppingListItemsWithDb(db);
    expect(listed[0]?.text).toBe('历史商品快照');
    const mapped = mapShoppingIntentRowToListItem(db.rows.get('src-indep')!);
    expect(mapped?.text).toBe('历史商品快照');
    expect(mapped?.isCompleted).toBe(false);
  });

  it('R — local-only: facade does not touch sync_outbox / supabase', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, 'shoppingList.ts'),
      'utf8'
    );
    expect(source).toMatch(/LOCAL-ONLY/);
    expect(source).not.toMatch(
      /from ['"].*syncOutbox|from ['"].*cloudBackup|from ['"]@?supabase|enqueueSync|sync_outbox/i
    );
    expect(source).not.toMatch(
      /(?:import|require)\([^)]*supabase/i
    );
  });

  it('S — cold reload preserves active/completed state', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, 'active', {
      idFactory: () => 'cold-a',
      now: FIXED_NOW,
    });
    await addManualShoppingListItemWithDb(db, 'done', {
      idFactory: () => 'cold-d',
      now: LATER,
    });
    await toggleShoppingListItemCompletedWithDb(db, 'cold-d', EVEN_LATER);

    // "Cold reload" = re-list from same persisted rows without React state.
    const listed = await listShoppingListItemsWithDb(db);
    expect(listed.find((item) => item.id === 'cold-a')?.isCompleted).toBe(false);
    expect(listed.find((item) => item.id === 'cold-d')?.isCompleted).toBe(true);
    expect(listed.find((item) => item.id === 'cold-d')?.completedAt).toBe(
      Date.parse('2026-09-03T12:00:00.000Z')
    );
  });

  it('D — Concurrent trusted add → one active + already_exists', async () => {
    const db = createMemoryShoppingIntentDatabase();
    let seq = 0;
    const [first, second] = await Promise.all([
      addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
        idFactory: () => `race-${++seq}`,
        now: FIXED_NOW,
      }),
      addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
        idFactory: () => `race-${++seq}`,
        now: LATER,
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['already_exists', 'created']);
    const active = [...db.rows.values()].filter(
      (row) =>
        row.status === 'active' &&
        row.source_identity_kind === 'merchant_product' &&
        row.source_identity_key === 'mp:milk-1l'
    );
    expect(active).toHaveLength(1);
  });

  it('E — Cross-source race Next Purchase vs Product Detail', async () => {
    const db = createMemoryShoppingIntentDatabase();
    let seq = 0;
    const results = await Promise.all([
      addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
        idFactory: () => `xs-${++seq}`,
        now: FIXED_NOW,
      }),
      addShoppingListItemFromProductDetailWithDb(
        db,
        {
          displayName: '牛乳1L',
          identityKind: 'merchant_product',
          identityKey: 'mp:milk-1l',
        },
        { idFactory: () => `xs-${++seq}`, now: LATER }
      ),
    ]);
    expect(results.some((r) => r.status === 'created')).toBe(true);
    expect(results.some((r) => r.status === 'already_exists')).toBe(true);
    expect(
      [...db.rows.values()].filter((row) => row.status === 'active')
    ).toHaveLength(1);
  });

  it('F — personal_product concurrent uniqueness', async () => {
    const db = createMemoryShoppingIntentDatabase();
    let seq = 0;
    const personal = {
      displayName: '我家牛奶',
      identityKind: 'personal_product' as const,
      identityKey: 'pp:milk-home',
    };
    const results = await Promise.all([
      addShoppingListItemFromNextPurchaseWithDb(db, personal, {
        idFactory: () => `pp-race-${++seq}`,
        now: FIXED_NOW,
      }),
      addShoppingListItemFromNextPurchaseWithDb(db, personal, {
        idFactory: () => `pp-race-${++seq}`,
        now: LATER,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'already_exists',
      'created',
    ]);
    expect(
      [...db.rows.values()].filter(
        (row) =>
          row.status === 'active' &&
          row.source_identity_kind === 'personal_product'
      )
    ).toHaveLength(1);
  });

  it('I/J — complete then re-add; uncomplete collision keeps A completed', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'np-old',
      now: FIXED_NOW,
    });
    const completed = await toggleShoppingListItemCompletedWithDb(
      db,
      'np-old',
      LATER
    );
    expect(completed.status).toBe('toggled');
    const again = await addShoppingListItemFromNextPurchaseWithDb(
      db,
      candidate(),
      { idFactory: () => 'np-new', now: EVEN_LATER }
    );
    expect(again.status).toBe('created');
    const collision = await toggleShoppingListItemCompletedWithDb(
      db,
      'np-old',
      () => new Date('2026-09-03T13:00:00.000Z')
    );
    expect(collision.status).toBe('already_active_identity');
    expect(db.rows.get('np-old')?.status).toBe('completed');
    expect(db.rows.get('np-new')?.status).toBe('active');
    expect(
      [...db.rows.values()].filter((row) => row.status === 'active')
    ).toHaveLength(1);
  });

  it('K — uncomplete when no collision succeeds', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'solo',
      now: FIXED_NOW,
    });
    await toggleShoppingListItemCompletedWithDb(db, 'solo', LATER);
    const result = await toggleShoppingListItemCompletedWithDb(
      db,
      'solo',
      EVEN_LATER
    );
    expect(result.status).toBe('toggled');
    if (result.status !== 'toggled') return;
    expect(result.item.isCompleted).toBe(false);
  });

  it('L — manual uncomplete allowed with identical active manual text', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addManualShoppingListItemWithDb(db, '牛乳', {
      idFactory: () => 'man-a',
      now: FIXED_NOW,
    });
    await addManualShoppingListItemWithDb(db, '牛乳', {
      idFactory: () => 'man-b',
      now: LATER,
    });
    await toggleShoppingListItemCompletedWithDb(db, 'man-a', EVEN_LATER);
    const result = await toggleShoppingListItemCompletedWithDb(
      db,
      'man-a',
      () => new Date('2026-09-03T13:00:00.000Z')
    );
    expect(result.status).toBe('toggled');
    expect(db.rows.get('man-a')?.status).toBe('active');
    expect(db.rows.get('man-b')?.status).toBe('active');
  });

  it('active identity set only includes incomplete trusted pairs', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromNextPurchaseWithDb(db, candidate(), {
      idFactory: () => 'set-1',
      now: FIXED_NOW,
    });
    await addManualShoppingListItemWithDb(db, '手动', {
      idFactory: () => 'set-m',
      now: LATER,
    });
    const set = await getActiveShoppingListIdentitySetWithDb(db);
    expect([...set]).toEqual([
      shoppingListIdentityKey('merchant_product', 'mp:milk-1l'),
    ]);
  });
});
