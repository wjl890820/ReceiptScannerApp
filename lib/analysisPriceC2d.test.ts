/**
 * C2D — validation-only AP-3 gate + frozen period semantics.
 */
/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import fs from 'fs';
import path from 'path';

import {
  isAnalysisPriceChangesEnabled,
  setAnalysisPriceChangesEnabledForTests,
} from './analysisPriceChangesGate';
import {
  filterAnalysisTrustedPriceChangeCandidatesByCurrentEventPeriod,
  isCurrentPriceChangeEventInAnalysisPeriod,
} from './analysisPricePeriodEligibility';
import {
  bindPriceChangesToCycle,
  resolveBoundPriceChangesSurface,
} from './analysisPriceLoadCycle';
import {
  buildAnalysisPriceChangesSurface,
  type AnalysisPriceChangesSurface,
} from './analysisPriceSurfaces';
import type { AnalysisTrustedPriceChangeCandidate } from './analysisTrustedPriceChanges';
import {
  __resetAnalysisPriceSessionCacheForTests,
  buildAnalysisPriceSnapshotSignature,
  getAnalysisPriceDomainDerivationCount,
  readAnalysisPriceDomainCache,
  writeAnalysisPriceDomainCache,
} from './analysisPriceSessionCache';
import { createAnalysisPriceGeneration } from './analysisPriceScheduler';
import { scheduleDeriveAnalysisPriceDomain } from './analysisPriceDerivation';

const MS_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

function candidate(partial: {
  key: string;
  currentAt: number;
  previousAt: number;
  delta?: number;
}): AnalysisTrustedPriceChangeCandidate {
  const currentPrice = 360;
  const previousPrice = currentPrice - (partial.delta ?? 60);
  return {
    target: { type: 'sku', key: partial.key },
    displayName: partial.key,
    comparableOccurrenceCount: 2,
    latestOccurredAt: partial.currentAt,
    interpretation: {
      status: 'available',
      identityAuthority: 'sku',
      grossDirection: 'increased',
      grossDelta: partial.delta ?? 60,
      promoTransition: 'none',
      previousPromo: 'none_observed',
      currentPromo: 'none_observed',
      previousDiscountAllocated: null,
      currentDiscountAllocated: null,
      current: {
        receiptId: `cur-${partial.key}`,
        occurredAt: partial.currentAt,
        priceValue: currentPrice,
        grossLineAmount: currentPrice,
        purchaseQuantity: 1,
        currency: 'JPY',
        priceKind: 'unit',
        amountBasis: 'tax_included',
        promoContext: { markers: [], explicitDiscount: false },
        promoState: 'none_observed',
        discountAllocated: null,
        effectiveLineAmount: null,
        skuKey: partial.key,
      },
      previous: {
        receiptId: `prev-${partial.key}`,
        occurredAt: partial.previousAt,
        priceValue: previousPrice,
        grossLineAmount: previousPrice,
        purchaseQuantity: 1,
        currency: 'JPY',
        priceKind: 'unit',
        amountBasis: 'tax_included',
        promoContext: { markers: [], explicitDiscount: false },
        promoState: 'none_observed',
        discountAllocated: null,
        effectiveLineAmount: null,
        skuKey: partial.key,
      },
    },
  } as unknown as AnalysisTrustedPriceChangeCandidate;
}

