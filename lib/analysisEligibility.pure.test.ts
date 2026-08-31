import {
  selectAnalysisEligibleReceipts,
  selectAnalysisPeriodReceiptSets,
} from './analysisEligibility';

describe('analysisEligibility pure module boundary', () => {
  it('loads without DB or expo-sqlite transitive dependencies', () => {
    expect(typeof selectAnalysisEligibleReceipts).toBe('function');
    expect(typeof selectAnalysisPeriodReceiptSets).toBe('function');
  });

  it('filters supported JPY without duplicate canonicalization', () => {
    const rows = [
      {
        id: 'a',
        currency: 'JPY',
        merchant_type: 'supermarket',
        transaction_at: Date.now(),
        total: 100,
        analysis_json: '{}',
      },
      {
        id: 'b',
        currency: 'USD',
        merchant_type: 'supermarket',
        transaction_at: Date.now(),
        total: 50,
        analysis_json: '{}',
      },
      {
        id: 'c',
        currency: 'JPY',
        merchant_type: 'other',
        transaction_at: Date.now(),
        total: 200,
        analysis_json: '{}',
      },
    ] as any;

    expect(selectAnalysisEligibleReceipts(rows).map((r) => r.id)).toEqual(['a']);
  });
});
