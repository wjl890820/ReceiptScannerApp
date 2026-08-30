import {
  beginAsyncRequestGeneration,
  invalidateAsyncRequestGeneration,
  shouldApplyAsyncRequestGeneration,
} from './asyncRequestGeneration';

describe('asyncRequestGeneration', () => {
  it('A. old request N cannot apply after newer N+1 starts', () => {
    const ref = { current: 0 };
    const n = beginAsyncRequestGeneration(ref);
    const nPlusOne = beginAsyncRequestGeneration(ref);
    expect(shouldApplyAsyncRequestGeneration(n, ref.current)).toBe(false);
    expect(shouldApplyAsyncRequestGeneration(nPlusOne, ref.current)).toBe(true);
  });

  it('B. old failure cannot clear newer ready state when generation mismatches', () => {
    const ref = { current: 0 };
    const stale = beginAsyncRequestGeneration(ref);
    beginAsyncRequestGeneration(ref);
    expect(shouldApplyAsyncRequestGeneration(stale, ref.current)).toBe(false);
  });

  it('C. blur/unmount invalidates pending request', () => {
    const ref = { current: 0 };
    const pending = beginAsyncRequestGeneration(ref);
    invalidateAsyncRequestGeneration(ref);
    expect(shouldApplyAsyncRequestGeneration(pending, ref.current)).toBe(false);
  });

  it('D. latest active request may apply', () => {
    const ref = { current: 0 };
    const latest = beginAsyncRequestGeneration(ref);
    expect(shouldApplyAsyncRequestGeneration(latest, ref.current)).toBe(true);
  });
});
