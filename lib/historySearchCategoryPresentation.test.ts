/**
 * R2-F2 — History product-search category presentation contracts.
 * Presentation only: domain category enums and search semantics stay frozen.
 */

/* eslint-disable import/first -- mocks must run before i18n/categoryPalette imports. */
import * as fs from 'fs';
import * as path from 'path';

const storage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    storage.set(key, value);
  }),
}));

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en' }],
}));

import { getCategoryLabel } from './categoryPalette';
import { initI18n, setLocalePreference, t } from './i18n';
import { buildPersonalAwareProductSearchResultHref } from './personalProductReturnTarget';

const localesDir = path.resolve(__dirname, '../locales');
const historyScreenPath = path.resolve(
  __dirname,
  '../app/(tabs)/history/index.tsx'
);

function readLocaleCategory(
  locale: 'en' | 'zh' | 'ja',
  key: string
): string {
  const data = JSON.parse(
    fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8')
  ) as { category: Record<string, string> };
  return data.category[key];
}

describe('R2-F2 History search category presentation', () => {
  beforeAll(async () => {
    await initI18n();
  });

  beforeEach(() => {
    storage.clear();
  });

  it('A — public History presentation never renders literal food_ingredients', () => {
    const source = fs.readFileSync(historyScreenPath, 'utf8');
    expect(source).toContain(
      "import { getCategoryLabel } from '@/lib/categoryPalette'"
    );
    expect(source).toContain('getCategoryLabel(result.category)');

    const metaBlock = source.match(
      /const itemMeta = \[[\s\S]*?\]\.filter/
    )?.[0];
    expect(metaBlock).toBeTruthy();
    expect(metaBlock).toContain('getCategoryLabel(result.category)');
    // Must not push the raw enum as a standalone meta entry.
    expect(metaBlock).not.toMatch(/^\s*result\.category\s*,\s*$/m);
    expect(metaBlock).toMatch(
      /result\.category\s*\n\s*\?\s*getCategoryLabel\(result\.category\)/
    );
    expect(metaBlock).not.toContain("'food_ingredients'");
    expect(metaBlock).not.toContain('"food_ingredients"');
  });

  it('B/C/D — food_ingredients localizes via category SSOT (zh/ja/en)', async () => {
    expect(readLocaleCategory('zh', 'food_ingredients')).toBe('食材');
    expect(readLocaleCategory('ja', 'food_ingredients')).toBe('食材');
    expect(readLocaleCategory('en', 'food_ingredients')).toBe('Ingredients');

    await setLocalePreference('zh');
    expect(getCategoryLabel('food_ingredients')).toBe('食材');
    expect(getCategoryLabel('food_ingredients')).not.toBe('food_ingredients');

    await setLocalePreference('ja');
    expect(getCategoryLabel('food_ingredients')).toBe('食材');
    expect(getCategoryLabel('food_ingredients')).not.toBe('food_ingredients');

    await setLocalePreference('en');
    expect(getCategoryLabel('food_ingredients')).toBe('Ingredients');
    expect(getCategoryLabel('food_ingredients')).not.toBe('food_ingredients');
  });

  it('E — search matching/ranking modules remain the History search SSOT', () => {
    const source = fs.readFileSync(historyScreenPath, 'utf8');
    expect(source).toContain('performHistoryPurchaseSearch');
    expect(source).toContain('searchHistoryPurchases');
    expect(source).toContain('normalizeReceiptItemSearchQuery');
  });

  it('F — Product Detail search href contract remains unchanged without personal inventory', () => {
    const source = fs.readFileSync(historyScreenPath, 'utf8');
    expect(source).toContain('buildPersonalAwareProductSearchResultHref');
    expect(source).toContain('onProductSearchResultPress');

    const href = buildPersonalAwareProductSearchResultHref(
      {
        source: {
          skuKey: 'sku-chicken-1',
          canonicalProductName: null,
          productFamilyKey: null,
          receiptId: 'receipt-1',
          itemId: 'item-1',
        },
        sourceIndex: 0,
      },
      null
    );
    expect(href).toBe('/product/sku?key=sku-chicken-1');
    expect(href).not.toContain('food_ingredients');
  });

  it('G — unknown/fallback follows existing category presentation contract', async () => {
    await setLocalePreference('en');
    // normalizeProductCategory maps unknown → uncategorized (existing SSOT).
    expect(getCategoryLabel('not_a_real_category')).toBe(
      t('category.uncategorized')
    );
    expect(getCategoryLabel('not_a_real_category')).not.toBe(
      'not_a_real_category'
    );
    await setLocalePreference('zh');
    expect(getCategoryLabel('')).toBe(t('category.uncategorized'));
  });
});
