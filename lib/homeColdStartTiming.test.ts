import {
  HOME_COLD_START_TIMING_LIMIT,
  HOME_COLD_START_TIMING_STORAGE_KEY,
  HOME_COLD_START_TIMING_VERSION,
  appendHomeColdStartTimingSummary,
  beginHomeColdStartTiming,
  createProductIdentityHotPathTiming,
  getActiveHomeColdStartTimingSnapshotForTests,
  measureHomeColdStartAsync,
  measureHomeColdStartSync,
  parseHomeColdStartTimingSummaries,
  readHomeColdStartTimingSummaries,
  resetHomeColdStartTimingForTests,
  type HomeColdStartTimingSummary,
} from './homeColdStartTiming';
import { buildIdentityFrequentProductGroups } from './productIdentityConsumer';

function summary(index: number): HomeColdStartTimingSummary {
  return {
    version: HOME_COLD_START_TIMING_VERSION,
    correlationId: `home-cold-${index}`,
    startedAtEpochMs: index,
    completedAtEpochMs: index + 1,
    outcome: 'success',
    phases: {
      initialReceiptRead: {
        durationMs: index,
        counts: { receiptCount: 127 },
      },
    },
  };
}

describe('Home cold-start timing', () => {
  beforeEach(() => {
    resetHomeColdStartTimingForTests();
  });

  it('reuses one correlation for the active cold-load pipeline', () => {
    const first = beginHomeColdStartTiming();
    const second = beginHomeColdStartTiming();

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
  });

  it('records durations and numeric counts without changing return values', () => {
    beginHomeColdStartTiming();
    const result = measureHomeColdStartSync(
      'initialAnalyticsSelection',
      () => 'unchanged',
      () => ({ receiptCount: 127.2, invalidCount: Number.NaN })
    );

    expect(result).toBe('unchanged');
    expect(getActiveHomeColdStartTimingSnapshotForTests()?.phases)
      .toMatchObject({
        initialAnalyticsSelection: {
          counts: { receiptCount: 127 },
        },
      });
  });

  it('records aggregate Product Identity hot-path phases without private inputs', () => {
    beginHomeColdStartTiming();
    const { groups, qualified } = buildIdentityFrequentProductGroups([
      {
        receiptId: 'timing-r1',
        itemSourceIndex: 0,
        rawName: 'Timing Secret Product 500ml',
        merchantKey: 'timing-merchant',
        occurredAt: 1,
        lineTotal: 100,
        quantity: 1,
      },
      {
        receiptId: 'timing-r2',
        itemSourceIndex: 0,
        rawName: 'Timing Secret Product 500ml',
        merchantKey: 'timing-merchant',
        occurredAt: 2,
        lineTotal: 100,
        quantity: 1,
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(qualified).toHaveLength(2);
    const phases = getActiveHomeColdStartTimingSnapshotForTests()?.phases;
    expect(phases?.identityResolverObservationLoop?.counts).toMatchObject({
      observationCount: 2,
      resolvedObservationCount: 2,
      createdMerchantProductCount: 1,
    });
    expect(phases?.identityNormalization?.counts).toEqual({
      normalizationCallCount: 2,
    });
    expect(phases?.identityMerchantCatalogRetrieval?.counts).toEqual({
      catalogLookupCount: 2,
      catalogCandidateCount: 1,
    });
    expect(phases?.identityExactLookup?.counts).toMatchObject({
      exactLookupCount: 2,
      exactLookupHitCount: 1,
      exactLookupMissCount: 1,
      exactAcceptedMatchCount: 1,
    });
    expect(phases?.identityMerchantProductUpsert?.counts).toEqual({
      merchantProductUpsertCount: 1,
      createdMerchantProductCount: 1,
    });
    expect(phases?.identityLinkPersistence?.counts).toEqual({
      linkPersistenceCount: 2,
    });
    expect(phases?.identityQualityQualification?.counts).toEqual({
      qualityEvaluationCount: 2,
    });
    expect(phases?.identityQualityNormalization?.counts).toEqual({
      qualityNormalizationCallCount: 2,
    });
    expect(phases?.identityFuzzyEvaluation?.counts).toMatchObject({
      fuzzyCandidateVisitCount: 0,
      similarityCallCount: 0,
    });
    expect(JSON.stringify(phases)).not.toContain('Timing Secret Product');
    expect(JSON.stringify(phases)).not.toContain('timing-merchant');
  });

  it('does not create Product Identity timing outside a cold-start correlation', () => {
    expect(createProductIdentityHotPathTiming()).toBeNull();
  });

  it('does not serialize operations that callers start in parallel', async () => {
    beginHomeColdStartTiming();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const engagement = measureHomeColdStartAsync(
      'engagementTotal',
      async () => {
        events.push('engagement:start');
        await gate;
        events.push('engagement:end');
        return 1;
      }
    );
    const productContext = measureHomeColdStartAsync(
      'productContextTotal',
      async () => {
        events.push('product:start');
        await gate;
        events.push('product:end');
        return 2;
      }
    );

    expect(events).toEqual(['engagement:start', 'product:start']);
    release();
    await Promise.all([engagement, productContext]);
    expect(events).toEqual([
      'engagement:start',
      'product:start',
      'engagement:end',
      'product:end',
    ]);
  });

  it('keeps only the latest ten local summaries', async () => {
    const values = new Map<string, string>();
    const storage = {
      async getItem(key: string) {
        return values.get(key) ?? null;
      },
      async setItem(key: string, value: string) {
        values.set(key, value);
      },
    };

    for (let index = 0; index < 12; index += 1) {
      await appendHomeColdStartTimingSummary(summary(index), storage);
    }

    const stored = await readHomeColdStartTimingSummaries(storage);
    expect(stored).toHaveLength(HOME_COLD_START_TIMING_LIMIT);
    expect(stored[0]?.correlationId).toBe('home-cold-2');
    expect(stored[9]?.correlationId).toBe('home-cold-11');
    expect(values.has(HOME_COLD_START_TIMING_STORAGE_KEY)).toBe(true);
  });

  it('rejects malformed persisted data and contains no private content fields', () => {
    expect(parseHomeColdStartTimingSummaries('{bad json')).toEqual([]);
    const serialized = JSON.stringify(summary(1));
    for (const forbidden of [
      'merchantName',
      'productName',
      'receiptContents',
      'ocrText',
      'userId',
      'email',
      'authToken',
      'imagePath',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
