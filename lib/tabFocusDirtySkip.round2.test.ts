/**
 * Performance Slice 1 A-Fix Round 2 —
 * mounted owner-state remount + Home final apply + retryable fallback.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('./env', () => ({
  isProductIdentityPriceHistoryV1Enabled: () => true,
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const map = new Map<string, string>();
  return {
    getItem: jest.fn(async (key: string) => (map.has(key) ? map.get(key)! : null)),
    setItem: jest.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
  };
});

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: {} })),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  applyExternalSession,
  getAuthSessionLifecycleRevision,
  __resetAnonAuthForTests,
} from './anonAuth';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  invalidateAnalyticsReceiptSelection,
} from './analyticsReceiptSelectionCache';
import { __resetPersonalProductEndpointInventoryCacheForTests } from './personalProductEndpointInventoryCache';
import {
  __resetHomeFocusHeavySnapshotForTests,
  commitHomeFocusHeavySnapshot,
  getHomeFocusHeavySnapshot,
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
import { clearTabFocusHeavySnapshots } from './tabFocusHeavySnapshots';
import {
  readTabFocusDataGenerations,
  shouldApplyAnalysisHeavyLoadResult,
  shouldApplyHistoryHeavyLoadResult,
  shouldApplyHomeHeavyReuseResult,
  shouldBlessHomeHeavySnapshot,
} from './tabFocusDataGenerations';
import {
  buildHomeProgressiveExperienceBundle,
  refreshHomeNextPurchaseFromProfiles,
} from './homeProgressiveExperience';
import { buildNextPurchaseCandidates } from './nextPurchaseCandidates';
import { buildAnalysisTruthSnapshot } from './analysisTruthCycle';
import type { RepeatProductProfile } from './repeatProductProfile';
import { REPEAT_DAY_MS } from './repeatProductProfile';
import type { ReceiptRow } from './db';
import type { Session } from '@supabase/supabase-js';

const DAY = REPEAT_DAY_MS;
const T0 = 1_700_000_000_000;
const OWNER_A = 'user:owner-a';
const OWNER_B = 'user:owner-b';

function atDay(day: number): number {
  return T0 + day * DAY;
}

function emptyExperience() {
  return buildHomeProgressiveExperienceBundle([], null).experience;
}

function emptyHistoryTruth() {
  return {
    visibleRows: [] as never[],
    storedCount: 0,
    selection: {
      storedReceipts: [],
      analyticsReceipts: [],
      analyticsPurchaseCandidateCount: 0,
      excludedDuplicateReceiptIds: new Set<string>(),
      contentExactDuplicateExtras: 0,
      structuralExactDuplicateExtras: 0,
      reconciledStructuralExactDuplicateExtras: 0,
      probableDuplicateExtras: 0,
      highConfidenceDuplicateExtras: 0,
      highConfidenceDuplicateGroups: [],
      keepSeparateReceiptIds: new Set<string>(),
    },
  };
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
    purchaseOccurrenceCount: overrides.purchaseOccurrenceCount ?? dates.length,
    purchaseEventDates: dates,
    datedPurchaseOccurrenceCount:
      overrides.datedPurchaseOccurrenceCount ?? dates.length,
    firstPurchasedAt: dates[0] ?? null,
    lastPurchasedAt: dates.length > 0 ? dates[dates.length - 1]! : null,
  };
}

function fakeSession(userId: string): Session {
  return {
    access_token: 'tok',
    refresh_token: 'ref',
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: userId,
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '',
      identities: [],
    },
  } as unknown as Session;
}

/**
 * Models mounted tab React state bound to session lifecycle revision.
 * When revision changes (remount), old content is no longer presentable.
 */
function presentMountedTabContent(
  mounted: { revision: number; ownerContent: string } | null,
  liveRevision: number
): string | null {
  if (!mounted || mounted.revision !== liveRevision) return null;
  return mounted.ownerContent;
}

