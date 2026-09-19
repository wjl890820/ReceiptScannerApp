/**
 * Shopping Loop Slice 2 — Product Detail → Scan wiring.
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

describe('Shopping Loop Slice 2 — Product Detail Scan', () => {
  it('A — Home uses canonical shared scan launcher', () => {
    const home = read('app/(tabs)/index.tsx');
    const launcher = read('hooks/useReceiptScanLauncher.ts');
    expect(home).toContain('useReceiptScanLauncher');
    expect(home).toContain('launchReceiptScan');
    expect(home).not.toContain('handleScanReceipt');
    expect(launcher).toContain('launchReceiptScan');
    expect(launcher).toContain('allowsMultipleSelection: true');
    expect(launcher).toContain('runScanPipelineToReview');
  });

  it('B/C — Product Detail exposes Scan CTA for trusted targets', () => {
    const detail = read('app/product/[targetType].tsx');
    expect(detail).toContain('useReceiptScanLauncher');
    expect(detail).toContain('launchReceiptScan');
    expect(detail).toContain('productDetail.scanReceipt');
    expect(detail).toContain('styles.scanReceiptCta');
  });

  it('D/E — Scan CTA is independent of Shopping List membership state', () => {
    const detail = read('app/product/[targetType].tsx');
    const ctaIdx = detail.indexOf('styles.scanReceiptCta');
    const shoppingIdx = detail.indexOf('styles.shoppingListCta');
    expect(ctaIdx).toBeGreaterThan(shoppingIdx);
    // Scan CTA is not gated on alreadyOnShoppingList / trustedShoppingIdentity.
    const scanBlock = detail.slice(
      detail.indexOf('onPress={launchReceiptScan}'),
      detail.indexOf('styles.scanReceiptCtaText')
    );
    expect(scanBlock).not.toContain('alreadyOnShoppingList');
    expect(scanBlock).not.toContain('trustedShoppingIdentity');
  });

  it('F — Scan launch has no product identity/context propagation', () => {
    const launcher = read('hooks/useReceiptScanLauncher.ts');
    expect(launcher).not.toContain('identityKind');
    expect(launcher).not.toContain('identityKey');
    expect(launcher).not.toContain('merchant_product');
    expect(launcher).not.toContain('personal_product');
    expect(launcher).not.toContain('targetType');
    expect(launcher).not.toContain('returnTo');
    expect(launcher).not.toContain('sourceProduct');
    expect(launcher).toContain('runScanPipelineToReview(uri)');
    expect(launcher).toContain('runScanPipelineToReview(uris[i]!)');
  });

  it('G — Cancel path does not mutate Shopping List APIs', () => {
    const launcher = read('hooks/useReceiptScanLauncher.ts');
    expect(launcher).not.toContain('completeShoppingIntent');
    expect(launcher).not.toContain('deleteShoppingListItem');
    expect(launcher).not.toContain('addShoppingListItem');
    expect(launcher).not.toContain('shoppingIntent');
  });

  it('H — Successful scan routes to /scan-review/:draftId', () => {
    const launcher = read('hooks/useReceiptScanLauncher.ts');
    expect(launcher).toContain('router.push(`/scan-review/${result.draftId}`');
    expect(launcher).toContain('router.push(`/scan-review/${draftIds[0]}`');
  });

  it('I — Multi-image gallery uses existing queue behavior', () => {
    const launcher = read('hooks/useReceiptScanLauncher.ts');
    expect(launcher).toContain('allowsMultipleSelection: true');
    expect(launcher).toContain('clearScanReviewQueue');
    expect(launcher).toContain('setScanReviewQueue');
    expect(launcher).toContain('processMultipleReceiptImages');
  });

  it('J — Post-save destination helper unchanged', () => {
    const nav = read('lib/postSaveSummaryNavigation.ts');
    expect(nav).toContain("return nextDraftId");
    expect(nav).toContain("'/'");
    expect(nav).toContain('/scan-review/');
  });

  it('K — Manual/untrusted Shopping List item still cannot route to Product Detail', () => {
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      })
    ).toBeNull();
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: null,
        sourceIdentityKey: 'manual-text',
      })
    ).toBeNull();
  });

  it('L — Product Detail Add/Remove Shopping List wiring remains', () => {
    const detail = read('app/product/[targetType].tsx');
    expect(detail).toContain('addShoppingListItemFromProductDetail');
    expect(detail).toContain('deleteActiveShoppingListItemByTrustedIdentity');
    expect(detail).toContain('onShoppingListCtaPress');
  });

  it('M — rapid tap guard via isScanning / scanningRef', () => {
    const launcher = read('hooks/useReceiptScanLauncher.ts');
    expect(launcher).toContain('if (scanningRef.current) return');
    const detail = read('app/product/[targetType].tsx');
    expect(detail).toContain('disabled={receiptScanning || shoppingListCtaBusy}');
  });

  it('i18n productDetail.scanReceipt exists in zh/ja/en', () => {
    for (const locale of ['zh', 'ja', 'en'] as const) {
      const json = JSON.parse(read(`locales/${locale}.json`)) as {
        productDetail: { scanReceipt?: string };
      };
      expect(typeof json.productDetail.scanReceipt).toBe('string');
      expect(json.productDetail.scanReceipt!.length).toBeGreaterThan(0);
    }
  });
});
