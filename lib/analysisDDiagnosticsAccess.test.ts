/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  ANALYSIS_D_EXPORT_PRIVACY_WARNING,
  ANALYSIS_D_JSON_MIME_TYPE,
  ANALYSIS_D_JSON_UTI,
  buildAnalysisDDiagnosticsViewModel,
  buildAnalysisDExportFilename,
  buildAnalysisDJsonFileShareRequest,
  buildAnalysisDSharePayload,
  shareAnalysisDJsonFile,
  shouldShowAnalysisDDiagnosticsEntry,
  writeAnalysisDJsonExportFile,
} from './analysisDDiagnosticsAccess';
import {
  ANALYSIS_D_DIAGNOSTICS_RECEIPT_LIMIT,
  generateAnalysisDReportFromLocalReceipts,
} from './analysisDDiagnosticsGenerate';
import * as analysisDReport from './analysisDReport';
import type { ReceiptRow } from './db';

const nowMs = Date.parse('2026-08-22T12:00:00+09:00');

function makeReceipt(id: string): ReceiptRow {
  return {
    id,
    created_at: nowMs - 86400000,
    transaction_at: nowMs - 86400000,
    image_uri: '',
    total: 100,
    tax: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [
        {
          name: '牛乳',
          category: 'food_ingredients',
          lineTotal: 100,
          quantity: 1,
        },
      ],
    }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

describe('Analysis D1-A diagnostics access', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('A — flag false: Settings diagnostic entry absent', () => {
    expect(shouldShowAnalysisDDiagnosticsEntry(false)).toBe(false);
  });

  test('B — flag true: entry present', () => {
    expect(shouldShowAnalysisDDiagnosticsEntry(true)).toBe(true);
  });

  test('C — generate path calls buildAnalysisDReport (D0 harness)', async () => {
    const spy = jest.spyOn(analysisDReport, 'buildAnalysisDReport');
    const receipts = [makeReceipt('d1a-c')];
    await generateAnalysisDReportFromLocalReceipts({
      listReceiptsFn: async () => receipts,
      nowMs,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      receipts,
      nowMs,
    });
  });

  test('D — generate does not call receipt write APIs', async () => {
    const writeNames = [
      'saveReceipt',
      'updateReceipt',
      'deleteReceipt',
      'deleteReceipts',
    ];
    const listReceiptsFn = jest.fn(async () => [makeReceipt('d1a-d')]);
    await generateAnalysisDReportFromLocalReceipts({
      listReceiptsFn,
      nowMs,
    });
    expect(listReceiptsFn).toHaveBeenCalledWith(
      ANALYSIS_D_DIAGNOSTICS_RECEIPT_LIMIT
    );

    const generateSource = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDiagnosticsGenerate.ts'),
      'utf8'
    );
    for (const name of writeNames) {
      expect(generateSource).not.toContain(name);
    }
    expect(generateSource).toContain('listReceipts');
    expect(generateSource).toContain('buildAnalysisDReport');
  });

  test('E — manual JSON serialization uses report object', () => {
    const report = analysisDReport.buildAnalysisDReport({
      receipts: [makeReceipt('d1a-e')],
      nowMs,
    });
    const serializeSpy = jest.spyOn(
      analysisDReport,
      'serializeAnalysisDReport'
    );
    const payload = buildAnalysisDSharePayload(report, nowMs);
    expect(serializeSpy).toHaveBeenCalledWith(report);
    expect(JSON.parse(payload.json).generatedAt).toBe(report.generatedAt);
    expect(payload.filename).toBe(buildAnalysisDExportFilename(nowMs));
  });

  test('F — share payload includes report JSON and never auto-uploads', () => {
    const report = analysisDReport.buildAnalysisDReport({
      receipts: [makeReceipt('d1a-f')],
      nowMs,
    });
    const payload = buildAnalysisDSharePayload(report, nowMs);
    expect(payload.autoUpload).toBe(false);
    expect(payload.json).toContain('"contractVersion"');
    expect(payload.json).toContain(String(report.dataset.totalLocalReceiptCount));

    const accessSource = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDiagnosticsAccess.ts'),
      'utf8'
    );
    const screenSource = fs.readFileSync(
      path.resolve(__dirname, '../app/analysis-d-diagnostics.tsx'),
      'utf8'
    );
    expect(accessSource).not.toMatch(/supabase|fetch\(|uploadAsync|telemetry/i);
    expect(accessSource).toContain('autoUpload: false');
    expect(screenSource).not.toMatch(/supabase\.|uploadAsync|telemetry/i);
    expect(screenSource).toContain('Share.share');
    expect(screenSource).toContain('Sharing.shareAsync');
    expect(screenSource).toContain('writeAnalysisDJsonExportFile');
    expect(payload.autoUpload).toBe(false);
  });

  test('G — generation error surfaces without mutating domain data', async () => {
    await expect(
      generateAnalysisDReportFromLocalReceipts({
        listReceiptsFn: async () => {
          throw new Error('local_db_unavailable');
        },
        nowMs,
      })
    ).rejects.toThrow('local_db_unavailable');

    const screenSource = fs.readFileSync(
      path.resolve(__dirname, '../app/analysis-d-diagnostics.tsx'),
      'utf8'
    );
    expect(screenSource).toContain('setErrorMessage');
    expect(screenSource).toMatch(/catch \(e/);
    expect(screenSource).not.toMatch(
      /saveReceipt|updateReceipt|reclassifyReceipts|appendUserCorrections/
    );
  });

  test('H — private-data warning shown for export path', () => {
    const report = analysisDReport.buildAnalysisDReport({
      receipts: [makeReceipt('d1a-h')],
      nowMs,
    });
    const payload = buildAnalysisDSharePayload(report, nowMs);
    expect(payload.privacyWarning).toBe(ANALYSIS_D_EXPORT_PRIVACY_WARNING);
    expect(ANALYSIS_D_EXPORT_PRIVACY_WARNING).toMatch(/private purchase-history/i);

    const screenSource = fs.readFileSync(
      path.resolve(__dirname, '../app/analysis-d-diagnostics.tsx'),
      'utf8'
    );
    expect(screenSource).toContain('ANALYSIS_D_EXPORT_PRIVACY_WARNING');
    expect(screenSource).toContain('payload.privacyWarning');
  });

  test('I — Settings gates Analysis D entry; normal tree unchanged when flag OFF', () => {
    const settingsSource = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/settings.tsx'),
      'utf8'
    );
    expect(settingsSource).toContain('shouldShowAnalysisDDiagnosticsEntry');
    expect(settingsSource).toContain('isAnalysisDDiagnosticsEnabled');
    expect(settingsSource).toContain('showAnalysisDDiagnostics');
    expect(settingsSource).toContain('Analysis D Diagnostics');
    expect(settingsSource).toContain('/analysis-d-diagnostics');

    // Entry is behind the flag gate, not always visible JSX without condition.
    expect(settingsSource).toMatch(
      /\{showAnalysisDDiagnostics \? \([\s\S]*Analysis D Diagnostics[\s\S]*\) : null\}/
    );

    // Release-forbidden engineering tokens remain outside the gated Internal section.
    const jsxStart = settingsSource.indexOf('return (\n    <ScrollView');
    const beforeDiagnostics =
      settingsSource.slice(jsxStart).split('{showAnalysisDDiagnostics ?')[0] ??
      '';
    expect(beforeDiagnostics).not.toContain('Analysis D Diagnostics');
    expect(beforeDiagnostics).not.toContain('Internal / Validation');
  });

  test('view-model formats report fields only (no subjective labels)', () => {
    const report = analysisDReport.buildAnalysisDReport({
      receipts: [makeReceipt('d1a-vm')],
      nowMs,
    });
    const vm = buildAnalysisDDiagnosticsViewModel(report);
    expect(vm.generatedAtLabel).toBe(new Date(report.generatedAt).toISOString());
    expect(vm.summaryText).toContain('receipt');
    const titles = vm.sections.map((s) => s.title);
    expect(titles).toEqual([
      'Dataset',
      'Coverage',
      'Merchants',
      'Products',
      'Prices',
      'Trends',
      'Insights',
      'Corrections',
      'Quality',
    ]);
    const blob = JSON.stringify(vm);
    expect(blob).not.toMatch(/\bUSEFUL\b|\bBAD\b|\bNOISY\b|\bMISLEADING\b/);
  });

  test('D2-A — view-model includes duplicate / re-scan section when audit provided', () => {
    const { buildAnalysisDDuplicateScanAudit } = require('./analysisDDuplicateAudit');
    const receipts = [makeReceipt('d2a-vm-1'), makeReceipt('d2a-vm-2')];
    // Force exact duplicate pair
    receipts[1]!.id = 'd2a-vm-2';
    receipts[1]!.created_at = nowMs - 86400000 + 1;
    receipts[1]!.transaction_at = receipts[0]!.transaction_at;
    receipts[1]!.analysis_json = receipts[0]!.analysis_json;
    receipts[1]!.total = receipts[0]!.total;
    const audit = buildAnalysisDDuplicateScanAudit(receipts, nowMs);
    const report = analysisDReport.buildAnalysisDReport({ receipts, nowMs });
    const vm = buildAnalysisDDiagnosticsViewModel(report, audit);
    expect(vm.sections.map((s) => s.title)).toContain(
      'Duplicate / re-scan (D2-A)'
    );
    const section = vm.sections.find(
      (s) => s.title === 'Duplicate / re-scan (D2-A)'
    );
    expect(section?.lines.some((l) => l.includes('exact duplicate'))).toBe(
      true
    );
  });
});


