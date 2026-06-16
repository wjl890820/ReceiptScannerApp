/**
 * Tests for scan retry pure helpers: 失败项收集、重试后 draftId 合并、失败原因聚合。
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

import {
  collectFailedScanItems,
  mergeDraftIdsAfterRetry,
  buildBatchFailureSummary,
} from './scanRetryHelpers';
import type { ScanOneResult } from './scanPipeline';

describe('collectFailedScanItems', () => {
  it('只收集失败项，保留原始 index / code / uri', () => {
    const uris = ['a', 'b', 'c'];
    const results: ScanOneResult[] = [
      { ok: true, kind: 'review', draftId: 'd1', traceId: 't1' },
      { ok: false, code: 'NETWORK_ERROR', message: 'boom' },
      { ok: false, code: 'SERVER_ERROR' },
    ];
    const failed = collectFailedScanItems(uris, results);
    expect(failed).toEqual([
      { uri: 'b', index: 1, code: 'NETWORK_ERROR', message: 'boom' },
      { uri: 'c', index: 2, code: 'SERVER_ERROR', message: undefined },
    ]);
  });

  it('无失败项返回空数组', () => {
    const uris = ['a'];
    const results: ScanOneResult[] = [{ ok: true, kind: 'review', draftId: 'd1', traceId: 't1' }];
    expect(collectFailedScanItems(uris, results)).toEqual([]);
  });

  it('缺失 code 时回退为 FAILED', () => {
    const uris = ['a'];
    const results: ScanOneResult[] = [{ ok: false, code: '' }];
    expect(collectFailedScanItems(uris, results)[0].code).toBe('FAILED');
  });
});

describe('mergeDraftIdsAfterRetry', () => {
  it('把重试成功的 draftId 追加到原有之后', () => {
    const original = ['d1', 'd2'];
    const retry: ScanOneResult[] = [
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: true, kind: 'review', draftId: 'd3', traceId: 't3' },
    ];
    expect(mergeDraftIdsAfterRetry(original, retry)).toEqual(['d1', 'd2', 'd3']);
  });

  it('重试全部失败时保持原有不变', () => {
    const original = ['d1'];
    const retry: ScanOneResult[] = [{ ok: false, code: 'SERVER_ERROR' }];
    expect(mergeDraftIdsAfterRetry(original, retry)).toEqual(['d1']);
  });

  it('忽略 saved 类型，只追加 review draftId', () => {
    const retry: ScanOneResult[] = [
      { ok: true, kind: 'saved', id: 'x' },
      { ok: true, kind: 'review', draftId: 'd9', traceId: 't9' },
    ];
    expect(mergeDraftIdsAfterRetry([], retry)).toEqual(['d9']);
  });
});

describe('buildBatchFailureSummary', () => {
  it('按 code 聚合失败数量', () => {
    const out = buildBatchFailureSummary([
      { uri: 'a', index: 0, code: 'NETWORK_ERROR' },
      { uri: 'b', index: 1, code: 'NETWORK_ERROR' },
      { uri: 'c', index: 2, code: 'SERVER_ERROR' },
    ]);
    expect(out.failCount).toBe(3);
    expect(out.failureReasonsByCode).toEqual({ NETWORK_ERROR: 2, SERVER_ERROR: 1 });
  });

  it('空失败列表返回 0', () => {
    const out = buildBatchFailureSummary([]);
    expect(out.failCount).toBe(0);
    expect(out.failureReasonsByCode).toEqual({});
  });
});
