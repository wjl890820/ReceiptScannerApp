/**
 * Next Purchase readiness label — presentation-only from existing candidate.state.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  REPEAT_DAY_MS,
  type RepeatProductProfile,
} from './repeatProductProfile';
import {
  buildNextPurchaseCandidates,
  type NextPurchaseCandidate,
  type NextPurchaseState,
} from './nextPurchaseCandidates';
import { formatNextPurchaseReadinessLabel } from './nextPurchaseReadinessPresentation';

const DAY_MS = REPEAT_DAY_MS;
/** B1/B2 reject non-positive timestamps — never use epoch 0 in fixtures. */
const T0 = 1_700_000_000_000;

function atDay(day: number): number {
  return T0 + day * DAY_MS;
}

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

function translate(
  key: string,
  _params?: Record<string, string | number>
): string {
  if (key === 'home.progressive.nextPurchase.approaching') {
    return 'Approaching your usual purchase time';
  }
  if (key === 'home.progressive.nextPurchase.likelyDue') {
    return 'Around your usual purchase time';
  }
  return key;
}

function profile(
  overrides: Partial<RepeatProductProfile> &
    Pick<
      RepeatProductProfile,
      'identityKey' | 'displayName' | 'purchaseEventDates'
    >
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

describe('Next Purchase readiness presentation', () => {
  it('1 — approaching state maps to approaching label', () => {
    expect(
      formatNextPurchaseReadinessLabel('approaching', translate)
    ).toBe('Approaching your usual purchase time');
  });

  it('2 — likely_due state maps to due label', () => {
    expect(
      formatNextPurchaseReadinessLabel('likely_due', translate)
    ).toBe('Around your usual purchase time');
  });

  it('3 — missing / unsupported state renders no label', () => {
    expect(formatNextPurchaseReadinessLabel(null, translate)).toBeNull();
    expect(formatNextPurchaseReadinessLabel(undefined, translate)).toBeNull();
    expect(
      formatNextPurchaseReadinessLabel(
        'unknown' as NextPurchaseState,
        translate
      )
    ).toBeNull();
    expect(
      formatNextPurchaseReadinessLabel('' as NextPurchaseState, translate)
    ).toBeNull();
  });

  it('4 — readiness is consumed from candidate.state, not recomputed in UI', () => {
    const list = read('components/home/HomeNextPurchaseList.tsx');
    const helper = read('lib/nextPurchaseReadinessPresentation.ts');
    expect(list).toContain('formatNextPurchaseReadinessLabel');
    expect(list).toContain('candidate.state');
    expect(list).not.toMatch(/daysSinceLast\s*>=/);
    expect(list).not.toMatch(/daysSince\s*>=\s*median/);
    expect(list).not.toMatch(/cadenceRatio/);
    expect(list).not.toContain('NEXT_PURCHASE_EARLY_RATIO');
    expect(list).not.toContain('NEXT_PURCHASE_STALE_RATIO');
    expect(list).not.toContain('resolveState');
    expect(helper).not.toMatch(/daysSinceLastPurchase/);
    expect(helper).not.toMatch(/medianIntervalDays/);
    expect(helper).not.toMatch(/cadenceRatio/);
    expect(helper).toContain("state === 'approaching'");
    expect(helper).toContain("state === 'likely_due'");
  });

  it('5 — candidate ordering is unchanged by presentation helper', () => {
    const now = atDay(30) + 8 * DAY_MS;
    const profiles = [
      profile({
        identityKey: 'mp:approach',
        displayName: 'Approach Milk',
        purchaseEventDates: [atDay(0), atDay(10), atDay(20), atDay(30)],
      }),
      profile({
        identityKey: 'mp:due',
        displayName: 'Due Milk',
        purchaseEventDates: [atDay(0), atDay(7), atDay(14), atDay(21)],
      }),
    ];
    const first = buildNextPurchaseCandidates(profiles, { now });
    const second = buildNextPurchaseCandidates(profiles, { now });
    expect(first.map((c) => `${c.identityKind}:${c.identityKey}`)).toEqual(
      second.map((c) => `${c.identityKind}:${c.identityKey}`)
    );
    expect(first.map((c) => c.state).sort()).toEqual(
      ['approaching', 'likely_due'].sort()
    );
    const labeledIds = first.map((c: NextPurchaseCandidate) => {
      formatNextPurchaseReadinessLabel(c.state, translate);
      return `${c.identityKind}:${c.identityKey}`;
    });
    expect(labeledIds).toEqual(
      first.map((c) => `${c.identityKind}:${c.identityKey}`)
    );
  });

  it('6 — Shopping List Add behavior remains unchanged', () => {
    const list = read('components/home/HomeNextPurchaseList.tsx');
    expect(list).toContain('onAddToShoppingList(candidate)');
    expect(list).toContain('shoppingListIdentityKey');
    const home = read('app/(tabs)/index.tsx');
    expect(home).toContain('addShoppingListItemFromNextPurchase');
    expect(home).toContain('handleAddNextPurchaseToShoppingList');
  });

  it('7 — Product Detail navigation remains unchanged', () => {
    const list = read('components/home/HomeNextPurchaseList.tsx');
    expect(list).toContain('onPress(candidate)');
    expect(list).toContain('styles.contentHit');
    const home = read('app/(tabs)/index.tsx');
    expect(home).toContain('handleNextPurchasePress');
  });

  it('8 — locale keys exist in en / ja / zh', () => {
    for (const locale of ['en', 'ja', 'zh'] as const) {
      const json = JSON.parse(read(`locales/${locale}.json`));
      expect(json.home.progressive.nextPurchase.approaching).toBeTruthy();
      expect(json.home.progressive.nextPurchase.likelyDue).toBeTruthy();
    }
    expect(
      JSON.parse(read('locales/en.json')).home.progressive.nextPurchase
        .approaching
    ).toBe('Approaching your usual purchase time');
    expect(
      JSON.parse(read('locales/en.json')).home.progressive.nextPurchase
        .likelyDue
    ).toBe('Around your usual purchase time');
    expect(
      JSON.parse(read('locales/ja.json')).home.progressive.nextPurchase
        .approaching
    ).toBe('いつもの購入時期が近づいています');
    expect(
      JSON.parse(read('locales/ja.json')).home.progressive.nextPurchase
        .likelyDue
    ).toBe('いつもの購入時期です');
    expect(
      JSON.parse(read('locales/zh.json')).home.progressive.nextPurchase
        .approaching
    ).toBe('接近你通常购买的时间');
    expect(
      JSON.parse(read('locales/zh.json')).home.progressive.nextPurchase
        .likelyDue
    ).toBe('到了你通常购买的时间');
  });
});
