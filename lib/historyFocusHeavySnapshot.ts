/**
 * History focus heavy list snapshot (dirty-skip).
 *
 * Keyed by authoritative ownerKey + analytics generation.
 */

import type { ReceiptListRow } from './db';
import type { HistoryPurchaseTruthView } from './historyPurchaseTruth';
import {
  historyFocusHeavyKeysEqual,
  normalizeTabFocusOwnerKey,
  readTabFocusDataGenerations,
  type TabFocusDataGenerations,
} from './tabFocusDataGenerations';

export type HistoryFocusHeavySnapshot = {
  ownerKey: string;
  generations: TabFocusDataGenerations;
  visibleRows: ReceiptListRow[];
  truth: HistoryPurchaseTruthView;
};

let snapshot: HistoryFocusHeavySnapshot | null = null;

export function getHistoryFocusHeavySnapshot(): HistoryFocusHeavySnapshot | null {
  return snapshot;
}

export function clearHistoryFocusHeavySnapshot(): void {
  snapshot = null;
}

export function __resetHistoryFocusHeavySnapshotForTests(): void {
  snapshot = null;
}

export function tryReuseHistoryFocusHeavySnapshot(
  ownerKey: string
): HistoryFocusHeavySnapshot | null {
  if (!snapshot) return null;
  const current = readTabFocusDataGenerations();
  if (
    !historyFocusHeavyKeysEqual(
      {
        ownerKey: snapshot.ownerKey,
        analyticsGeneration: snapshot.generations.analyticsGeneration,
      },
      {
        ownerKey: normalizeTabFocusOwnerKey(ownerKey),
        analyticsGeneration: current.analyticsGeneration,
      }
    )
  ) {
    return null;
  }
  return snapshot;
}

export function commitHistoryFocusHeavySnapshot(input: {
  ownerKey: string;
  startGenerations: TabFocusDataGenerations;
  visibleRows: ReceiptListRow[];
  truth: HistoryPurchaseTruthView;
}): boolean {
  const ownerKey = normalizeTabFocusOwnerKey(input.ownerKey);
  const end = readTabFocusDataGenerations();
  if (
    !historyFocusHeavyKeysEqual(
      {
        ownerKey,
        analyticsGeneration: input.startGenerations.analyticsGeneration,
      },
      {
        ownerKey,
        analyticsGeneration: end.analyticsGeneration,
      }
    )
  ) {
    return false;
  }
  snapshot = {
    ownerKey,
    generations: { ...end },
    visibleRows: input.visibleRows,
    truth: input.truth,
  };
  return true;
}
