/**
 * 审核草稿 + 队列的 SQLite 持久化（receipts_v2.db）。
 * 由 scanReviewDraftStore / scanReviewQueue 调用；表在 lib/db initIfNeeded 中创建。
 */

import * as SQLite from 'expo-sqlite';
import { initIfNeeded } from './db';

const DB_NAME = 'receipts_v2.db';

async function openDb(): Promise<SQLite.SQLiteDatabase> {
  await initIfNeeded();
  return SQLite.openDatabaseAsync(DB_NAME);
}

export type ScanReviewDraftPersistRow = {
  id: string;
  image_uri: string;
  recognition_snapshot_json: string;
  trace_id: string;
  editor_state_json: string;
  created_at: number;
  updated_at: number;
  /** Edge provenance.requestId — nullable for legacy drafts */
  ocr_request_id?: string | null;
};

/** Ensure durable draft column for OCR request linkage (cold-start safe). */
export async function ensureScanReviewDraftOcrRequestIdColumn(
  db: SQLite.SQLiteDatabase
): Promise<void> {
  const info = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(scan_review_draft)`);
  const names = new Set((info ?? []).map((c) => c.name));
  if (!names.has('ocr_request_id')) {
    try {
      await db.runAsync(`ALTER TABLE scan_review_draft ADD COLUMN ocr_request_id TEXT`);
    } catch (e: any) {
      if (!e?.message?.includes('duplicate column')) throw e;
    }
  }
}

export async function insertScanReviewDraft(row: {
  id: string;
  imageUri: string;
  recognitionSnapshotJson: string;
  traceId: string;
  createdAt: number;
  updatedAt: number;
  ocrRequestId?: string | null;
}): Promise<void> {
  const db = await openDb();
  await ensureScanReviewDraftOcrRequestIdColumn(db);
  const ocrRequestId =
    typeof row.ocrRequestId === 'string' && row.ocrRequestId.trim()
      ? row.ocrRequestId.trim()
      : null;
  await db.runAsync(
    `
    INSERT INTO scan_review_draft (
      id, image_uri, recognition_snapshot_json, trace_id, editor_state_json,
      created_at, updated_at, ocr_request_id
    ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)
    `,
    [
      row.id,
      row.imageUri,
      row.recognitionSnapshotJson,
      row.traceId,
      row.createdAt,
      row.updatedAt,
      ocrRequestId,
    ]
  );
}

export async function loadScanReviewDraft(id: string): Promise<ScanReviewDraftPersistRow | null> {
  const db = await openDb();
  await ensureScanReviewDraftOcrRequestIdColumn(db);
  const row = await db.getFirstAsync<ScanReviewDraftPersistRow>(
    `SELECT id, image_uri, recognition_snapshot_json, trace_id, editor_state_json,
            created_at, updated_at, ocr_request_id
     FROM scan_review_draft WHERE id = ? LIMIT 1`,
    [id]
  );
  return row ?? null;
}

export async function deleteScanReviewDraft(id: string): Promise<void> {
  const db = await openDb();
  await db.runAsync(`DELETE FROM scan_review_draft WHERE id = ?`, [id]);
}

export async function updateScanReviewDraftEditorJson(id: string, editorStateJson: string, updatedAt: number): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    `UPDATE scan_review_draft SET editor_state_json = ?, updated_at = ? WHERE id = ?`,
    [editorStateJson, updatedAt, id]
  );
}

export async function listScanReviewDraftIds(): Promise<string[]> {
  const db = await openDb();
  const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM scan_review_draft ORDER BY updated_at DESC`);
  return (rows ?? []).map((r) => r.id);
}

async function ensureQueueRow(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO scan_review_queue (slot, queue_json, updated_at) VALUES (1, '[]', ?)`,
    [Date.now()]
  );
}

export async function loadScanReviewQueue(): Promise<string[]> {
  const db = await openDb();
  await ensureQueueRow(db);
  const row = await db.getFirstAsync<{ queue_json: string }>(
    `SELECT queue_json FROM scan_review_queue WHERE slot = 1 LIMIT 1`
  );
  if (!row?.queue_json) return [];
  try {
    const arr = JSON.parse(row.queue_json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export async function replaceScanReviewQueue(ids: string[]): Promise<void> {
  const db = await openDb();
  await ensureQueueRow(db);
  const now = Date.now();
  await db.runAsync(`UPDATE scan_review_queue SET queue_json = ?, updated_at = ? WHERE slot = 1`, [
    JSON.stringify(ids),
    now,
  ]);
}

/** 按传入顺序返回仍存在于 scan_review_draft 表中的 id */
export async function filterExistingDraftIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const db = await openDb();
  const ph = ids.map(() => '?').join(',');
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM scan_review_draft WHERE id IN (${ph})`,
    ids
  );
  const keep = new Set((rows ?? []).map((r) => r.id));
  return ids.filter((id) => keep.has(id));
}
