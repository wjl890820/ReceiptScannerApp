/**
 * Home Frequent Product recency — presentation-only lastPurchasedAt label.
 */

import * as fs from 'fs';
import * as path from 'path';

import { formatHomeFrequentLastPurchasedLabel } from './homeFrequentProductRecency';
import { formatDate } from './formatDate';
import { mapRepeatProductProfileToHomeFrequentProduct } from './repeatProductProfile';
import type { RepeatProductProfile } from './repeatProductProfile';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

function translate(
  key: string,
  params?: Record<string, string | number>
): string {
  if (key !== 'home.progressive.frequent.lastPurchased') {
    return key;
  }
  return `Last bought ${params?.date ?? ''}`;
}

describe('Home Frequent Product recency', () => {
  it('1 — valid lastPurchasedAt formats via existing formatDate date portion', () => {
    const ts = Date.UTC(2026, 8, 20, 15, 30);
    const expectedDate = formatDate(ts).slice(0, 10);
    const label = formatHomeFrequentLastPurchasedLabel(ts, translate);
    expect(label).toBe(`Last bought ${expectedDate}`);
    expect(expectedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(label).not.toMatch(/T\d{2}:\d{2}/);
    expect(label).not.toContain(formatDate(ts)); // date-only, not full datetime
  });

  it('2 — missing / zero lastPurchasedAt omits the label', () => {
    expect(formatHomeFrequentLastPurchasedLabel(0, translate)).toBeNull();
    expect(
      formatHomeFrequentLastPurchasedLabel(null as unknown as number, translate)
    ).toBeNull();
    expect(
      formatHomeFrequentLastPurchasedLabel(
        undefined as unknown as number,
        translate
      )
    ).toBeNull();
  });

  it('3 — invalid / unsupported values do not fabricate recency', () => {
    expect(formatHomeFrequentLastPurchasedLabel(NaN, translate)).toBeNull();
    expect(
      formatHomeFrequentLastPurchasedLabel(Number.POSITIVE_INFINITY, translate)
    ).toBeNull();
    expect(
      formatHomeFrequentLastPurchasedLabel(Number.NEGATIVE_INFINITY, translate)
    ).toBeNull();
    expect(formatHomeFrequentLastPurchasedLabel(-1, translate)).toBeNull();
  });

  it('4 — Product Detail navigation wiring remains unchanged', () => {
    const list = read('components/home/HomeFrequentProductList.tsx');
    expect(list).toContain('onPress={() => onPress(product)}');
    expect(list).toContain('styles.contentHit');
    const home = read('app/(tabs)/index.tsx');
    expect(home).toContain('buildHomeFrequentProductDetailHref');
    expect(home).toContain('handleProductPress');
  });

  it('5 — Add / On List action remains unchanged', () => {
    const list = read('components/home/HomeFrequentProductList.tsx');
    expect(list).toContain('onAddToShoppingList?.(product)');
    expect(list).toContain('home.progressive.frequent.add');
    expect(list).toContain('home.progressive.frequent.added');
    expect(list).toContain('isTrustedShoppingListIdentity');
  });

  it('6 — no Repeat ranking / qualification change; uses mapped lastPurchasedAt only', () => {
    const profile: RepeatProductProfile = {
      identityKind: 'merchant_product',
      identityKey: 'mp:milk',
      displayName: 'Milk',
      purchaseOccurrenceCount: 3,
      purchaseEventDates: [1000, 2000, 3000],
      datedPurchaseOccurrenceCount: 3,
      firstPurchasedAt: 1000,
      lastPurchasedAt: 3000,
      totalPurchaseQuantity: 3,
    };
    const home = mapRepeatProductProfileToHomeFrequentProduct(profile);
    expect(home.lastPurchasedAt).toBe(3000);
    const label = formatHomeFrequentLastPurchasedLabel(
      home.lastPurchasedAt,
      translate
    );
    expect(label).toContain(formatDate(3000).slice(0, 10));

    const missing: RepeatProductProfile = {
      ...profile,
      lastPurchasedAt: null,
      purchaseEventDates: [],
      datedPurchaseOccurrenceCount: 0,
      firstPurchasedAt: null,
    };
    const mappedMissing = mapRepeatProductProfileToHomeFrequentProduct(missing);
    expect(mappedMissing.lastPurchasedAt).toBe(0);
    expect(
      formatHomeFrequentLastPurchasedLabel(
        mappedMissing.lastPurchasedAt,
        translate
      )
    ).toBeNull();

    const repeatSource = read('lib/repeatProductProfile.ts');
    const list = read('components/home/HomeFrequentProductList.tsx');
    expect(list).not.toContain('qualify');
    expect(list).not.toContain('rankRepeat');
    expect(list).toContain('product.lastPurchasedAt');
    expect(list).not.toMatch(/getAllAsync|SELECT\s+/i);
    expect(repeatSource).toContain(
      'mapRepeatProductProfileToHomeFrequentProduct'
    );
  });

  it('7 — locale keys exist in en / ja / zh', () => {
    for (const locale of ['en', 'ja', 'zh'] as const) {
      const json = JSON.parse(read(`locales/${locale}.json`));
      const value = json.home.progressive.frequent.lastPurchased;
      expect(typeof value).toBe('string');
      expect(value).toContain('{date}');
    }
    expect(
      JSON.parse(read('locales/en.json')).home.progressive.frequent
        .lastPurchased
    ).toBe('Last bought {date}');
    expect(
      JSON.parse(read('locales/ja.json')).home.progressive.frequent
        .lastPurchased
    ).toBe('最終購入 {date}');
    expect(
      JSON.parse(read('locales/zh.json')).home.progressive.frequent
        .lastPurchased
    ).toBe('上次购买 {date}');
  });

  it('UI wires formatHomeFrequentLastPurchasedLabel into meta', () => {
    const list = read('components/home/HomeFrequentProductList.tsx');
    expect(list).toContain('formatHomeFrequentLastPurchasedLabel');
    expect(list).toContain('lastPurchasedLabel');
    expect(list).toContain('product.lastPurchasedAt');
    const helper = read('lib/homeFrequentProductRecency.ts');
    expect(helper).toContain('formatDate');
    expect(helper).toContain('.slice(0, 10)');
  });
});
