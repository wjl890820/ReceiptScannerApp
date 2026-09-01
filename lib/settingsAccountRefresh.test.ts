import { createAccountStatusRefresher } from './settingsAccountRefresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createAccountStatusRefresher', () => {
  it('C. queues one follow-up refresh and applies the newer result', async () => {
    const first = deferred<{ uiState: string; pendingOutboxCount: number }>();
    const second = deferred<{ uiState: string; pendingOutboxCount: number }>();
    let loadCalls = 0;
    const snapshots: Array<{ uiState: string; pendingOutboxCount: number } | null> =
      [];

    const refresher = createAccountStatusRefresher({
      isEnabled: () => true,
      loadStatus: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          return first.promise;
        }
        return second.promise;
      },
      onStatus: (status) => {
        snapshots.push(status);
      },
    });

    const focusRefresh = refresher.refresh();
    await Promise.resolve();
    expect(loadCalls).toBe(1);

    void refresher.refresh();
    await Promise.resolve();
    expect(loadCalls).toBe(1);

    first.resolve({ uiState: 'anonymous', pendingOutboxCount: 0 });
    second.resolve({ uiState: 'apple_linked_protected', pendingOutboxCount: 0 });
    await focusRefresh;

    expect(snapshots).toEqual([
      { uiState: 'anonymous', pendingOutboxCount: 0 },
      { uiState: 'apple_linked_protected', pendingOutboxCount: 0 },
    ]);
    expect(loadCalls).toBe(2);
  });

  it('D. multiple overlapping requests run only one follow-up refresh', async () => {
    const first = deferred<{ uiState: string; pendingOutboxCount: number }>();
    let loadCalls = 0;

    const refresher = createAccountStatusRefresher({
      isEnabled: () => true,
      loadStatus: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          return first.promise;
        }
        return { uiState: 'apple_linked_protected', pendingOutboxCount: 0 };
      },
      onStatus: () => {},
    });

    const initial = refresher.refresh();
    await Promise.resolve();
    void refresher.refresh();
    void refresher.refresh();
    void refresher.refresh();

    first.resolve({ uiState: 'anonymous', pendingOutboxCount: 0 });
    await initial;

    expect(loadCalls).toBe(2);
  });

  it('E. post-action refresh during focus refresh ends on post-action state', async () => {
    const focus = deferred<{ uiState: string; pendingOutboxCount: number }>();
    let loadCalls = 0;
    let finalStatus: { uiState: string; pendingOutboxCount: number } | null =
      null;

    const refresher = createAccountStatusRefresher({
      isEnabled: () => true,
      loadStatus: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          return focus.promise;
        }
        return { uiState: 'apple_linked_protected', pendingOutboxCount: 0 };
      },
      onStatus: (status) => {
        finalStatus = status;
      },
    });

    const focusRefresh = refresher.refresh();
    await Promise.resolve();
    void refresher.refresh();

    focus.resolve({ uiState: 'anonymous', pendingOutboxCount: 1 });
    await focusRefresh;

    expect(loadCalls).toBe(2);
    expect(finalStatus).toEqual({
      uiState: 'apple_linked_protected',
      pendingOutboxCount: 0,
    });
  });
});
