/**
 * AP-3 derivation orchestration: session cache + generation cancel + paint deferral.
 * Feature flag gating lives at the Analysis screen entry.
 *
 * Domain cache is global (no period truncation). Period filters CURRENT events
 * only when building the release surface.
 */

import type { ReceiptRow } from './db';
import type { AnalysisPeriodRange } from './analysisPeriod';
import {
  collectAnalysisTrustedPriceChangeCandidatesAsync,
  type AnalysisTrustedPriceChangeCandidate,
} from './analysisTrustedPriceChanges';
import {
  buildAnalysisPriceChangesSurface,
  type AnalysisPriceChangesSurface,
} from './analysisPriceSurfaces';
import {
  buildAnalysisPriceSnapshotSignature,
  readAnalysisPriceDomainCache,
  writeAnalysisPriceDomainCache,
} from './analysisPriceSessionCache';
import {
  beginAnalysisPriceChunkTimingCapture,
  createAnalysisPriceGeneration,
  endAnalysisPriceChunkTimingCapture,
  summarizeAp3SyncChunkTimings,
  runAfterAnalysisFirstPaint,
  scheduleAfterAnalysisFirstPaint,
  scheduleAfterAnalysisFirstPaintForTests,
  type AnalysisPriceFocusToken,
  type AnalysisPriceGeneration,
  type ScheduledPaintWork,
} from './analysisPriceScheduler';
import type { ProductPriceHistoryRow } from './productPriceHistory';
import { emitAp3CandidateFunnel } from './analysisPriceCandidateFunnel';
import { recordDiagnosticEvent } from './internalDiagnostics';

const UNAVAILABLE: AnalysisPriceChangesSurface = { status: 'unavailable' };

export type DeriveAnalysisPriceDomainInput = {
  ownerKey: string;
  analyticsReceipts: readonly ReceiptRow[];
  rows: readonly ProductPriceHistoryRow[];
  receiptFingerprints: readonly string[];
  generation?: AnalysisPriceGeneration;
  focusToken?: AnalysisPriceFocusToken;
  /** Extra stale predicate (screen focus / load cycle). */
  shouldCancel?: () => boolean;
  /** When false, runs immediately (tests). Default true. */
  deferUntilPaint?: boolean;
  /** Use controllable test paint gate instead of timer/rAF. */
  useTestPaintGate?: boolean;
  limit?: number;
  /**
   * Selected Analysis period — filters CURRENT event eligibility only.
   * Omitted ⇒ no period filter (tests / legacy callers).
   */
  period?: { range: AnalysisPeriodRange; nowMs: number };
};

export type DeriveAnalysisPriceDomainResult = {
  status: 'available' | 'unavailable' | 'canceled';
  surface: AnalysisPriceChangesSurface;
  candidates: readonly AnalysisTrustedPriceChangeCandidate[];
  cacheHit: boolean;
  signature: string;
};

export type ScheduledAnalysisPriceDerivation = {
  promise: Promise<DeriveAnalysisPriceDomainResult>;
  cancel: () => void;
};

function receiptFingerprint(receipt: ReceiptRow): string {
  const updated = receipt.client_updated_at ?? '';
  const analysisLen =
    typeof receipt.analysis_json === 'string' ? receipt.analysis_json.length : 0;
  const userItemsLen =
    typeof receipt.user_items_json === 'string'
      ? receipt.user_items_json.length
      : 0;
  const edited = receipt.user_edited ?? 0;
  return `${receipt.id}:${updated}:${edited}:${analysisLen}:${userItemsLen}`;
}

export function buildDefaultAnalysisPriceReceiptFingerprints(
  analyticsReceipts: readonly ReceiptRow[]
): string[] {
  return analyticsReceipts.map(receiptFingerprint);
}

function canceledResult(
  signature: string,
  cacheHit: boolean
): DeriveAnalysisPriceDomainResult {
  return {
    status: 'canceled',
    surface: UNAVAILABLE,
    candidates: [],
    cacheHit,
    signature,
  };
}

/**
 * Derive AP-3 domain candidates with session cache + cooperative async collect.
 * Stale/canceled generations / focus tokens neither apply nor write cache.
 */
export async function deriveAnalysisPriceDomain(
  input: DeriveAnalysisPriceDomainInput
): Promise<DeriveAnalysisPriceDomainResult> {
  const scheduled = scheduleDeriveAnalysisPriceDomain(input);
  return scheduled.promise;
}

function emitAp3Timing(
  name: string,
  durationMs?: number,
  meta?: Record<string, unknown>
): void {
  recordDiagnosticEvent({
    category: 'timing',
    name,
    screen: 'analysis',
    ...(durationMs != null ? { durationMs } : {}),
    ...(meta != null ? { meta } : {}),
  });
}

