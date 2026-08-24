export type HomeRefreshState = {
  initialLoading: boolean;
  backgroundRefreshing: boolean;
  hasCompleteSnapshot: boolean;
};

export const INITIAL_HOME_REFRESH_STATE: HomeRefreshState = {
  initialLoading: false,
  backgroundRefreshing: false,
  hasCompleteSnapshot: false,
};

export function beginHomeRefresh(
  state: HomeRefreshState
): HomeRefreshState {
  return state.hasCompleteSnapshot
    ? {
        ...state,
        initialLoading: false,
        backgroundRefreshing: true,
      }
    : {
        ...state,
        initialLoading: true,
        backgroundRefreshing: false,
      };
}

export function completeHomeRefresh(): HomeRefreshState {
  return {
    initialLoading: false,
    backgroundRefreshing: false,
    hasCompleteSnapshot: true,
  };
}

export function failHomeRefresh(
  state: HomeRefreshState
): HomeRefreshState {
  return {
    initialLoading: false,
    backgroundRefreshing: false,
    hasCompleteSnapshot: state.hasCompleteSnapshot,
  };
}

export function isLatestHomeRefresh(
  requestGeneration: number,
  latestGeneration: number
): boolean {
  return requestGeneration === latestGeneration;
}
