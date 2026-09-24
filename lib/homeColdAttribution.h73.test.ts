/**
 * Home Performance H7.3 — Repeat cold-path substage attribution.
 * Instrumentation only — no Repeat / identity / occurrence semantic change.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./env', () => ({
  isProductIdentityPriceHistoryV1Enabled: () => true,
}));

import type { ReceiptRow } from './db';
import type { EngagementProductRow } from './engagementMilestones';
import {
  __setHomeRepeatSurfacesTestHooksForTests,
  buildHomeProgressiveExperienceBundle,
} from './homeProgressiveExperience';
import {
  beginHomeRefreshTimingCapture,
  enableHomeRefreshTimingsForTests,
  endHomeRefreshTimingCapture,
  type HomeRefreshTimingSample,
  type HomeRefreshTimingStage,
} from './homeRefreshTimings';
import { buildNextPurchaseCandidates } from './nextPurchaseCandidates';
import {
  buildRepeatProductProfiles,
  type RepeatProductProfile,
} from './repeatProductProfile';
import * as fs from 'fs';
import * as path from 'path';

const DAY_MS = 24 * 60 * 60 * 1000;

const REPEAT_CHILD_STAGES: HomeRefreshTimingStage[] = [
  'repeat.occurrence',
  'repeat.identity',
  'repeat.safeFilter',
  'repeat.personalOverlay',
  'repeat.mpIndexBuild',
  'repeat.mpProfiles',
  'repeat.profileSort',
  'repeat.nextPurchase',
];

function privacyKeysOf(sample: HomeRefreshTimingSample): string[] {
  return Object.keys(sample).filter(
    (k) =>
      ![
        'stage',
        'durationMs',
        'success',
        'rowCount',
        'itemRowCount',
        'receiptCount',
        'decisionCount',
        'inputRowCount',
        'outputRowCount',
        'resolvedRowCount',
        'analyticsReceiptCount',
        'productRowCount',
        'cacheState',
        'safeQualifiedCount',
        'safeMpTargetCount',
        'personalProfileCount',
        'suppressedMpCount',
        'finalProfileCount',
        'mpIndexRowVisits',
        'mpBucketLookups',
      ].includes(k)
  );
}

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow {
  const index = Number(String(id).replace(/\D/g, '')) || 1;
  const transactionAt =
    overrides.transaction_at === undefined
      ? index * DAY_MS
      : overrides.transaction_at;
  const precision =
    overrides.transaction_time_precision ??
    (transactionAt == null ? 'unknown' : 'second');
  return {
    id,
    created_at: index * DAY_MS,
    transaction_at: transactionAt,
    transaction_time_precision: precision,
    image_uri: '',
    total: 100,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [],
      transaction_time_precision: precision,
    }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: 'h73-owner',
    installation_id: null,
    ...overrides,
  };
}

function productRow(
  receiptId: string,
  itemId: string,
  overrides: Partial<EngagementProductRow> = {}
): EngagementProductRow {
  const index = Number(String(receiptId).replace(/\D/g, '')) || 1;
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    occurredAt: index * DAY_MS,
    merchantRaw: 'イオン',
    merchantNormalized: 'イオン',
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

function frequentEvaluation(count: number) {
  return {
    status: {
      supportedReceiptCount: count,
      currentMilestone: count >= 10 ? (10 as const) : (5 as const),
      justUnlocked: null,
      nextMilestone: count >= 10 ? null : (10 as const),
      receiptsUntilNext: count >= 10 ? null : 10 - count,
    },
    currentResult: null,
  };
}

beforeEach(() => {
  enableHomeRefreshTimingsForTests(true);
  beginHomeRefreshTimingCapture();
});

afterEach(() => {
  endHomeRefreshTimingCapture();
  enableHomeRefreshTimingsForTests(false);
});

describe('H7.3 Repeat cold-path substage attribution', () => {
  it('emits parent repeatBuild once and each child stage once on frequent path', () => {
    const receipts = [1, 2, 3, 4, 5].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows: EngagementProductRow[] = [
      productRow('r1', 'cola', {
        displayName: 'Cola 500ml',
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'cola', {
        displayName: 'Cola 500ml',
        occurredAt: 2 * DAY_MS,
      }),
      productRow('r3', 'cola', {
        displayName: 'Cola 500ml',
        occurredAt: 3 * DAY_MS,
      }),
      productRow('r1', 'milk', {
        displayName: 'Milk 1L',
        sourceIndex: 1,
        occurredAt: DAY_MS,
      }),
      productRow('r4', 'milk', {
        displayName: 'Milk 1L',
        occurredAt: 4 * DAY_MS,
      }),
    ];

    const bundle = buildHomeProgressiveExperienceBundle(
      receipts,
      frequentEvaluation(5),
      false,
      rows,
      null,
      10 * DAY_MS,
      receipts
    );
    expect(bundle.experience.stage).toBe('frequent');
    expect(bundle.repeatProfiles.length).toBeGreaterThan(0);

    const samples = endHomeRefreshTimingCapture();
    const parent = samples.filter(
      (s) => s.stage === 'home.progressive.repeatBuild'
    );
    expect(parent).toHaveLength(1);
    expect(parent[0]!.success).toBe(true);

    for (const stage of REPEAT_CHILD_STAGES) {
      const hits = samples.filter((s) => s.stage === stage);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.success).toBe(true);
      expect(privacyKeysOf(hits[0]!)).toEqual([]);
    }

    const sortSample = samples.find((s) => s.stage === 'repeat.profileSort')!;
    expect(typeof sortSample.safeQualifiedCount).toBe('number');
    expect(typeof sortSample.safeMpTargetCount).toBe('number');
    expect(typeof sortSample.finalProfileCount).toBe('number');
    expect(typeof sortSample.mpIndexRowVisits).toBe('number');
    expect(typeof sortSample.mpBucketLookups).toBe('number');
    expect(sortSample.mpIndexRowVisits).toBe(sortSample.safeQualifiedCount);
    expect(sortSample.finalProfileCount).toBe(bundle.repeatProfiles.length);

    const indexSample = samples.find((s) => s.stage === 'repeat.mpIndexBuild')!;
    expect(indexSample.mpIndexRowVisits).toBe(sortSample.safeQualifiedCount);

    const occurrence = samples.find((s) => s.stage === 'repeat.occurrence')!;
    expect(['fresh', 'prepared', 'prebuilt']).toContain(occurrence.cacheState);
  });

  it('does not emit Repeat substages when frequent stage is locked', () => {
    buildHomeProgressiveExperienceBundle(
      [receipt('r1')],
      null,
      false,
      [],
      null
    );
    const samples = endHomeRefreshTimingCapture();
    expect(
      samples.some((s) => s.stage === 'home.progressive.repeatBuild')
    ).toBe(false);
    for (const stage of REPEAT_CHILD_STAGES) {
      expect(samples.some((s) => s.stage === stage)).toBe(false);
    }
  });

  it('instrumentation does not change profiles or Next Purchase vs timing-off', () => {
    const receipts = [1, 2, 3].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows: EngagementProductRow[] = [
      productRow('r1', 'item', {
        displayName: 'Same Item',
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'item', {
        displayName: 'Same Item',
        occurredAt: 2 * DAY_MS,
      }),
      productRow('r3', 'item', {
        displayName: 'Same Item',
        occurredAt: 3 * DAY_MS,
      }),
    ];
    const now = 10 * DAY_MS;

    enableHomeRefreshTimingsForTests(true);
    beginHomeRefreshTimingCapture();
    const withTiming = buildRepeatProductProfiles(receipts, rows);
    endHomeRefreshTimingCapture();

    enableHomeRefreshTimingsForTests(false);
    const withoutTiming = buildRepeatProductProfiles(receipts, rows);

    expect(withTiming).toEqual(withoutTiming);
    expect(buildNextPurchaseCandidates(withTiming, { now })).toEqual(
      buildNextPurchaseCandidates(withoutTiming, { now })
    );
  });

  it('preserves H7.2 indexed vs baseline differential under instrumentation', () => {
    const receipts = [1, 2, 3, 4].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows: EngagementProductRow[] = [
      productRow('r1', 'a', { displayName: 'Alpha', occurredAt: DAY_MS }),
      productRow('r2', 'a', { displayName: 'Alpha', occurredAt: 2 * DAY_MS }),
      productRow('r1', 'b', {
        displayName: 'Beta',
        sourceIndex: 1,
        occurredAt: DAY_MS,
      }),
      productRow('r3', 'b', { displayName: 'Beta', occurredAt: 3 * DAY_MS }),
    ];

    enableHomeRefreshTimingsForTests(true);
    beginHomeRefreshTimingCapture();
    const indexed: RepeatProductProfile[] = buildRepeatProductProfiles(
      receipts,
      rows,
      { __useMerchantProductObservationIndexForTests: true }
    );
    const baseline: RepeatProductProfile[] = buildRepeatProductProfiles(
      receipts,
      rows,
      { __useMerchantProductObservationIndexForTests: false }
    );
    endHomeRefreshTimingCapture();

    expect(indexed).toEqual(baseline);
  });
});

describe('H7.3a restore frequent → Next Purchase execution order', () => {
  function buildHomeRepeatSurfacesSourceBlock(): string {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'homeProgressiveExperience.ts'),
      'utf8'
    );
    const start = source.indexOf('function buildHomeRepeatSurfaces');
    const end = source.indexOf(
      'export type HomeProgressiveExperienceBuildResult'
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('success order in source: profiles → frequentProducts → timed Next Purchase', () => {
    const block = buildHomeRepeatSurfacesSourceBlock();
    const profilesIdx = block.indexOf('buildRepeatProductProfiles(');
    const frequentIdx = block.indexOf(
      'const frequentProducts = takeHomeRepeatProducts'
    );
    const nextTimerIdx = block.indexOf("'repeat.nextPurchase'");
    const nextBuildIdx = block.indexOf(
      'buildNextPurchaseCandidatesBound(allProfiles'
    );
    expect(profilesIdx).toBeGreaterThan(-1);
    expect(frequentIdx).toBeGreaterThan(-1);
    expect(nextTimerIdx).toBeGreaterThan(-1);
    expect(nextBuildIdx).toBeGreaterThan(-1);
    expect(profilesIdx).toBeLessThan(frequentIdx);
    expect(frequentIdx).toBeLessThan(nextTimerIdx);
    expect(nextTimerIdx).toBeLessThan(nextBuildIdx);
  });

  it('timings on/off preserve the same baseline statement order', () => {
    const timingsSource = fs.readFileSync(
      path.resolve(__dirname, 'homeRefreshTimings.ts'),
      'utf8'
    );
    expect(timingsSource).toMatch(
      /if \(!isHomeRefreshTimingEnabled\(\)\) \{\s*return work\(\);/
    );
    const block = buildHomeRepeatSurfacesSourceBlock();
    const frequentIdx = block.indexOf(
      'const frequentProducts = takeHomeRepeatProducts'
    );
    const nextIdx = block.indexOf("'repeat.nextPurchase'");
    expect(frequentIdx).toBeLessThan(nextIdx);
  });
});

describe('H7.3b behavioral presentation-failure regression', () => {
  afterEach(() => {
    __setHomeRepeatSurfacesTestHooksForTests(null);
  });

  function fixtureWithRepeatProfiles() {
    // Stage authority: resolveProgressiveHomeStage(5) === 'frequent' → Repeat unlocked.
    const receipts = [1, 2, 3, 4, 5].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows: EngagementProductRow[] = [
      productRow('r1', 'item', {
        displayName: 'Same Item',
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'item', {
        displayName: 'Same Item',
        occurredAt: 2 * DAY_MS,
      }),
      productRow('r3', 'item', {
        displayName: 'Same Item',
        occurredAt: 3 * DAY_MS,
      }),
      productRow('r4', 'item', {
        displayName: 'Same Item',
        occurredAt: 4 * DAY_MS,
      }),
      productRow('r5', 'item', {
        displayName: 'Same Item',
        occurredAt: 5 * DAY_MS,
      }),
    ];
    return { receipts, rows };
  }

  function runWithPresentationThrow(timingsOn: boolean) {
    const { receipts, rows } = fixtureWithRepeatProfiles();
    let presentationCallCount = 0;
    let nextPurchaseCallCount = 0;

    __setHomeRepeatSurfacesTestHooksForTests({
      mapFrequentProduct: () => {
        presentationCallCount += 1;
        throw new Error('H7.3b forced frequent presentation failure');
      },
      buildNextPurchaseCandidates: (...args) => {
        nextPurchaseCallCount += 1;
        return buildNextPurchaseCandidates(...args);
      },
    });

    enableHomeRefreshTimingsForTests(timingsOn);
    beginHomeRefreshTimingCapture();
    const bundle = buildHomeProgressiveExperienceBundle(
      receipts,
      frequentEvaluation(5),
      false,
      rows,
      null,
      10 * DAY_MS,
      receipts
    );
    const samples = endHomeRefreshTimingCapture();
    enableHomeRefreshTimingsForTests(false);

    return {
      bundle,
      samples,
      presentationCallCount,
      nextPurchaseCallCount,
    };
  }

  it('presentation throw: Next Purchase not called, no successful repeat.nextPurchase, baseline empty fallback', () => {
    const {
      bundle,
      samples,
      presentationCallCount,
      nextPurchaseCallCount,
    } = runWithPresentationThrow(true);

    // Must have entered unlocked Repeat / buildHomeRepeatSurfaces.
    expect(bundle.experience.stage).toBe('frequent');
    expect(presentationCallCount).toBe(1);
    expect(nextPurchaseCallCount).toBe(0);

    const npTiming = samples.filter((s) => s.stage === 'repeat.nextPurchase');
    expect(npTiming).toHaveLength(0);

    // buildHomeRepeatSurfaces catches and returns baseline empty surfaces.
    expect(bundle.experience.frequentProducts).toEqual([]);
    expect(bundle.experience.nextPurchaseCandidates).toEqual([]);
    expect(bundle.repeatProfiles).toEqual([]);
  });

  it('timing-disabled: same fallback and Next Purchase still not called', () => {
    const { bundle, presentationCallCount, nextPurchaseCallCount } =
      runWithPresentationThrow(false);
    expect(bundle.experience.stage).toBe('frequent');
    expect(presentationCallCount).toBe(1);
    expect(nextPurchaseCallCount).toBe(0);
    expect(bundle.experience.frequentProducts).toEqual([]);
    expect(bundle.experience.nextPurchaseCandidates).toEqual([]);
    expect(bundle.repeatProfiles).toEqual([]);
  });
});
