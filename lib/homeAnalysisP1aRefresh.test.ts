import {
  beginAnalysisRefresh,
  completeAnalysisRefresh,
  createInitialAnalysisRefreshUiState,
  failAnalysisRefresh,
  shouldShowAnalysisBlockingLoader,
  shouldShowAnalysisContent,
  shouldShowAnalysisLoadFailed,
} from './analysisRefreshState';
import {
  beginHomeRefresh,
  completeHomeRefresh,
  failHomeRefresh,
  INITIAL_HOME_REFRESH_STATE,
  isLatestHomeRefresh,
} from './homeRefreshState';

describe('Home loading semantics (P1A)', () => {
  it('no snapshot + loading => initial spinner', () => {
    const cold = beginHomeRefresh(INITIAL_HOME_REFRESH_STATE);
    expect(cold.initialLoading).toBe(true);
    expect(cold.hasCompleteSnapshot).toBe(false);
  });

  it('valid snapshot + background refresh => no blocking spinner', () => {
    const refreshing = beginHomeRefresh(completeHomeRefresh());
    expect(refreshing.initialLoading).toBe(false);
    expect(refreshing.backgroundRefreshing).toBe(true);
    expect(refreshing.hasCompleteSnapshot).toBe(true);
  });

  it('background refresh failure => valid content remains', () => {
    const failed = failHomeRefresh(beginHomeRefresh(completeHomeRefresh()));
    expect(failed.hasCompleteSnapshot).toBe(true);
    expect(failed.initialLoading).toBe(false);
    expect(failed.backgroundRefreshing).toBe(false);
  });

  it('successful background refresh => new truth replaces old', () => {
    const done = completeHomeRefresh();
    expect(done.hasCompleteSnapshot).toBe(true);
    expect(done.initialLoading).toBe(false);
    expect(done.backgroundRefreshing).toBe(false);
  });

  it('older completion cannot overwrite newer (generation)', () => {
    expect(isLatestHomeRefresh(1, 2)).toBe(false);
    expect(isLatestHomeRefresh(2, 2)).toBe(true);
  });
});

describe('Analysis loading semantics (P1A)', () => {
  it('first focus, no snapshot => blocking loading', () => {
    const state = beginAnalysisRefresh(createInitialAnalysisRefreshUiState());
    expect(shouldShowAnalysisBlockingLoader(state)).toBe(true);
    expect(shouldShowAnalysisContent(state)).toBe(false);
  });

  it('existing truth + refocus => content remains, no blocking loader', () => {
    const withTruth = completeAnalysisRefresh(
      beginAnalysisRefresh(createInitialAnalysisRefreshUiState())
    );
    const refreshing = beginAnalysisRefresh(withTruth);
    expect(shouldShowAnalysisBlockingLoader(refreshing)).toBe(false);
    expect(shouldShowAnalysisContent(refreshing)).toBe(true);
    expect(refreshing.backgroundRefreshing).toBe(true);
  });

  it('background refresh success => has truth, not loading', () => {
    const done = completeAnalysisRefresh(
      beginAnalysisRefresh(completeAnalysisRefresh(createInitialAnalysisRefreshUiState()))
    );
    expect(done.hasTruthSnapshot).toBe(true);
    expect(shouldShowAnalysisBlockingLoader(done)).toBe(false);
  });

  it('background refresh failure => prior truth remains, no full-screen error', () => {
    const withTruth = completeAnalysisRefresh(
      beginAnalysisRefresh(createInitialAnalysisRefreshUiState())
    );
    const failed = failAnalysisRefresh(beginAnalysisRefresh(withTruth));
    expect(failed.hasTruthSnapshot).toBe(true);
    expect(shouldShowAnalysisLoadFailed(failed)).toBe(false);
    expect(shouldShowAnalysisContent(failed)).toBe(true);
  });

  it('initial load failure with no prior truth => load-failed state', () => {
    const failed = failAnalysisRefresh(
      beginAnalysisRefresh(createInitialAnalysisRefreshUiState())
    );
    expect(shouldShowAnalysisLoadFailed(failed)).toBe(true);
    expect(shouldShowAnalysisContent(failed)).toBe(false);
  });

  it('out-of-order G1/G2 load => G1 cannot overwrite G2', async () => {
    let loadCycle = 0;
    let applied: number | null = null;

    const runLoad = async (label: number, gate: Promise<void>) => {
      const cycleId = ++loadCycle;
      await gate;
      if (loadCycle !== cycleId) return;
      applied = label;
    };

    let resolveG1!: () => void;
    const g1Gate = new Promise<void>((r) => {
      resolveG1 = r;
    });
    const p1 = runLoad(1, g1Gate);
    const p2 = runLoad(2, Promise.resolve());
    await p2;
    expect(applied).toBe(2);
    resolveG1();
    await p1;
    expect(applied).toBe(2);
  });
});
