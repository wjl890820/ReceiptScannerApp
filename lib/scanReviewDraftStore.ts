/**
 * 审核草稿：内存缓存 + SQLite 持久化（冷启动可恢复）。
 * 保存或放弃后应 removeScanReviewDraft。
 */

import { nanoid } from 'nanoid/non-secure';
import * as P from './scanReviewPersistence';

export type ScanReviewEditorStateV1 = {
  version: 1;
  merchant: string;
  dateStr: string;
  totalStr: string;
  taxStr: string;
  currency: string;
  note: string;
  lineItems: { name: string; category: string; quantity: number; lineTotal: number }[];
  errorTags: string[];
};

export type ScanReviewDraft = {
  imageUri: string;
  /** 分类增强后的完整结构（深拷贝），作为不可变识别快照的来源 */
  recognitionSnapshot: unknown;
  traceId: string;
  createdAt: number;
  /** 从磁盘恢复的编辑态；未持久化过则为 undefined */
  editorState?: ScanReviewEditorStateV1;
};

const mem = new Map<string, ScanReviewDraft>();

function parseEditorStateJson(json: string): ScanReviewEditorStateV1 | undefined {
  if (!json || json === '{}') return undefined;
  try {
    const o = JSON.parse(json) as ScanReviewEditorStateV1;
    if (o && o.version === 1 && Array.isArray(o.lineItems)) return o;
  } catch {
    // ignore
  }
  return undefined;
}

function rowToDraft(row: P.ScanReviewDraftPersistRow): ScanReviewDraft {
  let snap: unknown;
  try {
    snap = JSON.parse(row.recognition_snapshot_json);
  } catch {
    snap = {};
  }
  return {
    imageUri: row.image_uri,
    recognitionSnapshot: snap,
    traceId: row.trace_id,
    createdAt: row.created_at,
    editorState: parseEditorStateJson(row.editor_state_json),
  };
}

export async function putScanReviewDraft(
  draft: Omit<ScanReviewDraft, 'createdAt' | 'editorState'> & { createdAt?: number }
): Promise<string> {
  const id = nanoid();
  const now = draft.createdAt ?? Date.now();
  const snapJson = JSON.stringify(draft.recognitionSnapshot);
  await P.insertScanReviewDraft({
    id,
    imageUri: draft.imageUri,
    recognitionSnapshotJson: snapJson,
    traceId: draft.traceId,
    createdAt: now,
    updatedAt: now,
  });
  const full: ScanReviewDraft = {
    imageUri: draft.imageUri,
    recognitionSnapshot: draft.recognitionSnapshot,
    traceId: draft.traceId,
    createdAt: now,
  };
  mem.set(id, full);
  return id;
}

export async function getScanReviewDraft(id: string): Promise<ScanReviewDraft | undefined> {
  if (mem.has(id)) return mem.get(id);
  const row = await P.loadScanReviewDraft(id);
  if (!row) return undefined;
  const d = rowToDraft(row);
  mem.set(id, d);
  return d;
}

export async function removeScanReviewDraft(id: string): Promise<void> {
  await P.deleteScanReviewDraft(id);
  mem.delete(id);
}

/** 防抖后写入当前表单，用于冷启动恢复未保存的修改 */
export async function persistScanReviewDraftEditorState(id: string, state: ScanReviewEditorStateV1): Promise<void> {
  const now = Date.now();
  await P.updateScanReviewDraftEditorJson(id, JSON.stringify(state), now);
  const d = mem.get(id);
  if (d) {
    d.editorState = state;
    mem.set(id, d);
  }
}
