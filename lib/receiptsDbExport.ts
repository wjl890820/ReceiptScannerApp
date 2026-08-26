/**
 * Dev-only local SQLite receipts dump.
 * Read-only SELECT *; does not mutate schema or domain write paths.
 */

import { getReceiptsDatabase, initIfNeeded } from './db';

export const RECEIPTS_DB_EXPORT_NAME = 'receipts_v2.db';

export const RECEIPTS_DB_EXPORT_SQL = `
SELECT *
FROM receipts
ORDER BY COALESCE(transaction_at, created_at) ASC
`.trim();

export const RECEIPTS_DB_EXPORT_PRIVACY_WARNING =
  'This JSON contains full local receipt rows (including analysis_json and images URIs). Share only with trusted recipients.';

/** Pad to 2 digits for local timestamp stamps. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Filename: receipts_export_YYYYMMDD_HHmm.json (local time).
 */
export function buildReceiptsDbExportFilename(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return `receipts_export_${stamp}.json`;
}

export function assertReceiptsDbExportAllowed(isDevBuild: boolean = __DEV__): void {
  if (!isDevBuild) {
    throw new Error(
      'Receipts DB export is only available in development builds.'
    );
  }
}

/**
 * Load every receipts row with all DB columns intact (JSON TEXT left as strings).
 */
export async function listAllReceiptRowsForExport(
  isDevBuild: boolean = __DEV__
): Promise<Record<string, unknown>[]> {
  assertReceiptsDbExportAllowed(isDevBuild);
  await initIfNeeded();
  const db = await getReceiptsDatabase();
  const rows = await db.getAllAsync<Record<string, unknown>>(RECEIPTS_DB_EXPORT_SQL);
  return rows ?? [];
}

export type ReceiptsDbExportEnvelope = {
  exportedAt: string;
  dbName: string;
  orderBy: string;
  receiptCount: number;
  receipts: Record<string, unknown>[];
};

/**
 * Serialize rows without parsing/stripping analysis_json / snapshot / user_items.
 */
export function buildReceiptsDbExportJson(
  rows: Record<string, unknown>[],
  nowMs: number = Date.now()
): { filename: string; json: string; envelope: ReceiptsDbExportEnvelope } {
  const envelope: ReceiptsDbExportEnvelope = {
    exportedAt: new Date(nowMs).toISOString(),
    dbName: RECEIPTS_DB_EXPORT_NAME,
    orderBy: 'COALESCE(transaction_at, created_at) ASC',
    receiptCount: rows.length,
    receipts: rows,
  };
  return {
    filename: buildReceiptsDbExportFilename(nowMs),
    // Pretty-print for manual inspection; nested JSON columns stay escaped strings.
    json: JSON.stringify(envelope, null, 2),
    envelope,
  };
}

export type WriteReceiptsDbExportFileDeps = {
  rows: Record<string, unknown>[];
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  nowMs?: number;
};

export async function writeReceiptsDbExportFile(
  deps: WriteReceiptsDbExportFileDeps
): Promise<{ fileUri: string; filename: string; json: string }> {
  if (!deps.cacheDirectory) {
    throw new Error('Cache directory unavailable; cannot export receipts JSON.');
  }
  const built = buildReceiptsDbExportJson(deps.rows, deps.nowMs);
  const fileUri = `${deps.cacheDirectory}${built.filename}`;
  await deps.writeAsStringAsync(fileUri, built.json);
  return {
    fileUri,
    filename: built.filename,
    json: built.json,
  };
}

export type ShareReceiptsDbExportFileDeps = {
  fileUri: string;
  filename: string;
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (
    url: string,
    options?: {
      mimeType?: string;
      UTI?: string;
      dialogTitle?: string;
    }
  ) => Promise<void>;
};

/**
 * Share the written JSON via native Share Sheet (file URI — not text fallback).
 */
export async function shareReceiptsDbExportFile(
  deps: ShareReceiptsDbExportFileDeps
): Promise<void> {
  const available = await deps.isAvailableAsync();
  if (!available) {
    throw new Error(
      'Native file sharing is unavailable on this device. Cannot export receipts JSON as a file.'
    );
  }
  await deps.shareAsync(deps.fileUri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: deps.filename,
  });
}

/**
 * End-to-end: load rows → write cache file → open Share Sheet.
 */
export async function exportAndShareReceiptsDb(deps: {
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: ShareReceiptsDbExportFileDeps['shareAsync'];
  nowMs?: number;
  isDevBuild?: boolean;
}): Promise<{ fileUri: string; filename: string; receiptCount: number }> {
  const rows = await listAllReceiptRowsForExport(deps.isDevBuild ?? __DEV__);
  const written = await writeReceiptsDbExportFile({
    rows,
    cacheDirectory: deps.cacheDirectory,
    writeAsStringAsync: deps.writeAsStringAsync,
    nowMs: deps.nowMs,
  });
  await shareReceiptsDbExportFile({
    fileUri: written.fileUri,
    filename: written.filename,
    isAvailableAsync: deps.isAvailableAsync,
    shareAsync: deps.shareAsync,
  });
  return {
    fileUri: written.fileUri,
    filename: written.filename,
    receiptCount: rows.length,
  };
}
