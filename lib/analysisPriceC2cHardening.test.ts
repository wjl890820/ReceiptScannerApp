/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import fs from 'fs';
import path from 'path';

import {
  beginPeerQualityWorkCounting,
  endPeerQualityWorkCounting,
  evaluatePriceObservationQuality,
  leaveOneOutPeerStats,
  legacyLeaveOneOutPeerPrices,
  legacyPeerCoeffOfVariation,
  preparePeerPriceBucket,
} from './productIdentityPriceObservationQuality';
import {
  __armAnalysisPricePaintGateForTests,
  __clearAnalysisPricePaintGateForTests,
  __resetAnalysisPriceFocusForTests,
  __resetAnalysisPriceGenerationsForTests,
  createAnalysisPriceFocusToken,
  createAnalysisPriceGeneration,
  beginAnalysisPriceChunkTimingCapture,
  endAnalysisPriceChunkTimingCapture,
} from './analysisPriceScheduler';
import {
  __resetAnalysisPriceSessionCacheForTests,
  getAnalysisPriceDomainDerivationCount,
  notifyAnalysisPriceTruthInvalidated,
  readAnalysisPriceDomainCache,
  writeAnalysisPriceDomainCache,
  buildAnalysisPriceSnapshotSignature,
} from './analysisPriceSessionCache';
import {
  scheduleDeriveAnalysisPriceDomain,
} from './analysisPriceDerivation';
import { collectAnalysisTrustedPriceChangeCandidates } from './analysisTrustedPriceChanges';
import {
  beginAnalysisPriceWorkCounting,
  endAnalysisPriceWorkCounting,
} from './analysisPricePreparedContext';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';

const MS_DAY = 86_400_000;
const MERCHANT = 'ヨークベニマル';
const PRODUCT = '牛乳ハードニング';

function legacyVsPrepared(all: number[], exclude: number) {
  const peers = legacyLeaveOneOutPeerPrices(all, exclude);
  const legacyQuality = evaluatePriceObservationQuality({
    lineTotal: exclude,
    quantity: 1,
    peerPurchaseUnitPrices: peers,
  });
  const prepared = leaveOneOutPeerStats(preparePeerPriceBucket(all), exclude);
  const preparedQuality = evaluatePriceObservationQuality({
    lineTotal: exclude,
    quantity: 1,
    preparedPeerStats: prepared,
  });
  return { peers, legacyQuality, prepared, preparedQuality };
}

