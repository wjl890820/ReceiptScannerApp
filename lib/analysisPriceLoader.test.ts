/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import { loadAnalysisTrustedPriceChangesSurface } from './analysisPriceLoader';
import { loadEngagementProductInsightContext } from './engagementMilestones';
import { buildAnalysisPriceChangesSurfaceFromRows } from './analysisPriceSurfaces';
import { createEmptyStats } from './analysisHelpers';
import { buildAnalysisReleaseViewModel } from './analysisPresentation';

jest.mock('./engagementMilestones', () => ({
  loadEngagementProductInsightContext: jest.fn(),
}));

jest.mock('./analysisPriceSurfaces', () => {
  const actual = jest.requireActual('./analysisPriceSurfaces');
  return {
    ...actual,
    buildAnalysisPriceChangesSurfaceFromRows: jest.fn(
      actual.buildAnalysisPriceChangesSurfaceFromRows
    ),
  };
});

const mockLoadContext = loadEngagementProductInsightContext as jest.MockedFunction<
  typeof loadEngagementProductInsightContext
>;
const mockBuildSurface = buildAnalysisPriceChangesSurfaceFromRows as jest.MockedFunction<
  typeof buildAnalysisPriceChangesSurfaceFromRows
>;

describe('loadAnalysisTrustedPriceChangesSurface soft-fail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('degrades to unavailable when surface construction throws', async () => {
    mockLoadContext.mockResolvedValue({
      rows: [{ id: 'row-1' }],
      queryFailed: false,
    } as any);
    mockBuildSurface.mockImplementation(() => {
      throw new Error('candidate construction failed');
    });

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
    mockLoadContext.mockRejectedValue(new Error('loader exploded'));
    const priceChanges = await loadAnalysisTrustedPriceChangesSurface([
      { id: 'r1' } as any,
    ]);
    const viewModel = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
      priceChanges,
    });
    expect(priceChanges).toEqual({ status: 'unavailable' });
    expect(viewModel.stage).toBe('ready');
    expect(viewModel.priceChanges).toEqual({ status: 'unavailable' });
  });
});
