/**
 * Shopping Loop — Shopping List → Scan wiring.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { buildShoppingListItemProductDetailHref } from './shoppingList';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

describe('Shopping Loop — Shopping List Scan CTA', () => {
  it('A — Shopping List exposes Scan CTA via shared launcher', () => {
    const screen = read('app/shopping-list.tsx');
    const launcher = read('hooks/useReceiptScanLauncher.ts');
    expect(screen).toContain('useReceiptScanLauncher');
    expect(screen).toContain('launchReceiptScan');
    expect(screen).toContain("t('shoppingList.scanReceipt')");
    expect(screen).toContain('styles.scanReceiptCta');
    expect(screen).toContain('onPress={launchReceiptScan}');
    expect(launcher).toContain('runScanPipelineToReview');
    expect(launcher).toContain('allowsMultipleSelection: true');
  });

  it('B — Scan CTA does not inject Shopping List / product identity', () => {
    const screen = read('app/shopping-list.tsx');
    const scanBlock = screen.slice(
      screen.indexOf('onPress={launchReceiptScan}'),
      screen.indexOf('styles.scanReceiptCtaText')
    );
    expect(scanBlock).not.toContain('sourceIdentityKind');
    expect(scanBlock).not.toContain('sourceIdentityKey');
    expect(scanBlock).not.toContain('merchant_product');
    expect(scanBlock).not.toContain('personal_product');
    expect(scanBlock).not.toContain('identityKind');
    expect(scanBlock).not.toContain('identityKey');
    // Launcher call has no arguments / identity payload.
    expect(screen).toMatch(/onPress=\{launchReceiptScan\}/);
    expect(screen).not.toMatch(/launchReceiptScan\s*\(/);
  });

  it('C — Scan does not auto-complete or mutate Shopping List intents', () => {
    const screen = read('app/shopping-list.tsx');
    const launcher = read('hooks/useReceiptScanLauncher.ts');
    expect(screen).not.toContain('completeShoppingIntent');
    expect(launcher).not.toContain('completeShoppingIntent');
    expect(launcher).not.toContain('deleteShoppingListItem');
    expect(launcher).not.toContain('toggleShoppingListItemCompleted');
    // Screen still uses toggle only for explicit checkbox presses.
    expect(screen).toContain('toggleShoppingListItemCompleted');
    expect(screen).toContain('accessibilityRole="checkbox"');
  });

  it('D — Product Detail navigation for trusted rows remains unchanged', () => {
    const screen = read('app/shopping-list.tsx');
    expect(screen).toContain('buildShoppingListItemProductDetailHref');
    expect(screen).toContain('onOpenProductDetail');
    expect(screen).toContain("t('shoppingList.openProductDetailA11y'");
  });

  it('E — Manual items without trusted identity still cannot open Detail', () => {
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      })
    ).toBeNull();
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: 'merchant_product',
        sourceIdentityKey: 'mp:milk',
      })
    ).toBe('/product/merchant_product?key=mp%3Amilk');
  });

  it('F — locales include shoppingList.scanReceipt (zh/ja/en)', () => {
    for (const locale of [
      ['zh', '扫描小票'],
      ['ja', 'レシートをスキャン'],
      ['en', 'Scan Receipt'],
    ] as const) {
      const json = JSON.parse(read(`locales/${locale[0]}.json`));
      expect(json.shoppingList.scanReceipt).toBe(locale[1]);
    }
  });
});
