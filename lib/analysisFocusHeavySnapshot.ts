/**
 * Analysis focus heavy truth session snapshot (dirty-skip).
 *
 * Keyed by authoritative ownerKey + analytics/inventory generations.
 * On reuse, callers must commit a new truthCycle with a fresh nowMs.
 */

import type { ReceiptRow } from './db';
import {
  buildTabFocusHeavyKey,
  normalizeTabFocusOwnerKey,
  readTabFocusDataGenerations,
  tabFocusHeavyKeysEqual,
  type TabFocusDataGenerations,
  type TabFocusHeavyKey,
} from './tabFocusDataGenerations';

export type AnalysisFocusHeavySnapshot = {
  ownerKey: string;
  generations: TabFocusDataGenerations;
  /** Occurrence-representative analytics receipts (load-boundary truth). */
  receipts: ReceiptRow[];
};

let snapshot: AnalysisFocusHeavySnapshot | null = null;

export function getAnalysisFocusHeavySnapshot(): AnalysisFocusHeavySnapshot | null {
  return snapshot;
}

export function clearAnalysisFocusHeavySnapshot(): void {
  snapshot = null;
}

export function __resetAnalysisFocusHeavySnapshotForTests(): void {
  snapshot = null;
}

export function tryReuseAnalysisFocusHeavySnapshot(
  ownerKey: string
): AnalysisFocusHeavySnapshot | null {
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

export function commitAnalysisFocusHeavySnapshot(input: {
  ownerKey: string;
  startGenerations: TabFocusDataGenerations;
  receipts: ReceiptRow[];
}): boolean {
  const ownerKey = normalizeTabFocusOwnerKey(input.ownerKey);
  const end = readTabFocusDataGenerations();
  const startKey: TabFocusHeavyKey = {
    ownerKey,
    ...input.startGenerations,
  };
  const endKey: TabFocusHeavyKey = { ownerKey, ...end };
  if (!tabFocusHeavyKeysEqual(startKey, endKey)) {
    return false;
  }
  const live = buildTabFocusHeavyKey(ownerKey);
  if (!tabFocusHeavyKeysEqual(startKey, live)) {
    return false;
  }
  snapshot = {
    ownerKey,
    generations: end,
    receipts: input.receipts,
  };
  return true;
}
