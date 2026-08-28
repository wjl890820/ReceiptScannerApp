/* eslint-disable import/first -- Jest mocks must run before module imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import type { ReceiptRow } from './db';
import {
  buildFiveReceiptMilestone,
  buildTenReceiptMilestone,
  distinctReceiptCount,
  frequentProductGroups,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';
import {
  HOME_LONG_TERM_FREQUENT_PRODUCT_CAP,
  buildLongTermFrequentProductProfiles,
  buildLongTermFrequentProductProfilesFromStoredReceipts,
  mapFrequentProductProfileToHomeFrequentProduct,
  resolveStableFrequentProductIdentity,
  takeHomeLongTermFrequentProducts,
} from './frequentProductProfile';
import { buildHomeProgressiveExperience } from './homeProgressiveExperience';
import { buildHomeFrequentProductDetailHref } from './homeValueHierarchy';

const DAY_MS = 24 * 60 * 60 * 1000;

function receipt(
  id: string,
  overrides: Partial<EngagementReceipt> = {}
): EngagementReceipt {
  const numericId = Number(id.replace(/\D/g, '')) || 1;
  return {
    id,
    created_at: numericId * DAY_MS,
    transaction_at: numericId * DAY_MS,
    merchant_raw: `Store ${id}`,
    merchant_normalized: `store ${id}`,
    merchant_type: 'supermarket',
    total: 100,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: [] }),
    final_total: null,
    user_items_json: null,
    ...overrides,
  };
}

function productRow(
  receiptId: string,
  itemId: string,
  overrides: Partial<EngagementProductRow> = {}
): EngagementProductRow {
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    occurredAt: Number(receiptId.replace(/\D/g, '')) * DAY_MS,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    merchant_type: 'supermarket',
    analysis_json: '{}',
    displayName: itemId,
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    canonicalProductName: null,
    productFamilyKey: null,
    skuKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    ...overrides,
  };
}

function asReceiptRows(receipts: EngagementReceipt[]): ReceiptRow[] {
  return receipts as unknown as ReceiptRow[];
}

describe('R2-F3B long-term FrequentProductProfile core', () => {
  it('A — same stable product on two DISTINCT receipts qualifies', () => {
    const profiles = buildLongTermFrequentProductProfiles(
      [receipt('r1'), receipt('r2')],
      [
        productRow('r1', 'm1', { canonicalProductName: '明治牛乳' }),
        productRow('r2', 'm2', { canonicalProductName: '明治牛乳' }),
      ]
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      targetType: 'canonical',
      key: '明治牛乳',
      distinctReceiptCount: 2,
    });
  });

  it('B — two rows on ONE receipt do NOT qualify', () => {
    expect(
      buildLongTermFrequentProductProfiles(
        [receipt('r1'), receipt('r2')],
        [
          productRow('r1', 'm1', {
            canonicalProductName: '明治牛乳',
            sourceIndex: 0,
          }),
          productRow('r1', 'm2', {
            canonicalProductName: '明治牛乳',
            sourceIndex: 1,
          }),
        ]
      )
    ).toEqual([]);
  });

  it('C — quantity=2 on one receipt does NOT qualify as two occasions', () => {
    expect(
      buildLongTermFrequentProductProfiles(
        [receipt('r1')],
        [
          productRow('r1', 'm1', {
            canonicalProductName: '明治牛乳',
            purchaseQuantity: 2,
          }),
        ]
      )
    ).toEqual([]);
  });

  it('D — raw-name-only repeats (e.g. 鶏肉) do NOT qualify', () => {
    const rows = [
      productRow('r1', 'a', { displayName: '鶏肉' }),
      productRow('r2', 'b', { displayName: '鶏肉' }),
      productRow('r3', 'c', { displayName: '鶏肉' }),
    ];
    expect(
      buildLongTermFrequentProductProfiles(
        [receipt('r1'), receipt('r2'), receipt('r3')],
        rows
      )
    ).toEqual([]);
    expect(resolveStableFrequentProductIdentity(rows[0])).toBeNull();
  });

  it('E/F/G — canonical / family / sku qualify with frozen hierarchy', () => {
    const profiles = buildLongTermFrequentProductProfiles(
      [receipt('r1'), receipt('r2')],
      [
        productRow('r1', 'c1', { canonicalProductName: 'Canon Milk' }),
        productRow('r2', 'c2', { canonicalProductName: 'Canon Milk' }),
        productRow('r1', 'f1', { productFamilyKey: 'eggs' }),
        productRow('r2', 'f2', { productFamilyKey: 'eggs' }),
        productRow('r1', 's1', {
          skuKey: 'v1|sku-water',
          displayName: 'Water 500ml',
        }),
        productRow('r2', 's2', {
          skuKey: 'v1|sku-water',
          displayName: 'Water 500ml',
        }),
      ]
    );
    const byType = Object.fromEntries(
      profiles.map((profile) => [profile.targetType, profile])
    );
    expect(byType.canonical.key).toBe('Canon Milk');
    expect(byType.family.key).toBe('eggs');
    expect(byType.sku.key).toBe('v1|sku-water');
    expect(byType.sku.displayName).toBe('Water 500ml');
    expect(byType.sku.displayName).not.toContain('v1|');
  });

  it('H/I — firstPurchaseAt / latestPurchaseAt', () => {
    const [profile] = buildLongTermFrequentProductProfiles(
      [receipt('r1'), receipt('r3')],
      [
        productRow('r1', 'a', {
          canonicalProductName: 'Milk',
          occurredAt: 1000,
        }),
        productRow('r3', 'b', {
          canonicalProductName: 'Milk',
          occurredAt: 3000,
        }),
      ]
    );
    expect(profile.firstPurchaseAt).toBe(1000);
    expect(profile.latestPurchaseAt).toBe(3000);
  });

  it('J — invalid timestamps excluded from first/latest but receipt still counts', () => {
    const [profile] = buildLongTermFrequentProductProfiles(
      [receipt('r1'), receipt('r2')],
      [
        productRow('r1', 'a', {
          canonicalProductName: 'Milk',
          occurredAt: 0,
        }),
        productRow('r2', 'b', {
          canonicalProductName: 'Milk',
          occurredAt: 5000,
        }),
      ]
    );
    expect(profile.distinctReceiptCount).toBe(2);
    expect(profile.firstPurchaseAt).toBe(5000);
    expect(profile.latestPurchaseAt).toBe(5000);
  });
});

describe('R2-F3B universe', () => {
  it('K — receipts outside the analytics/supported set do not inflate count', () => {
    const supported = [receipt('keep'), receipt('other')];
    const rows = [
      productRow('keep', 'a', { canonicalProductName: 'Milk' }),
      productRow('dup-extra', 'b', { canonicalProductName: 'Milk' }),
      productRow('other', 'c', { canonicalProductName: 'Milk' }),
    ];
    const [profile] = buildLongTermFrequentProductProfiles(supported, rows);
    expect(profile.distinctReceiptCount).toBe(2);
  });

  it('L — unsupported merchant receipts do not inflate count', () => {
    expect(
      buildLongTermFrequentProductProfiles(
        [receipt('r1'), receipt('r2', { merchant_type: 'other' })],
        [
          productRow('r1', 'a', { canonicalProductName: 'Milk' }),
          productRow('r2', 'b', {
            canonicalProductName: 'Milk',
            merchant_type: 'other',
          }),
        ]
      )
    ).toEqual([]);
  });

  it('M — stored-receipt entry reuses analytics selection SSOT', async () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'frequentProductProfile.ts'),
      'utf8'
    );
    expect(source).toContain('selectAnalyticsReceipts');
    expect(source).toContain(
      'buildLongTermFrequentProductProfilesFromStoredReceipts'
    );
    expect(source).toContain("await import('./analyticsReceiptSelection')");
    await expect(
      buildLongTermFrequentProductProfilesFromStoredReceipts([], [])
    ).resolves.toEqual([]);
  });
});

describe('R2-F3B sorting', () => {
  it('distinctReceiptCount DESC, then latestPurchaseAt DESC, then identity', () => {
    const profiles = buildLongTermFrequentProductProfiles(
      [receipt('r1'), receipt('r2'), receipt('r3')],
      [
        productRow('r1', 'a1', {
          canonicalProductName: 'A-three',
          occurredAt: 100,
        }),
        productRow('r2', 'a2', {
          canonicalProductName: 'A-three',
          occurredAt: 200,
        }),
        productRow('r3', 'a3', {
          canonicalProductName: 'A-three',
          occurredAt: 300,
        }),
        productRow('r1', 'b1', {
          canonicalProductName: 'B-two',
          occurredAt: 900,
        }),
        productRow('r2', 'b2', {
          canonicalProductName: 'B-two',
          occurredAt: 1000,
        }),
      ]
    );
    expect(profiles.map((profile) => profile.key)).toEqual([
      'A-three',
      'B-two',
    ]);

    const tied = buildLongTermFrequentProductProfiles(
      [receipt('r1'), receipt('r2')],
      [
        productRow('r1', 'x', {
          canonicalProductName: 'Zebra',
          occurredAt: 50,
        }),
        productRow('r2', 'y', {
          canonicalProductName: 'Zebra',
          occurredAt: 50,
        }),
        productRow('r1', 'u', {
          canonicalProductName: 'Apple',
          occurredAt: 50,
        }),
        productRow('r2', 'v', {
          canonicalProductName: 'Apple',
          occurredAt: 50,
        }),
      ]
    );
    expect(tied.map((profile) => profile.key)).toEqual(['Apple', 'Zebra']);
  });
});

describe('R2-F3B Home migration', () => {
  const unlockedStatus = {
    supportedReceiptCount: 5,
    currentMilestone: 5 as const,
    justUnlocked: null,
    nextMilestone: 10 as const,
    receiptsUntilNext: 5,
  };

  it('Home consumes long-term profiles with distinctReceiptCount display', () => {
    const receipts = [1, 2, 3, 4, 5].map((n) => receipt(`r${n}`));
    const rows = [
      productRow('r1', 'm1', { canonicalProductName: '明治牛乳' }),
      productRow('r2', 'm2', { canonicalProductName: '明治牛乳' }),
      productRow('r1', 'x1', { canonicalProductName: 'OnlyOnce' }),
    ];
    const experience = buildHomeProgressiveExperience(
      asReceiptRows(receipts),
      {
        status: unlockedStatus,
        currentResult: buildFiveReceiptMilestone(receipts, {
          rows,
          queryFailed: false,
        }),
      },
      false,
      rows
    );
    expect(experience.stage).toBe('frequent');
    expect(experience.frequentProducts).toHaveLength(1);
    expect(experience.frequentProducts[0].purchaseOccurrenceCount).toBe(2);
    expect(experience.frequentProducts[0].displayLabel).toBe('明治牛乳');
  });

  it('Home stage gate unchanged — no frequent list before unlock', () => {
    const experience = buildHomeProgressiveExperience(
      asReceiptRows([receipt('r1'), receipt('r2'), receipt('r3')]),
      null,
      false,
      [
        productRow('r1', 'm1', { canonicalProductName: '明治牛乳' }),
        productRow('r2', 'm2', { canonicalProductName: '明治牛乳' }),
      ]
    );
    expect(experience.stage).toBe('recent');
    expect(experience.frequentProducts).toEqual([]);
  });

  it('Home cap = 5; SSOT itself is uncapped', () => {
    const receipts = [1, 2, 3, 4, 5, 6].map((n) => receipt(`r${n}`));
    const rows: EngagementProductRow[] = [];
    for (let i = 0; i < 8; i += 1) {
      const key = `Product-${i}`;
      rows.push(
        productRow('r1', `${i}-a`, { canonicalProductName: key }),
        productRow('r2', `${i}-b`, { canonicalProductName: key })
      );
    }
    const all = buildLongTermFrequentProductProfiles(receipts, rows);
    expect(all).toHaveLength(8);
    expect(takeHomeLongTermFrequentProducts(all)).toHaveLength(
      HOME_LONG_TERM_FREQUENT_PRODUCT_CAP
    );
    const experience = buildHomeProgressiveExperience(
      asReceiptRows(receipts),
      {
        status: {
          ...unlockedStatus,
          supportedReceiptCount: 6,
          receiptsUntilNext: 4,
        },
        currentResult: null,
      },
      false,
      rows
    );
    expect(experience.frequentProducts).toHaveLength(5);
  });

  it('Product Detail href valid; raw-only remains suppressed', () => {
    const profiles = buildLongTermFrequentProductProfiles(
      [receipt('r1'), receipt('r2')],
      [
        productRow('r1', 'a', { canonicalProductName: '明治牛乳' }),
        productRow('r2', 'b', { canonicalProductName: '明治牛乳' }),
        productRow('r1', 'c', { displayName: '鶏肉' }),
        productRow('r2', 'd', { displayName: '鶏肉' }),
      ]
    );
    expect(profiles).toHaveLength(1);
    const mapped = mapFrequentProductProfileToHomeFrequentProduct(profiles[0]);
    const href = buildHomeFrequentProductDetailHref(mapped);
    expect(href).toBe(
      `/product/canonical?key=${encodeURIComponent('明治牛乳')}`
    );
  });
});

describe('R2-F3B milestone / frequentProductGroups freeze', () => {
  it('buildTenReceiptMilestone still windows last 10 supported receipts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'engagementMilestones.ts'),
      'utf8'
    );
    expect(source).toMatch(/\.slice\(\s*-10\s*\)/);
    expect(source).toContain('frequentProductGroups(receipts');
  });

  it('frequentProductGroups uses distinct receipt purchase events + top-5', () => {
    const receipts = [receipt('r1'), receipt('r2')];
    const sameReceiptRows = [
      productRow('r1', 'a', {
        canonicalProductName: 'SameReceiptMilk',
        sourceIndex: 0,
        purchaseQuantity: 1,
      }),
      productRow('r1', 'b', {
        canonicalProductName: 'SameReceiptMilk',
        sourceIndex: 1,
        purchaseQuantity: 2,
      }),
    ];
    expect(
      frequentProductGroups(receipts, {
        rows: sameReceiptRows,
        queryFailed: false,
      }).frequentProducts
    ).toHaveLength(0);
    expect(distinctReceiptCount(sameReceiptRows)).toBe(1);

    const withSecondReceipt = [
      ...sameReceiptRows,
      productRow('r2', 'c', {
        canonicalProductName: 'SameReceiptMilk',
        sourceIndex: 0,
        purchaseQuantity: 3,
      }),
    ];
    const milestone = frequentProductGroups(receipts, {
      rows: withSecondReceipt,
      queryFailed: false,
    });
    expect(milestone.frequentProducts).toHaveLength(1);
    expect(milestone.frequentProducts[0].purchaseOccurrenceCount).toBe(2);
    expect(milestone.frequentProducts[0].totalPurchaseQuantity).toBe(6);
    expect(
      buildLongTermFrequentProductProfiles(receipts, sameReceiptRows)
    ).toEqual([]);
    expect(
      buildLongTermFrequentProductProfiles(receipts, withSecondReceipt)
    ).toEqual([
      expect.objectContaining({
        key: 'SameReceiptMilk',
        distinctReceiptCount: 2,
        targetType: 'canonical',
      }),
    ]);

    const manyRows: EngagementProductRow[] = [];
    for (let i = 0; i < 8; i += 1) {
      const key = `Cap-${i}`;
      manyRows.push(
        productRow('r1', `${i}a`, { canonicalProductName: key }),
        productRow('r2', `${i}b`, { canonicalProductName: key })
      );
    }
    expect(
      frequentProductGroups(receipts, { rows: manyRows, queryFailed: false })
        .frequentProducts
    ).toHaveLength(5);

    const ten = buildTenReceiptMilestone(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => receipt(`r${n}`)),
      { rows: manyRows, queryFailed: false }
    );
    expect(ten?.frequentProducts.length).toBeLessThanOrEqual(5);
  });

  it('Analysis D frequent windows still use frequentProductGroups', () => {
    const analysisSource = fs.readFileSync(
      path.resolve(__dirname, 'analysisDReport.ts'),
      'utf8'
    );
    expect(analysisSource).toContain('frequentProductGroups');
  });
});