describe('C2C hardening — O(1) leave-one-out peer stats', () => {
  it('duplicate multiplicity removes exactly one first occurrence', () => {
    const all = [100, 100, 100, 120];
    const { peers, prepared, legacyQuality, preparedQuality } = legacyVsPrepared(
      all,
      100
    );
    expect(peers).toEqual([100, 100, 120]);
    expect(prepared.count).toBe(3);
    expect(prepared.median).toBe(100);
    expect(preparedQuality.quality).toBe(legacyQuality.quality);
  });

  it('O(1) median/variance structural counters on large bucket', () => {
    const prices = Array.from({ length: 500 }, (_, i) => 100 + (i % 11));
    beginPeerQualityWorkCounting();
    const bucket = preparePeerPriceBucket(prices);
    for (const price of prices) {
      leaveOneOutPeerStats(bucket, price);
    }
    const counts = endPeerQualityWorkCounting();
    expect(counts.peerBucketSortCount).toBe(1);
    expect(counts.peerFirstIndexMapBuildCount).toBe(1);
    expect(counts.peerFullScanCount).toBe(0);
    expect(counts.peerCandidateLinearScans).toBe(0);
    expect(counts.peerO1MedianLookups).toBeGreaterThan(0);
    expect(counts.peerO1VarianceLookups).toBeGreaterThan(0);
    // Lookups scale with candidates, not with B² scans.
    expect(counts.peerO1MedianLookups).toBeLessThanOrEqual(prices.length * 4);
  });

  it.each([
    {
      name: '1e12 tiny relative',
      all: [1e12, 1e12 + 1e6, 1e12 + 2e6, 1e12 + 3e6],
      exclude: 1e12 + 3e6,
    },
    {
      name: '1e15 small deltas',
      all: [1e15, 1e15 + 1e5, 1e15 + 2e5, 1e15 + 3e5],
      exclude: 1e15,
    },
    {
      name: 'identical huge',
      all: [1e14, 1e14, 1e14, 1e14],
      exclude: 1e14,
    },
    {
      name: 'one huge outlier',
      all: [1e12, 1e12, 1e12, 2e12],
      exclude: 2e12,
    },
    {
      name: 'mixed duplicate huge',
      all: [1e13, 1e13, 1e13 + 1e6, 1e13],
      exclude: 1e13,
    },
  ])('huge finite $name: no NaN/false-zero; classification parity when legacy CV finite', ({
    all,
    exclude,
  }) => {
    const { peers, legacyQuality, prepared, preparedQuality } = legacyVsPrepared(
      all,
      exclude
    );
    expect(Number.isNaN(prepared.coeffOfVariation)).toBe(false);
    if (peers.length >= 2) {
      const legacyCv = legacyPeerCoeffOfVariation(peers);
      const hasVariation = peers.some((p) => p !== peers[0]);
      if (hasVariation && Number.isFinite(legacyCv) && legacyCv > 0) {
        expect(prepared.coeffOfVariation).toBeGreaterThan(0);
      }
      if (Number.isFinite(legacyCv) && !Number.isNaN(legacyCv)) {
        expect(preparedQuality.quality).toBe(legacyQuality.quality);
        expect(preparedQuality.potentialOutlier).toBe(
          legacyQuality.potentialOutlier
        );
      }
    }
  });

  it.each([100, 500, 1000] as const)(
    'single-MP bucket %s observations: O(B log B + B) peer prep',
    (bucketSize) => {
      const rows = Array.from({ length: bucketSize }, (_, i) =>
        makeTrustedG3TestRow(`sb-${i}`, {
          receiptId: `sb-r-${i}`,
          sourceIndex: 0,
          itemId: `sb-it-${i}`,
          displayName: PRODUCT,
          merchantRaw: MERCHANT,
          merchantNormalized: MERCHANT,
          occurredAt: (i + 1) * MS_DAY,
          grossLineAmount: 100 + (i % 9),
          lineTotal: 100 + (i % 9),
          purchaseQuantity: 1,
          skuKey: null,
        })
      );
      const seed = new Set(rows.map((r) => r.receiptId));
      beginPeerQualityWorkCounting();
      beginAnalysisPriceWorkCounting();
      const started = Date.now();
      collectAnalysisTrustedPriceChangeCandidates({
        rows,
        seedReceiptIds: seed,
      });
      const elapsed = Date.now() - started;
      const peer = endPeerQualityWorkCounting();
      const work = endAnalysisPriceWorkCounting();
      expect(work?.fullUniverseIdentityResolves).toBe(1);
      expect(work?.evidenceCacheBuilds).toBe(1);
      expect(peer.peerBucketSortCount).toBeGreaterThan(0);
      expect(peer.peerBucketSortCount).toBeLessThan(20);
      expect(peer.peerCandidateLinearScans).toBe(0);
      expect(peer.peerFullScanCount).toBe(0);
      // eslint-disable-next-line no-console
      console.info(
        `[AP-3 C2C harden single-MP] ${bucketSize}: ${elapsed}ms sorts=${peer.peerBucketSortCount} o1med=${peer.peerO1MedianLookups}`
      );
    }
  );
});

describe('C2C hardening — invalidation', () => {
  beforeEach(() => {
    __resetAnalysisPriceSessionCacheForTests();
  });

  it('logical-edit success path source wires notifyAnalysisPriceTruthInvalidated', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, './db.ts'),
      'utf8'
    );
    const fnStart = src.indexOf('export async function updateLogicalPurchaseItemEdit');
    const fnBody = src.slice(fnStart, fnStart + 8000);
    expect(fnBody).toContain('notifyAnalysisPriceTruthInvalidated');
    expect(fnBody).toContain('updatedReceiptIds.length > 0');
  });

  it('maintenance batch invalidates only when succeeded > 0', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, './db.ts'),
      'utf8'
    );
    const fnStart = src.indexOf(
      'export async function runReceiptItemIndexMaintenanceBatch'
    );
    const fnBody = src.slice(fnStart, fnStart + 1200);
    expect(fnBody).toContain('result.succeeded > 0');
    expect(fnBody).toContain('notifyAnalysisPriceTruthInvalidated');
  });

  it('category backfill invalidates AP-3 when fixedReceipts > 0', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, './categoryBackfill.ts'),
      'utf8'
    );
    expect(src).toContain('fixedReceipts > 0');
    expect(src).toContain('notifyAnalysisPriceTruthInvalidated');
  });

  it('notify clears cache that fingerprint lengths alone would not', () => {
    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'installation:test',
      seedReceiptIds: ['a'],
      receiptFingerprints: ['a::same-len'],
      insightRowCount: 1,
    });
    writeAnalysisPriceDomainCache({
      signature,
      candidates: [],
      generationMatches: true,
    });
    expect(readAnalysisPriceDomainCache(signature)).not.toBeNull();
    notifyAnalysisPriceTruthInvalidated();
    expect(readAnalysisPriceDomainCache(signature)).toBeNull();
  });
});

