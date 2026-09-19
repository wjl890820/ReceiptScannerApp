/**
 * Tab-focus heavy-data fingerprints: ownerKey + generation counters.
 *
 * HEAVY DATA TRUTH is reusable only when the authoritative ownerKey AND the
 * relevant generations still match. Generation equality alone is insufficient.
 *
 * Shopping List–only mutations do NOT bump generations.
 */

import { getAnalyticsReceiptSelectionDataGeneration } from './analyticsReceiptSelectionCache';
import { getPersonalProductInventoryDataGeneration } from './personalProductEndpointInventoryCache';

export type TabFocusDataGenerations = {
  analyticsGeneration: number;
  inventoryGeneration: number;
};

/** Full heavy-snapshot key used by Home / Analysis. */
export type TabFocusHeavyKey = {
  ownerKey: string;
  analyticsGeneration: number;
  inventoryGeneration: number;
};

export function normalizeTabFocusOwnerKey(ownerKey: string | null | undefined): string {
  return typeof ownerKey === 'string' ? ownerKey.trim() : '';
}

export function readTabFocusDataGenerations(): TabFocusDataGenerations {
  return {
    analyticsGeneration: getAnalyticsReceiptSelectionDataGeneration(),
    inventoryGeneration: getPersonalProductInventoryDataGeneration(),
  };
}

export function buildTabFocusHeavyKey(ownerKey: string): TabFocusHeavyKey {
  const generations = readTabFocusDataGenerations();
  return {
    ownerKey: normalizeTabFocusOwnerKey(ownerKey),
    analyticsGeneration: generations.analyticsGeneration,
    inventoryGeneration: generations.inventoryGeneration,
  };
}

export function tabFocusDataGenerationsEqual(
  left: TabFocusDataGenerations,
  right: TabFocusDataGenerations
): boolean {
  return (
    left.analyticsGeneration === right.analyticsGeneration &&
    left.inventoryGeneration === right.inventoryGeneration
  );
}

export function tabFocusHeavyKeysEqual(
  left: TabFocusHeavyKey,
  right: TabFocusHeavyKey
): boolean {
  return (
    left.ownerKey === right.ownerKey &&
    left.analyticsGeneration === right.analyticsGeneration &&
    left.inventoryGeneration === right.inventoryGeneration
  );
}

/** History list truth: owner + analytics generation (inventory not required). */
export function historyFocusHeavyKeysEqual(
  left: Pick<TabFocusHeavyKey, 'ownerKey' | 'analyticsGeneration'>,
  right: Pick<TabFocusHeavyKey, 'ownerKey' | 'analyticsGeneration'>
): boolean {
  return (
    left.ownerKey === right.ownerKey &&
    left.analyticsGeneration === right.analyticsGeneration
  );
}

/**
 * Gate before applying a Home heavy-reuse OR uncached heavy-build result
 * after any await. Drift in owner/generations, stale request, or hidden UI
 * → discard. Callers must pass REAL requestStillLatest / canApply — never
 * hardcode true after an await.
 */
export function shouldApplyHomeHeavyReuseResult(input: {
  snapshotOwnerKey: string;
  snapshotGenerations: TabFocusDataGenerations;
  currentOwnerKey: string;
  currentGenerations: TabFocusDataGenerations;
  requestStillLatest: boolean;
  canApply: boolean;
}): boolean {
  if (!input.requestStillLatest || !input.canApply) return false;
  return tabFocusHeavyKeysEqual(
    {
      ownerKey: normalizeTabFocusOwnerKey(input.snapshotOwnerKey),
      analyticsGeneration: input.snapshotGenerations.analyticsGeneration,
      inventoryGeneration: input.snapshotGenerations.inventoryGeneration,
    },
    {
      ownerKey: normalizeTabFocusOwnerKey(input.currentOwnerKey),
      analyticsGeneration: input.currentGenerations.analyticsGeneration,
      inventoryGeneration: input.currentGenerations.inventoryGeneration,
    }
  );
}

/**
 * Displayable analyticsUnavailable fallback must NOT bless the generation:
 * no heavy snapshot commit, no complete-snapshot dirty-skip marker.
 */
export function shouldBlessHomeHeavySnapshot(input: {
  progressiveAnalyticsSucceeded: boolean;
}): boolean {
  return input.progressiveAnalyticsSucceeded === true;
}

/**
 * Gate before applying History heavy-load / truth UI state.
 */
export function shouldApplyHistoryHeavyLoadResult(input: {
  startOwnerKey: string;
  startAnalyticsGeneration: number;
  currentOwnerKey: string;
  currentAnalyticsGeneration: number;
  requestStillCurrent: boolean;
}): boolean {
  if (!input.requestStillCurrent) return false;
  return historyFocusHeavyKeysEqual(
    {
      ownerKey: normalizeTabFocusOwnerKey(input.startOwnerKey),
      analyticsGeneration: input.startAnalyticsGeneration,
    },
    {
      ownerKey: normalizeTabFocusOwnerKey(input.currentOwnerKey),
      analyticsGeneration: input.currentAnalyticsGeneration,
    }
  );
}

/**
 * Gate before applying Analysis heavy-build result after async work.
 */
export function shouldApplyAnalysisHeavyLoadResult(input: {
  startOwnerKey: string;
  startGenerations: TabFocusDataGenerations;
  currentOwnerKey: string;
  currentGenerations: TabFocusDataGenerations;
  requestStillCurrent: boolean;
}): boolean {
  if (!input.requestStillCurrent) return false;
  return tabFocusHeavyKeysEqual(
    {
      ownerKey: normalizeTabFocusOwnerKey(input.startOwnerKey),
      ...input.startGenerations,
    },
    {
      ownerKey: normalizeTabFocusOwnerKey(input.currentOwnerKey),
      ...input.currentGenerations,
    }
  );
}
