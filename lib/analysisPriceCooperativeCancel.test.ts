/**
 * Performance Slice 2 — AP3 cooperative cancellation for peerPrepare + finalize.
 */
/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  prepareAnalysisPriceInsightContext,
  prepareAnalysisPriceInsightContextAsync,
} from './analysisPricePreparedContext';
import {
  collectAnalysisTrustedPriceChangeCandidates,
  collectAnalysisTrustedPriceChangeCandidatesAsync,
} from './analysisTrustedPriceChanges';
import {
  beginAnalysisPriceChunkTimingCapture,
  createAnalysisPriceGeneration,
  endAnalysisPriceChunkTimingCapture,
  __peekAnalysisPriceChunkTimingLabelsForTests,
  __resetAnalysisPriceGenerationsForTests,
} from './analysisPriceScheduler';
import {
  buildAnalysisPriceSnapshotSignature,
  getAnalysisPriceDomainDerivationCount,
  readAnalysisPriceDomainCache,
  __resetAnalysisPriceSessionCacheForTests,
} from './analysisPriceSessionCache';
import { scheduleDeriveAnalysisPriceDomain } from './analysisPriceDerivation';
import {
  resolveIdentityConsumerObservations,
  resolveIdentityConsumerObservationsAsync,
  identityObservationsFromPriceHistoryRows,
  type IdentityConsumerObservation,
} from './productIdentityConsumer';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';
import { buildAnalysisPriceChangesSurface } from './analysisPriceSurfaces';

const MS_DAY = 86_400_000;
const MERCHANT = 'ヨークベニマル';

function mpRow(
  id: string,
  gross: number,
  overrides: Partial<ReturnType<typeof makeTrustedG3TestRow>> = {}
) {
  return makeTrustedG3TestRow(id, {
    grossLineAmount: gross,
    lineTotal: gross,
    purchaseQuantity: 1,
    displayName: overrides.displayName ?? '横浜家系',
    merchantRaw: MERCHANT,
    merchantNormalized: MERCHANT,
    receiptId: overrides.receiptId ?? `r-${id}`,
    occurredAt: overrides.occurredAt ?? MS_DAY,
    skuKey: null,
    ...overrides,
  });
}

function scaleFixture(receiptCount: number) {
  const rows: ReturnType<typeof makeTrustedG3TestRow>[] = [];
  const seedReceiptIds: string[] = [];
  const merchants = [MERCHANT, 'イオン', 'ライフ', '西友'];
  const products = ['横浜家系', '牛乳', '卵', '豆腐', '納豆'];
  for (let r = 0; r < receiptCount; r += 1) {
    const receiptId = `coop-r-${r}`;
    seedReceiptIds.push(receiptId);
    const merchantKey = merchants[r % merchants.length]!;
    for (let i = 0; i < 3; i += 1) {
      rows.push(
        mpRow(`${r}-${i}`, 100 + (r % 7) * 10 + i, {
          receiptId,
          sourceIndex: i,
          itemId: `it-${r}-${i}`,
          displayName: products[(r + i) % products.length]!,
          merchantRaw: merchantKey,
          merchantNormalized: merchantKey,
          occurredAt: (r + 1) * MS_DAY,
        })
      );
    }
  }
  return { rows, seedReceiptIds };
}

function makeObs(i: number): IdentityConsumerObservation {
  return {
    receiptId: `r-${i}`,
    itemSourceIndex: 0,
    rawName: `Item ${i}`,
    merchantKey: 'merchant-a',
    occurredAt: 1_700_000_000_000 + i * MS_DAY,
    lineTotal: 100 + (i % 17),
    quantity: 1,
  };
}

function serializePrepared(
  ctx: NonNullable<Awaited<ReturnType<typeof prepareAnalysisPriceInsightContextAsync>>>
) {
  return {
    qualified: ctx.qualified.map((q) => ({
      receiptId: q.receiptId,
      itemSourceIndex: q.itemSourceIndex,
      merchantProductId: q.merchantProductId,
      purchaseUnitPrice: q.purchaseUnitPrice,
      quality: q.quality,
      includeInHistory: q.includeInHistory,
      includeInTrend: q.includeInTrend,
    })),
    skuKeys: [...ctx.skuBuckets.keys()],
    mpKeys: [...ctx.merchantProductBuckets.keys()],
    mpViewKeys: [...ctx.merchantProductIdentityViews.keys()],
    seededSku: [...ctx.seededSkuKeys].sort(),
    seededMp: [...ctx.seededMerchantProductIds].sort(),
    skuBucketSizes: [...ctx.skuBuckets.entries()].map(([k, v]) => [k, v.length]),
    mpBucketSizes: [...ctx.merchantProductBuckets.entries()].map(([k, v]) => [
      k,
      v.length,
    ]),
  };
}

