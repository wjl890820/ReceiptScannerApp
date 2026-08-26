/**
 * Dev-only receipts DB export — copy/share helpers; no DB mutations.
 */

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  getReceiptsDatabase: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  assertReceiptsDbExportAllowed,
  buildReceiptsDbExportFilename,
  buildReceiptsDbExportJson,
  RECEIPTS_DB_EXPORT_SQL,
  shareReceiptsDbExportFile,
  writeReceiptsDbExportFile,
} from './receiptsDbExport';

describe('receiptsDbExport', () => {
  it('filename uses receipts_export_YYYYMMDD_HHmm.json (local time)', () => {
    const now = new Date(2026, 7, 25, 15, 45, 30).getTime(); // Aug 25 2026 15:45 local
    expect(buildReceiptsDbExportFilename(now)).toBe(
      'receipts_export_20260825_1545.json'
    );
  });

  it('SQL is SELECT * ordered by COALESCE(transaction_at, created_at) ASC', () => {
    expect(RECEIPTS_DB_EXPORT_SQL).toMatch(/SELECT\s+\*/i);
    expect(RECEIPTS_DB_EXPORT_SQL).toMatch(/FROM\s+receipts/i);
    expect(RECEIPTS_DB_EXPORT_SQL).toMatch(
      /ORDER BY\s+COALESCE\(\s*transaction_at\s*,\s*created_at\s*\)\s+ASC/i
    );
    expect(RECEIPTS_DB_EXPORT_SQL).not.toMatch(/LIMIT/i);
  });

  it('keeps analysis_json / recognition_snapshot_json / user_items_json as raw strings', () => {
    const analysisRaw = '{"items":[{"name":"milk","qty":2}],"extra":true}';
    const snapshotRaw = '{"ocr":"raw-line","keep":1}';
    const userItemsRaw = '[{"name":"edited"}]';
    const rows = [
      {
        id: 'r1',
        created_at: 100,
        transaction_at: null,
        analysis_json: analysisRaw,
        recognition_snapshot_json: snapshotRaw,
        user_items_json: userItemsRaw,
        merchant_raw: 'Store',
      },
    ];
    const { json, envelope } = buildReceiptsDbExportJson(rows, 1_700_000_000_000);
    expect(envelope.receiptCount).toBe(1);
    expect(envelope.receipts[0].analysis_json).toBe(analysisRaw);
    expect(envelope.receipts[0].recognition_snapshot_json).toBe(snapshotRaw);
    expect(envelope.receipts[0].user_items_json).toBe(userItemsRaw);

    const parsed = JSON.parse(json) as typeof envelope;
    expect(typeof parsed.receipts[0].analysis_json).toBe('string');
    expect(parsed.receipts[0].analysis_json).toBe(analysisRaw);
    expect(JSON.parse(String(parsed.receipts[0].analysis_json)).extra).toBe(true);
    expect(typeof parsed.receipts[0].recognition_snapshot_json).toBe('string');
    expect(typeof parsed.receipts[0].user_items_json).toBe('string');
  });

  it('rejects export outside development builds', () => {
    expect(() => assertReceiptsDbExportAllowed(false)).toThrow(
      /development builds/i
    );
    expect(() => assertReceiptsDbExportAllowed(true)).not.toThrow();
  });

  it('writes cache file then shares via file URI (Share Sheet path)', async () => {
    const writes: Array<{ uri: string; contents: string }> = [];
    const written = await writeReceiptsDbExportFile({
      rows: [
        {
          id: 'a',
          analysis_json: '{"x":1}',
          recognition_snapshot_json: null,
          user_items_json: null,
        },
      ],
      cacheDirectory: 'file:///tmp/',
      writeAsStringAsync: async (fileUri, contents) => {
        writes.push({ uri: fileUri, contents });
      },
      nowMs: new Date(2026, 0, 2, 9, 8).getTime(),
    });
    expect(written.filename).toBe('receipts_export_20260102_0908.json');
    expect(written.fileUri).toBe('file:///tmp/receipts_export_20260102_0908.json');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].contents).receipts[0].analysis_json).toBe(
      '{"x":1}'
    );

    const shareCalls: unknown[] = [];
    await shareReceiptsDbExportFile({
      fileUri: written.fileUri,
      filename: written.filename,
      isAvailableAsync: async () => true,
      shareAsync: async (url, options) => {
        shareCalls.push({ url, options });
      },
    });
    expect(shareCalls).toEqual([
      {
        url: written.fileUri,
        options: {
          mimeType: 'application/json',
          UTI: 'public.json',
          dialogTitle: written.filename,
        },
      },
    ]);
  });

  it('settings entry is __DEV__-gated and uses export helper', () => {
    const settingsSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/settings/index.tsx'),
      'utf8'
    );
    expect(settingsSource).toContain('exportAndShareReceiptsDb');
    expect(settingsSource).toContain('Export receipts DB (JSON)');
    expect(settingsSource).toMatch(/\{__DEV__\s*\?/);
    expect(settingsSource).toContain('runExportReceiptsDb');
    expect(settingsSource).toContain('Sharing.shareAsync');
  });

  it('export module does not mutate receipts write paths', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'receiptsDbExport.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/\b(runAsync|execAsync|saveReceipt|updateReceipt|deleteReceipt)\b/);
    expect(source).toContain('getAllAsync');
    expect(source).toContain('SELECT *');
  });
});
