/**
 * Session cache for CanonicalPurchaseOccurrenceIndex (Slice 3D / 3D.1).
 *
 * Caches the occurrence INDEX only — not excluded-ID unions or ReceiptRow
 * objects. Callers rematerialize representatives against their own analytics
 * rows and union HC exclusions after HIT.
 *
 * Key = ownerKey + INPUT analyticsGeneration + analytics receipt-ID set
 * signature + contract version.
 *
 * Slice 3D.1: callers MUST supply the analytics generation that produced the
 * supplied receipt rows. Live generation is only used to detect staleness —
 * never as a substitute for input provenance.
 *
 * Bound: at most CANONICAL_PURCHASE_OCCURRENCE_CACHE_MAX_ENTRIES entries;
 * oldest insertion is dropped on overflow. Invalidation clears the Map.
 *
 * Shared indexes are treated as read-only; production consumers must not
 * mutate Maps/groups after receive.
 */

import {
  buildAnalyticsReceiptSetSignature,
  getAnalyticsReceiptSelectionDataGeneration,
} from './analyticsReceiptSelectionCache';
import {
  applyOccurrenceRepresentativeUniverse,
  buildCanonicalPurchaseOccurrenceIndex,
  collectNonRepresentativeOccurrenceReceiptIds,
  retainOccurrenceRepresentativeReceipts,
  type CanonicalPurchaseOccurrenceIndex,
} from './canonicalPurchaseOccurrence';
import type { ReceiptRow } from './db';
import { logger } from './logger';

export const CANONICAL_PURCHASE_OCCURRENCE_CACHE_VERSION =
  'meruno-canonical-purchase-occurrence-index-v1' as const;

/** Soft bound — a few owner/generation/set variants per session. */
export const CANONICAL_PURCHASE_OCCURRENCE_CACHE_MAX_ENTRIES = 8;

export type CanonicalPurchaseOccurrenceCacheState =
  | 'hit'
  | 'miss'
  | 'direct'
  | 'stale';

type CacheEntry = {
  key: string;
  index: CanonicalPurchaseOccurrenceIndex;
};

const entries = new Map<string, CacheEntry>();
let insertionOrder: string[] = [];
let underlyingBuildCount = 0;

export function getCanonicalPurchaseOccurrenceBuildCount(): number {
  return underlyingBuildCount;
}

export function __resetCanonicalPurchaseOccurrenceCacheForTests(): void {
  entries.clear();
  insertionOrder = [];
  underlyingBuildCount = 0;
}

/** Called from analytics selection invalidation for memory hygiene. */
export function clearCanonicalPurchaseOccurrenceCache(
  reason?: string
): void {
  entries.clear();
  insertionOrder = [];
  if (reason) {
    logger.info(
      'OccurrenceIndexPerf',
      `cleared reason=${reason} generation=${getAnalyticsReceiptSelectionDataGeneration()}`
    );
  }
}

export function buildCanonicalPurchaseOccurrenceCacheKey(input: {
  ownerKey: string;
  dataGeneration: number;
  setSignature: string;
  cacheVersion?: string;
}): string {
  return [
    `o=${input.ownerKey}`,
    `g=${input.dataGeneration}`,
    `v=${input.cacheVersion ?? CANONICAL_PURCHASE_OCCURRENCE_CACHE_VERSION}`,
    `set=${input.setSignature}`,
  ].join('|');
}

function rememberEntry(key: string, index: CanonicalPurchaseOccurrenceIndex): void {
  if (entries.has(key)) {
    entries.set(key, { key, index });
    return;
  }
  while (insertionOrder.length >= CANONICAL_PURCHASE_OCCURRENCE_CACHE_MAX_ENTRIES) {
    const oldest = insertionOrder.shift();
    if (oldest) entries.delete(oldest);
  }
  entries.set(key, { key, index });
  insertionOrder.push(key);
}

function isStaleInputGeneration(inputAnalyticsGeneration: number): boolean {
  return (
    inputAnalyticsGeneration !== getAnalyticsReceiptSelectionDataGeneration()
  );
}

export type GetOrBuildCanonicalPurchaseOccurrenceIndexResult =
  | {
      ok: true;
      index: CanonicalPurchaseOccurrenceIndex;
      cacheState: Exclude<CanonicalPurchaseOccurrenceCacheState, 'stale'>;
    }
  | {
      ok: false;
      cacheState: 'stale';
    };

export type CanonicalPurchaseOccurrenceCachedOptions = {
  ownerKey?: string | null;
  /**
   * Analytics generation that produced `analyticsReceipts`.
   * Required provenance — must match live generation for any cache/direct use.
   */
  analyticsGeneration: number;
};

/**
 * Get or build a shared occurrence index for HC-retained analytics receipts.
 */
