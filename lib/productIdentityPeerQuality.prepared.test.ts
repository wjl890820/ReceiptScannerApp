/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import {
  beginPeerQualityWorkCounting,
  endPeerQualityWorkCounting,
  evaluatePriceObservationQuality,
  leaveOneOutPeerStats,
  legacyLeaveOneOutPeerPrices,
  preparePeerPriceBucket,
} from './productIdentityPriceObservationQuality';

function legacyStats(all: number[], exclude: number | null) {
  const peers = legacyLeaveOneOutPeerPrices(all, exclude);
  const quality = evaluatePriceObservationQuality({
    lineTotal: exclude ?? 100,
    quantity: 1,
    peerPurchaseUnitPrices: peers,
  });
  const prepared = leaveOneOutPeerStats(preparePeerPriceBucket(all), exclude);
  const preparedQuality = evaluatePriceObservationQuality({
    lineTotal: exclude ?? 100,
    quantity: 1,
    preparedPeerStats: prepared,
  });
  return { peers, quality, prepared, preparedQuality };
}

describe('prepared leave-one-out peer quality equivalence', () => {
  it.each([
    { name: 'single', all: [100], exclude: 100 },
    { name: 'two peers', all: [100, 120], exclude: 100 },
    { name: 'three odd', all: [100, 120, 140], exclude: 120 },
    { name: 'four even', all: [100, 110, 120, 130], exclude: 110 },
    { name: 'equal prices', all: [200, 200, 200, 200], exclude: 200 },
    { name: 'duplicate equals', all: [100, 100, 150], exclude: 100 },
    { name: 'mild outlier', all: [100, 105, 110, 200], exclude: 200 },
    { name: 'strong outlier', all: [400, 400, 400, 800], exclude: 800 },
    { name: 'fractional', all: [99.5, 100.25, 101.0], exclude: 100.25 },
    { name: 'large', all: [10000, 10100, 10200, 15000], exclude: 15000 },
  ])('$name: median/CV/quality parity', ({ all, exclude }) => {
    const { peers, quality, prepared, preparedQuality } = legacyStats(
      all,
      exclude
    );
    expect(prepared.count).toBe(peers.length);
    if (peers.length > 0) {
      const sorted = [...peers].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const legacyMedian =
        sorted.length % 2
          ? sorted[mid]!
          : (sorted[mid - 1]! + sorted[mid]!) / 2;
      expect(prepared.median).toBeCloseTo(legacyMedian, 10);
    }
    expect(preparedQuality.quality).toBe(quality.quality);
    expect(preparedQuality.includeInHistory).toBe(quality.includeInHistory);
    expect(preparedQuality.includeInTrend).toBe(quality.includeInTrend);
    expect(preparedQuality.potentialOutlier).toBe(quality.potentialOutlier);
    expect(preparedQuality.suspectedIntegerMultiple).toBe(
      quality.suspectedIntegerMultiple
    );
    expect([...preparedQuality.reasons].sort()).toEqual(
      [...quality.reasons].sort()
    );
  });

  it('malformed price still fail-closed with prepared empty peers', () => {
    const quality = evaluatePriceObservationQuality({
      lineTotal: 0,
      quantity: 1,
      preparedPeerStats: { count: 0, median: 0, coeffOfVariation: 0 },
    });
    expect(quality.quality).toBe('invalid');
    expect(quality.includeInHistory).toBe(false);
  });

  it('peer bucket sort happens once per prepare, not per observation', () => {
    beginPeerQualityWorkCounting();
    const prices = Array.from({ length: 40 }, (_, i) => 100 + (i % 7));
    const bucket = preparePeerPriceBucket(prices);
    for (const price of prices) {
      leaveOneOutPeerStats(bucket, price);
    }
    const counts = endPeerQualityWorkCounting();
    expect(counts.peerBucketSortCount).toBe(1);
    expect(counts.peerFirstIndexMapBuildCount).toBe(1);
    expect(counts.peerFullScanCount).toBe(0);
    expect(counts.peerCandidateLinearScans).toBe(0);
  });

  it('leave-one-out variance matches legacy peer array CV', () => {
    const all = [100, 105, 110, 200];
    const exclude = 200;
    const peers = legacyLeaveOneOutPeerPrices(all, exclude);
    const mean = peers.reduce((a, b) => a + b, 0) / peers.length;
    const variance =
      peers.reduce((a, b) => a + (b - mean) ** 2, 0) / peers.length;
    const legacyCv = Math.sqrt(variance) / mean;
    const prepared = leaveOneOutPeerStats(preparePeerPriceBucket(all), exclude);
    expect(prepared.coeffOfVariation).toBeCloseTo(legacyCv, 12);
  });
});