describe('A-Fix Round 2 — mounted owner-state + final apply + fallback', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetPersonalProductEndpointInventoryCacheForTests();
    __resetHomeFocusHeavySnapshotForTests();
    __resetAnalysisFocusHeavySnapshotForTests();
    __resetHistoryFocusHeavySnapshotForTests();
    __resetAnonAuthForTests();
  });

  it('A — mounted Home state does not survive A→B as B-owned content', () => {
    const revA = getAuthSessionLifecycleRevision();
    let mountedHome: { revision: number; ownerContent: string } | null = {
      revision: revA,
      ownerContent: 'home-owner-A',
    };
    expect(presentMountedTabContent(mountedHome, revA)).toBe('home-owner-A');

    applyExternalSession(fakeSession('owner-b'));
    const revB = getAuthSessionLifecycleRevision();
    expect(revB).toBeGreaterThan(revA);
    // Remount: new mount starts empty until B load resolves.
    mountedHome = { revision: revB, ownerContent: '' };
    expect(presentMountedTabContent(mountedHome, revB)).toBe('');
    expect(presentMountedTabContent({ revision: revA, ownerContent: 'home-owner-A' }, revB)).toBeNull();

    mountedHome = { revision: revB, ownerContent: 'home-owner-B' };
    expect(presentMountedTabContent(mountedHome, revB)).toBe('home-owner-B');
  });

  it('B — mounted Analysis state does not survive A→B', () => {
    const revA = getAuthSessionLifecycleRevision();
    const mounted = { revision: revA, ownerContent: 'analysis-A-truth' };
    applyExternalSession(fakeSession('owner-b'));
    const revB = getAuthSessionLifecycleRevision();
    expect(presentMountedTabContent(mounted, revB)).toBeNull();
  });

  it('C — mounted History rows/truth do not survive A→B', () => {
    const revA = getAuthSessionLifecycleRevision();
    const mounted = { revision: revA, ownerContent: 'history-A-rows' };
    applyExternalSession(fakeSession('owner-b'));
    expect(
      presentMountedTabContent(mounted, getAuthSessionLifecycleRevision())
    ).toBeNull();
  });

  it('D — uid_changed path invalidates lifecycle + clears heavy snapshots', () => {
    const gens = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      displayReceipts: [{ id: 'a' } as ReceiptRow],
      experience: emptyExperience(),
      repeatProfiles: [],
    });
    commitAnalysisFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      receipts: [],
    });
    commitHistoryFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      visibleRows: [],
      truth: emptyHistoryTruth(),
    });
    const before = getAuthSessionLifecycleRevision();
    applyExternalSession(fakeSession('new-uid-after-apple'));
    expect(getAuthSessionLifecycleRevision()).toBeGreaterThan(before);
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)).toBeNull();
    expect(tryReuseAnalysisFocusHeavySnapshot(OWNER_A)).toBeNull();
    expect(tryReuseHistoryFocusHeavySnapshot(OWNER_A)).toBeNull();

    const tabsLayout = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/_layout.tsx'),
      'utf8'
    );
    expect(tabsLayout).toContain('getAuthSessionLifecycleRevision');
    expect(tabsLayout).toContain('key={sessionLifecycleRevision}');
    expect(tabsLayout).toContain('subscribeAuthState');
  });

  it('E — Home uncached heavy: request superseded after final owner await → no apply', () => {
    const gens = readTabFocusDataGenerations();
    expect(
      shouldApplyHomeHeavyReuseResult({
        snapshotOwnerKey: OWNER_A,
        snapshotGenerations: gens,
        currentOwnerKey: OWNER_A,
        currentGenerations: gens,
        requestStillLatest: false,
        canApply: true,
      })
    ).toBe(false);
  });

  it('F — Home uncached heavy: screen hidden after final owner await → no apply', () => {
    const gens = readTabFocusDataGenerations();
    expect(
      shouldApplyHomeHeavyReuseResult({
        snapshotOwnerKey: OWNER_A,
        snapshotGenerations: gens,
        currentOwnerKey: OWNER_A,
        currentGenerations: gens,
        requestStillLatest: true,
        canApply: false,
      })
    ).toBe(false);
  });

  it('G — cold progressive analytics failure → fallback displayable, NO heavy commit', () => {
    expect(
      shouldBlessHomeHeavySnapshot({ progressiveAnalyticsSucceeded: false })
    ).toBe(false);
    const gens = readTabFocusDataGenerations();
    // Simulate: UI may show analyticsUnavailable, but bless gate blocks commit.
    if (
      shouldBlessHomeHeavySnapshot({ progressiveAnalyticsSucceeded: false })
    ) {
      commitHomeFocusHeavySnapshot({
        ownerKey: OWNER_A,
        startGenerations: gens,
        displayReceipts: [],
        experience: buildHomeProgressiveExperienceBundle([], null, true).experience,
        repeatProfiles: [],
      });
    }
    expect(getHomeFocusHeavySnapshot()).toBeNull();
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)).toBeNull();
  });

  it('H — second same-generation focus retries after cold failure (no dirty-skip)', () => {
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)).toBeNull();
    const gens = readTabFocusDataGenerations();
    // Focus #2 after failed bless: still no snapshot → must run heavy again.
    expect(getHomeFocusHeavySnapshot()).toBeNull();
    expect(
      shouldBlessHomeHeavySnapshot({ progressiveAnalyticsSucceeded: true })
    ).toBe(true);
    expect(
      commitHomeFocusHeavySnapshot({
        ownerKey: OWNER_A,
        startGenerations: gens,
        displayReceipts: [],
        experience: emptyExperience(),
        repeatProfiles: [],
      })
    ).toBe(true);
  });

  it('I — successful retry then caches normally', () => {
    const gens = readTabFocusDataGenerations();
    expect(
      commitHomeFocusHeavySnapshot({
        ownerKey: OWNER_A,
        startGenerations: gens,
        displayReceipts: [{ id: 'ok' } as ReceiptRow],
        experience: emptyExperience(),
        repeatProfiles: [],
      })
    ).toBe(true);
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)?.displayReceipts[0]?.id).toBe(
      'ok'
    );
  });

  it('J — normal same-owner same-generation dirty-skip still hits', () => {
    const gens = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      displayReceipts: [],
      experience: emptyExperience(),
      repeatProfiles: [],
    });
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)).not.toBeNull();
    commitAnalysisFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      receipts: [],
    });
    expect(tryReuseAnalysisFocusHeavySnapshot(OWNER_A)).not.toBeNull();
    commitHistoryFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      visibleRows: [],
      truth: emptyHistoryTruth(),
    });
    expect(tryReuseHistoryFocusHeavySnapshot(OWNER_A)).not.toBeNull();
  });

  it('K — Home reuse generation/owner drift still rejected', () => {
    const start = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: start,
      displayReceipts: [],
      experience: emptyExperience(),
      repeatProfiles: [],
    });
    const snap = tryReuseHomeFocusHeavySnapshot(OWNER_A)!;
    invalidateAnalyticsReceiptSelection('receipt_updated');
    expect(
      shouldApplyHomeHeavyReuseResult({
        snapshotOwnerKey: snap.ownerKey,
        snapshotGenerations: snap.generations,
        currentOwnerKey: OWNER_A,
        currentGenerations: readTabFocusDataGenerations(),
        requestStillLatest: true,
        canApply: true,
      })
    ).toBe(false);
    expect(
      shouldApplyHomeHeavyReuseResult({
        snapshotOwnerKey: snap.ownerKey,
        snapshotGenerations: start,
        currentOwnerKey: OWNER_B,
        currentGenerations: start,
        requestStillLatest: true,
        canApply: true,
      })
    ).toBe(false);
  });

  it('L — History generation/owner drift still rejected', () => {
    const start = readTabFocusDataGenerations();
    invalidateAnalyticsReceiptSelection('receipt_saved');
    expect(
      shouldApplyHistoryHeavyLoadResult({
        startOwnerKey: OWNER_A,
        startAnalyticsGeneration: start.analyticsGeneration,
        currentOwnerKey: OWNER_A,
        currentAnalyticsGeneration:
          readTabFocusDataGenerations().analyticsGeneration,
        requestStillCurrent: true,
      })
    ).toBe(false);
    expect(
      shouldApplyHistoryHeavyLoadResult({
        startOwnerKey: OWNER_A,
        startAnalyticsGeneration: start.analyticsGeneration,
        currentOwnerKey: OWNER_B,
        currentAnalyticsGeneration: start.analyticsGeneration,
        requestStillCurrent: true,
      })
    ).toBe(false);
  });

  it('M — Analysis owner/generation safety remains', () => {
    const gens = readTabFocusDataGenerations();
    commitAnalysisFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      receipts: [],
    });
    expect(tryReuseAnalysisFocusHeavySnapshot(OWNER_B)).toBeNull();
    expect(
      shouldApplyAnalysisHeavyLoadResult({
        startOwnerKey: OWNER_A,
        startGenerations: gens,
        currentOwnerKey: OWNER_B,
        currentGenerations: gens,
        requestStillCurrent: true,
      })
    ).toBe(false);
  });

  it('N — Next Purchase time freshness remains', () => {
    const dates = [atDay(0), atDay(7), atDay(14), atDay(21)];
    const profiles = [
      profile({
        identityKey: 'mp-milk',
        displayName: 'Milk',
        purchaseEventDates: dates,
      }),
    ];
    const experience = {
      ...emptyExperience(),
      stage: 'frequent' as const,
      nextPurchaseCandidates: buildNextPurchaseCandidates(profiles, {
        now: atDay(22),
      }),
    };
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
    expect(later.nextPurchaseCandidates[0]?.cadence.daysSinceLastPurchase).toBe(
      7
    );
    expect(
      early.nextPurchaseCandidates[0]?.cadence.daysSinceLastPurchase
    ).not.toBe(later.nextPurchaseCandidates[0]?.cadence.daysSinceLastPurchase);
  });

  it('O — Analysis range freshness remains', () => {
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
    } as unknown as ReceiptRow;
    const gens = readTabFocusDataGenerations();
    commitAnalysisFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      receipts: [receipt],
    });
    const heavy = tryReuseAnalysisFocusHeavySnapshot(OWNER_A)!;
    const weekSnap = buildAnalysisTruthSnapshot({
      receipts: heavy.receipts,
      range: 'week',
      nowMs: atDay(3),
    });
    const laterWeek = buildAnalysisTruthSnapshot({
      receipts: heavy.receipts,
      range: 'week',
      nowMs: atDay(20),
    });
    expect(weekSnap.periodStats.totalSpend).not.toBe(
      laterWeek.periodStats.totalSpend
    );
  });
});

