import {
  performHistoryPurchaseSearch,
  resolveHistorySearchSubmitAction,
  shouldApplyHistorySearchQueryChange,
} from './historySearchUi';

describe('history search query change', () => {
  it('ignores identical re-fires (IME / Search submit)', () => {
    expect(shouldApplyHistorySearchQueryChange('みか', 'みか')).toBe(false);
    expect(shouldApplyHistorySearchQueryChange('みか', 'みかん')).toBe(true);
  });
});

describe('history search keyboard submit', () => {
  it('A: keeps results when live search already completed for the same query', () => {
    expect(
      resolveHistorySearchSubmitAction({
        rawQuery: 'みか',
        lastCompletedNormalizedQuery: 'みか',
      })
    ).toEqual({ type: 'keep_results' });
  });

  it('B: searches immediately when debounce has not completed yet', () => {
    expect(
      resolveHistorySearchSubmitAction({
        rawQuery: 'みか',
        lastCompletedNormalizedQuery: '',
      })
    ).toEqual({ type: 'search', query: 'みか' });
  });

  it('D: empty/whitespace submit clears instead of loading forever', () => {
    expect(
      resolveHistorySearchSubmitAction({
        rawQuery: '   ',
        lastCompletedNormalizedQuery: 'みか',
      })
    ).toEqual({ type: 'clear' });
  });
});

describe('history search async settlement', () => {
  it('C: search throw still settles so caller can clear loading', async () => {
    let loading = true;
    try {
      const outcome = await performHistoryPurchaseSearch({
        rawQuery: 'みか',
        isCurrent: () => true,
        searchFn: async () => {
          throw new Error('boom');
        },
      });
      expect(outcome).toEqual({ status: 'error', error: expect.any(Error) });
    } finally {
      loading = false;
    }
    expect(loading).toBe(false);
  });

  it('A regression: completed live query + submit does not require another effect', () => {
    // Simulate: live search finished for みか, then Search re-fires same text.
    expect(shouldApplyHistorySearchQueryChange('みか', 'みか')).toBe(false);
    expect(
      resolveHistorySearchSubmitAction({
        rawQuery: 'みか',
        lastCompletedNormalizedQuery: 'みか',
      })
    ).toEqual({ type: 'keep_results' });
  });

  it('returns ok for successful shared search path', async () => {
    const outcome = await performHistoryPurchaseSearch({
      rawQuery: 'みか',
      isCurrent: () => true,
      searchFn: async () => ({
        itemResults: [{ itemId: '1' }],
        receiptResults: [],
      }),
    });
    expect(outcome).toEqual({
      status: 'ok',
      normalizedQuery: 'みか',
      itemResults: [{ itemId: '1' }],
      receiptResults: [],
    });
  });

  it('empty query does not call searchFn', async () => {
    const searchFn = jest.fn();
    const outcome = await performHistoryPurchaseSearch({
      rawQuery: ' \t ',
      isCurrent: () => true,
      searchFn,
    });
    expect(outcome).toEqual({ status: 'empty' });
    expect(searchFn).not.toHaveBeenCalled();
  });
});
