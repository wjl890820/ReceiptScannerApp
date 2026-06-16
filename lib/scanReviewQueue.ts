/** 多张扫描时按顺序逐张审核的 draft id 队列（SQLite 持久化） */

import {
  filterExistingDraftIds,
  listScanReviewDraftIds,
  loadScanReviewQueue,
  replaceScanReviewQueue,
} from './scanReviewPersistence';
import { logger } from './logger';

export async function setScanReviewQueue(ids: string[]): Promise<void> {
  const ordered = await filterExistingDraftIds(ids);
  await replaceScanReviewQueue(ordered);
}

export async function peekNextDraftId(afterRemoving: string): Promise<string | null> {
  const ids = await loadScanReviewQueue();
  let next = ids.filter((id) => id !== afterRemoving);
  next = await filterExistingDraftIds(next);
  await replaceScanReviewQueue(next);
  return next[0] ?? null;
}

export async function clearScanReviewQueue(): Promise<void> {
  await replaceScanReviewQueue([]);
}

export async function getScanReviewQueue(): Promise<string[]> {
  return loadScanReviewQueue();
}

export type PendingScanReviewState = {
  nextDraftId: string | null;
  pendingCount: number;
};

/**
 * 首页“继续未完成审核”入口使用：返回是否存在仍可继续审核的 draft。
 * - 读取 queue，过滤掉已不存在的脏 id，并把清理结果写回（自动修复脏 queue）。
 * - 若 queue 为空但 scan_review_draft 表仍有草稿（queue 丢失场景），用现有 draft 重建 queue 兜底。
 * - 没有任何有效 draft 时返回空状态，并确保 queue 被清空。
 * 不删除有效 draft；任何异常都降级为空状态，不让首页因脏数据崩溃。
 */
export async function getPendingScanReviewState(): Promise<PendingScanReviewState> {
  try {
    const queue = await loadScanReviewQueue();
    let valid = await filterExistingDraftIds(queue);
    // queue 含脏 id：写回清理后的结果
    if (valid.length !== queue.length) {
      await replaceScanReviewQueue(valid);
    }

    // 兜底：queue 丢失但本地仍有草稿，按现有 draft 重建 queue
    if (valid.length === 0) {
      const draftIds = await listScanReviewDraftIds();
      const rebuilt = await filterExistingDraftIds(draftIds);
      if (rebuilt.length > 0) {
        await replaceScanReviewQueue(rebuilt);
        valid = rebuilt;
      } else if (queue.length > 0) {
        // 既无有效 queue 也无草稿，确保 queue 为空
        await replaceScanReviewQueue([]);
      }
    }

    return { nextDraftId: valid[0] ?? null, pendingCount: valid.length };
  } catch (e) {
    logger.warn('ScanReviewQueue', 'getPendingScanReviewState failed', { error: e });
    return { nextDraftId: null, pendingCount: 0 };
  }
}