describe('C2C hardening — focus lifetime / G1 G2', () => {
  beforeEach(() => {
    __resetAnalysisPriceSessionCacheForTests();
    __resetAnalysisPriceGenerationsForTests();
    __resetAnalysisPriceFocusForTests();
    __clearAnalysisPricePaintGateForTests();
  });

  function tinyRows() {
    return [
      makeTrustedG3TestRow('1', {
        receiptId: 'r1',
        occurredAt: MS_DAY,
        displayName: PRODUCT,
        merchantNormalized: MERCHANT,
        merchantRaw: MERCHANT,
        grossLineAmount: 100,
        lineTotal: 100,
      }),
      makeTrustedG3TestRow('2', {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        displayName: PRODUCT,
        merchantNormalized: MERCHANT,
        merchantRaw: MERCHANT,
        grossLineAmount: 130,
        lineTotal: 130,
      }),
    ];
  }

  it('blur-before-scheduled-work => zero derivation', async () => {
    const { release } = __armAnalysisPricePaintGateForTests();
    const focus = createAnalysisPriceFocusToken();
    const generation = createAnalysisPriceGeneration();
    const rows = tinyRows();
    const scheduled = scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts: [{ id: 'r2' } as any],
      rows,
      receiptFingerprints: ['r1::1', 'r2::1'],
      generation,
      focusToken: focus,
      deferUntilPaint: true,
      useTestPaintGate: true,
    });
    scheduled.cancel();
    focus.cancel();
    release();
    const result = await scheduled.promise;
    expect(result.status).toBe('canceled');
    expect(getAnalysisPriceDomainDerivationCount()).toBe(0);
  });

  it('blur-during-chunks cancels without cache write', async () => {
    const focus = createAnalysisPriceFocusToken();
    const generation = createAnalysisPriceGeneration();
    const rows = Array.from({ length: 80 }, (_, i) =>
      makeTrustedG3TestRow(`c-${i}`, {
        receiptId: `cr-${i}`,
        occurredAt: (i + 1) * MS_DAY,
        displayName: PRODUCT,
        merchantNormalized: MERCHANT,
        merchantRaw: MERCHANT,
        grossLineAmount: 100 + (i % 5),
        lineTotal: 100 + (i % 5),
      })
    );
    beginAnalysisPriceChunkTimingCapture();
    const scheduled = scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts: rows.slice(-1).map((r) => ({ id: r.receiptId } as any)),
      rows,
      receiptFingerprints: rows.map((r) => `${r.receiptId}::1`),
      generation,
      focusToken: focus,
      deferUntilPaint: false,
      shouldCancel: () => !focus.isActive(),
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    focus.cancel();
    generation.cancel();
    const result = await scheduled.promise;
    endAnalysisPriceChunkTimingCapture();
    expect(result.status).toBe('canceled');
    expect(getAnalysisPriceDomainDerivationCount()).toBe(0);
  });

  it('G2 wins over late G1 success; stale failure cannot override', async () => {
    const { release } = __armAnalysisPricePaintGateForTests();
    const rows = tinyRows();
    const fingerprints = ['r1::1', 'r2::1'];
    const g1Focus = createAnalysisPriceFocusToken();
    const g1Gen = createAnalysisPriceGeneration();
    const g1 = scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts: [{ id: 'r2' } as any],
      rows,
      receiptFingerprints: fingerprints,
      generation: g1Gen,
      focusToken: g1Focus,
      deferUntilPaint: true,
      useTestPaintGate: true,
    });

    // Start G2 as newer focus/generation.
    g1Focus.cancel();
    g1Gen.cancel();
    const g2Focus = createAnalysisPriceFocusToken();
    const g2Gen = createAnalysisPriceGeneration();
    const g2 = scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts: [{ id: 'r2' } as any],
      rows,
      receiptFingerprints: fingerprints,
      generation: g2Gen,
      focusToken: g2Focus,
      deferUntilPaint: false,
    });
    const g2Result = await g2.promise;
    expect(g2Result.status).not.toBe('canceled');
    const countAfterG2 = getAnalysisPriceDomainDerivationCount();

    release();
    const g1Result = await g1.promise;
    expect(g1Result.status).toBe('canceled');
    expect(getAnalysisPriceDomainDerivationCount()).toBe(countAfterG2);
  });

  it('completed valid cache reused on later focus', async () => {
    const rows = tinyRows();
    const fingerprints = ['r1::1', 'r2::1'];
    const first = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts: [{ id: 'r2' } as any],
      rows,
      receiptFingerprints: fingerprints,
      deferUntilPaint: false,
    }).promise;
    expect(first.cacheHit).toBe(false);
    expect(getAnalysisPriceDomainDerivationCount()).toBe(1);

    // Simulate blur then refocus with new tokens — same snapshot.
    const focus = createAnalysisPriceFocusToken();
    const second = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts: [{ id: 'r2' } as any],
      rows,
      receiptFingerprints: fingerprints,
      focusToken: focus,
      deferUntilPaint: false,
    }).promise;
    expect(second.cacheHit).toBe(true);
    expect(getAnalysisPriceDomainDerivationCount()).toBe(1);
  });

  it('ANALYSIS_PRICE_CHANGES gate remains fail-closed by default', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('isAnalysisPriceChangesEnabled');
    expect(source).not.toContain('ANALYSIS_PRICE_CHANGES_ENABLED = false');
    expect(source).toContain('focusTokenRef');
    expect(source).toContain('cancelScheduledPriceRef');
  });
});
