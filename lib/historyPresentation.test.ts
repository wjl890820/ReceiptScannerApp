import * as fs from 'fs';
import * as path from 'path';

import {
  buildHistoryReceiptRowA11yLabel,
  buildHistorySearchSectionSpecs,
  buildHistorySelectModeSubtitle,
  formatHistoryMerchantDisplay,
} from './historyPresentation';

describe('formatHistoryMerchantDisplay', () => {
  it('prefers merchant_raw over merchant_normalized', () => {
    expect(
      formatHistoryMerchantDisplay(
        {
          merchant_raw: 'ヨークベニマル古川店',
          merchant_normalized: 'york benimaru',
        },
        'Unknown'
      )
    ).toBe('ヨークベニマル古川店');
  });

  it('falls back to normalized, then unknown label', () => {
    expect(
      formatHistoryMerchantDisplay(
        { merchant_raw: null, merchant_normalized: 'aeon' },
        'Unknown'
      )
    ).toBe('aeon');
    expect(
      formatHistoryMerchantDisplay(
        { merchant_raw: '  ', merchant_normalized: null },
        'Unknown'
      )
    ).toBe('Unknown');
  });

  it('never surfaces analytics-style keys from this helper', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'historyPresentation.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/merchantAnalyticsKey|retailerKey/);
  });
});

describe('buildHistorySearchSectionSpecs', () => {
  it('keeps products-before-receipts order and omits empty sides', () => {
    expect(
      buildHistorySearchSectionSpecs({
        productCount: 2,
        receiptCount: 3,
        productsTitle: 'Products',
        receiptsTitle: 'Receipts',
      })
    ).toEqual([
      { kind: 'products', title: 'Products' },
      { kind: 'receipts', title: 'Receipts' },
    ]);
    expect(
      buildHistorySearchSectionSpecs({
        productCount: 0,
        receiptCount: 1,
        productsTitle: 'Products',
        receiptsTitle: 'Receipts',
      })
    ).toEqual([{ kind: 'receipts', title: 'Receipts' }]);
  });
});

describe('history presentation helpers', () => {
  it('builds receipt row a11y labels from visible fields only', () => {
    expect(
      buildHistoryReceiptRowA11yLabel({
        merchant: 'Aeon',
        dateLine: '2026-01-02',
        totalLabel: '¥1,200',
      })
    ).toBe('Aeon, 2026-01-02, ¥1,200');
  });

  it('clarifies select-mode subtitle without changing delete semantics', () => {
    expect(
      buildHistorySelectModeSubtitle({
        selectMode: false,
        selectedCount: 0,
        defaultSubtitle: 'Your purchases',
        selectingSubtitle: '{count} selected',
      })
    ).toBe('Your purchases');
    expect(
      buildHistorySelectModeSubtitle({
        selectMode: true,
        selectedCount: 3,
        defaultSubtitle: 'Your purchases',
        selectingSubtitle: '{count} selected',
      })
    ).toBe('3 selected');
  });
});

describe('History / Receipt Detail freeze proofs (R2-B4)', () => {
  it('does not alter product-search href builder or search ranking modules', () => {
    const historyIndex = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/index.tsx'),
      'utf8'
    );
    expect(historyIndex).toContain('buildProductSearchResultHref');
    expect(historyIndex).toContain('performHistoryPurchaseSearch');
    expect(historyIndex).toContain('searchHistoryPurchases');
    expect(historyIndex).not.toMatch(/merchantAnalyticsKey/);
  });

  it('keeps Receipt Detail edit and Product Detail actions separate', () => {
    const detail = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/[id].tsx'),
      'utf8'
    );
    expect(detail).toContain('openItemEditor');
    expect(detail).toContain('buildAggregatableProductDetailHref');
    expect(detail).toContain('itemEditHit');
    expect(detail).toContain('productDetailHit');
    expect(detail).toContain('navigateBackOrHistory');
  });
});
