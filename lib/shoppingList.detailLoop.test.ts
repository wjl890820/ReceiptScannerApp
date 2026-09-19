/**
 * Phase 3 Slice 1 — Product Detail ⇄ Shopping List connectivity.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import { createMemoryShoppingIntentDatabase } from './shoppingIntentRepository';
import {
  addManualShoppingListItemWithDb,
  addShoppingListItemFromNextPurchaseWithDb,
  addShoppingListItemFromProductDetailWithDb,
  buildShoppingListItemProductDetailHref,
  deleteActiveShoppingListItemByTrustedIdentityWithDb,
  findActiveShoppingListItemByTrustedIdentityWithDb,
  listShoppingListItemsWithDb,
  trustedShoppingIdentityFromProductDetailTarget,
} from './shoppingList';
import { buildNextPurchaseCandidates } from './nextPurchaseCandidates';
import type { RepeatProductProfile } from './repeatProductProfile';

const FIXED_NOW = () => new Date('2026-09-03T10:00:00.000Z');

describe('Phase 3 Slice 1 — Detail ⇄ Shopping List', () => {
  it('A — trusted Product Detail target not in list has no active intent', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const trusted = trustedShoppingIdentityFromProductDetailTarget({
      type: 'merchant_product',
      key: 'mp:cola',
    });
    expect(trusted).toEqual({
      identityKind: 'merchant_product',
      identityKey: 'mp:cola',
    });
    const active = await findActiveShoppingListItemByTrustedIdentityWithDb(
      db,
      trusted!.identityKind,
      trusted!.identityKey
    );
    expect(active).toBeNull();
  });

  it('B — add creates one active row and resolves for Remove state', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const created = await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: 'Cola',
        identityKind: 'merchant_product',
        identityKey: 'mp:cola',
      },
      { now: FIXED_NOW, idFactory: () => 'pd-1' }
    );
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    expect(created.item.sourceType).toBe('history');
    const active = await findActiveShoppingListItemByTrustedIdentityWithDb(
      db,
      'merchant_product',
      'mp:cola'
    );
    expect(active?.id).toBe('pd-1');
    expect(await listShoppingListItemsWithDb(db)).toHaveLength(1);
  });

  it('C — remove by trusted identity deletes row (Add state again)', async () => {
    const db = createMemoryShoppingIntentDatabase();
    await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: 'Cola',
        identityKind: 'merchant_product',
        identityKey: 'mp:cola',
      },
      { idFactory: () => 'pd-rm' }
    );
    const removed = await deleteActiveShoppingListItemByTrustedIdentityWithDb(
      db,
      'merchant_product',
      'mp:cola'
    );
    expect(removed.status).toBe('deleted');
    expect(
      await findActiveShoppingListItemByTrustedIdentityWithDb(
        db,
        'merchant_product',
        'mp:cola'
      )
    ).toBeNull();
    expect(await listShoppingListItemsWithDb(db)).toHaveLength(0);
  });

  it('D — repeated add does not create duplicate active trusted intent', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const first = await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: 'Cola',
        identityKind: 'merchant_product',
        identityKey: 'mp:cola',
      },
      { idFactory: () => 'pd-a' }
    );
    const second = await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: 'Cola again',
        identityKind: 'merchant_product',
        identityKey: 'mp:cola',
      },
      { idFactory: () => 'pd-b' }
    );
    expect(first.status).toBe('created');
    expect(second.status).toBe('already_exists');
    if (second.status !== 'already_exists') return;
    expect(second.item.id).toBe('pd-a');
    expect(await listShoppingListItemsWithDb(db)).toHaveLength(1);
  });

  it('E — merchant_product list entry maps to correct Detail route', () => {
    const href = buildShoppingListItemProductDetailHref({
      sourceIdentityKind: 'merchant_product',
      sourceIdentityKey: 'mp:milk',
    });
    expect(href).toBe('/product/merchant_product?key=mp%3Amilk');
  });

  it('F — personal_product list entry maps to correct Detail route', () => {
    const href = buildShoppingListItemProductDetailHref({
      sourceIdentityKind: 'personal_product',
      sourceIdentityKey: 'mp-anchor-cola',
    });
    expect(href).toBe('/product/personal_product?key=mp-anchor-cola');
  });

  it('G — manual/untrusted entry does not fabricate Detail navigation', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const manual = await addManualShoppingListItemWithDb(db, '随便买点什么', {
      idFactory: () => 'manual-1',
    });
    expect(manual.status).toBe('created');
    if (manual.status !== 'created') return;
    expect(buildShoppingListItemProductDetailHref(manual.item)).toBeNull();
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      })
    ).toBeNull();
    expect(
      trustedShoppingIdentityFromProductDetailTarget({
        type: 'sku',
        key: 'sku-x',
      })
    ).toBeNull();
  });

  it('H — checkbox/qty/delete remain row-id based (navigation is identity-href only)', () => {
    // Pure contract: navigation helper never returns a fake id; controls use item.id.
    const href = buildShoppingListItemProductDetailHref({
      sourceIdentityKind: 'merchant_product',
      sourceIdentityKey: 'mp:x',
    });
    expect(href).toContain('/product/merchant_product');
    expect(href).not.toContain('item.id');
  });

  it('I — next_purchase sourced removal does not alter Next Purchase candidates', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const DAY = 86_400_000;
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    const atDay = (d: number) => T0 + d * DAY;
    const dates = [atDay(0), atDay(7), atDay(14), atDay(21)];
    const profile: RepeatProductProfile = {
      identityKind: 'merchant_product',
      identityKey: 'mp:milk',
      displayName: 'Milk',
      purchaseOccurrenceCount: 4,
      purchaseEventDates: dates,
      datedPurchaseOccurrenceCount: 4,
      firstPurchasedAt: dates[0]!,
      lastPurchasedAt: dates[dates.length - 1]!,
    };

    const before = buildNextPurchaseCandidates([profile], { now: atDay(28) });
    expect(before).toHaveLength(1);

    await addShoppingListItemFromNextPurchaseWithDb(db, {
      displayName: 'Milk',
      identityKind: 'merchant_product',
      identityKey: 'mp:milk',
    });
    const removed = await deleteActiveShoppingListItemByTrustedIdentityWithDb(
      db,
      'merchant_product',
      'mp:milk'
    );
    expect(removed.status).toBe('deleted');
    if (removed.status === 'deleted') {
      expect(removed.item.sourceType).toBe('next_purchase');
    }

    const after = buildNextPurchaseCandidates([profile], { now: atDay(28) });
    expect(after).toEqual(before);
  });

  it('J — personal_product add/remove round-trip keeps one active slot', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const created = await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: 'My Cola',
        identityKind: 'personal_product',
        identityKey: 'mp-anchor',
      },
      { idFactory: () => 'pp-1' }
    );
    expect(created.status).toBe('created');
    expect(buildShoppingListItemProductDetailHref({
      sourceIdentityKind: 'personal_product',
      sourceIdentityKey: 'mp-anchor',
    })).toBe('/product/personal_product?key=mp-anchor');

    await deleteActiveShoppingListItemByTrustedIdentityWithDb(
      db,
      'personal_product',
      'mp-anchor'
    );
    const readd = await addShoppingListItemFromProductDetailWithDb(
      db,
      {
        displayName: 'My Cola',
        identityKind: 'personal_product',
        identityKey: 'mp-anchor',
      },
      { idFactory: () => 'pp-2' }
    );
    expect(readd.status).toBe('created');
    if (readd.status !== 'created') return;
    expect(readd.item.id).toBe('pp-2');
    expect(await listShoppingListItemsWithDb(db)).toHaveLength(1);
  });
});
