/**
 * Tests for getPendingScanReviewState: 脏 queue 过滤、queue 丢失时按 draft 重建兜底。
 * 通过 mock scanReviewPersistence 的低层函数，避免依赖 SQLite。
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('./scanReviewPersistence', () => ({
  loadScanReviewQueue: jest.fn(),
  filterExistingDraftIds: jest.fn(),
  listScanReviewDraftIds: jest.fn(),
  replaceScanReviewQueue: jest.fn(),
}));

import { getPendingScanReviewState } from './scanReviewQueue';

const P = jest.requireMock('./scanReviewPersistence') as {
  loadScanReviewQueue: jest.Mock;
  filterExistingDraftIds: jest.Mock;
  listScanReviewDraftIds: jest.Mock;
  replaceScanReviewQueue: jest.Mock;
};

/** 用一组“真实存在的 draft id”驱动 filterExistingDraftIds（按输入顺序保留存在者） */
function setExistingDrafts(existing: string[]) {
  const set = new Set(existing);
  P.filterExistingDraftIds.mockImplementation(async (ids: string[]) => ids.filter((id) => set.has(id)));
  P.listScanReviewDraftIds.mockImplementation(async () => [...existing]);
}

beforeEach(() => {
  jest.clearAllMocks();
  P.replaceScanReviewQueue.mockResolvedValue(undefined);
});

describe('getPendingScanReviewState', () => {
  it('queue 为空且没有 draft -> pendingCount 0', async () => {
    P.loadScanReviewQueue.mockResolvedValue([]);
    setExistingDrafts([]);

    const out = await getPendingScanReviewState();
    expect(out).toEqual({ nextDraftId: null, pendingCount: 0 });
  });

  it('queue 有有效 draft -> 返回第一个 draft', async () => {
    P.loadScanReviewQueue.mockResolvedValue(['d1', 'd2']);
    setExistingDrafts(['d1', 'd2']);

    const out = await getPendingScanReviewState();
    expect(out).toEqual({ nextDraftId: 'd1', pendingCount: 2 });
    // 全部有效，无需写回
    expect(P.replaceScanReviewQueue).not.toHaveBeenCalled();
  });

  it('queue 含无效 id -> 自动过滤并写回', async () => {
    P.loadScanReviewQueue.mockResolvedValue(['ghost', 'd2']);
    setExistingDrafts(['d2']);

    const out = await getPendingScanReviewState();
    expect(out).toEqual({ nextDraftId: 'd2', pendingCount: 1 });
    expect(P.replaceScanReviewQueue).toHaveBeenCalledWith(['d2']);
  });

  it('queue 为空但 draft 表有草稿 -> 用现有 draft 重建 queue', async () => {
    P.loadScanReviewQueue.mockResolvedValue([]);
    setExistingDrafts(['d3', 'd4']);

    const out = await getPendingScanReviewState();
    expect(out).toEqual({ nextDraftId: 'd3', pendingCount: 2 });
    expect(P.replaceScanReviewQueue).toHaveBeenCalledWith(['d3', 'd4']);
  });

  it('queue 混合有效/无效 -> 只保留有效，第一张为有效首项', async () => {
    P.loadScanReviewQueue.mockResolvedValue(['ghost1', 'd5', 'ghost2', 'd6']);
    setExistingDrafts(['d5', 'd6']);

    const out = await getPendingScanReviewState();
    expect(out).toEqual({ nextDraftId: 'd5', pendingCount: 2 });
    expect(P.replaceScanReviewQueue).toHaveBeenCalledWith(['d5', 'd6']);
  });

  it('queue 全是脏 id 且无草稿 -> 清空 queue 并返回空状态', async () => {
    P.loadScanReviewQueue.mockResolvedValue(['ghost1', 'ghost2']);
    setExistingDrafts([]);

    const out = await getPendingScanReviewState();
    expect(out).toEqual({ nextDraftId: null, pendingCount: 0 });
    // 至少有一次写回为空
    expect(P.replaceScanReviewQueue).toHaveBeenCalledWith([]);
  });

  it('底层异常 -> 降级为空状态，不抛错', async () => {
    P.loadScanReviewQueue.mockRejectedValue(new Error('db boom'));

    const out = await getPendingScanReviewState();
    expect(out).toEqual({ nextDraftId: null, pendingCount: 0 });
  });
});