describe('C2D AP-3 validation gate', () => {
  afterEach(() => {
    setAnalysisPriceChangesEnabledForTests(null);
    delete process.env.ENABLE_ANALYSIS_PRICE_CHANGES;
    delete process.env.EXPO_PUBLIC_ENABLE_ANALYSIS_PRICE_CHANGES;
  });

  it('A — OFF by default / missing env (fail closed)', () => {
    setAnalysisPriceChangesEnabledForTests(null);
    delete process.env.ENABLE_ANALYSIS_PRICE_CHANGES;
    delete process.env.EXPO_PUBLIC_ENABLE_ANALYSIS_PRICE_CHANGES;
    expect(isAnalysisPriceChangesEnabled()).toBe(false);
  });

  it('A2 — all non-validation eas profiles explicitly pin AP-3 OFF', () => {
    const eas = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../eas.json'), 'utf8')
    );
    expect(eas.build.validation.env.ENABLE_ANALYSIS_PRICE_CHANGES).toBe('true');
    expect(eas.build.production.env.ENABLE_ANALYSIS_PRICE_CHANGES).toBe('false');
    expect(eas.build.development.env.ENABLE_ANALYSIS_PRICE_CHANGES).toBe(
      'false'
    );
    expect(eas.build.preview.env.ENABLE_ANALYSIS_PRICE_CHANGES).toBe('false');
    for (const [name, profile] of Object.entries(eas.build) as [
      string,
      { env?: Record<string, string> },
    ][]) {
      const value = profile.env?.ENABLE_ANALYSIS_PRICE_CHANGES;
      expect(value).toBeDefined();
      if (name === 'validation') {
        expect(value).toBe('true');
      } else {
        expect(value).toBe('false');
      }
    }
  });

  it('B — ON only for validation configuration', () => {
    const eas = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../eas.json'), 'utf8')
    );
    expect(eas.build.validation.env.ENABLE_ANALYSIS_PRICE_CHANGES).toBe('true');
    setAnalysisPriceChangesEnabledForTests(true);
    expect(isAnalysisPriceChangesEnabled()).toBe(true);
  });

  it('B2 — exact-true only; aliases and unknowns fail closed', () => {
    const onValues = ['true', 'TRUE', ' true '];
    for (const value of onValues) {
      process.env.ENABLE_ANALYSIS_PRICE_CHANGES = value;
      expect(isAnalysisPriceChangesEnabled()).toBe(true);
    }

    const offValues = [
      'false',
      '1',
      'yes',
      'on',
      '0',
      'no',
      'off',
      '',
      'maybe',
      'TRUEISH',
      'enabled',
    ];
    for (const value of offValues) {
      process.env.ENABLE_ANALYSIS_PRICE_CHANGES = value;
      expect(isAnalysisPriceChangesEnabled()).toBe(false);
    }

    delete process.env.ENABLE_ANALYSIS_PRICE_CHANGES;
    delete process.env.EXPO_PUBLIC_ENABLE_ANALYSIS_PRICE_CHANGES;
    // No env/extra and no __DEV__ coupling in the gate ⇒ OFF.
    expect(isAnalysisPriceChangesEnabled()).toBe(false);
  });

  it('B3 — app.config maps env into extra with fail-closed default false', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app.config.js'),
      'utf8'
    );
    expect(source).toMatch(
      /ENABLE_ANALYSIS_PRICE_CHANGES:\s*[\s\S]*process\.env\.ENABLE_ANALYSIS_PRICE_CHANGES[\s\S]*\|\|[\s\S]*'false'/
    );
    expect(source).not.toMatch(
      /ENABLE_ANALYSIS_PRICE_CHANGES:[\s\S]{0,120}'true'/
    );
  });

  it('Analysis screen uses validation gate (not hardcoded false const)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('isAnalysisPriceChangesEnabled');
    expect(source).not.toContain(
      'ANALYSIS_PRICE_CHANGES_ENABLED = false'
    );
    expect(source).toContain('scheduleAnalysisPriceLoadAfterPaint');
  });
});

