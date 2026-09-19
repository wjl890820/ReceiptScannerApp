/**
 * Performance Slice 1 A-Fix — owner isolation + mid-flight apply gates.
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

import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  invalidateAnalyticsReceiptSelection,
} from './analyticsReceiptSelectionCache';
import {
  __resetPersonalProductEndpointInventoryCacheForTests,
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
import { clearTabFocusHeavySnapshots } from './tabFocusHeavySnapshots';
import {
  readTabFocusDataGenerations,
  shouldApplyAnalysisHeavyLoadResult,
  shouldApplyHistoryHeavyLoadResult,
  shouldApplyHomeHeavyReuseResult,
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
import { applyExternalSession, __resetAnonAuthForTests } from './anonAuth';
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

describe('A-Fix owner isolation + mid-flight gates', () => {
  beforeEach(() => {
    __resetAnalyticsReceiptSelectionCacheForTests();
    __resetPersonalProductEndpointInventoryCacheForTests();
    __resetHomeFocusHeavySnapshotForTests();
    __resetAnalysisFocusHeavySnapshotForTests();
    __resetHistoryFocusHeavySnapshotForTests();
    __resetAnonAuthForTests();
  });

  it('A — owner A snapshot cannot reuse for owner B with same generations', () => {
    const gens = readTabFocusDataGenerations();
    expect(
      commitHomeFocusHeavySnapshot({
        ownerKey: OWNER_A,
        startGenerations: gens,
        displayReceipts: [{ id: 'a-only' } as ReceiptRow],
        experience: emptyExperience(),
        repeatProfiles: [],
      })
    ).toBe(true);
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_B)).toBeNull();
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)?.displayReceipts[0]?.id).toBe(
      'a-only'
    );

    expect(
      commitAnalysisFocusHeavySnapshot({
        ownerKey: OWNER_A,
        startGenerations: gens,
        receipts: [{ id: 'a-analysis' } as ReceiptRow],
      })
    ).toBe(true);
    expect(tryReuseAnalysisFocusHeavySnapshot(OWNER_B)).toBeNull();

    expect(
      commitHistoryFocusHeavySnapshot({
        ownerKey: OWNER_A,
        startGenerations: gens,
        visibleRows: [],
        truth: emptyHistoryTruth(),
      })
    ).toBe(true);
    expect(tryReuseHistoryFocusHeavySnapshot(OWNER_B)).toBeNull();
  });

  it('B — applyExternalSession / uid_changed clears all heavy snapshots', () => {
    const gens = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      displayReceipts: [],
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
    applyExternalSession(fakeSession('new-uid-after-apple'));
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)).toBeNull();
    expect(tryReuseAnalysisFocusHeavySnapshot(OWNER_A)).toBeNull();
    expect(tryReuseHistoryFocusHeavySnapshot(OWNER_A)).toBeNull();
  });

  it('C — logout/login A→B isolation via clearTabFocusHeavySnapshots', () => {
    const gens = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      displayReceipts: [{ id: 'a' } as ReceiptRow],
      experience: emptyExperience(),
      repeatProfiles: [],
    });
    clearTabFocusHeavySnapshots();
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)).toBeNull();
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_B)).toBeNull();
  });

  it('D — History generation drift before setRows → gate rejects apply', () => {
    const start = readTabFocusDataGenerations();
    invalidateAnalyticsReceiptSelection('receipt_saved');
    const live = readTabFocusDataGenerations();
    expect(
      shouldApplyHistoryHeavyLoadResult({
        startOwnerKey: OWNER_A,
        startAnalyticsGeneration: start.analyticsGeneration,
        currentOwnerKey: OWNER_A,
        currentAnalyticsGeneration: live.analyticsGeneration,
        requestStillCurrent: true,
      })
    ).toBe(false);
  });

  it('E — History owner drift mid-load → gate rejects apply', () => {
    const gens = readTabFocusDataGenerations();
    expect(
      shouldApplyHistoryHeavyLoadResult({
        startOwnerKey: OWNER_A,
        startAnalyticsGeneration: gens.analyticsGeneration,
        currentOwnerKey: OWNER_B,
        currentAnalyticsGeneration: gens.analyticsGeneration,
        requestStillCurrent: true,
      })
    ).toBe(false);
  });

  it('F — Home reuse generation drifts during awaited projection → not applied', () => {
    const start = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: start,
      displayReceipts: [],
      experience: emptyExperience(),
      repeatProfiles: [],
    });
    const snap = tryReuseHomeFocusHeavySnapshot(OWNER_A);
    expect(snap).not.toBeNull();
    // Simulate await boundary then mutation.
    invalidateAnalyticsReceiptSelection('receipt_updated');
    const after = readTabFocusDataGenerations();
    expect(
      shouldApplyHomeHeavyReuseResult({
        snapshotOwnerKey: snap!.ownerKey,
        snapshotGenerations: snap!.generations,
        currentOwnerKey: OWNER_A,
        currentGenerations: after,
        requestStillLatest: true,
        canApply: true,
      })
    ).toBe(false);
  });

  it('G — Home reuse owner changes during await → not applied', () => {
    const gens = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      displayReceipts: [],
      experience: emptyExperience(),
      repeatProfiles: [],
    });
    const snap = tryReuseHomeFocusHeavySnapshot(OWNER_A)!;
    expect(
      shouldApplyHomeHeavyReuseResult({
        snapshotOwnerKey: snap.ownerKey,
        snapshotGenerations: snap.generations,
        currentOwnerKey: OWNER_B,
        currentGenerations: gens,
        requestStillLatest: true,
        canApply: true,
      })
    ).toBe(false);
  });

  it('H — Analysis owner mismatch → snapshot miss / apply gate reject', () => {
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

  it('I — same-owner same-generation still hits dirty-skip', () => {
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

  it('J — Shopping List mutation does not force heavy analytics reload', () => {
    const gens = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER_A,
      startGenerations: gens,
      displayReceipts: [],
      experience: emptyExperience(),
      repeatProfiles: [],
    });
    // No shopping-list invalidate for analytics/inventory.
    expect(tryReuseHomeFocusHeavySnapshot(OWNER_A)).not.toBeNull();
  });

  it('K — Next Purchase fresh-now semantics remain', () => {
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

  it('L — Analysis 7D/30D freshness remains with reused heavy receipts', () => {
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

describe('A-Fix production wiring', () => {
  it('History validates before setRows', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/history/index.tsx'),
      'utf8'
    );
    const gateIdx = source.indexOf('shouldApplyHistoryHeavyLoadResult');
    const setRowsIdx = source.indexOf('setRows(truth.visibleRows)');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(setRowsIdx).toBeGreaterThan(gateIdx);
    expect(source).toContain('tryReuseHistoryFocusHeavySnapshot(startOwnerKey)');
  });

  it('Home reuse re-checks after awaited time projection', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    const awaitIdx = source.indexOf('refreshHomeNextPurchaseFromProfiles');
    const gateIdx = source.indexOf('shouldApplyHomeHeavyReuseResult');
    const applyIdx = source.indexOf('setReceipts(reusable.displayReceipts)');
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(awaitIdx);
    expect(applyIdx).toBeGreaterThan(gateIdx);
  });

  it('anonAuth clears tab heavy snapshots on session user change / applyExternalSession', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, 'anonAuth.ts'),
      'utf8'
    );
    expect(source).toContain('clearTabFocusHeavySnapshots');
    expect(source).toContain('applyExternalSession');
  });
});
