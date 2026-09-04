/**
 * AP-3 in-memory Analysis session cache (domain truth only).
 * No SQLite persistence. Locale/timeRange do not invalidate domain data.
 */

import type { AnalysisTrustedPriceChangeCandidate } from './analysisTrustedPriceChanges';
import { invalidateAnalysisPriceGenerations } from './analysisPriceScheduler';

export type AnalysisPriceDomainCacheEntry = {
  signature: string;
  candidates: readonly AnalysisTrustedPriceChangeCandidate[];
  derivedAtMs: number;
};

let domainCache: AnalysisPriceDomainCacheEntry | null = null;
let identityRevision = 0;
let derivationCount = 0;

/** Test seam: how many times domain derivation completed successfully. */
export function getAnalysisPriceDomainDerivationCount(): number {
  return derivationCount;
}

export function __resetAnalysisPriceSessionCacheForTests(): void {
  domainCache = null;
  identityRevision = 0;
  derivationCount = 0;
}

/**
 * Bump when personal SAME / identity authority revisions affect AP-3 truth.
 * Receipt edits are covered by snapshot signature fingerprints.
 */
export function bumpAnalysisPriceIdentityRevision(): void {
  identityRevision += 1;
  domainCache = null;
  invalidateAnalysisPriceGenerations();
}

export function clearAnalysisPriceSessionCache(): void {
  domainCache = null;
}

/**
 * Truth-change invalidation: clear domain cache and cancel in-flight generations.
 * Locale / timeRange / focus must NOT call this.
 */
export function notifyAnalysisPriceTruthInvalidated(): void {
  domainCache = null;
  invalidateAnalysisPriceGenerations();
}

export function getAnalysisPriceIdentityRevision(): number {
  return identityRevision;
}

/**
 * Cheap deterministic signature from analytics membership + edit evidence.
 * Avoids hashing full JSON on every focus.
 */
export function buildAnalysisPriceSnapshotSignature(input: {
  ownerKey: string;
  /** Sorted or unsorted receipt ids in analytics seed universe. */
  seedReceiptIds: readonly string[];
  /** Per-receipt cheap fingerprints, e.g. `${id}:${updatedAt ?? ''}:${itemCount}`. */
  receiptFingerprints: readonly string[];
  insightRowCount: number;
  identityRevision?: number;
}): string {
  const seedSorted = [...input.seedReceiptIds].sort();
  const fingerprintsSorted = [...input.receiptFingerprints].sort();
  const rev =
    input.identityRevision != null
      ? input.identityRevision
      : identityRevision;
  // Length-prefixed joins keep collisions extremely unlikely for local data.
  return [
    `o=${input.ownerKey}`,
    `r=${rev}`,
    `n=${seedSorted.length}`,
    `i=${input.insightRowCount}`,
    `ids=${seedSorted.join('\u001f')}`,
    `fp=${fingerprintsSorted.join('\u001f')}`,
  ].join('|');
}

export function readAnalysisPriceDomainCache(
  signature: string
): AnalysisPriceDomainCacheEntry | null {
  if (!domainCache || domainCache.signature !== signature) return null;
  return domainCache;
}

/**
 * Only a successful derivation for the matching signature may populate cache.
 */
export function writeAnalysisPriceDomainCache(input: {
  signature: string;
  candidates: readonly AnalysisTrustedPriceChangeCandidate[];
  generationMatches: boolean;
}): void {
  if (!input.generationMatches) return;
  domainCache = {
    signature: input.signature,
    candidates: input.candidates,
    derivedAtMs: Date.now(),
  };
  derivationCount += 1;
}