export function getOrBuildCanonicalPurchaseOccurrenceIndexCached(input: {
  analyticsReceipts: readonly ReceiptRow[];
  ownerKey?: string | null;
  analyticsGeneration: number;
}): GetOrBuildCanonicalPurchaseOccurrenceIndexResult {
  const started = Date.now();
  const ownerKey =
    typeof input.ownerKey === 'string' ? input.ownerKey.trim() : '';
  const receipts = input.analyticsReceipts;
  const inputAnalyticsGeneration = input.analyticsGeneration;

  // Stale generation takes precedence over cache mode / direct fallback.
  if (isStaleInputGeneration(inputAnalyticsGeneration)) {
    logger.info(
      'OccurrenceIndexPerf',
      `decisionCache=stale durationMs=${Date.now() - started} receiptCount=${receipts.length} inputGeneration=${inputAnalyticsGeneration} liveGeneration=${getAnalyticsReceiptSelectionDataGeneration()}`
    );
    return { ok: false, cacheState: 'stale' };
  }

  if (!ownerKey) {
    const index = buildCanonicalPurchaseOccurrenceIndex(receipts);
    // Pre-return recheck: do not treat stale rows as current direct truth.
    if (isStaleInputGeneration(inputAnalyticsGeneration)) {
      logger.info(
        'OccurrenceIndexPerf',
        `decisionCache=stale durationMs=${Date.now() - started} receiptCount=${receipts.length} phase=post_direct_build`
      );
      return { ok: false, cacheState: 'stale' };
    }
    logger.info(
      'OccurrenceIndexPerf',
      `decisionCache=direct durationMs=${Date.now() - started} receiptCount=${receipts.length} generation=${inputAnalyticsGeneration}`
    );
    return { ok: true, index, cacheState: 'direct' };
  }

  const setSignature = buildAnalyticsReceiptSetSignature(receipts);
  const key = buildCanonicalPurchaseOccurrenceCacheKey({
    ownerKey,
    dataGeneration: inputAnalyticsGeneration,
    setSignature,
  });

  const hit = entries.get(key);
  if (hit) {
    // Defensive: generation may have bumped between key resolve and return.
    if (isStaleInputGeneration(inputAnalyticsGeneration)) {
      logger.info(
        'OccurrenceIndexPerf',
        `decisionCache=stale durationMs=${Date.now() - started} receiptCount=${receipts.length} phase=post_hit`
      );
      return { ok: false, cacheState: 'stale' };
    }
    logger.info(
      'OccurrenceIndexPerf',
      `decisionCache=HIT durationMs=${Date.now() - started} receiptCount=${receipts.length} generation=${inputAnalyticsGeneration}`
    );
    return { ok: true, index: hit.index, cacheState: 'hit' };
  }

  const index = buildCanonicalPurchaseOccurrenceIndex(receipts);

  // Pre-insert recheck: never install under a generation that no longer matches.
  if (isStaleInputGeneration(inputAnalyticsGeneration)) {
    logger.info(
      'OccurrenceIndexPerf',
      `decisionCache=stale durationMs=${Date.now() - started} receiptCount=${receipts.length} phase=pre_insert`
    );
    return { ok: false, cacheState: 'stale' };
  }

  rememberEntry(key, index);
  underlyingBuildCount += 1;
  logger.info(
    'OccurrenceIndexPerf',
    `decisionCache=MISS durationMs=${Date.now() - started} receiptCount=${receipts.length} generation=${inputAnalyticsGeneration}`
  );
  return { ok: true, index, cacheState: 'miss' };
}

export type ApplyOccurrenceRepresentativeUniverseCachedResult =
  | {
      ok: true;
      representativeReceipts: ReceiptRow[];
      excludedReceiptIds: Set<string>;
      occurrenceIndex: CanonicalPurchaseOccurrenceIndex;
      cacheState: Exclude<CanonicalPurchaseOccurrenceCacheState, 'stale'>;
    }
  | {
      ok: false;
      cacheState: 'stale';
    };

/**
 * Same semantics as applyOccurrenceRepresentativeUniverse when ok,
 * with shared index reuse. Propagates stale without fabricating truth.
 */
export function applyOccurrenceRepresentativeUniverseCached(
  analyticsReceipts: readonly ReceiptRow[],
  excludedDuplicateReceiptIds: ReadonlySet<string> | null | undefined,
  options: CanonicalPurchaseOccurrenceCachedOptions
): ApplyOccurrenceRepresentativeUniverseCachedResult {
  const built = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
    analyticsReceipts,
    ownerKey: options.ownerKey,
    analyticsGeneration: options.analyticsGeneration,
  });
  if (!built.ok) {
    return { ok: false, cacheState: 'stale' };
  }

  const { index, cacheState } = built;
  const excludedReceiptIds = new Set(excludedDuplicateReceiptIds ?? []);
  for (const id of collectNonRepresentativeOccurrenceReceiptIds(
    analyticsReceipts,
    index
  )) {
    excludedReceiptIds.add(id);
  }

  return {
    ok: true,
    representativeReceipts: retainOccurrenceRepresentativeReceipts(
      analyticsReceipts,
      index
    ),
    excludedReceiptIds,
    occurrenceIndex: index,
    cacheState,
  };
}

/**
 * Fresh apply path — used for differential tests only.
 * Production callers should use applyOccurrenceRepresentativeUniverseCached
 * when an ownerKey is available.
 */
export function applyOccurrenceRepresentativeUniverseFresh(
  analyticsReceipts: readonly ReceiptRow[],
  excludedDuplicateReceiptIds?: ReadonlySet<string> | null
): ReturnType<typeof applyOccurrenceRepresentativeUniverse> {
  return applyOccurrenceRepresentativeUniverse(
    analyticsReceipts,
    excludedDuplicateReceiptIds
  );
}
