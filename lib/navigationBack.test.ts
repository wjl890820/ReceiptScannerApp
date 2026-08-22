import {
  HISTORY_TAB_FALLBACK_HREF,
  navigateBackOrHistory,
} from './navigationBack';

describe('navigateBackOrHistory', () => {
  it('uses router.back when history exists', () => {
    const back = jest.fn();
    const replace = jest.fn();
    navigateBackOrHistory({
      canGoBack: () => true,
      back,
      replace,
    });
    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('falls back to History when there is no stack entry', () => {
    const back = jest.fn();
    const replace = jest.fn();
    navigateBackOrHistory({
      canGoBack: () => false,
      back,
      replace,
    });
    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(HISTORY_TAB_FALLBACK_HREF);
  });
});
