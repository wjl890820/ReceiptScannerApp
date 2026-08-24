import {
  HOME_COLD_START_TIMING_LIMIT,
  HOME_COLD_START_TIMING_STORAGE_KEY,
  HOME_COLD_START_TIMING_VERSION,
  appendHomeColdStartTimingSummary,
  beginHomeColdStartTiming,
  getActiveHomeColdStartTimingSnapshotForTests,
  measureHomeColdStartAsync,
  measureHomeColdStartSync,
  parseHomeColdStartTimingSummaries,
  readHomeColdStartTimingSummaries,
  resetHomeColdStartTimingForTests,
  type HomeColdStartTimingSummary,
} from './homeColdStartTiming';

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