describe('C2D frozen period semantics', () => {
  it('C — current inside period + previous before period => included', () => {
    const currentAt = NOW - 10 * MS_DAY;
    const previousAt = NOW - 45 * MS_DAY;
    expect(
      isCurrentPriceChangeEventInAnalysisPeriod(currentAt, 'month', NOW)
    ).toBe(true);
    const filtered = filterAnalysisTrustedPriceChangeCandidatesByCurrentEventPeriod(
      [candidate({ key: 'milk', currentAt, previousAt })],
      'month',
      NOW
    );
    expect(filtered).toHaveLength(1);
    // Previous baseline is older than the 30d window — still kept.
    expect(filtered[0]!.interpretation.previous.occurredAt).toBe(previousAt);
    expect(filtered[0]!.interpretation.previous.occurredAt).toBeLessThan(
      NOW - 30 * MS_DAY
    );
  });

  it('D — current outside selected period => excluded', () => {
    const currentAt = NOW - 40 * MS_DAY;
    const previousAt = NOW - 50 * MS_DAY;
    expect(
      isCurrentPriceChangeEventInAnalysisPeriod(currentAt, 'month', NOW)
    ).toBe(false);
    const filtered = filterAnalysisTrustedPriceChangeCandidatesByCurrentEventPeriod(
      [candidate({ key: 'milk', currentAt, previousAt })],
      'month',
      NOW
    );
    expect(filtered).toHaveLength(0);
  });

  it('E — both events inside period => included', () => {
    const currentAt = NOW - 5 * MS_DAY;
    const previousAt = NOW - 12 * MS_DAY;
    const filtered = filterAnalysisTrustedPriceChangeCandidatesByCurrentEventPeriod(
      [candidate({ key: 'eggs', currentAt, previousAt })],
      'month',
      NOW
    );
    expect(filtered).toHaveLength(1);
  });

  it('F — range switch invalidates bound surface for prior range', () => {
    const surface: AnalysisPriceChangesSurface = {
      status: 'available',
      items: [
        {
          displayName: 'Milk',
          direction: 'up',
          deltaAmount: 60,
          currency: 'JPY',
          targetType: 'sku',
          targetKey: 'milk',
          promoBodyKey: null,
        },
      ],
    };
    const bindingMonth = bindPriceChangesToCycle(1, surface, 'month');
    expect(resolveBoundPriceChangesSurface(1, bindingMonth, 'month')).toEqual(
      surface
    );
    expect(resolveBoundPriceChangesSurface(1, bindingMonth, 'week')).toEqual({
      status: 'unavailable',
    });
  });

  it('G — global baseline history is not truncated by selected period', () => {
    // Surface filter only looks at current; previous may predate period.
    const rows = [
      candidate({
        key: 'a',
        currentAt: NOW - 10 * MS_DAY,
        previousAt: NOW - 100 * MS_DAY,
      }),
    ];
    const surface = buildAnalysisPriceChangesSurface(rows, 3, {
      range: 'month',
      nowMs: NOW,
    });
    expect(surface.status).toBe('available');
    // Domain signature excludes range — same truth reuses cache across periods.
    const sig = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'user:u',
      seedReceiptIds: ['r1'],
      receiptFingerprints: ['r1:1'],
      insightRowCount: 10,
    });
    const sigAgain = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'user:u',
      seedReceiptIds: ['r1'],
      receiptFingerprints: ['r1:1'],
      insightRowCount: 10,
    });
    expect(sig).toBe(sigAgain);
    expect(sig).not.toContain('month');
    expect(sig).not.toContain('week');
  });

  it('H — stale generation cannot apply after cancel', async () => {
    __resetAnalysisPriceSessionCacheForTests();
    const generation = createAnalysisPriceGeneration();
    generation.cancel();
    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:0'],
      generation,
      deferUntilPaint: false,
      period: { range: 'month', nowMs: NOW },
    }).promise;
    expect(result.status).toBe('canceled');
    expect(result.surface).toEqual({ status: 'unavailable' });
    expect(readAnalysisPriceDomainCache(result.signature)).toBeNull();
  });

  it('I — cache hit reuses global candidates; period only affects surface', async () => {
    __resetAnalysisPriceSessionCacheForTests();
    const cands = [
      candidate({
        key: 'milk',
        currentAt: NOW - 10 * MS_DAY,
        previousAt: NOW - 45 * MS_DAY,
      }),
      candidate({
        key: 'old',
        currentAt: NOW - 40 * MS_DAY,
        previousAt: NOW - 50 * MS_DAY,
      }),
    ];
    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'user:u',
      seedReceiptIds: ['r1'],
      receiptFingerprints: ['r1:1'],
      insightRowCount: 2,
    });
    writeAnalysisPriceDomainCache({
      signature,
      candidates: cands,
      generationMatches: true,
    });
    expect(getAnalysisPriceDomainDerivationCount()).toBe(1);

    const monthSurface = buildAnalysisPriceChangesSurface(cands, 3, {
      range: 'month',
      nowMs: NOW,
    });
    const weekSurface = buildAnalysisPriceChangesSurface(cands, 3, {
      range: 'week',
      nowMs: NOW,
    });
    expect(monthSurface.status).toBe('available');
    if (monthSurface.status === 'available') {
      expect(monthSurface.items.map((i) => i.targetKey)).toEqual(['milk']);
    }
    // 10 days ago is outside last 7 days.
    expect(weekSurface.status).toBe('unavailable');
    // Cache entry still holds both candidates (global).
    expect(readAnalysisPriceDomainCache(signature)?.candidates).toHaveLength(2);
  });
});
