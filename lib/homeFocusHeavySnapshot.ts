/**
 * Home focus heavy-data session snapshot (dirty-skip).
 *
 * Keyed by authoritative ownerKey + analytics/inventory generations.
 * Next Purchase is reprojected with a fresh `now` on reuse — never frozen.
 */

import type { ReceiptRow } from './db';
import type { HomeProgressiveExperience } from './homeProgressiveExperience';
import type { RepeatProductProfile } from './repeatProductProfile';
import {
  buildTabFocusHeavyKey,
  normalizeTabFocusOwnerKey,
  readTabFocusDataGenerations,
  tabFocusHeavyKeysEqual,
  type TabFocusDataGenerations,
  type TabFocusHeavyKey,
} from './tabFocusDataGenerations';

export type HomeFocusHeavySnapshot = {
  ownerKey: string;
  generations: TabFocusDataGenerations;
  displayReceipts: ReceiptRow[];
  /**
   * Last successful progressive experience (NP may be stale until
   * `refreshHomeNextPurchaseFromProfiles` runs with a fresh now).
   */
  experience: HomeProgressiveExperience;
  /** Uncapped Repeat profiles for cheap Next Purchase reproject. */
  repeatProfiles: readonly RepeatProductProfile[];
};

let snapshot: HomeFocusHeavySnapshot | null = null;

export function getHomeFocusHeavySnapshot(): HomeFocusHeavySnapshot | null {
  return snapshot;
}

export function clearHomeFocusHeavySnapshot(): void {
  snapshot = null;
}

export function __resetHomeFocusHeavySnapshotForTests(): void {
  snapshot = null;
}

/**
 * Returns the reusable snapshot when ownerKey + generations match.
 * Caller must resolve ownerKey BEFORE calling, and still reproject NP with fresh now.
 */
export function tryReuseHomeFocusHeavySnapshot(
  ownerKey: string
): HomeFocusHeavySnapshot | null {
  if (!snapshot) return null;
  const current = buildTabFocusHeavyKey(ownerKey);
  const cached: TabFocusHeavyKey = {
    ownerKey: snapshot.ownerKey,
    ...snapshot.generations,
  };
  if (!tabFocusHeavyKeysEqual(cached, current)) {
    return null;
  }
  return snapshot;
}

/**
 * Store only after a successful heavy refresh whose start/end owner+generations
 * match and still equal the current counters (no mid-flight mutation/owner switch).
 */
export function commitHomeFocusHeavySnapshot(input: {
  ownerKey: string;
  startGenerations: TabFocusDataGenerations;
  displayReceipts: ReceiptRow[];
  experience: HomeProgressiveExperience;
  repeatProfiles: readonly RepeatProductProfile[];
}): boolean {
  const ownerKey = normalizeTabFocusOwnerKey(input.ownerKey);
  const end = readTabFocusDataGenerations();
  const startKey: TabFocusHeavyKey = {
    ownerKey,
    ...input.startGenerations,
  };
  const endKey: TabFocusHeavyKey = {
    ownerKey,
    ...end,
  };
  if (!tabFocusHeavyKeysEqual(startKey, endKey)) {
    return false;
  }
  // Re-read live key in case owner identity changed without generation bump.
  const live = buildTabFocusHeavyKey(ownerKey);
  if (!tabFocusHeavyKeysEqual(startKey, live)) {
    return false;
  }
  snapshot = {
    ownerKey,
    generations: end,
    displayReceipts: input.displayReceipts,
    experience: input.experience,
    repeatProfiles: input.repeatProfiles,
  };
  return true;
}
