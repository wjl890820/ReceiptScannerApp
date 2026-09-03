import {
  REPEAT_DAY_MS,
  type RepeatProductProfile,
} from './repeatProductProfile';
import {
  NEXT_PURCHASE_DEFAULT_LIMIT,
  buildNextPurchaseCandidates,
  formatNextPurchaseDaysSinceForDisplay,
  formatNextPurchaseMedianDaysForDisplay,
  medianSortedNumbers,
} from './nextPurchaseCandidates';

const DAY = REPEAT_DAY_MS;
/** B1/B2 reject non-positive timestamps — never use epoch 0 in fixtures. */
const T0 = 1_700_000_000_000;

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
    ...(overrides.totalPurchaseQuantity != null
      ? { totalPurchaseQuantity: overrides.totalPurchaseQuantity }
      : {}),
    ...(overrides.merchantSummary
      ? { merchantSummary: overrides.merchantSummary }
      : {}),
  };
}

describe('nextPurchaseCandidates domain', () => {
  it('median helper is deterministic', () => {
    expect(medianSortedNumbers([7, 10, 7])).toBe(7);
    expect(medianSortedNumbers([7, 10])).toBe(8.5);
  });

  it('A. regular cadence → likely_due at ratio 1', () => {
    const dates = [atDay(0), atDay(7), atDay(14), atDay(21)];
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-regular',
          displayName: 'Regular Milk',
          purchaseEventDates: dates,
        }),
      ],
      { now: atDay(28) }
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.cadence.medianIntervalDays).toBe(7);
    expect(result[0]!.cadence.daysSinceLastPurchase).toBe(7);
    expect(result[0]!.cadence.cadenceRatio).toBe(1);
    expect(result[0]!.state).toBe('likely_due');
    expect(formatNextPurchaseMedianDaysForDisplay(7)).toBe(7);
    expect(formatNextPurchaseDaysSinceForDisplay(7)).toBe(7);
  });

  it('B. too early → no candidate', () => {
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-early',
          displayName: 'Early',
          purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
        }),
      ],
      { now: atDay(23) }
    );
    expect(result).toHaveLength(0);
  });

  it('C. stale 肉まん-style → excluded', () => {
    const last = atDay(0);
    const dates = [atDay(-21), atDay(-14), atDay(-7), last];
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-nikuman',
          displayName: '肉まん',
          purchaseEventDates: dates,
          purchaseOccurrenceCount: 8,
        }),
      ],
      { now: atDay(160) }
    );
    expect(result).toHaveLength(0);
  });

  it('D. irregular intervals → excluded by MAD gate', () => {
    // intervals: 2, 38, 3, 57
    const dates = [
      atDay(0),
      atDay(2),
      atDay(2 + 38),
      atDay(2 + 38 + 3),
      atDay(2 + 38 + 3 + 57),
    ];
    const last = dates[dates.length - 1]!;
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-irregular',
          displayName: 'Irregular',
          purchaseEventDates: dates,
        }),
      ],
      { now: last + 20 * DAY }
    );
    expect(result).toHaveLength(0);
  });

  it('E. moderately variable cadence may remain candidate', () => {
    const dates = [atDay(0), atDay(6), atDay(13), atDay(21), atDay(28)];
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-moderate',
          displayName: 'Moderate',
          purchaseEventDates: dates,
        }),
      ],
      { now: atDay(28) + 7 * DAY }
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.cadence.normalizedIntervalMad).toBeLessThanOrEqual(0.75);
    expect(result[0]!.state).toBe('likely_due');
  });

  it('F. two dated purchases → no candidate', () => {
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-two',
          displayName: 'Two',
          purchaseEventDates: [atDay(0), atDay(7)],
        }),
      ],
      { now: atDay(14) }
    );
    expect(result).toHaveLength(0);
  });

  it('G. three dated purchases eligible for cadence evaluation', () => {
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-three',
          displayName: 'Three',
          purchaseEventDates: [atDay(0), atDay(7), atDay(14)],
        }),
      ],
      { now: atDay(21) }
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.cadence.windowEventCount).toBe(3);
    expect(result[0]!.cadence.intervalSampleSize).toBe(2);
    expect(result[0]!.state).toBe('likely_due');
  });

  it('H. future lastPurchasedAt → excluded', () => {
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-future',
          displayName: 'Future',
          purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(30)],
        }),
      ],
      { now: atDay(21) }
    );
    expect(result).toHaveLength(0);
  });

  it('I. near-zero median → excluded', () => {
    const dates = [atDay(0), T0 + 0.1 * DAY, T0 + 0.2 * DAY, T0 + 0.3 * DAY];
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-zero',
          displayName: 'Burst',
          purchaseEventDates: dates,
        }),
      ],
      { now: T0 + 0.4 * DAY }
    );
    expect(result).toHaveLength(0);
  });

  it('J. same-day separate purchases handled by median safety', () => {
    const sameDay = atDay(14);
    const dates = [atDay(0), atDay(7), sameDay, sameDay, atDay(21)];
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-sameday',
          displayName: 'SameDay',
          purchaseEventDates: dates,
          purchaseOccurrenceCount: 5,
        }),
      ],
      { now: atDay(28) }
    );
    for (const candidate of result) {
      expect(candidate.cadence.medianIntervalDays).toBeGreaterThanOrEqual(0.5);
      expect(candidate.cadence.normalizedIntervalMad).toBeLessThanOrEqual(0.75);
    }
  });

  it('K. recent window uses only last max 5 events', () => {
    const dates = [
      atDay(0),
      atDay(30),
      atDay(60),
      atDay(100),
      atDay(107),
      atDay(114),
      atDay(121),
      atDay(128),
    ];
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-window',
          displayName: 'Windowed',
          purchaseEventDates: dates,
          purchaseOccurrenceCount: dates.length,
        }),
      ],
      { now: atDay(135) }
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.cadence.windowEventCount).toBe(5);
    expect(result[0]!.cadence.medianIntervalDays).toBe(7);
    expect(result[0]!.cadence.daysSinceLastPurchase).toBe(7);
  });

  it('L. proximity to ratio 1 outranks much later candidates', () => {
    const near = profile({
      identityKey: 'a',
      displayName: 'A',
      purchaseEventDates: [atDay(0), atDay(10), atDay(20), atDay(30)],
    });
    const far = profile({
      identityKey: 'b',
      displayName: 'B',
      purchaseEventDates: [atDay(-10), atDay(0), atDay(10), atDay(20)],
    });
    const ranked = buildNextPurchaseCandidates([far, near], {
      now: atDay(40),
    });
    expect(ranked.map((c) => c.identityKey)).toEqual(['a', 'b']);
    expect(Math.abs(ranked[0]!.cadence.cadenceRatio - 1)).toBeLessThan(
      Math.abs(ranked[1]!.cadence.cadenceRatio - 1)
    );
  });

  it('M. cap exactly 5 deterministic results', () => {
    const profiles = Array.from({ length: 8 }, (_, i) =>
      profile({
        identityKey: `mp-${i}`,
        displayName: `Product ${String(i).padStart(2, '0')}`,
        purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
      })
    );
    const result = buildNextPurchaseCandidates(profiles, { now: atDay(28) });
    expect(result).toHaveLength(NEXT_PURCHASE_DEFAULT_LIMIT);
    expect(result.map((c) => c.identityKey)).toEqual([
      'mp-0',
      'mp-1',
      'mp-2',
      'mp-3',
      'mp-4',
    ]);
  });

  it('N. deterministic now → identical output', () => {
    const profiles = [
      profile({
        identityKey: 'mp-det',
        displayName: 'Det',
        purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
      }),
    ];
    const a = buildNextPurchaseCandidates(profiles, { now: atDay(28) });
    const b = buildNextPurchaseCandidates(profiles, { now: atDay(28) });
    expect(a).toEqual(b);
  });

  it('O. えのき / えのき茸 remain independent — no merge', () => {
    const enoki = profile({
      identityKey: 'mp-enoki',
      displayName: 'えのき',
      purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
    });
    const enokiTake = profile({
      identityKey: 'mp-enoki-take',
      displayName: 'えのき茸',
      purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
    });
    const result = buildNextPurchaseCandidates([enoki, enokiTake], {
      now: atDay(28),
    });
    expect(result).toHaveLength(2);
    expect(new Set(result.map((c) => c.identityKey))).toEqual(
      new Set(['mp-enoki', 'mp-enoki-take'])
    );
  });

  it('P. personal SAME → one candidate', () => {
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKind: 'personal_product',
          identityKey: 'pp-anchor',
          displayName: 'コカ・コーラ 500ml',
          purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
          purchaseOccurrenceCount: 4,
        }),
      ],
      { now: atDay(28) }
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.identityKind).toBe('personal_product');
    expect(result[0]!.identityKey).toBe('pp-anchor');
  });

  it('approaching state when 0.75 <= ratio < 1', () => {
    const result = buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-approach',
          displayName: 'Approach',
          purchaseEventDates: [atDay(0), atDay(10), atDay(20), atDay(30)],
        }),
      ],
      { now: atDay(30) + 8 * DAY }
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe('approaching');
    expect(result[0]!.cadence.cadenceRatio).toBeCloseTo(0.8);
  });

  it('does not call Date.now — injected now only', () => {
    const spy = jest.spyOn(Date, 'now');
    buildNextPurchaseCandidates(
      [
        profile({
          identityKey: 'mp-now',
          displayName: 'Now',
          purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
        }),
      ],
      { now: atDay(28) }
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('nextPurchaseCandidates presentation helpers', () => {
  it('rounds median and floors days-since for copy only', () => {
    expect(formatNextPurchaseMedianDaysForDisplay(7.4)).toBe(7);
    expect(formatNextPurchaseMedianDaysForDisplay(7.5)).toBe(8);
    expect(formatNextPurchaseDaysSinceForDisplay(9.9)).toBe(9);
  });
});

describe('nextPurchaseCandidates B1 consumption guard', () => {
  /* eslint-disable import/first -- local require keeps this suite lightweight */
  it('feeds only B1 Repeat SSOT output into candidates (no second purchase pipeline)', () => {
    const domainSource = require('fs').readFileSync(
      require('path').resolve(__dirname, 'nextPurchaseCandidates.ts'),
      'utf8'
    );
    expect(domainSource).toContain('RepeatProductProfile');
    expect(domainSource).not.toMatch(/selectAnalyticsReceipts|resolveReceiptItemIdentity/);
    expect(domainSource).not.toMatch(/family_only|productFamilyKey/);
  });

  it('1L vs 500ml Repeat profiles stay independent candidates when both eligible', () => {
    const oneL = profile({
      identityKey: 'mp-1l',
      displayName: '牛乳 1L',
      purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
    });
    const half = profile({
      identityKey: 'mp-500',
      displayName: '牛乳 500ml',
      purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
    });
    const result = buildNextPurchaseCandidates([oneL, half], {
      now: atDay(28),
    });
    expect(result).toHaveLength(2);
    expect(new Set(result.map((c) => c.identityKey))).toEqual(
      new Set(['mp-1l', 'mp-500'])
    );
  });
});
