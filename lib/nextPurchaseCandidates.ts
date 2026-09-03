/**
 * Next Purchase V0 (Shopping Loop B2).
 *
 * Deterministic replenishment candidates from Repeat V1 profiles.
 * PURE / RECOMPUTABLE — no DB, React, network, or Date.now().
 */

import {
  REPEAT_DAY_MS,
  type RepeatProductIdentityKind,
  type RepeatProductProfile,
} from './repeatProductProfile';

export const NEXT_PURCHASE_RECENT_EVENT_LIMIT = 5 as const;
export const NEXT_PURCHASE_MIN_DATED_EVENTS = 3 as const;
export const NEXT_PURCHASE_MIN_MEDIAN_INTERVAL_DAYS = 0.5 as const;
export const NEXT_PURCHASE_MAX_NORMALIZED_MAD = 0.75 as const;
export const NEXT_PURCHASE_EARLY_RATIO = 0.75 as const;
export const NEXT_PURCHASE_STALE_RATIO = 2.5 as const;
export const NEXT_PURCHASE_DEFAULT_LIMIT = 5 as const;

export type NextPurchaseState = 'approaching' | 'likely_due';

export type NextPurchaseCadenceFacts = {
  medianIntervalDays: number;
  daysSinceLastPurchase: number;
  cadenceRatio: number;
  intervalSampleSize: number;
  windowEventCount: number;
  /** Eligibility diagnostic only — never expose statistical terminology in UI. */
  normalizedIntervalMad: number;
};

export type NextPurchaseCandidate = {
  identityKind: RepeatProductIdentityKind;
  identityKey: string;
  displayName: string;
  purchaseOccurrenceCount: number;
  lastPurchasedAt: number;
  previousPurchasedAt: number | null;
  cadence: NextPurchaseCadenceFacts;
  state: NextPurchaseState;
};