describe('A-Fix Round 2 production wiring', () => {
  it('Home uncached final apply uses real requestStillLatest/canApply (no hardcoded true)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    expect(source).not.toMatch(
      /shouldApplyHomeHeavyReuseResult\(\{[\s\S]*?requestStillLatest:\s*true[\s\S]*?canApply:\s*true/
    );
    expect(source).toContain('shouldBlessHomeHeavySnapshot');
    expect(source).toContain('progressiveAnalyticsSucceeded');
    const liveOwnerIdx = source.lastIndexOf(
      'const liveOwnerScope = await resolveCurrentLocalReceiptOwnerScope()'
    );
    const requestStillIdx = source.indexOf(
      'const requestStillLatest = isLatestHomeRefresh(',
      liveOwnerIdx
    );
    const canApplyIdx = source.indexOf(
      'const canApply = canApplyHomeUi(options)',
      liveOwnerIdx
    );
    const gateIdx = source.indexOf(
      'shouldApplyHomeHeavyReuseResult({',
      liveOwnerIdx
    );
    const commitIdx = source.indexOf(
      'commitHomeFocusHeavySnapshot({',
      liveOwnerIdx
    );
    expect(requestStillIdx).toBeGreaterThan(liveOwnerIdx);
    expect(canApplyIdx).toBeGreaterThan(requestStillIdx);
    expect(gateIdx).toBeGreaterThan(canApplyIdx);
    expect(commitIdx).toBeGreaterThan(gateIdx);
    expect(source.indexOf('shouldBlessHomeHeavySnapshot', liveOwnerIdx)).toBeGreaterThan(
      gateIdx
    );
  });

  it('anonAuth bumps session lifecycle revision on applyExternalSession', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'anonAuth.ts'),
      'utf8'
    );
    expect(source).toContain('bumpSessionLifecycleRevision');
    expect(source).toContain('getAuthSessionLifecycleRevision');
    expect(source).toContain('_sessionLifecycleRevision');
  });

  it('owner A cold fallback disappears on session change to B', () => {
    const revA = getAuthSessionLifecycleRevision();
    const fallbackMounted = {
      revision: revA,
      ownerContent: 'analyticsUnavailable-A',
    };
    applyExternalSession(fakeSession('owner-b'));
    expect(
      presentMountedTabContent(
        fallbackMounted,
        getAuthSessionLifecycleRevision()
      )
    ).toBeNull();
    clearTabFocusHeavySnapshots();
  });
});
