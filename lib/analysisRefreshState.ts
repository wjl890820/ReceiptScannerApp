/**
 * Analysis focus refresh loading semantics (P1A stale-while-refresh).
 */

export type AnalysisRefreshUiState = {
  /** True only when no valid truth snapshot exists yet. */
  initialLoading: boolean;
  /** True while a refresh runs with an existing snapshot (no blocking spinner). */
  backgroundRefreshing: boolean;
  hasTruthSnapshot: boolean;
  loadError: boolean;
};

export function createInitialAnalysisRefreshUiState(): AnalysisRefreshUiState {
  return {
    initialLoading: true,
    backgroundRefreshing: false,
    hasTruthSnapshot: false,
    loadError: false,
  };
}

export function beginAnalysisRefresh(
  state: AnalysisRefreshUiState
): AnalysisRefreshUiState {
  if (state.hasTruthSnapshot) {
    return {
      ...state,
      initialLoading: false,
      backgroundRefreshing: true,
      loadError: false,
    };
  }
  return {
    ...state,
    initialLoading: true,
    backgroundRefreshing: false,
    loadError: false,
  };
}

export function completeAnalysisRefresh(
  state: AnalysisRefreshUiState
): AnalysisRefreshUiState {
  return {
    initialLoading: false,
    backgroundRefreshing: false,
    hasTruthSnapshot: true,
    loadError: false,
  };
}

export function failAnalysisRefresh(
  state: AnalysisRefreshUiState
): AnalysisRefreshUiState {
  if (state.hasTruthSnapshot) {
    return {
      ...state,
      initialLoading: false,
      backgroundRefreshing: false,
      loadError: false,
    };
  }
  return {
    initialLoading: false,
    backgroundRefreshing: false,
    hasTruthSnapshot: false,
    loadError: true,
  };
}

export function shouldShowAnalysisBlockingLoader(
  state: AnalysisRefreshUiState
): boolean {
  return state.initialLoading && !state.hasTruthSnapshot;
}

export function shouldShowAnalysisLoadFailed(
  state: AnalysisRefreshUiState
): boolean {
  return state.loadError && !state.hasTruthSnapshot;
}

export function shouldShowAnalysisContent(
  state: AnalysisRefreshUiState
): boolean {
  return state.hasTruthSnapshot && !shouldShowAnalysisBlockingLoader(state);
}