describe('Analysis D1-B1 JSON file export', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('A/B/C — full JSON export writes a .json file with complete serialized report', async () => {
    const report = analysisDReport.buildAnalysisDReport({
      receipts: [makeReceipt('d1b1-abc')],
      nowMs,
    });
    const expectedJson = analysisDReport.serializeAnalysisDReport(report);
    let writtenUri = '';
    let writtenContents = '';
    const written = await writeAnalysisDJsonExportFile({
      report,
      cacheDirectory: 'file:///tmp/analysis-d-cache/',
      writeAsStringAsync: async (uri, contents) => {
        writtenUri = uri;
        writtenContents = contents;
      },
      nowMs,
    });

    expect(written.filename).toMatch(/\.json$/);
    expect(written.filename).toBe(buildAnalysisDExportFilename(nowMs));
    expect(written.filename.startsWith('analysis-d-report-')).toBe(true);
    expect(written.fileUri).toBe(`file:///tmp/analysis-d-cache/${written.filename}`);
    expect(writtenUri).toBe(written.fileUri);
    expect(writtenContents).toBe(expectedJson);
    expect(written.json).toBe(expectedJson);
  });

  test('D/E — file share receives a file URI + application/json (not full JSON string)', async () => {
    const report = analysisDReport.buildAnalysisDReport({
      receipts: [makeReceipt('d1b1-de')],
      nowMs,
    });
    const payload = buildAnalysisDSharePayload(report, nowMs);
    const fileUri = `file:///tmp/${payload.filename}`;
    const request = buildAnalysisDJsonFileShareRequest(fileUri, payload.filename);

    expect(request.fileUri).toBe(fileUri);
    expect(request.fileUri).not.toBe(payload.json);
    expect(request.message).toBeUndefined();
    expect(request.mimeType).toBe(ANALYSIS_D_JSON_MIME_TYPE);
    expect(request.mimeType).toBe('application/json');
    expect(request.uti).toBe(ANALYSIS_D_JSON_UTI);
    expect(request.autoUpload).toBe(false);

    const shareCalls: Array<{ url: string; options?: Record<string, string> }> =
      [];
    const shared = await shareAnalysisDJsonFile({
      fileUri,
      filename: payload.filename,
      isAvailableAsync: async () => true,
      shareAsync: async (url, options) => {
        shareCalls.push({
          url,
          options: options as Record<string, string> | undefined,
        });
      },
    });
    expect(shareCalls).toHaveLength(1);
    expect(shareCalls[0]?.url).toBe(fileUri);
    expect(shareCalls[0]?.url).not.toContain(payload.json.slice(0, 32));
    expect(shareCalls[0]?.options).toMatchObject({
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: payload.filename,
    });
    expect(shared.fileUri).toBe(fileUri);
  });

  test('F — no auto upload / network path in export helpers or screen export', () => {
    const accessSource = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDiagnosticsAccess.ts'),
      'utf8'
    );
    const screenSource = fs.readFileSync(
      path.resolve(__dirname, '../app/analysis-d-diagnostics.tsx'),
      'utf8'
    );
    expect(accessSource).not.toMatch(/supabase|fetch\(|uploadAsync|telemetry/i);
    expect(screenSource).not.toMatch(/supabase\.|uploadAsync|telemetry/i);
    expect(screenSource).toContain('Sharing.shareAsync');
    expect(screenSource).not.toMatch(/Share\.share\(\{[\s\S]*payload\.json/);
    expect(screenSource).not.toContain('90000');
  });

  test('G — Share summary remains text-based', () => {
    const screenSource = fs.readFileSync(
      path.resolve(__dirname, '../app/analysis-d-diagnostics.tsx'),
      'utf8'
    );
    expect(screenSource).toMatch(
      /Share\.share\(\{\s*message:\s*viewModel\.summaryText\s*\}\)/
    );
  });

  test('H — privacy confirmation remains on export path', () => {
    const screenSource = fs.readFileSync(
      path.resolve(__dirname, '../app/analysis-d-diagnostics.tsx'),
      'utf8'
    );
    expect(screenSource).toContain('payload.privacyWarning');
    expect(screenSource).toContain('Alert.alert');
    expect(screenSource).toContain('ANALYSIS_D_EXPORT_PRIVACY_WARNING');
  });

  test('I — temporary file creation does not mutate receipts/domain data', async () => {
    const report = analysisDReport.buildAnalysisDReport({
      receipts: [makeReceipt('d1b1-i')],
      nowMs,
    });
    await writeAnalysisDJsonExportFile({
      report,
      cacheDirectory: 'file:///tmp/analysis-d-cache/',
      writeAsStringAsync: async () => undefined,
      nowMs,
    });

    const accessSource = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDiagnosticsAccess.ts'),
      'utf8'
    );
    const screenSource = fs.readFileSync(
      path.resolve(__dirname, '../app/analysis-d-diagnostics.tsx'),
      'utf8'
    );
    for (const src of [accessSource, screenSource]) {
      expect(src).not.toMatch(
        /saveReceipt|updateReceipt|deleteReceipt|reclassifyReceipts|appendUserCorrections/
      );
    }
  });

  test('fallback — unavailable native sharing throws (no text fallback)', async () => {
    await expect(
      shareAnalysisDJsonFile({
        fileUri: 'file:///tmp/analysis-d-report.json',
        filename: 'analysis-d-report.json',
        isAvailableAsync: async () => false,
        shareAsync: async () => {
          throw new Error('should not be called');
        },
      })
    ).rejects.toThrow(/Native file sharing is unavailable/i);
  });
});
