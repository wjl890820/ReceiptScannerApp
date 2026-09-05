/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  beginAnalysisPriceWorkCounting,
  endAnalysisPriceWorkCounting,
  prepareAnalysisPriceInsightContext,
} from './analysisPricePreparedContext';
import {
  collectAnalysisTrustedPriceChangeCandidates,
  collectAnalysisTrustedPriceChangeCandidatesAsync,
} from './analysisTrustedPriceChanges';
import {
  beginAnalysisPriceChunkTimingCapture,
  createAnalysisPriceGeneration,
  endAnalysisPriceChunkTimingCapture,
  __resetAnalysisPriceGenerationsForTests,
} from './analysisPriceScheduler';
import {
  buildAnalysisPriceSnapshotSignature,
  getAnalysisPriceDomainDerivationCount,
  readAnalysisPriceDomainCache,
  writeAnalysisPriceDomainCache,
  __resetAnalysisPriceSessionCacheForTests,
} from './analysisPriceSessionCache';
import { deriveAnalysisPriceDomain } from './analysisPriceDerivation';
import {
  beginPeerQualityWorkCounting,
  endPeerQualityWorkCounting,
} from './productIdentityPriceObservationQuality';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';
import fs from 'fs';
import path from 'path';

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
    const receiptId = `c2c-r-${r}`;
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
          purchaseQuantity: i === 0 && r % 5 === 0 ? 2 : 1,
          grossLineAmount:
            i === 0 && r % 5 === 0
              ? 2 * (100 + (r % 7) * 10)
              : 100 + (r % 7) * 10 + i,
          lineTotal:
            i === 0 && r % 5 === 0
              ? 2 * (100 + (r % 7) * 10)
              : 100 + (r % 7) * 10 + i,
        })
      );
    }
  }
  return { rows, seedReceiptIds };
}

describe('AP-3 C2C session cache + cancellation', () => {
  beforeEach(() => {
    __resetAnalysisPriceSessionCacheForTests();
    __resetAnalysisPriceGenerationsForTests();
  });

  it('cache hit => zero additional domain derivation writes', async () => {
    const { rows, seedReceiptIds } = scaleFixture(20);
    const fingerprints = seedReceiptIds.map((id) => `${id}::3`);
    const analyticsReceipts = seedReceiptIds.map((id) => ({ id } as any));

    const first = await deriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      deferUntilPaint: false,
    });
    expect(first.cacheHit).toBe(false);
    expect(getAnalysisPriceDomainDerivationCount()).toBe(1);

    const second = await deriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      deferUntilPaint: false,
    });
    expect(second.cacheHit).toBe(true);
    expect(getAnalysisPriceDomainDerivationCount()).toBe(1);
    expect(second.signature).toBe(first.signature);
  });

  it('locale/timeRange conceptual reuse: same signature keeps cache', () => {
    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'installation:test',
      seedReceiptIds: ['a', 'b'],
      receiptFingerprints: ['a::1', 'b::1'],
      insightRowCount: 4,
    });
    writeAnalysisPriceDomainCache({
      signature,
      candidates: [],
      generationMatches: true,
    });
    // Locale / timeRange are presentation-only — signature unchanged.
    expect(readAnalysisPriceDomainCache(signature)).not.toBeNull();
  });

  it('snapshot change forces recompute', async () => {
    const { rows, seedReceiptIds } = scaleFixture(12);
    const analyticsReceipts = seedReceiptIds.map((id) => ({ id } as any));
    await deriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts,
      rows,
      receiptFingerprints: seedReceiptIds.map((id) => `${id}::1`),
      deferUntilPaint: false,
    });
    expect(getAnalysisPriceDomainDerivationCount()).toBe(1);

    await deriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts,
      rows,
      receiptFingerprints: seedReceiptIds.map((id) => `${id}::2`),
      deferUntilPaint: false,
    });
    expect(getAnalysisPriceDomainDerivationCount()).toBe(2);
  });

  it('owner change forces recompute', async () => {
    const { rows, seedReceiptIds } = scaleFixture(10);
    const analyticsReceipts = seedReceiptIds.map((id) => ({ id } as any));
    const fingerprints = seedReceiptIds.map((id) => `${id}::1`);
    await deriveAnalysisPriceDomain({
      ownerKey: 'installation:a',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      deferUntilPaint: false,
    });
    await deriveAnalysisPriceDomain({
      ownerKey: 'installation:b',
      analyticsReceipts,
      rows,
      receiptFingerprints: fingerprints,
      deferUntilPaint: false,
    });
    expect(getAnalysisPriceDomainDerivationCount()).toBe(2);
  });

  it('stale generation cannot apply or cache', async () => {
    const { rows, seedReceiptIds } = scaleFixture(15);
    const generation = createAnalysisPriceGeneration();
    generation.cancel();
    const result = await deriveAnalysisPriceDomain({
      ownerKey: 'installation:test',
      analyticsReceipts: seedReceiptIds.map((id) => ({ id } as any)),
      rows,
      receiptFingerprints: seedReceiptIds.map((id) => `${id}::1`),
      generation,
      deferUntilPaint: false,
    });
    expect(result.status).toBe('canceled');
    expect(result.surface).toEqual({ status: 'unavailable' });
    expect(getAnalysisPriceDomainDerivationCount()).toBe(0);
    expect(
      readAnalysisPriceDomainCache(result.signature)
    ).toBeNull();
  });

  it('async collect honors cancel mid-flight without applying', async () => {
    const { rows, seedReceiptIds } = scaleFixture(200);
    let cancel = false;
    const pending = collectAnalysisTrustedPriceChangeCandidatesAsync(
      {
        rows,
        seedReceiptIds: new Set(seedReceiptIds),
      },
      {
        shouldCancel: () => cancel,
        targetsPerChunk: 1,
      }
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    cancel = true;
    await expect(pending).resolves.toBeNull();
  });

  it('async collect records cooperative chunk timings', async () => {
    const { rows, seedReceiptIds } = scaleFixture(40);
    beginAnalysisPriceChunkTimingCapture();
    const result = await collectAnalysisTrustedPriceChangeCandidatesAsync(
      {
        rows,
        seedReceiptIds: new Set(seedReceiptIds),
      },
      { targetsPerChunk: 2 }
    );
    const timings = endAnalysisPriceChunkTimingCapture();
    expect(result).not.toBeNull();
    expect(timings.length).toBeGreaterThan(0);
    expect(
      timings.some(
        (sample) =>
          sample.label.startsWith('identity:') ||
          sample.label.startsWith('prepare:')
      )
    ).toBe(true);
  });
});