describe('AP3 cooperative cancel — peerPrepare + finalize', () => {
  beforeEach(() => {
    __resetAnalysisPriceSessionCacheForTests();
    __resetAnalysisPriceGenerationsForTests();
  });

  it('A — peerPrepare uninterrupted async == sync baseline', async () => {
    const observations = Array.from({ length: 48 }, (_, i) => makeObs(i));
    const sync = resolveIdentityConsumerObservations(
      observations,
      createMemoryProductIdentityStore()
    );
    const asyncResult = await resolveIdentityConsumerObservationsAsync(
      observations,
      createMemoryProductIdentityStore(),
      { rowsPerChunk: 8 }
    );
    expect(asyncResult).not.toBeNull();
    expect(asyncResult!.qualified).toEqual(sync.qualified);
  });

  it('B — finalize uninterrupted async == sync baseline', async () => {
    const { rows, seedReceiptIds } = scaleFixture(30);
    const seeds = new Set(seedReceiptIds);
    const sync = prepareAnalysisPriceInsightContext(rows, seeds);
    const asyncCtx = await prepareAnalysisPriceInsightContextAsync(rows, seeds, {
      rowsPerChunk: 8,
    });
    expect(asyncCtx).not.toBeNull();
    expect(serializePrepared(asyncCtx!)).toEqual(serializePrepared(sync));
  });

  it('C — peerPrepare cancellation after chunks returns null', async () => {
    const observations = Array.from({ length: 40 }, (_, i) => makeObs(i));
    let yields = 0;
    let cancel = false;
    beginAnalysisPriceChunkTimingCapture();
    const result = await resolveIdentityConsumerObservationsAsync(
      observations,
      createMemoryProductIdentityStore(),
      {
        rowsPerChunk: 2,
        shouldCancel: () => cancel,
        yieldFn: async () => {
          yields += 1;
          if (
            __peekAnalysisPriceChunkTimingLabelsForTests().includes(
              'identity:peerPrepare'
            )
          ) {
            cancel = true;
          }
        },
      }
    );
    endAnalysisPriceChunkTimingCapture();
    expect(result).toBeNull();
    expect(cancel).toBe(true);
    expect(yields).toBeGreaterThan(0);
  });

  it('D — finalize cancellation after chunks returns null', async () => {
    const { rows, seedReceiptIds } = scaleFixture(24);
    let yields = 0;
    let cancel = false;
    beginAnalysisPriceChunkTimingCapture();
    const result = await prepareAnalysisPriceInsightContextAsync(
      rows,
      new Set(seedReceiptIds),
      {
        rowsPerChunk: 2,
        shouldCancel: () => cancel,
        yieldFn: async () => {
          yields += 1;
          if (
            __peekAnalysisPriceChunkTimingLabelsForTests().includes(
              'prepare:finalize'
            )
          ) {
            cancel = true;
          }
        },
      }
    );
    endAnalysisPriceChunkTimingCapture();
    expect(result).toBeNull();
    expect(cancel).toBe(true);
    expect(yields).toBeGreaterThan(0);
  });

  it('E — blur/cancel prevents later AP3 phases (collect null, no candidates)', async () => {
    const { rows, seedReceiptIds } = scaleFixture(40);
    let cancel = false;
    const pending = collectAnalysisTrustedPriceChangeCandidatesAsync(
      { rows, seedReceiptIds: new Set(seedReceiptIds) },
      {
        shouldCancel: () => cancel,
        targetsPerChunk: 1,
      }
    );
    await Promise.resolve();
    cancel = true;
    await expect(pending).resolves.toBeNull();
  });

  it('F — range supersede via generation cancel stops old derive', async () => {
    const { rows, seedReceiptIds } = scaleFixture(36);
    const generation = createAnalysisPriceGeneration();
    const fingerprints = seedReceiptIds.map((id) => `${id}::1`);
    const analyticsReceipts = seedReceiptIds.map((id) => ({ id } as never));
    const scheduled = scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:coop',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      generation,
      deferUntilPaint: false,
      shouldCancel: () => generation.isCanceled(),
      period: { range: 'week', nowMs: 40 * MS_DAY },
    });
    await Promise.resolve();
    generation.cancel();
    const result = await scheduled.promise;
    expect(result.status).toBe('canceled');
    expect(
      readAnalysisPriceDomainCache(
        buildAnalysisPriceSnapshotSignature({
          ownerKey: 'user:coop',
          seedReceiptIds,
          receiptFingerprints: fingerprints,
          insightRowCount: rows.length,
        })
      )
    ).toBeNull();
    expect(getAnalysisPriceDomainDerivationCount()).toBe(0);
  });

  it('G — focus A superseded by focus B (generation A cannot write cache)', async () => {
    const { rows, seedReceiptIds } = scaleFixture(28);
    const genA = createAnalysisPriceGeneration();
    const genB = createAnalysisPriceGeneration();
    const fingerprints = seedReceiptIds.map((id) => `${id}::1`);
    const analyticsReceipts = seedReceiptIds.map((id) => ({ id } as never));
    const sig = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'user:coop',
      seedReceiptIds,
      receiptFingerprints: fingerprints,
      insightRowCount: rows.length,
    });
    const taskA = scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:coop',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      generation: genA,
      deferUntilPaint: false,
      shouldCancel: () => genA.isCanceled(),
    });
    await Promise.resolve();
    genA.cancel();
    const taskB = scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:coop',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      generation: genB,
      deferUntilPaint: false,
      shouldCancel: () => genB.isCanceled(),
    });
    const [resultA, resultB] = await Promise.all([
      taskA.promise,
      taskB.promise,
    ]);
    expect(resultA.status).toBe('canceled');
    expect(resultB.status).not.toBe('canceled');
    const cached = readAnalysisPriceDomainCache(sig);
    expect(cached).not.toBeNull();
    expect(cached!.candidates).toEqual(resultB.candidates);
  });

  it('H/I — canceled prepare/finalize does not write domain cache', async () => {
    const { rows, seedReceiptIds } = scaleFixture(32);
    const generation = createAnalysisPriceGeneration();
    const fingerprints = seedReceiptIds.map((id) => `${id}::1`);
    const analyticsReceipts = seedReceiptIds.map((id) => ({ id } as never));
    const before = getAnalysisPriceDomainDerivationCount();
    const scheduled = scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:coop-hi',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      generation,
      deferUntilPaint: false,
      shouldCancel: () => generation.isCanceled(),
    });
    await Promise.resolve();
    await Promise.resolve();
    generation.cancel();
    const result = await scheduled.promise;
    expect(result.status).toBe('canceled');
    expect(getAnalysisPriceDomainDerivationCount()).toBe(before);
    expect(
      readAnalysisPriceDomainCache(
        buildAnalysisPriceSnapshotSignature({
          ownerKey: 'user:coop-hi',
          seedReceiptIds,
          receiptFingerprints: fingerprints,
          insightRowCount: rows.length,
        })
      )
    ).toBeNull();
  });

  it('J — canceled task surface is unavailable (no binding apply)', async () => {
    const { rows, seedReceiptIds } = scaleFixture(20);
    let cancel = false;
    const pending = collectAnalysisTrustedPriceChangeCandidatesAsync(
      { rows, seedReceiptIds: new Set(seedReceiptIds) },
      { shouldCancel: () => cancel, targetsPerChunk: 1 }
    );
    cancel = true;
    const collected = await pending;
    expect(collected).toBeNull();
    const surface = buildAnalysisPriceChangesSurface([], 3, {
      range: 'week',
      nowMs: 30 * MS_DAY,
    });
    expect(surface.status).toBe('unavailable');
  });

  it('K — multi-yield candidate order determinism', async () => {
    const { rows, seedReceiptIds } = scaleFixture(25);
    const seeds = new Set(seedReceiptIds);
    const sync = collectAnalysisTrustedPriceChangeCandidates({
      rows,
      seedReceiptIds: seeds,
    });
    const asyncResult = await collectAnalysisTrustedPriceChangeCandidatesAsync(
      { rows, seedReceiptIds: seeds },
      { targetsPerChunk: 2 }
    );
    expect(asyncResult).not.toBeNull();
    expect(
      (asyncResult?.candidates ?? []).map(
        (c) => `${c.target.type}:${c.target.key}`
      )
    ).toEqual(sync.map((c) => `${c.target.type}:${c.target.key}`));
  });

  it('L — domain cache hit behavior unchanged', async () => {
    const { rows, seedReceiptIds } = scaleFixture(18);
    const fingerprints = seedReceiptIds.map((id) => `${id}::1`);
    const analyticsReceipts = seedReceiptIds.map((id) => ({ id } as never));
    const first = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:coop-l',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      deferUntilPaint: false,
    }).promise;
    expect(first.cacheHit).toBe(false);
    expect(first.status).not.toBe('canceled');
    const second = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:coop-l',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      deferUntilPaint: false,
    }).promise;
    expect(second.cacheHit).toBe(true);
    expect(second.candidates).toEqual(first.candidates);
  });

  it('M — peerPrepare/finalize emit bounded sync timing samples', async () => {
    const { rows, seedReceiptIds } = scaleFixture(20);
    beginAnalysisPriceChunkTimingCapture();
    await prepareAnalysisPriceInsightContextAsync(
      rows,
      new Set(seedReceiptIds),
      { rowsPerChunk: 4 }
    );
    const samples = endAnalysisPriceChunkTimingCapture();
    const peer = samples.filter((s) => s.label === 'identity:peerPrepare');
    const finalize = samples.filter((s) => s.label === 'prepare:finalize');
    expect(peer.length).toBeGreaterThan(0);
    expect(finalize.length).toBeGreaterThan(0);
    // Each sample is a sync-only chunk (not the full wall prepare).
    for (const sample of [...peer, ...finalize]) {
      expect(sample.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('AP3 cooperative cancel — identity observations path', () => {
  it('identityObservationsFromPriceHistoryRows feeds equal sync/async resolve', async () => {
    const { rows } = scaleFixture(12);
    const observations = identityObservationsFromPriceHistoryRows([...rows]);
    const sync = resolveIdentityConsumerObservations(observations);
    const asyncResult = await resolveIdentityConsumerObservationsAsync(
      observations,
      undefined,
      { rowsPerChunk: 3 }
    );
    expect(asyncResult!.qualified).toEqual(sync.qualified);
  });
});
