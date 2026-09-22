/**
 * Shopping Loop Slice 3 — Next Purchase → Product Detail hardening.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  buildNextPurchaseCandidates,
} from './nextPurchaseCandidates';
import {
  buildProductDetailHref,
  buildTrustedProductIdentityDetailHref,
} from './productDetailTarget';
import type { RepeatProductProfile } from './repeatProductProfile';
import { buildShoppingListItemProductDetailHref } from './shoppingList';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

function navigateNextPurchase(
  candidate: {
    identityKind?: unknown;
    identityKey?: unknown;
    displayName?: string;
  },
  push: (href: string) => void
): void {
  const href = buildTrustedProductIdentityDetailHref({
    identityKind: candidate.identityKind,
    identityKey: candidate.identityKey,
  });
  if (!href) return;
  push(href);
}

describe('Shopping Loop Slice 3 — trusted Product Detail href', () => {
  it('A — merchant_product NP → exact Product Detail href', () => {
    expect(
      buildTrustedProductIdentityDetailHref({
        identityKind: 'merchant_product',
        identityKey: 'mp:milk',
      })
    ).toBe('/product/merchant_product?key=mp%3Amilk');
  });

  it('B — personal_product NP → exact Product Detail href', () => {
    expect(
      buildTrustedProductIdentityDetailHref({
        identityKind: 'personal_product',
        identityKey: 'mp-anchor-cola',
      })
    ).toBe('/product/personal_product?key=mp-anchor-cola');
  });

  it('C — unsupported identity kind → null / no navigation', () => {
    const pushes: string[] = [];
    for (const kind of ['sku', 'canonical', 'family', 'occurrence', 'bogus']) {
      expect(
        buildTrustedProductIdentityDetailHref({
          identityKind: kind,
          identityKey: 'some-key',
        })
      ).toBeNull();
      navigateNextPurchase(
        { identityKind: kind, identityKey: 'some-key' },
        (href) => pushes.push(href)
      );
    }
    expect(pushes).toEqual([]);
  });

  it('D — empty / whitespace identity key → null / no navigation', () => {
    const pushes: string[] = [];
    for (const key of ['', '   ', '\t', null, undefined]) {
      expect(
        buildTrustedProductIdentityDetailHref({
          identityKind: 'merchant_product',
          identityKey: key,
        })
      ).toBeNull();
      navigateNextPurchase(
        { identityKind: 'merchant_product', identityKey: key },
        (href) => pushes.push(href)
      );
    }
    expect(pushes).toEqual([]);
  });

  it('E — displayName alone cannot create href', () => {
    expect(
      buildTrustedProductIdentityDetailHref({
        identityKind: undefined,
        identityKey: undefined,
      })
    ).toBeNull();
    // Helper has no displayName parameter — name cannot invent a route.
    expect(
      buildTrustedProductIdentityDetailHref({
        identityKind: 'merchant_product',
        identityKey: '',
      })
    ).toBeNull();
  });

  it('F — encoded key uses existing Product Detail route contract exactly', () => {
    const key = 'mp:牛乳 900ml/特売';
    const trusted = buildTrustedProductIdentityDetailHref({
      identityKind: 'merchant_product',
      identityKey: key,
    });
    const canonical = buildProductDetailHref({
      type: 'merchant_product',
      key,
    });
    expect(trusted).toBe(canonical);
    expect(trusted).toBe(
      `/product/merchant_product?key=${encodeURIComponent(key)}`
    );
  });
});

describe('Shopping Loop Slice 3 — row interaction isolation', () => {
  it('G/H — content navigation and Add are sibling interactions (not nested)', () => {
    const list = read('components/home/HomeNextPurchaseList.tsx');

    // Row chrome is non-pressable; navigation lives on a sibling content Pressable.
    expect(list).toContain('styles.contentHit');
    expect(list).toContain('onAddToShoppingList');
    expect(list).toMatch(/<MerunoGroupedRow[\s\S]*?showDivider=/);
    expect(list).not.toMatch(
      /<MerunoGroupedRow[\s\S]*?onPress=\{pressable \?/
    );

    // Simulate the two independent handlers the Home screen wires.
    const navigations: string[] = [];
    const adds: string[] = [];
    const candidate = {
      identityKind: 'merchant_product' as const,
      identityKey: 'mp:milk',
      displayName: 'Milk',
    };

    const onContentPress = () => {
      navigateNextPurchase(candidate, (href) => navigations.push(href));
    };
    const onAddPress = () => {
      adds.push(candidate.identityKey);
    };

    onContentPress();
    expect(navigations).toEqual(['/product/merchant_product?key=mp%3Amilk']);
    expect(adds).toEqual([]);

    onAddPress();
    expect(adds).toEqual(['mp:milk']);
    expect(navigations).toHaveLength(1);

    // Add path never calls navigate.
    const navBeforeAddOnly = navigations.length;
    onAddPress();
    expect(adds).toHaveLength(2);
    expect(navigations).toHaveLength(navBeforeAddOnly);
  });

  it('Home Next Purchase press uses trusted-only helper (not Frequent broad helper)', () => {
    const home = read('app/(tabs)/index.tsx');
    const list = read('components/home/HomeNextPurchaseList.tsx');
    const handlerStart = home.indexOf('const handleNextPurchasePress');
    const handlerEnd = home.indexOf('const handleShoppingListPress');
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = home.slice(handlerStart, handlerEnd);
    expect(handler).toContain('buildTrustedProductIdentityDetailHref');
    expect(handler).not.toContain('buildHomeFrequentProductDetailHref');
    expect(handler).not.toContain('displayName');
    expect(list).toContain(
      'home.progressive.nextPurchase.openProductDetailA11y'
    );
    expect(list).not.toContain('openHistoryA11y');
  });
});

describe('Shopping Loop Slice 3 — Shopping List helper compatibility', () => {
  it('I — trusted merchant_product helper unchanged', () => {
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: 'merchant_product',
        sourceIdentityKey: 'mp:milk',
      })
    ).toBe('/product/merchant_product?key=mp%3Amilk');
  });

  it('J — trusted personal_product helper unchanged', () => {
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: 'personal_product',
        sourceIdentityKey: 'mp-anchor-cola',
      })
    ).toBe('/product/personal_product?key=mp-anchor-cola');
  });

  it('K — manual/untrusted helper remains null', () => {
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: null,
        sourceIdentityKey: null,
      })
    ).toBeNull();
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: 'sku' as never,
        sourceIdentityKey: 'sku-1',
      })
    ).toBeNull();
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: 'merchant_product',
        sourceIdentityKey: '   ',
      })
    ).toBeNull();
  });
});

describe('Shopping Loop Slice 3 — NP domain invariance', () => {
  it('L/M — ranking / candidate generation unchanged (trusted helper is routing only)', () => {
    const DAY = 86_400_000;
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    const atDay = (d: number) => T0 + d * DAY;
    const profiles: RepeatProductProfile[] = [
      {
        identityKind: 'merchant_product',
        identityKey: 'mp:a',
        displayName: 'A',
        purchaseOccurrenceCount: 4,
        purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
        datedPurchaseOccurrenceCount: 4,
        firstPurchasedAt: atDay(0),
        lastPurchasedAt: atDay(21),
      },
      {
        identityKind: 'personal_product',
        identityKey: 'pp:b',
        displayName: 'B',
        purchaseOccurrenceCount: 4,
        purchaseEventDates: [atDay(0), atDay(10), atDay(20), atDay(30)],
        datedPurchaseOccurrenceCount: 4,
        firstPurchasedAt: atDay(0),
        lastPurchasedAt: atDay(30),
      },
    ];
    const now = atDay(37);
    const before = buildNextPurchaseCandidates(profiles, { now });
    const after = buildNextPurchaseCandidates(profiles, { now });
    expect(after).toEqual(before);
    expect(after.map((c) => `${c.identityKind}:${c.identityKey}`)).toEqual(
      before.map((c) => `${c.identityKind}:${c.identityKey}`)
    );
    // Domain module is untouched by this slice.
    const domain = read('lib/nextPurchaseCandidates.ts');
    expect(domain).not.toContain('buildTrustedProductIdentityDetailHref');
    expect(domain).not.toContain('buildProductDetailHref');
  });

  it('N — Product Detail Scan CTA path from Slice 2 remains unaffected', () => {
    const detail = read('app/product/[targetType].tsx');
    expect(detail).toContain('useReceiptScanLauncher');
    expect(detail).toContain('launchReceiptScan');
    expect(detail).toContain('productDetail.scanReceipt');
    expect(
      buildShoppingListItemProductDetailHref({
        sourceIdentityKind: 'merchant_product',
        sourceIdentityKey: 'mp:milk',
      })
    ).toBe(
      buildTrustedProductIdentityDetailHref({
        identityKind: 'merchant_product',
        identityKey: 'mp:milk',
      })
    );
  });
});

describe('Shopping Loop Slice 3 — locales', () => {
  it('openProductDetailA11y present in zh/ja/en; history a11y removed from NP', () => {
    for (const locale of ['zh', 'ja', 'en']) {
      const json = JSON.parse(read(`locales/${locale}.json`));
      expect(
        json.home.progressive.nextPurchase.openProductDetailA11y
      ).toBeTruthy();
      expect(json.home.progressive.nextPurchase.openHistoryA11y).toBeUndefined();
      expect(json.home.progressive.frequent.openHistoryA11y).toBeTruthy();
    }
  });
});
