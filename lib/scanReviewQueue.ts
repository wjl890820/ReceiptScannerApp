/** 多张扫描时按顺序逐张审核的 draft id 队列（SQLite 持久化） */

import { filterExistingDraftIds, loadScanReviewQueue, replaceScanReviewQueue } from './scanReviewPersistence';

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
