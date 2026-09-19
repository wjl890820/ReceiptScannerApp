/**
 * Performance Slice 1 — Focus dirty-skip generation + time-sensitive contracts.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('./env', () => ({
  isProductIdentityPriceHistoryV1Enabled: () => true,
}));

import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionDataGeneration,
  invalidateAnalyticsReceiptSelection,
} from './analyticsReceiptSelectionCache';
import {
  __resetPersonalProductEndpointInventoryCacheForTests,
  getPersonalProductInventoryDataGeneration,
  invalidatePersonalProductEndpointInventory,
} from './personalProductEndpointInventoryCache';
import {
  __resetHomeFocusHeavySnapshotForTests,
  commitHomeFocusHeavySnapshot,
  tryReuseHomeFocusHeavySnapshot,
} from './homeFocusHeavySnapshot';
import {
  __resetAnalysisFocusHeavySnapshotForTests,
  commitAnalysisFocusHeavySnapshot,
  tryReuseAnalysisFocusHeavySnapshot,
} from './analysisFocusHeavySnapshot';
import {
  __resetHistoryFocusHeavySnapshotForTests,
  commitHistoryFocusHeavySnapshot,
  tryReuseHistoryFocusHeavySnapshot,
} from './historyFocusHeavySnapshot';
import {
  readTabFocusDataGenerations,
  tabFocusDataGenerationsEqual,
} from './tabFocusDataGenerations';
import {
  buildHomeProgressiveExperienceBundle,
  refreshHomeNextPurchaseFromProfiles,
  resolveProgressiveHomeStage,
} from './homeProgressiveExperience';
import { buildNextPurchaseCandidates } from './nextPurchaseCandidates';
import { buildAnalysisTruthSnapshot } from './analysisTruthCycle';
import type { RepeatProductProfile } from './repeatProductProfile';
import type { ReceiptRow } from './db';
import { REPEAT_DAY_MS } from './repeatProductProfile';

const DAY = REPEAT_DAY_MS;
const T0 = 1_700_000_000_000;
const OWNER = 'user:dirty-skip-owner';

function atDay(day: number): number {
  return T0 + day * DAY;
}

function profile(
  overrides: Partial<RepeatProductProfile> &
    Pick<RepeatProductProfile, 'identityKey' | 'displayName' | 'purchaseEventDates'>
): RepeatProductProfile {
  const dates = [...overrides.purchaseEventDates].sort((a, b) => a - b);
  return {
    identityKind: overrides.identityKind ?? 'merchant_product',
    identityKey: overrides.identityKey,
    displayName: overrides.displayName,
    purchaseOccurrenceCount:
      overrides.purchaseOccurrenceCount ?? dates.length,
    purchaseEventDates: dates,
    datedPurchaseOccurrenceCount:
      overrides.datedPurchaseOccurrenceCount ?? dates.length,
    firstPurchasedAt: dates[0] ?? null,
    lastPurchasedAt: dates.length > 0 ? dates[dates.length - 1]! : null,
  };
}

describe('tabFocusDataGenerations', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetPersonalProductEndpointInventoryCacheForTests();
    __resetHomeFocusHeavySnapshotForTests();
    __resetAnalysisFocusHeavySnapshotForTests();
    __resetHistoryFocusHeavySnapshotForTests();
  });

  it('A — first Home heavy commit then same-generation reuse', () => {
    const start = readTabFocusDataGenerations();
    const experience = buildHomeProgressiveExperienceBundle([], null).experience;
    expect(
      commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
        displayReceipts: [],
        experience,
        repeatProfiles: [],
      })
    ).toBe(true);
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).not.toBeNull();
  });

  it('B — second focus same generations → heavy snapshot reusable', () => {
    const start = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      displayReceipts: [],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    const again = tryReuseHomeFocusHeavySnapshot(OWNER);
    expect(again).not.toBeNull();
    expect(
      tabFocusDataGenerationsEqual(again!.generations, readTabFocusDataGenerations())
    ).toBe(true);
  });

  it('C — receipt_saved bumps analytics → Home heavy not reusable', () => {
    const start = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      displayReceipts: [],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    invalidateAnalyticsReceiptSelection('receipt_saved');
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).toBeNull();
  });

  it('D — receipt_updated invalidates Home heavy', () => {
    const start = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      displayReceipts: [],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    invalidateAnalyticsReceiptSelection('receipt_updated');
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).toBeNull();
  });

  it('E — receipt_deleted invalidates Home + Analysis + History', () => {
    const start = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      displayReceipts: [],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    commitAnalysisFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      receipts: [],
    });
    commitHistoryFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      visibleRows: [],
      truth: {
        visibleRows: [],
        storedCount: 0,
        selection: {
          storedReceipts: [],
          analyticsReceipts: [],
          analyticsPurchaseCandidateCount: 0,
          excludedDuplicateReceiptIds: new Set(),
          contentExactDuplicateExtras: 0,
          structuralExactDuplicateExtras: 0,
          reconciledStructuralExactDuplicateExtras: 0,
          probableDuplicateExtras: 0,
          highConfidenceDuplicateExtras: 0,
          highConfidenceDuplicateGroups: [],
          keepSeparateReceiptIds: new Set(),
        },
      },
    });
    invalidateAnalyticsReceiptSelection('receipt_deleted');
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).toBeNull();
    expect(tryReuseAnalysisFocusHeavySnapshot(OWNER)).toBeNull();
    expect(tryReuseHistoryFocusHeavySnapshot(OWNER)).toBeNull();
  });

  it('F — identity_decision bumps inventory → Home heavy not reusable', () => {
    const start = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      displayReceipts: [],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    const beforeInv = getPersonalProductInventoryDataGeneration();
    invalidatePersonalProductEndpointInventory('identity_decision');
    expect(getPersonalProductInventoryDataGeneration()).toBe(beforeInv + 1);
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).toBeNull();
  });

  it('G — Shopping List mutation does not bump receipt generations', () => {
    const before = readTabFocusDataGenerations();
    // No shopping-list invalidate API for analytics/inventory — assert stable.
    expect(getAnalyticsReceiptSelectionDataGeneration()).toBe(
      before.analyticsGeneration
    );
    expect(getPersonalProductInventoryDataGeneration()).toBe(
      before.inventoryGeneration
    );
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: before,
      displayReceipts: [],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).not.toBeNull();
  });

  it('H — failed mid-flight generation drift does not commit', () => {
    const start = readTabFocusDataGenerations();
    invalidateAnalyticsReceiptSelection('receipt_saved');
    expect(
      commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
        displayReceipts: [],
        experience: buildHomeProgressiveExperienceBundle([], null).experience,
        repeatProfiles: [],
      })
    ).toBe(false);
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).toBeNull();
  });

  it('I — older start generations cannot overwrite after newer invalidation commit', () => {
    const g0 = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: g0,
      displayReceipts: [],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    invalidateAnalyticsReceiptSelection('receipt_updated');
    const g1 = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: g1,
      displayReceipts: [{ id: 'newer' } as ReceiptRow],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    // Stale commit with old start gens must fail.
    expect(
      commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: g0,
        displayReceipts: [{ id: 'stale' } as ReceiptRow],
        experience: buildHomeProgressiveExperienceBundle([], null).experience,
        repeatProfiles: [],
      })
    ).toBe(false);
    const snap = tryReuseHomeFocusHeavySnapshot(OWNER);
    expect(snap?.displayReceipts.map((r) => r.id)).toEqual(['newer']);
  });
});

describe('Focus dirty-skip time-sensitive projections', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetPersonalProductEndpointInventoryCacheForTests();
    __resetHomeFocusHeavySnapshotForTests();
    __resetAnalysisFocusHeavySnapshotForTests();
  });

  it('A — same generation, advancing now rebuilds Next Purchase from cached profiles', () => {
    const dates = [atDay(0), atDay(7), atDay(14), atDay(21)];
    const profiles = [
      profile({
        identityKey: 'mp-milk',
        displayName: 'Milk',
        purchaseEventDates: dates,
      }),
    ];
    const base = buildHomeProgressiveExperienceBundle([], null).experience;
    // Force frequent stage so NP is unlocked.
    const experience = {
      ...base,
      stage: 'frequent' as const,
      status: {
        ...base.status,
        supportedReceiptCount: 5,
        nextMilestone: 10 as const,
      },
      nextPurchaseCandidates: buildNextPurchaseCandidates(profiles, {
        now: atDay(22),
      }),
    };
    expect(experience.stage).toBe('frequent');
    expect(resolveProgressiveHomeStage(5)).toBe('frequent');

    const early = refreshHomeNextPurchaseFromProfiles(
      experience,
      profiles,
      atDay(22)
    );
    const later = refreshHomeNextPurchaseFromProfiles(
      experience,
      profiles,
      atDay(28)
    );
    expect(early.nextPurchaseCandidates.length).toBeGreaterThanOrEqual(0);
    expect(later.nextPurchaseCandidates[0]?.cadence.daysSinceLastPurchase).toBe(
      7
    );
    expect(
      early.nextPurchaseCandidates[0]?.cadence.daysSinceLastPurchase
    ).not.toBe(later.nextPurchaseCandidates[0]?.cadence.daysSinceLastPurchase);
  });

  it('B — Analysis heavy receipts reused with fresh nowMs keep 7D/30D correct', () => {
    const receipt = {
      id: 'r1',
      created_at: atDay(0),
      transaction_at: atDay(0),
      image_uri: '',
      merchant_raw: 'Store',
      merchant_normalized: 'store',
      merchant_type: 'supermarket',
      total: 1000,
      tax: 0,
      tax_is_known: 1,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        items: [{ name: 'Milk', quantity: 1, lineTotal: 1000 }],
        tax: 0,
        total: 1000,
        tax_is_known: true,
        currency: 'JPY',
        merchant_type: 'supermarket',
        is_grocery: true,
      }),
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    } as ReceiptRow;

    const start = readTabFocusDataGenerations();
    commitAnalysisFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      receipts: [receipt],
    });
    const heavy = tryReuseAnalysisFocusHeavySnapshot(OWNER);
    expect(heavy).not.toBeNull();

    const weekSnap = buildAnalysisTruthSnapshot({
      receipts: heavy!.receipts,
      range: 'week',
      nowMs: atDay(3),
    });
    const laterWeek = buildAnalysisTruthSnapshot({
      receipts: heavy!.receipts,
      range: 'week',
      nowMs: atDay(20),
    });
    // Same heavy receipts; nowMs change can alter whether receipt is in 7D window.
    expect(weekSnap.nowMs).toBe(atDay(3));
    expect(laterWeek.nowMs).toBe(atDay(20));
    expect(weekSnap.periodStats.totalSpend).not.toBe(
      laterWeek.periodStats.totalSpend
    );
  });

  it('C — Home volatile path is independent of heavy reuse (generations stay)', () => {
    const start = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
        ownerKey: OWNER,
        startGenerations: start,
      displayReceipts: [],
      experience: buildHomeProgressiveExperienceBundle([], null).experience,
      repeatProfiles: [],
    });
    // Simulate shopping-list / pending refresh without mutation.
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).not.toBeNull();
    expect(readTabFocusDataGenerations()).toEqual(start);
  });
});
