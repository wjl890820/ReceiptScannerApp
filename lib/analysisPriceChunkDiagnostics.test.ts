/**
 * C2D diagnostics — sync-only ap3_chunk_max + producer timing boundaries.
 */
/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

jest.mock('./analysisTrustedPriceChanges', () => {
  const actual = jest.requireActual('./analysisTrustedPriceChanges');
  return {
    ...actual,
    collectAnalysisTrustedPriceChangeCandidatesAsync: jest.fn(),
  };
});

import {
  AP3_PREPARE_TOTAL_WALL_LABEL,
  isSyncAp3ChunkTimingLabel,
  sanitizeAp3ChunkTimingLabelForDiagnostics,
  summarizeAp3SyncChunkTimings,
  beginAnalysisPriceChunkTimingCapture,
  endAnalysisPriceChunkTimingCapture,
  recordAnalysisPriceChunkTiming,
  createAnalysisPriceGeneration,
  __resetAnalysisPriceGenerationsForTests,
  type ChunkTimingSample,
} from './analysisPriceScheduler';
import {
  __resetAnalysisPriceSessionCacheForTests,
  readAnalysisPriceDomainCache,
} from './analysisPriceSessionCache';
import { scheduleDeriveAnalysisPriceDomain } from './analysisPriceDerivation';
import {
  getDiagnosticSnapshot,
  internalDiagnostics,
} from './internalDiagnostics';
import { setInternalDiagnosticsEnabledForTests } from './internalDiagnosticsGate';
import { collectAnalysisTrustedPriceChangeCandidatesAsync } from './analysisTrustedPriceChanges';
import {
  resolveIdentityConsumerObservationsAsync,
  type IdentityConsumerObservation,
} from './productIdentityConsumer';
import { createMemoryProductIdentityStore } from './productIdentityStore';

const mockCollect =
  collectAnalysisTrustedPriceChangeCandidatesAsync as jest.MockedFunction<
    typeof collectAnalysisTrustedPriceChangeCandidatesAsync
  >;

function makeObs(i: number): IdentityConsumerObservation {
  return {
    receiptId: `r-${i}`,
    itemSourceIndex: 0,
    rawName: `Item ${i}`,
    merchantKey: 'merchant-a',
    occurredAt: 1_700_000_000_000 + i * 86_400_000,
    lineTotal: 100 + i,
    quantity: 1,
  };
}

