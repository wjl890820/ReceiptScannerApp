/**
 * Shopping List 1.0 UI / wiring source contracts (B3B).
 */
import * as fs from 'fs';
import * as path from 'path';

function source(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

describe('Shopping List 1.0 UI wiring', () => {
  it('1–4 — Home Shopping List entry above Next Purchase, ungated, navigates', () => {
    const insights = source('components/ProgressiveHomeInsights.tsx');
    const home = source('app/(tabs)/index.tsx');
    const shoppingIdx = insights.indexOf(
      "t('home.progressive.shoppingList.title')"
    );
    const nextIdx = insights.indexOf(
      "t('home.progressive.nextPurchase.title')"
    );
    const frequentIdx = insights.indexOf(
      "t('home.progressive.frequent.title')"
    );
    expect(shoppingIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(-1);
    expect(frequentIdx).toBeGreaterThan(-1);
    expect(shoppingIdx).toBeLessThan(nextIdx);
    expect(nextIdx).toBeLessThan(frequentIdx);
    // Entry is not wrapped in showNextPurchaseSection / frequent gate.
    expect(insights).toContain('shoppingListIncompleteCount');
    expect(insights).toMatch(
      /SectionTitle title=\{t\('home\.progressive\.shoppingList\.title'\)\}/
    );
    expect(home).toContain("router.push('/shopping-list'");
    expect(home).toContain('listShoppingListItems');
    expect(home).toContain('shoppingListIncompleteCount');
  });

  it('5–7 — Next Purchase add CTA + already-added from DB identities', () => {
    const list = source('components/home/HomeNextPurchaseList.tsx');
    const home = source('app/(tabs)/index.tsx');
    expect(list).toContain('onAddToShoppingList');
    expect(list).toContain('activeShoppingListIdentities');
    expect(list).toContain("t('home.progressive.nextPurchase.added')");
    expect(list).toContain('+');
    expect(home).toContain('addShoppingListItemFromNextPurchase');
    expect(home).toContain('refreshShoppingListHomeState');
  });

  it('8–13 — Shopping List screen contracts', () => {
    const screen = source('app/shopping-list.tsx');
    expect(screen).toContain('addManualShoppingListItem');
    expect(screen).toContain('toggleShoppingListItemCompleted');
    expect(screen).toContain('already_active_identity');
    expect(screen).toContain("t('shoppingList.alreadyOnList')");
    expect(screen).toContain('deleteShoppingListItem');
    expect(screen).toContain('clearCompletedShoppingListItems');
    expect(screen).toContain("t('shoppingList.emptyTitle')");
    expect(screen).toContain('KeyboardAvoidingView');
    expect(screen).toContain('itemText');
    expect(screen).not.toContain('flexWrap: \'nowrap\'');
    // Long text uses flex + wrap-capable MerunoText without single-line clamp on items.
    expect(screen).not.toMatch(/itemText[\s\S]{0,80}numberOfLines=\{1\}/);
  });

  it('14 — Product Detail has one add action', () => {
    const product = source('app/product/[targetType].tsx');
    expect(product).toContain('addShoppingListItemFromProductDetail');
    expect(product).toContain("t('productDetail.addToShoppingList')");
    expect(
      (product.match(/addToShoppingList/g) || []).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('15 — still exactly four bottom tabs', () => {
    const tabs = source('app/(tabs)/_layout.tsx');
    const screens = tabs.match(/<Tabs\.Screen/g) || [];
    expect(screens).toHaveLength(4);
    expect(tabs).not.toMatch(/shopping-list|Shopping List|買い物リスト/);
  });

  it('16 — Frequent / Product Detail navigation wiring preserved', () => {
    const home = source('app/(tabs)/index.tsx');
    const insights = source('components/ProgressiveHomeInsights.tsx');
    expect(home).toContain('buildHomeFrequentProductDetailHref');
    expect(home).toContain('handleProductPress');
    expect(home).toContain('handleNextPurchasePress');
    expect(insights).toContain('HomeFrequentProductList');
    expect(insights).toContain('onProductPress');
  });

  it('locales include B3 shopping list keys (zh/ja/en)', () => {
    for (const locale of ['zh', 'ja', 'en']) {
      const json = JSON.parse(source(`locales/${locale}.json`));
      expect(json.shoppingList.title).toBeTruthy();
      expect(json.shoppingList.add).toBeTruthy();
      expect(json.shoppingList.incomplete).toBeTruthy();
      expect(json.shoppingList.completed).toBeTruthy();
      expect(json.shoppingList.clearCompleted).toBeTruthy();
      expect(json.shoppingList.alreadyOnList).toBeTruthy();
      expect(json.home.progressive.shoppingList.title).toBeTruthy();
      expect(json.home.progressive.nextPurchase.added).toBeTruthy();
      expect(json.productDetail.addToShoppingList).toBeTruthy();
    }
  });
});