describe('AP-3 C2C structural fixtures + flag', () => {
  it.each([100, 500, 1000] as const)(
    '%s receipts: one identity/evidence; peer sorts bounded; history inputs < I',
    (receiptCount) => {
      const { rows, seedReceiptIds } = scaleFixture(receiptCount);
      beginAnalysisPriceWorkCounting();
      beginPeerQualityWorkCounting();
      const started = Date.now();
      collectAnalysisTrustedPriceChangeCandidates({
        rows,
        seedReceiptIds: new Set(seedReceiptIds),
      });
      const elapsed = Date.now() - started;
      const work = endAnalysisPriceWorkCounting();
      const peer = endPeerQualityWorkCounting();

      expect(work?.fullUniverseIdentityResolves).toBe(1);
      expect(work?.evidenceCacheBuilds).toBe(1);
      // One prepare/sort per identity or history peer bucket — not per observation.
      expect(peer.peerBucketSortCount).toBeGreaterThan(0);
      expect(peer.peerBucketSortCount).toBeLessThan(rows.length);
      expect(peer.peerFullScanCount).toBe(0);
      const historySum = (work?.historyInputRowCounts ?? []).reduce(
        (a, b) => a + b,
        0
      );
      expect(historySum).toBeLessThanOrEqual(rows.length * 2);
      // eslint-disable-next-line no-console
      console.info(
        `[AP-3 C2C] ${receiptCount} receipts: ${elapsed}ms sorts=${peer.peerBucketSortCount} historySum=${historySum}`
      );
    }
  );

  it('SKU path reuses prepared row identity metadata coverage', () => {
    const rows = [
      makeTrustedG3TestRow('1', {
        skuKey: 'sku-c2c',
        grossLineAmount: 100,
        lineTotal: 100,
        purchaseQuantity: 1,
        displayName: 'Milk',
        receiptId: 's1',
        occurredAt: MS_DAY,
      }),
      makeTrustedG3TestRow('2', {
        skuKey: 'sku-c2c',
        grossLineAmount: 130,
        lineTotal: 130,
        purchaseQuantity: 1,
        displayName: 'Milk',
        receiptId: 's2',
        occurredAt: 2 * MS_DAY,
      }),
    ];
    const prepared = prepareAnalysisPriceInsightContext(
      rows,
      new Set(['s1', 's2'])
    );
    for (const row of prepared.skuBuckets.get('sku-c2c') ?? []) {
      expect(
        prepared.rowIdentityMetadata.has(`${row.receiptId}:${row.sourceIndex}`)
      ).toBe(true);
    }
    const surfaceCandidates = collectAnalysisTrustedPriceChangeCandidates({
      rows,
      seedReceiptIds: new Set(['s2']),
      prepared,
    });
    expect(surfaceCandidates.length).toBeGreaterThanOrEqual(1);
  });

  it('ANALYSIS_PRICE_CHANGES gate remains fail-closed by default', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('isAnalysisPriceChangesEnabled');
    expect(source).not.toContain('ANALYSIS_PRICE_CHANGES_ENABLED = false');
    // Loader stays behind dynamic enablement import, not Analysis module text.
    expect(source).not.toContain('loadAnalysisTrustedPriceChangesSurface');
  });

  it('sync vs async collect ranking equivalence', async () => {
    const { rows, seedReceiptIds } = scaleFixture(30);
    const seed = new Set(seedReceiptIds);
    const sync = collectAnalysisTrustedPriceChangeCandidates({
      rows,
      seedReceiptIds: seed,
    });
    const asyncResult = await collectAnalysisTrustedPriceChangeCandidatesAsync(
      { rows, seedReceiptIds: seed },
      { targetsPerChunk: 2 }
    );
    expect(asyncResult).not.toBeNull();
    expect(
      (asyncResult?.candidates ?? []).map(
        (c) => `${c.target.type}:${c.target.key}`
      )
    ).toEqual(sync.map((c) => `${c.target.type}:${c.target.key}`));
  });
});
