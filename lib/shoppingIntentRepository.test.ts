/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  archiveShoppingIntentWithDb,
  completeShoppingIntentWithDb,
  createMemoryShoppingIntentDatabase,
  createShoppingIntentWithDb,
  deleteShoppingIntentWithDb,
  getShoppingIntentWithDb,
  listShoppingIntentsWithDb,
  updateShoppingIntentWithDb,
} from './shoppingIntentRepository';

const FIXED_NOW = () => new Date('2026-08-22T05:00:00.000Z');

describe('ShoppingIntent repository (M1-D)', () => {
  it('A — create rawText="牛奶" persists exactly', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const intent = await createShoppingIntentWithDb(db, {
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'intent-milk-1',
    });
    expect(intent.rawText).toBe('牛奶');
    const loaded = await getShoppingIntentWithDb(db, intent.id);
    expect(loaded?.rawText).toBe('牛奶');
  });

  it('B — two identical rawText intents get different IDs', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const a = await createShoppingIntentWithDb(db, {
      rawText: '牛奶',
      idFactory: () => 'id-a',
      now: FIXED_NOW,
    });
    const b = await createShoppingIntentWithDb(db, {
      rawText: '牛奶',
      idFactory: () => 'id-b',
      now: FIXED_NOW,
    });
    expect(a.id).not.toBe(b.id);
  });

  it('C — unresolved intent saves successfully', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const intent = await createShoppingIntentWithDb(db, {
      rawText: '周末买点火锅用的东西',
      now: FIXED_NOW,
      idFactory: () => 'intent-hotpot',
    });
    expect(intent.rawText).toBe('周末买点火锅用的东西');
  });

  it('I — complete persists completedAt without inventing receipt rows', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await createShoppingIntentWithDb(db, {
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'complete-1',
    });
    const completed = await completeShoppingIntentWithDb(
      db,
      'complete-1',
      () => new Date('2026-08-22T06:00:00.000Z')
    );
    expect(completed?.status).toBe('completed');
    expect(completed?.completedAt).toBe('2026-08-22T06:00:00.000Z');
    expect([...db.rows.keys()]).toEqual(['complete-1']);
  });

  it('J — archive persists without touching receipts', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await createShoppingIntentWithDb(db, {
      rawText: '鸡蛋',
      now: FIXED_NOW,
      idFactory: () => 'arch-1',
    });
    const archived = await archiveShoppingIntentWithDb(db, 'arch-1', FIXED_NOW);
    expect(archived?.status).toBe('archived');
    expect([...db.rows.keys()]).toEqual(['arch-1']);
  });

  it('K — delete is deterministic physical delete', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await createShoppingIntentWithDb(db, {
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'del-1',
    });
    expect(await deleteShoppingIntentWithDb(db, 'del-1')).toBe(true);
    expect(await getShoppingIntentWithDb(db, 'del-1')).toBeNull();
    expect(await deleteShoppingIntentWithDb(db, 'del-1')).toBe(false);
  });

  it('L — list only active intents when requested', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await createShoppingIntentWithDb(db, {
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'active-1',
    });
    await createShoppingIntentWithDb(db, {
      rawText: '面包',
      now: () => new Date('2026-08-22T05:01:00.000Z'),
      idFactory: () => 'active-2',
    });
    await completeShoppingIntentWithDb(
      db,
      'active-2',
      () => new Date('2026-08-22T05:02:00.000Z')
    );
    const active = await listShoppingIntentsWithDb(db, { status: 'active' });
    expect(active.map((row) => row.id)).toEqual(['active-1']);
  });

  it('M — rawText survives persisted resolution updates', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await createShoppingIntentWithDb(db, {
      rawText: '明治牛乳 两盒',
      now: FIXED_NOW,
      idFactory: () => 'raw-1',
    });
    const updated = await updateShoppingIntentWithDb(db, 'raw-1', {
      manualResolution: { familyKey: 'milk' },
      now: () => new Date('2026-08-22T07:00:00.000Z'),
    });
    expect(updated?.rawText).toBe('明治牛乳 两盒');
    expect(updated?.resolution?.resolutionSource).toBe('manual');
    expect(updated?.resolution?.familyKey).toBe('milk');
  });
});
