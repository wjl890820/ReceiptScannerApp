/**
 * Shopping Loop — Frequent Products → Shopping List add action.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import type { MilestoneFrequentProduct } from './engagementMilestones';
import { createMemoryShoppingIntentDatabase } from './shoppingIntentRepository';
import {
  addShoppingListItemFromProductDetailWithDb,
  isTrustedShoppingListIdentity,
  listShoppingListItemsWithDb,
  shoppingListIdentityKey,
} from './shoppingList';
import { buildHomeFrequentProductDetailHref } from './homeValueHierarchy';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

function frequentProduct(
  overrides: Partial<MilestoneFrequentProduct> &
    Pick<MilestoneFrequentProduct, 'groupingType' | 'key' | 'displayLabel'>
): MilestoneFrequentProduct {
  return {
    displayLabelKey: null,
    purchaseOccurrenceCount: 3,
    totalPurchaseQuantity: 3,
    lastPurchasedAt: 1,
    priceSummary: null,
    ...overrides,
  };
}

describe('Shopping Loop — Frequent → Shopping List', () => {
  it('A — merchant_product frequent add uses history source + trusted persistence', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const product = frequentProduct({
      groupingType: 'merchant_product',
      key: 'mp:milk',
      displayLabel: 'Milk',
    });
    expect(isTrustedShoppingListIdentity(product.groupingType, product.key)).toBe(
      true
    );
    const created = await addShoppingListItemFromProductDetailWithDb(db, {
      displayName: product.displayLabel,
      identityKind: 'merchant_product',
      identityKey: product.key,
    });
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    expect(created.item.sourceType).toBe('history');
    expect(created.item.sourceIdentityKind).toBe('merchant_product');
    expect(created.item.sourceIdentityKey).toBe('mp:milk');
  });

  it('B — personal_product frequent add is trusted', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const product = frequentProduct({
      groupingType: 'personal_product',
      key: 'mp-anchor-cola',
      displayLabel: 'Cola',
    });
    const created = await addShoppingListItemFromProductDetailWithDb(db, {
      displayName: product.displayLabel,
      identityKind: 'personal_product',
      identityKey: product.key,
    });
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    expect(created.item.sourceType).toBe('history');
    expect(created.item.sourceIdentityKind).toBe('personal_product');
  });

  it('C — unsupported grouping types fail closed for shopping add', () => {
    for (const groupingType of ['canonical', 'family', 'sku'] as const) {
      expect(
        isTrustedShoppingListIdentity(groupingType, 'some-key')
      ).toBe(false);
    }
    const list = read('components/home/HomeFrequentProductList.tsx');
    expect(list).toContain('isTrustedShoppingListIdentity');
    expect(list).toContain('onAddToShoppingList');
  });

  it('D — already-on-list does not create a duplicate trusted row', async () => {
    const db = createMemoryShoppingIntentDatabase();
    const input = {
      displayName: 'Milk',
      identityKind: 'merchant_product' as const,
      identityKey: 'mp:milk',
    };
    const first = await addShoppingListItemFromProductDetailWithDb(db, input, {
      idFactory: () => 'id-1',
    });
    expect(first.status).toBe('created');
    const second = await addShoppingListItemFromProductDetailWithDb(db, input, {
      idFactory: () => 'id-2',
    });
    expect(second.status).toBe('already_exists');
    if (second.status === 'already_exists') {
      expect(second.item.id).toBe('id-1');
    }
    expect(await listShoppingListItemsWithDb(db)).toHaveLength(1);
    expect(
      shoppingListIdentityKey('merchant_product', 'mp:milk')
    ).toBe('merchant_product:mp:milk');
  });

  it('E — main row still uses trusted Product Detail href', () => {
    expect(
      buildHomeFrequentProductDetailHref({
        groupingType: 'merchant_product',
        key: 'mp:milk',
      })
    ).toBe('/product/merchant_product?key=mp%3Amilk');
    expect(
      buildHomeFrequentProductDetailHref({
        groupingType: 'personal_product',
        key: 'mp-anchor',
      })
    ).toBe('/product/personal_product?key=mp-anchor');
    const home = read('app/(tabs)/index.tsx');
    expect(home).toContain('buildHomeFrequentProductDetailHref');
    expect(home).toContain('handleProductPress');
  });

  it('F — Add control is separate from row Product Detail press', () => {
    const list = read('components/home/HomeFrequentProductList.tsx');
    expect(list).toContain('styles.contentHit');
    expect(list).toContain('onPress={() => onPress(product)}');
    expect(list).toContain('onAddToShoppingList?.(product)');
    expect(list).not.toMatch(
      /MerunoGroupedRow[\s\S]{0,200}onPress=\{\(\) => onPress\(product\)\}/
    );
  });

  it('G — no completion / purchased / scan reconciliation mutation', () => {
    const home = read('app/(tabs)/index.tsx');
    const list = read('components/home/HomeFrequentProductList.tsx');
    expect(home).toContain('addShoppingListItemFromProductDetail');
    expect(home).not.toContain('completeShoppingIntent');
    expect(list).not.toContain('completeShoppingIntent');
    expect(list).not.toContain('toggleShoppingListItemCompleted');
    expect(home).not.toMatch(
      /handleAddFrequentProductToShoppingList[\s\S]{0,800}completeShoppingIntent/
    );
  });

  it('H — Frequent add uses Product Detail history path (not next_purchase)', () => {
    const home = read('app/(tabs)/index.tsx');
    expect(home).toContain('addShoppingListItemFromProductDetail');
    const addFn = read('lib/shoppingList.ts');
    const detailIdx = addFn.indexOf(
      'export async function addShoppingListItemFromProductDetailWithDb'
    );
    const slice = addFn.slice(detailIdx, detailIdx + 500);
    expect(slice).toContain("sourceType: 'history'");
    expect(slice).not.toContain("sourceType: 'next_purchase'");
  });

  it('I — Home wires Frequent add + active list identities', () => {
    const home = read('app/(tabs)/index.tsx');
    const insights = read('components/ProgressiveHomeInsights.tsx');
    expect(home).toContain('handleAddFrequentProductToShoppingList');
    expect(home).toContain('onAddFrequentProductToShoppingList');
    expect(insights).toContain('onAddFrequentProductToShoppingList');
    expect(insights).toContain('activeShoppingListIdentities');
  });

  it('J — locales include frequent add / on-list keys', () => {
    for (const locale of ['zh', 'ja', 'en']) {
      const json = JSON.parse(read(`locales/${locale}.json`));
      expect(json.home.progressive.frequent.add).toBeTruthy();
      expect(json.home.progressive.frequent.added).toBeTruthy();
      expect(json.home.progressive.frequent.addA11y).toBeTruthy();
      expect(json.home.progressive.frequent.addedA11y).toBeTruthy();
    }
  });
});