export function scheduleDeriveAnalysisPriceDomain(
  input: DeriveAnalysisPriceDomainInput
): ScheduledAnalysisPriceDerivation {
  const generation = input.generation ?? createAnalysisPriceGeneration();
  const seedReceiptIds = input.analyticsReceipts.map((receipt) => receipt.id);
  // Domain signature intentionally excludes Analysis timeRange — baseline
  // history is global; period only filters CURRENT events at surface build.
  const signature = buildAnalysisPriceSnapshotSignature({
    ownerKey: input.ownerKey,
    seedReceiptIds,
    receiptFingerprints: input.receiptFingerprints,
    insightRowCount: input.rows.length,
  });

  const isStale = () =>
    generation.isCanceled() ||
    (input.focusToken != null && !input.focusToken.isActive()) ||
    (input.shouldCancel?.() ?? false);

  const buildSurface = (
    candidates: readonly AnalysisTrustedPriceChangeCandidate[]
  ) =>
    buildAnalysisPriceChangesSurface(
      candidates,
      input.limit ?? 3,
      input.period
    );

  if (isStale()) {
    emitAp3Timing('ap3_stale_discarded', undefined, { cacheHit: 0 });
    return {
      promise: Promise.resolve(canceledResult(signature, false)),
      cancel: () => generation.cancel(),
    };
  }

  emitAp3Timing('ap3_start', undefined, {
    range: input.period?.range ?? 'none',
  });
  const totalStarted = Date.now();

  const cached = readAnalysisPriceDomainCache(signature);
  if (cached) {
    if (isStale()) {
      emitAp3Timing('ap3_stale_discarded', undefined, { cacheHit: 1 });
      return {
        promise: Promise.resolve(canceledResult(signature, true)),
        cancel: () => generation.cancel(),
      };
    }
    const surface = buildSurface(cached.candidates);
    emitAp3Timing('ap3_total', Date.now() - totalStarted, {
      cacheHit: 1,
      candidateCount: cached.candidates.length,
      applied: surface.status === 'available' ? 1 : 0,
    });
    return {
      promise: Promise.resolve({
        status: surface.status === 'available' ? 'available' : 'unavailable',
        surface,
        candidates: cached.candidates,
        cacheHit: true,
        signature,
      }),
      cancel: () => generation.cancel(),
    };
  }

  const runDerive = async (): Promise<DeriveAnalysisPriceDomainResult> => {
    if (isStale()) {
      emitAp3Timing('ap3_stale_discarded', undefined, { cacheHit: 0 });
      return canceledResult(signature, false);
    }
    beginAnalysisPriceChunkTimingCapture();
    const collected = await collectAnalysisTrustedPriceChangeCandidatesAsync(
      {
        rows: input.rows,
        seedReceiptIds: new Set(seedReceiptIds),
        canonicalDuplicateSelectionApplied: true,
      },
      { shouldCancel: isStale }
    );
    const chunkSamples = endAnalysisPriceChunkTimingCapture();
    const syncSummary = summarizeAp3SyncChunkTimings(chunkSamples);
    if (syncSummary.prepareWallMs != null) {
      emitAp3Timing('ap3_prepare_wall', syncSummary.prepareWallMs);
    }
    emitAp3Timing('ap3_chunk_max', syncSummary.maxDurationMs, {
      // Sync-only sample count (excludes prepare:totalWall).
      sampleCount: syncSummary.sampleCount,
      chunkCount: syncSummary.sampleCount,
      ...(syncSummary.maxLabel != null
        ? { maxLabel: syncSummary.maxLabel }
        : {}),
    });
    if (collected == null || isStale()) {
      emitAp3Timing('ap3_stale_discarded', undefined, { cacheHit: 0 });
      return canceledResult(signature, false);
    }
    const { candidates, funnel } = collected;
    // Final pre-emission boundary: never emit a completed funnel for a run
    // that is already stale (closes the former dynamic-import await window).
    if (isStale()) {
      emitAp3Timing('ap3_stale_discarded', undefined, { cacheHit: 0 });
      return canceledResult(signature, false);
    }
    try {
      emitAp3CandidateFunnel(funnel);
    } catch {
      // Diagnostics-only: never affect AP-3 product derivation.
    }
    emitAp3Timing('ap3_candidates', undefined, {
      candidateCount: candidates.length,
    });
    // Cache stores unfiltered global candidates (period applied at surface).
    writeAnalysisPriceDomainCache({
      signature,
      candidates,
      generationMatches: !isStale(),
    });
    if (isStale()) {
      emitAp3Timing('ap3_stale_discarded', undefined, { cacheHit: 0 });
      return canceledResult(signature, false);
    }
    const surface = buildSurface(candidates);
    emitAp3Timing('ap3_total', Date.now() - totalStarted, {
      cacheHit: 0,
      candidateCount: candidates.length,
      applied: surface.status === 'available' ? 1 : 0,
    });
    return {
      status: surface.status === 'available' ? 'available' : 'unavailable',
      surface,
      candidates,
      cacheHit: false,
      signature,
    };
  };

  if (input.deferUntilPaint === false) {
    return {
      promise: runDerive(),
      cancel: () => generation.cancel(),
    };
  }

  const scheduleFn = input.useTestPaintGate
    ? scheduleAfterAnalysisFirstPaintForTests
    : scheduleAfterAnalysisFirstPaint;

  const scheduled: ScheduledPaintWork<DeriveAnalysisPriceDomainResult> =
    scheduleFn(runDerive, {
      isStale,
      canceledResult: () => canceledResult(signature, false),
    });

  return {
    promise: scheduled.promise,
    cancel: () => {
      generation.cancel();
      scheduled.cancel();
    },
  };
}

/** @deprecated Prefer scheduleDeriveAnalysisPriceDomain for cancellable paint. */
export async function deriveAnalysisPriceDomainLegacyDefer(
  input: DeriveAnalysisPriceDomainInput
): Promise<DeriveAnalysisPriceDomainResult> {
  if (input.deferUntilPaint === false) {
    return deriveAnalysisPriceDomain(input);
  }
  return runAfterAnalysisFirstPaint(() =>
    deriveAnalysisPriceDomain({ ...input, deferUntilPaint: false })
  );
}
