/**
 * Minimal tests for scan pipeline and batch aggregation.
 * Prevents regressions on main flow and batch summary logic.
 */

import {
  runScanPipeline,
  aggregateBatchScanResults,
  type ScanOneResult,
} from './scanPipeline';

// Mock dependencies so we only test pipeline orchestration
jest.mock('./receiptAnalyzer', () => ({
  analyzeReceiptImage: jest.fn(),
}));
jest.mock('./receiptEnricher', () => ({
  applyCategoriesWithLearning: jest.fn(),
}));
jest.mock('./db', () => ({
  saveReceipt: jest.fn(),
}));

const mockAnalyze = jest.requireMock('./receiptAnalyzer').analyzeReceiptImage as jest.Mock;
const mockEnrich = jest.requireMock('./receiptEnricher').applyCategoriesWithLearning as jest.Mock;
const mockSave = jest.requireMock('./db').saveReceipt as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('aggregateBatchScanResults', () => {
  it('counts all success', () => {
    const results: ScanOneResult[] = [
      { ok: true },
      { ok: true },
      { ok: true },
    ];
    const out = aggregateBatchScanResults(results);
    expect(out.successCount).toBe(3);
    expect(out.failCount).toBe(0);
    expect(Object.keys(out.failureReasonsByCode)).toHaveLength(0);
  });

  it('counts all failure and aggregates by code', () => {
    const results: ScanOneResult[] = [
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: false, code: 'RATE_LIMIT' },
    ];
    const out = aggregateBatchScanResults(results);
    expect(out.successCount).toBe(0);
    expect(out.failCount).toBe(3);
    expect(out.failureReasonsByCode).toEqual({ NETWORK_ERROR: 2, RATE_LIMIT: 1 });
  });

  it('mixed success and failure: partial success stats', () => {
    const results: ScanOneResult[] = [
      { ok: true },
      { ok: false, code: 'SERVER_ERROR' },
      { ok: true },
      { ok: false, code: 'SERVER_ERROR' },
      { ok: false, code: 'FAILED' },
    ];
    const out = aggregateBatchScanResults(results);
    expect(out.successCount).toBe(2);
    expect(out.failCount).toBe(3);
    expect(out.failureReasonsByCode).toEqual({ SERVER_ERROR: 2, FAILED: 1 });
  });

  it('treats missing code as FAILED', () => {
    const results: ScanOneResult[] = [
      { ok: false, code: '' },
      { ok: false, code: 'FAILED' },
    ];
    const out = aggregateBatchScanResults(results);
    expect(out.failCount).toBe(2);
    expect(out.failureReasonsByCode['FAILED']).toBe(2);
  });
});

describe('runScanPipeline', () => {
  const uri = 'file:///test.jpg';

  it('success path: analyze -> enrich -> save, returns ok: true', async () => {
    const raw = { items: [], total: 0, currency: 'JPY' };
    const enriched = { ...raw, items: [] };
    mockAnalyze.mockResolvedValue(raw);
    mockEnrich.mockResolvedValue(enriched);
    mockSave.mockResolvedValue(undefined);

    const result = await runScanPipeline(uri);

    expect(result).toEqual({ ok: true });
    expect(mockAnalyze).toHaveBeenCalledWith(uri);
    expect(mockEnrich).toHaveBeenCalledWith(raw);
    expect(mockSave).toHaveBeenCalledWith({ imageUri: uri, analysis: enriched });
  });

  it('OCR failure: analyze throws with code, returns ok: false and does not call enrich/save', async () => {
    mockAnalyze.mockRejectedValue(Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' }));

    const result = await runScanPipeline(uri);

    expect(result).toEqual({ ok: false, code: 'RATE_LIMIT', message: 'rate limited' });
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('OCR failure: unknown error maps to FAILED', async () => {
    mockAnalyze.mockRejectedValue(new Error('network'));

    const result = await runScanPipeline(uri);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FAILED');
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it('enrich or save failure: returns ok: false with code when present', async () => {
    const raw = { items: [], total: 0, currency: 'JPY' };
    mockAnalyze.mockResolvedValue(raw);
    mockEnrich.mockRejectedValue(Object.assign(new Error('server'), { code: 'SERVER_ERROR' }));

    const result = await runScanPipeline(uri);

    expect(result).toEqual({ ok: false, code: 'SERVER_ERROR', message: 'server' });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('save failure: no code on error maps to FAILED', async () => {
    const raw = { items: [], total: 0, currency: 'JPY' };
    mockAnalyze.mockResolvedValue(raw);
    mockEnrich.mockResolvedValue(raw);
    mockSave.mockRejectedValue(new Error('db'));

    const result = await runScanPipeline(uri);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FAILED');
  });
});
