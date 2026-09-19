/**
 * Round 8 — Home long-term Repeat/Next Purchase must use full-history analytics,
 * not the newest-200 display slice.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./env', () => ({
  isProductIdentityPriceHistoryV1Enabled: () => true,
}));

import * as fs from 'fs';
import * as path from 'path';

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';
import type { EngagementProductRow } from './engagementMilestones';
import { buildHomeProgressiveExperience } from './homeProgressiveExperience';

const DAY_MS = 24 * 60 * 60 * 1000;
const DISPLAY_LIMIT = 200;
const NEWEST_BASE = Date.parse('2026-08-01T12:00:00+09:00');
const OLD_BASE = Date.parse('2025-01-10T15:30:00+09:00');
const STRONG_PRODUCT = 'コカ・コーラ 500ml';

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow {
  return {
    id,
    created_at: NEWEST_BASE,
    transaction_at: NEWEST_BASE,
    transaction_time_precision: 'second',
    image_uri: '',
    total: 100,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [{ name: 'filler', quantity: 1, unitPrice: 100, lineTotal: 100 }],
    }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: 'owner-a',
    installation_id: null,
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
    occurredAt: OLD_BASE,
    merchantRaw: 'イオン',
    merchantNormalized: 'イオン',
    merchant_type: 'supermarket',
    analysis_json: '{}',
    displayName: STRONG_PRODUCT,
    currency: 'JPY',
    lineTotal: 160,
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

function unlockedStatus(count: number) {
  return {
    supportedReceiptCount: count,
    currentMilestone: count >= 10 ? (10 as const) : (5 as const),
    justUnlocked: null,
    nextMilestone: count >= 10 ? null : (10 as const),
    receiptsUntilNext: count >= 10 ? null : 10 - count,
  };
}

function buildNewestDisplaySlice(count = DISPLAY_LIMIT): ReceiptRow[] {
  return Array.from({ length: count }, (_, i) =>
    receipt(`new${i}`, {
      created_at: NEWEST_BASE + i * DAY_MS,
      transaction_at: NEWEST_BASE + i * DAY_MS,
    transaction_time_precision: 'second',
      analysis_json: JSON.stringify({
        items: [
          {
            name: `filler-${i}`,
            quantity: 1,
            unitPrice: 100,
            lineTotal: 100,
          },
        ],
      }),
    })
  );
}

function buildOldStrongPurchases(count: number): ReceiptRow[] {
  return Array.from({ length: count }, (_, i) =>
    receipt(`old-strong-${i}`, {
      created_at: OLD_BASE + i * 7 * DAY_MS,
      transaction_at: OLD_BASE + i * 7 * DAY_MS,
    transaction_time_precision: 'second',
      total: 160,
      analysis_json: JSON.stringify({
        items: [
          {
            name: STRONG_PRODUCT,
            quantity: 1,
            unitPrice: 160,
            lineTotal: 160,
          },
        ],
      }),
    })
  );
}

describe('Round 8 Home full-history Repeat / Next Purchase universe', () => {
  it('>200: Repeat surfaces older strong product via longTermAnalyticsReceipts', () => {
    const displaySlice = buildNewestDisplaySlice(200);
    const oldStrong = buildOldStrongPurchases(2);
    const fullStored = [...displaySlice, ...oldStrong];
    const fullAnalytics = selectAnalyticsReceipts(fullStored).analyticsReceipts;
    const displayAnalytics =
      selectAnalyticsReceipts(displaySlice).analyticsReceipts;

    const productRows = oldStrong.map((row, i) =>
      productRow(row.id, `cola-${i}`, {
        occurredAt: row.transaction_at as number,
      })
    );

    const displayOnly = buildHomeProgressiveExperience(
      displayAnalytics,
      { status: unlockedStatus(fullAnalytics.length), currentResult: null },
      false,
      productRows,
      null,
      NEWEST_BASE + 250 * DAY_MS
    );
    expect(
      displayOnly.frequentProducts.some((p) =>
        p.displayLabel.includes('コカ・コーラ')
      )
    ).toBe(false);

    const withLongTerm = buildHomeProgressiveExperience(
      displayAnalytics,
      { status: unlockedStatus(fullAnalytics.length), currentResult: null },
      false,
      productRows,
      null,
      NEWEST_BASE + 250 * DAY_MS,
      fullAnalytics
    );
    expect(withLongTerm.stage).toBe('profile');
    expect(
      withLongTerm.frequentProducts.some(
        (p) =>
          p.displayLabel.includes('コカ・コーラ') &&
          p.purchaseOccurrenceCount >= 2
      )
    ).toBe(true);
  });

  it('>200: Next Purchase consumes Repeat profiles from full-history universe', () => {
    const displaySlice = buildNewestDisplaySlice(200);
    const oldStrong = buildOldStrongPurchases(3);
    const fullAnalytics = selectAnalyticsReceipts([
      ...displaySlice,
      ...oldStrong,
    ]).analyticsReceipts;
    const displayAnalytics =
      selectAnalyticsReceipts(displaySlice).analyticsReceipts;
    const productRows = oldStrong.map((row, i) =>
      productRow(row.id, `cola-np-${i}`, {
        occurredAt: row.transaction_at as number,
      })
    );
    // now ≈ one median interval after last purchase → likely_due window
    const lastAt = oldStrong[oldStrong.length - 1]!.transaction_at as number;
    const now = lastAt + 7 * DAY_MS;

    const displayOnly = buildHomeProgressiveExperience(
      displayAnalytics,
      { status: unlockedStatus(fullAnalytics.length), currentResult: null },
      false,
      productRows,
      null,
      now
    );
    expect(displayOnly.nextPurchaseCandidates).toHaveLength(0);

    const withLongTerm = buildHomeProgressiveExperience(
      displayAnalytics,
      { status: unlockedStatus(fullAnalytics.length), currentResult: null },
      false,
      productRows,
      null,
      now,
      fullAnalytics
    );
    expect(
      withLongTerm.nextPurchaseCandidates.some((c) =>
        c.displayName.includes('コカ・コーラ')
      )
    ).toBe(true);
    expect(
      withLongTerm.frequentProducts.some((p) =>
        p.displayLabel.includes('コカ・コーラ')
      )
    ).toBe(true);
  });

  it('>200: excluded duplicate extras outside newest 200 cannot leak into Repeat', () => {
    const displaySlice = buildNewestDisplaySlice(200);
    const at = OLD_BASE;
    const body = JSON.stringify({
      total: 160,
      items: [
        {
          name: STRONG_PRODUCT,
          quantity: 1,
          unitPrice: 160,
          lineTotal: 160,
        },
      ],
    });
    const keep = receipt('dup-keep', {
      created_at: at,
      transaction_at: at,
    transaction_time_precision: 'second',
      total: 160,
      analysis_json: body,
    });
    const drop = receipt('dup-drop', {
      created_at: at + 1,
      transaction_at: at,
    transaction_time_precision: 'second',
      total: 160,
      analysis_json: body,
    });
    const second = receipt('dup-second', {
      created_at: at + 14 * DAY_MS,
      transaction_at: at + 14 * DAY_MS,
    transaction_time_precision: 'second',
      total: 160,
      analysis_json: body,
    });
    const selection = selectAnalyticsReceipts([
      ...displaySlice,
      keep,
      drop,
      second,
    ]);
    expect(selection.excludedDuplicateReceiptIds.has(drop.id)).toBe(true);
    expect(selection.analyticsReceipts.some((r) => r.id === keep.id)).toBe(
      true
    );

    const productRows = [
      productRow(keep.id, 'k', { occurredAt: at }),
      // Would inflate if eligibility used stored receipts instead of analytics.
      productRow(drop.id, 'd', { occurredAt: at }),
      productRow(second.id, 's', { occurredAt: at + 14 * DAY_MS }),
    ];

    const experience = buildHomeProgressiveExperience(
      selectAnalyticsReceipts(displaySlice).analyticsReceipts,
      {
        status: unlockedStatus(selection.analyticsReceipts.length),
        currentResult: null,
      },
      false,
      productRows,
      null,
      at + 30 * DAY_MS,
      selection.analyticsReceipts
    );
    const cola = experience.frequentProducts.find((p) =>
      p.displayLabel.includes('コカ・コーラ')
    );
    expect(cola).toBeTruthy();
    // keep + second only — drop excluded by analytics eligibility set.
    expect(cola!.purchaseOccurrenceCount).toBe(2);
  });

  it('display/presentation surfaces stay newest-200 bounded', () => {
    const displaySlice = buildNewestDisplaySlice(200);
    const oldStrong = buildOldStrongPurchases(2);
    const displayAnalytics =
      selectAnalyticsReceipts(displaySlice).analyticsReceipts;
    const fullAnalytics = selectAnalyticsReceipts([
      ...displaySlice,
      ...oldStrong,
    ]).analyticsReceipts;

    const experience = buildHomeProgressiveExperience(
      displayAnalytics,
      { status: unlockedStatus(fullAnalytics.length), currentResult: null },
      false,
      oldStrong.map((row, i) =>
        productRow(row.id, `x-${i}`, {
          occurredAt: row.transaction_at as number,
        })
      ),
      null,
      NEWEST_BASE + 300 * DAY_MS,
      fullAnalytics
    );

    expect(displayAnalytics).toHaveLength(200);
    expect(fullAnalytics.length).toBeGreaterThan(200);
    // latestPurchase is presentation-scoped to the display slice.
    expect(experience.latestPurchase?.receiptId).toMatch(/^new/);
    expect(oldStrong.map((r) => r.id)).not.toContain(
      experience.latestPurchase?.receiptId
    );
  });

  it('Home wires longTermAnalyticsReceipts into progressive builder', () => {
    const homeSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    const progressiveSource = fs.readFileSync(
      path.join(__dirname, 'homeProgressiveExperience.ts'),
      'utf8'
    );
    expect(homeSource).toContain('longTermAnalyticsReceipts');
    expect(homeSource).toMatch(
      /buildHomeProgressiveExperience\([\s\S]*longTermAnalyticsReceipts/
    );
    expect(progressiveSource).toContain('longTermAnalyticsReceipts');
    expect(progressiveSource).toContain(
      'buildRepeatProductProfiles(\n      args.longTermAnalyticsReceipts'
    );
  });
});
