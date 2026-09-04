/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

jest.mock('./engagementMilestones', () => ({
  loadEngagementProductInsightContext: jest.fn(),
}));

jest.mock('./receiptOwnershipScope', () => ({
  resolveCurrentLocalReceiptOwnerScope: jest.fn(async () => ({
    status: 'ready',
    ownerKey: 'installation:test',
    params: [],
  })),
}));

jest.mock('./analysisPriceDerivation', () => {
  const actual = jest.requireActual('./analysisPriceDerivation');
  return {
    ...actual,
    deriveAnalysisPriceDomain: jest.fn(actual.deriveAnalysisPriceDomain),
  };
});

import { loadAnalysisTrustedPriceChangesSurface } from './analysisPriceLoader';
import { loadEngagementProductInsightContext } from './engagementMilestones';
import { deriveAnalysisPriceDomain } from './analysisPriceDerivation';
import { createEmptyStats } from './analysisHelpers';
import { buildAnalysisReleaseViewModel } from './analysisPresentation';
import { __resetAnalysisPriceSessionCacheForTests } from './analysisPriceSessionCache';

const mockLoadContext = loadEngagementProductInsightContext as jest.MockedFunction<
  typeof loadEngagementProductInsightContext
>;
const mockDerive = deriveAnalysisPriceDomain as jest.MockedFunction<
  typeof deriveAnalysisPriceDomain
>;

describe('loadAnalysisTrustedPriceChangesSurface soft-fail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetAnalysisPriceSessionCacheForTests();
    mockDerive.mockImplementation(async () => ({
      status: 'unavailable',
      surface: { status: 'unavailable' },
      candidates: [],
      cacheHit: false,
      signature: 'test',
    }));
  });

  it('degrades to unavailable when price context load throws', async () => {
    mockLoadContext.mockRejectedValue(new Error('db unavailable'));

    await expect(
      loadAnalysisTrustedPriceChangesSurface([{ id: 'r1' } as any])
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('degrades to unavailable when queryFailed', async () => {
    mockLoadContext.mockResolvedValue({
      rows: [],
      queryFailed: true,
    } as any);

    await expect(
      loadAnalysisTrustedPriceChangesSurface([{ id: 'r1' } as any])
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('degrades to unavailable when derivation throws', async () => {
    mockLoadContext.mockResolvedValue({
      rows: [{ id: 'row-1' }],
      queryFailed: false,
    } as any);
    mockDerive.mockRejectedValue(new Error('candidate construction failed'));

    await expect(
      loadAnalysisTrustedPriceChangesSurface([{ id: 'r1' } as any])
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('does not throw when optional price surface loader fails', async () => {
    mockLoadContext.mockRejectedValue(new Error('loader exploded'));

    await expect(
      loadAnalysisTrustedPriceChangesSurface([{ id: 'r1' } as any])
    ).resolves.not.toThrow();
  });

  it('keeps core analysis release usable when price surface loader fails', async () => {
    mockLoadContext.mockRejectedValue(new Error('price boom'));
    const priceChanges = await loadAnalysisTrustedPriceChangesSurface([
      { id: 'r1' } as any,
    ]);
    const viewModel = buildAnalysisReleaseViewModel({
      periodStats: createEmptyStats(),
      allSupportedCount: 0,
      itemCount: 0,
      insights: null,
      priceChanges,
    });
    expect(priceChanges).toEqual({ status: 'unavailable' });
    expect(viewModel.stage).toBeTruthy();
    expect(viewModel.priceChanges).toEqual({ status: 'unavailable' });
  });
});