export type BuildNextPurchaseCandidatesOptions = {
  now: number;
  limit?: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Deterministic mathematical median (no premature rounding). */
export function medianSortedNumbers(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Presentation helpers — domain keeps fractional cadence; UI may round/floor.
 */
export function formatNextPurchaseMedianDaysForDisplay(
  medianIntervalDays: number
): number {
  return Math.round(medianIntervalDays);
}

export function formatNextPurchaseDaysSinceForDisplay(
  daysSinceLastPurchase: number
): number {
  return Math.floor(daysSinceLastPurchase);
}

function takeRecentCadenceDates(
  purchaseEventDates: readonly number[]
): number[] | null {
  if (!Array.isArray(purchaseEventDates) || purchaseEventDates.length === 0) {
    return null;
  }
  for (const ts of purchaseEventDates) {
    if (!isFiniteNumber(ts) || ts <= 0) return null;
  }
  const recent = purchaseEventDates.slice(-NEXT_PURCHASE_RECENT_EVENT_LIMIT);
  if (recent.length < NEXT_PURCHASE_MIN_DATED_EVENTS) return null;
  return recent;
}

function buildConsecutiveIntervalsDays(
  recentDates: readonly number[]
): number[] | null {
  const intervals: number[] = [];
  for (let i = 1; i < recentDates.length; i += 1) {
    const delta = recentDates[i]! - recentDates[i - 1]!;
    if (!isFiniteNumber(delta) || delta < 0) return null;
    intervals.push(delta / REPEAT_DAY_MS);
  }
  return intervals;
}

function resolveState(cadenceRatio: number): NextPurchaseState | null {
  if (cadenceRatio < NEXT_PURCHASE_EARLY_RATIO) return null;
  if (cadenceRatio > NEXT_PURCHASE_STALE_RATIO) return null;
  if (cadenceRatio < 1) return 'approaching';
  return 'likely_due';
}

function evaluateProfile(
  profile: RepeatProductProfile,
  now: number
): NextPurchaseCandidate | null {
  if (!isFiniteNumber(now) || now <= 0) return null;

  const recentDates = takeRecentCadenceDates(profile.purchaseEventDates);
  if (!recentDates) return null;

  const lastPurchasedAt = recentDates[recentDates.length - 1]!;
  if (lastPurchasedAt > now) return null;

  const intervals = buildConsecutiveIntervalsDays(recentDates);
  if (!intervals || intervals.length === 0) return null;

  const medianIntervalDays = medianSortedNumbers(intervals);
  if (
    !isFiniteNumber(medianIntervalDays) ||
    medianIntervalDays < NEXT_PURCHASE_MIN_MEDIAN_INTERVAL_DAYS
  ) {
    return null;
  }

  const absoluteDeviations = intervals.map((interval) =>
    Math.abs(interval - medianIntervalDays)
  );
  const medianAbsoluteDeviation = medianSortedNumbers(absoluteDeviations);
  if (!isFiniteNumber(medianAbsoluteDeviation)) return null;
  const normalizedIntervalMad = medianAbsoluteDeviation / medianIntervalDays;
  if (
    !isFiniteNumber(normalizedIntervalMad) ||
    normalizedIntervalMad > NEXT_PURCHASE_MAX_NORMALIZED_MAD
  ) {
    return null;
  }

  const daysSinceLastPurchase = (now - lastPurchasedAt) / REPEAT_DAY_MS;
  if (!isFiniteNumber(daysSinceLastPurchase) || daysSinceLastPurchase < 0) {
    return null;
  }

  const cadenceRatio = daysSinceLastPurchase / medianIntervalDays;
  if (!isFiniteNumber(cadenceRatio)) return null;

  const state = resolveState(cadenceRatio);
  if (!state) return null;

  const displayName = profile.displayName.trim();
  if (!displayName) return null;
  const identityKey = profile.identityKey.trim();
  if (!identityKey) return null;
  if (
    profile.identityKind !== 'merchant_product' &&
    profile.identityKind !== 'personal_product'
  ) {
    return null;
  }

  const previousPurchasedAt =
    recentDates.length >= 2 ? recentDates[recentDates.length - 2]! : null;

  return {
    identityKind: profile.identityKind,
    identityKey,
    displayName,
    purchaseOccurrenceCount: profile.purchaseOccurrenceCount,
    lastPurchasedAt,
    previousPurchasedAt,
    cadence: {
      medianIntervalDays,
      daysSinceLastPurchase,
      cadenceRatio,
      intervalSampleSize: intervals.length,
      windowEventCount: recentDates.length,
      normalizedIntervalMad,
    },
    state,
  };
}

function compareCandidates(
  left: NextPurchaseCandidate,
  right: NextPurchaseCandidate
): number {
  const leftProximity = Math.abs(left.cadence.cadenceRatio - 1);
  const rightProximity = Math.abs(right.cadence.cadenceRatio - 1);
  if (leftProximity !== rightProximity) return leftProximity - rightProximity;
  if (left.cadence.windowEventCount !== right.cadence.windowEventCount) {
    return right.cadence.windowEventCount - left.cadence.windowEventCount;
  }
  if (left.purchaseOccurrenceCount !== right.purchaseOccurrenceCount) {
    return right.purchaseOccurrenceCount - left.purchaseOccurrenceCount;
  }
  if (left.lastPurchasedAt !== right.lastPurchasedAt) {
    return right.lastPurchasedAt - left.lastPurchasedAt;
  }
  const nameCmp = left.displayName.localeCompare(right.displayName);
  if (nameCmp !== 0) return nameCmp;
  const kindCmp = left.identityKind.localeCompare(right.identityKind);
  if (kindCmp !== 0) return kindCmp;
  return left.identityKey.localeCompare(right.identityKey);
}

/**
 * Build Next Purchase V0 candidates from uncapped Repeat V1 profiles.
 * Does not merge identities, rebuild purchase truth, or call Date.now().
 */
export function buildNextPurchaseCandidates(
  profiles: readonly RepeatProductProfile[],
  options: BuildNextPurchaseCandidatesOptions
): NextPurchaseCandidate[] {
  const now = options.now;
  const limit =
    typeof options.limit === 'number' &&
    Number.isFinite(options.limit) &&
    options.limit > 0
      ? Math.floor(options.limit)
      : NEXT_PURCHASE_DEFAULT_LIMIT;

  const candidates: NextPurchaseCandidate[] = [];
  for (const profile of profiles) {
    const candidate = evaluateProfile(profile, now);
    if (candidate) candidates.push(candidate);
  }

  return candidates.sort(compareCandidates).slice(0, limit);
}
