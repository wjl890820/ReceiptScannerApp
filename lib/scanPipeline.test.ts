/**
 * Minimal tests for scan pipeline and batch aggregation.
 * Prevents regressions on main flow and batch summary logic.
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

import {
  runScanPipeline,
  runScanPipelineToReview,
  aggregateBatchScanResults,
  type ScanOneResult,
} from './scanPipeline';

jest.mock('./receiptAnalyzer', () => ({
  analyzeReceiptImageWithProvenance: jest.fn(),
}));
jest.mock('./receiptEnricher', () => ({
  applyCategoriesWithLearning: jest.fn(),
}));
jest.mock('./db', () => ({
  saveReceipt: jest.fn(),
}));
jest.mock('./scanReviewDraftStore', () => ({
  putScanReviewDraft: jest.fn(async () => 'draft-mock-1'),
}));

const mockAnalyze = jest.requireMock('./receiptAnalyzer')
  .analyzeReceiptImageWithProvenance as jest.Mock;
const mockEnrich = jest.requireMock('./receiptEnricher').applyCategoriesWithLearning as jest.Mock;
const mockSave = jest.requireMock('./db').saveReceipt as jest.Mock;
const mockPutDraft = jest.requireMock('./scanReviewDraftStore').putScanReviewDraft as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockPutDraft.mockResolvedValue('draft-mock-1');
});

describe('aggregateBatchScanResults', () => {
  it('counts all success', () => {
    const results: ScanOneResult[] = [
      { ok: true, kind: 'saved', id: 'a' },
      { ok: true, kind: 'review', draftId: 'd1', traceId: 't1' },
      { ok: true, kind: 'saved', id: 'b' },
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
      { ok: true, kind: 'review', draftId: 'd', traceId: 't' },
      { ok: false, code: 'SERVER_ERROR' },
      { ok: true, kind: 'saved', id: 'x' },
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

  it('success path: analyze -> enrich -> save, returns ok saved', async () => {
    const raw = { items: [], total: 0, currency: 'JPY' };
    const enriched = { ...raw, items: [] };
    mockAnalyze.mockResolvedValue({ analysis: raw, ocrRequestId: 'req-1' });
    mockEnrich.mockResolvedValue(enriched);
    mockSave.mockResolvedValue('rid-1');

    const result = await runScanPipeline(uri);

    expect(result).toEqual({ ok: true, kind: 'saved', id: 'rid-1' });
    expect(mockAnalyze).toHaveBeenCalledWith(uri, expect.any(Object));
    expect(mockEnrich).toHaveBeenCalledWith(raw, expect.any(Object));
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUri: uri,
        analysis: enriched,
        ocrRequestId: 'req-1',
      }),
      expect.any(Object)
    );
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
    mockAnalyze.mockResolvedValue({ analysis: raw, ocrRequestId: null });
    mockEnrich.mockRejectedValue(Object.assign(new Error('server'), { code: 'SERVER_ERROR' }));

    const result = await runScanPipeline(uri);

    expect(result).toEqual({ ok: false, code: 'SERVER_ERROR', message: 'server' });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('save failure: no code on error maps to FAILED', async () => {
    const raw = { items: [], total: 0, currency: 'JPY' };
    mockAnalyze.mockResolvedValue({ analysis: raw, ocrRequestId: null });
    mockEnrich.mockResolvedValue(raw);
    mockSave.mockRejectedValue(new Error('db'));

    const result = await runScanPipeline(uri);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FAILED');
  });
});

describe('runScanPipelineToReview', () => {
  const uri = 'file:///review.jpg';

  it('returns draftId on success without saving', async () => {
    const raw = { items: [], total: 0, currency: 'JPY' };
    const enriched = { ...raw, items: [{ name: 'a' }] };
    mockAnalyze.mockResolvedValue({ analysis: raw, ocrRequestId: 'req-review' });
    mockEnrich.mockResolvedValue(enriched);

    const result = await runScanPipelineToReview(uri);

    expect(result).toEqual({ ok: true, kind: 'review', draftId: 'draft-mock-1', traceId: expect.any(String) });
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockPutDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUri: uri,
        traceId: expect.any(String),
        recognitionSnapshot: enriched,
        ocrRequestId: 'req-review',
      })
    );
  });

  it('OCR failure does not create draft', async () => {
    mockAnalyze.mockRejectedValue(new Error('bad'));
    const result = await runScanPipelineToReview(uri);
    expect(result.ok).toBe(false);
    expect(mockPutDraft).not.toHaveBeenCalled();
  });
});
