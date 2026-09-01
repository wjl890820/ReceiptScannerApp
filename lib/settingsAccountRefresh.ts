export type AccountStatusSnapshot = {
  uiState: string;
  pendingOutboxCount: number;
};

export type AccountStatusRefresher = {
  refresh: () => Promise<void>;
};

/**
 * Runs account-status refreshes with at-most-one active call and at-most-one
 * queued follow-up when overlapping requests occur (e.g. focus + post-action).
 */
export function createAccountStatusRefresher(params: {
  isEnabled: () => boolean;
  loadStatus: () => Promise<AccountStatusSnapshot>;
  onStatus: (status: AccountStatusSnapshot | null) => void;
  onError?: () => AccountStatusSnapshot;
}): AccountStatusRefresher {
  let inflight = false;
  let queuedFollowUp = false;

  const runRefresh = async (): Promise<void> => {
    inflight = true;
    try {
      const snapshot = await params.loadStatus();
      params.onStatus(snapshot);
    } catch {
      params.onStatus(
        params.onError?.() ?? {
          uiState: 'auth_unavailable',
          pendingOutboxCount: 0,
        }
      );
    } finally {
      inflight = false;
      if (queuedFollowUp) {
        queuedFollowUp = false;
        await runRefresh();
      }
    }
  };

  const refresh = async (): Promise<void> => {
    if (!params.isEnabled()) {
      params.onStatus(null);
      return;
    }
    if (inflight) {
      queuedFollowUp = true;
      return;
    }
    await runRefresh();
  };

  return { refresh };
}