describe('C2D sync chunk timing diagnostics', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    __resetAnalysisPriceSessionCacheForTests();
    __resetAnalysisPriceGenerationsForTests();
    beginAnalysisPriceChunkTimingCapture();
    endAnalysisPriceChunkTimingCapture();
    mockCollect.mockReset();
  });

  afterEach(async () => {
    // Cancel persist timers while gate is still forced; keep OFF so stray
    // callbacks cannot re-enter __DEV__-enabled diagnostics after teardown.
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    await internalDiagnostics.drainStorageForTests();
    setInternalDiagnosticsEnabledForTests(false);
  });

  afterAll(() => {
    setInternalDiagnosticsEnabledForTests(null);
  });

  it('A/B/C/D — prepare wall excluded from max; wall separate; maxLabel; sampleCount', () => {
    const samples: ChunkTimingSample[] = [
      { label: AP3_PREPARE_TOTAL_WALL_LABEL, durationMs: 750 },
      { label: 'identity:rows', durationMs: 12 },
      { label: 'prepare:finalize', durationMs: 20 },
      { label: 'sku:some-dynamic-key', durationMs: 5 },
      { label: 'mp:other-id', durationMs: 9 },
    ];
    const summary = summarizeAp3SyncChunkTimings(samples);
    expect(summary.maxDurationMs).toBe(20);
    expect(summary.maxDurationMs).not.toBe(750);
    expect(summary.prepareWallMs).toBe(750);
    expect(summary.maxLabel).toBe('prepare:finalize');
    expect(summary.sampleCount).toBe(4);
    expect(isSyncAp3ChunkTimingLabel(AP3_PREPARE_TOTAL_WALL_LABEL)).toBe(false);
  });

  it('E — selects the true largest among multiple sync labels', () => {
    const summary = summarizeAp3SyncChunkTimings([
      { label: 'identity:peerPrepare', durationMs: 40 },
      { label: 'prepare:evidence', durationMs: 15 },
      { label: 'identity:qualify', durationMs: 55 },
      { label: AP3_PREPARE_TOTAL_WALL_LABEL, durationMs: 900 },
    ]);
    expect(summary.maxDurationMs).toBe(55);
    expect(summary.maxLabel).toBe('identity:qualify');
    expect(summary.sampleCount).toBe(3);
  });

  it('F — sanitized maxLabel has no dynamic identifiers', () => {
    expect(
      sanitizeAp3ChunkTimingLabelForDiagnostics('sku:abc-product-key-99')
    ).toBe('sku');
    expect(
      sanitizeAp3ChunkTimingLabelForDiagnostics('mp:merchant-product-uuid')
    ).toBe('mp');
    const summary = summarizeAp3SyncChunkTimings([
      { label: 'sku:leaky-name', durationMs: 100 },
      { label: 'mp:leaky-id', durationMs: 50 },
    ]);
    expect(summary.maxLabel).toBe('sku');
    expect(JSON.stringify(summary)).not.toContain('leaky');
  });

  it('zero-duration maxLabel uses first deterministic valid sync sample', () => {
    const summary = summarizeAp3SyncChunkTimings([
      { label: AP3_PREPARE_TOTAL_WALL_LABEL, durationMs: 0 },
      { label: 'identity:rows', durationMs: 0 },
      { label: 'sku:x', durationMs: 0 },
    ]);
    expect(summary.maxDurationMs).toBe(0);
    expect(summary.maxLabel).toBe('identity:rows');
    expect(summary.sampleCount).toBe(2);
  });

  it('zero valid sync samples => no maxLabel', () => {
    const summary = summarizeAp3SyncChunkTimings([
      { label: AP3_PREPARE_TOTAL_WALL_LABEL, durationMs: 12 },
    ]);
    expect(summary.maxDurationMs).toBe(0);
    expect(summary.maxLabel).toBeNull();
    expect(summary.sampleCount).toBe(0);
    expect(summary.prepareWallMs).toBe(12);
  });

  it('G — canceled/stale derive emits sync max + prepare wall; does not cache', async () => {
    mockCollect.mockImplementation(async () => {
      recordAnalysisPriceChunkTiming(AP3_PREPARE_TOTAL_WALL_LABEL, 750);
      recordAnalysisPriceChunkTiming('identity:rows', 20);
      return null;
    });

    const generation = createAnalysisPriceGeneration();
    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:0'],
      generation,
      deferUntilPaint: false,
    }).promise;

    expect(result.status).toBe('canceled');
    expect(readAnalysisPriceDomainCache(result.signature)).toBeNull();

    const events = getDiagnosticSnapshot().events;
    const chunkMax = events.filter((e) => e.name === 'ap3_chunk_max').pop();
    const prepareWall = events.filter((e) => e.name === 'ap3_prepare_wall').pop();
    expect(prepareWall?.durationMs).toBe(750);
    expect(chunkMax?.durationMs).toBe(20);
    expect(chunkMax?.meta?.maxLabel).toBe('identity:rows');
    expect(chunkMax?.meta?.sampleCount).toBe(1);
    expect(chunkMax?.meta?.chunkCount).toBe(1);
  });
});

describe('C2D identity producer timing boundaries', () => {
  beforeEach(() => {
    beginAnalysisPriceChunkTimingCapture();
    endAnalysisPriceChunkTimingCapture();
  });

  it('A/B/C — identity rows/peerPrepare/qualify exclude deferred yield waits', async () => {
    const YIELD_MS = 180;
    const observations = Array.from({ length: 5 }, (_, i) => makeObs(i));
    beginAnalysisPriceChunkTimingCapture();

    await resolveIdentityConsumerObservationsAsync(
      observations,
      createMemoryProductIdentityStore(),
      {
        // Force partial final rows chunk + multiple qualify chunks.
        rowsPerChunk: 2,
        yieldFn: () =>
          new Promise((resolve) => {
            setTimeout(resolve, YIELD_MS);
          }),
      }
    );

    const samples = endAnalysisPriceChunkTimingCapture();
    const byLabel = (prefix: string) =>
      samples.filter((s) => s.label === prefix || s.label.startsWith(prefix));

    const rows = byLabel('identity:rows');
    const peer = byLabel('identity:peerPrepare');
    const qualify = byLabel('identity:qualify');

    expect(rows.length).toBeGreaterThan(0);
    expect(peer.length).toBe(1);
    expect(qualify.length).toBeGreaterThan(0);

    // If duration spanned the awaited yield/import, samples would be ≈180ms+.
    for (const sample of [...rows, ...peer, ...qualify]) {
      expect(sample.durationMs).toBeLessThan(YIELD_MS / 2);
    }
  });
});
