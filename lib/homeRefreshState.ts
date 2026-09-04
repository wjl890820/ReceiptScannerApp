export type HomeRefreshState = {
  initialLoading: boolean;
  backgroundRefreshing: boolean;
  hasCompleteSnapshot: boolean;
};

/**
 * Cold start: block progressive content until the first real local refresh resolves.
 * Avoids rendering empty stage as if it were final truth.
 */
export const INITIAL_HOME_REFRESH_STATE: HomeRefreshState = {
  initialLoading: true,
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

/**
 * Terminal failure for the current attempt.
 * - With a prior snapshot: keep it, clear spinners (background failure).
 * - Without a snapshot: clear loading so genuine persistent errors are not infinite spinners
 *   (callers may hold loading via holdHomeRefreshForRetry before a single automatic retry).
 */
export function failHomeRefresh(
  state: HomeRefreshState
): HomeRefreshState {
  return {
    initialLoading: false,
    backgroundRefreshing: false,
    hasCompleteSnapshot: state.hasCompleteSnapshot,
  };
}

/** Keep blocking loader while awaiting one cold-start retry after init readiness. */
export function holdHomeRefreshForRetry(): HomeRefreshState {
  return {
    initialLoading: true,
    backgroundRefreshing: false,
    hasCompleteSnapshot: false,
  };
}

export function isLatestHomeRefresh(
  requestGeneration: number,
  latestGeneration: number
): boolean {
  return requestGeneration === latestGeneration;
}
