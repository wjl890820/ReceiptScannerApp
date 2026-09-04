/**
 * AP-3 derivation orchestration: session cache + generation cancel + paint deferral.
 * Feature flag gating lives at the Analysis screen entry.
 */

import type { ReceiptRow } from './db';
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
  createAnalysisPriceGeneration,
  runAfterAnalysisFirstPaint,
  scheduleAfterAnalysisFirstPaint,
  scheduleAfterAnalysisFirstPaintForTests,
  type AnalysisPriceFocusToken,
  type AnalysisPriceGeneration,
  type ScheduledPaintWork,
} from './analysisPriceScheduler';
import type { ProductPriceHistoryRow } from './productPriceHistory';

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

export function scheduleDeriveAnalysisPriceDomain(
  input: DeriveAnalysisPriceDomainInput
): ScheduledAnalysisPriceDerivation {
  const generation = input.generation ?? createAnalysisPriceGeneration();
  const seedReceiptIds = input.analyticsReceipts.map((receipt) => receipt.id);
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

  if (isStale()) {
    return {
      promise: Promise.resolve(canceledResult(signature, false)),
      cancel: () => generation.cancel(),
    };
  }

  const cached = readAnalysisPriceDomainCache(signature);
  if (cached) {
    if (isStale()) {
      return {
        promise: Promise.resolve(canceledResult(signature, true)),
        cancel: () => generation.cancel(),
      };
    }
    const surface = buildAnalysisPriceChangesSurface(
      cached.candidates,
      input.limit ?? 3
    );
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
    if (isStale()) return canceledResult(signature, false);
    const candidates = await collectAnalysisTrustedPriceChangeCandidatesAsync(
      {
        rows: input.rows,
        seedReceiptIds: new Set(seedReceiptIds),
        canonicalDuplicateSelectionApplied: true,
      },
      { shouldCancel: isStale }
    );
    if (candidates == null || isStale()) {
      return canceledResult(signature, false);
    }
    writeAnalysisPriceDomainCache({
      signature,
      candidates,
      generationMatches: !isStale(),
    });
    if (isStale()) {
      return canceledResult(signature, false);
    }
    const surface = buildAnalysisPriceChangesSurface(
      candidates,
      input.limit ?? 3
    );
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
