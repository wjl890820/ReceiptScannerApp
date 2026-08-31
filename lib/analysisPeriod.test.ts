import {
  filterAnalysisReceiptsByTransactionWindow,
  filterAnalysisReceiptsByTimeRange,
  resolveAnalysisRollingWindowBounds,
  validAnalysisTransactionAt,
} from './analysisPeriod';
import { selectAnalysisPeriodReceiptSets } from './analysisEligibility';

const NOW = Date.parse('2026-08-31T12:00:00+09:00');
const MS_DAY = 24 * 60 * 60 * 1000;

type TxReceipt = { id: string; transaction_at: number };

function ids(
  receipts: readonly TxReceipt[],
  startMs: number,
  endMs: number,
  includeEnd: boolean
): string[] {
  return filterAnalysisReceiptsByTransactionWindow(
    receipts,
    startMs,
    endMs,
    { includeEnd }
  ).map((r) => r.id);
}

describe('analysisPeriod rolling window contract', () => {
  it('defines week current and previous bounds', () => {
    const bounds = resolveAnalysisRollingWindowBounds('week', NOW);
    expect(bounds.periodDays).toBe(7);
    expect(bounds.currentStartMs).toBe(NOW - 7 * MS_DAY);
    expect(bounds.currentEndMs).toBe(NOW);
    expect(bounds.previousStartMs).toBe(NOW - 14 * MS_DAY);
    expect(bounds.previousEndMs).toBe(bounds.currentStartMs);
  });

  it('defines month current and previous bounds', () => {
    const bounds = resolveAnalysisRollingWindowBounds('month', NOW);
    expect(bounds.periodDays).toBe(30);
    expect(bounds.currentStartMs).toBe(NOW - 30 * MS_DAY);
    expect(bounds.previousEndMs).toBe(bounds.currentStartMs);
  });

  it('matches filterAnalysisReceiptsByTimeRange to transaction window includeEnd', () => {
    const row = {
      transaction_at: NOW - 30 * MS_DAY,
    };
    const byRange = filterAnalysisReceiptsByTimeRange([row], 'month', NOW);
    const bounds = resolveAnalysisRollingWindowBounds('month', NOW);
    const byWindow = filterAnalysisReceiptsByTransactionWindow(
      [row],
      bounds.currentStartMs,
      bounds.currentEndMs,
      { includeEnd: true }
    );
    expect(byRange).toEqual(byWindow);
  });

  it('excludes receipts without valid transaction_at from rolling windows', () => {
    const rows = [
      { transaction_at: NOW - 1 * MS_DAY },
      { transaction_at: null },
      { transaction_at: 0 },
    ];
    const filtered = filterAnalysisReceiptsByTimeRange(rows, 'week', NOW);
    expect(filtered).toHaveLength(1);
    expect(validAnalysisTransactionAt(rows[1])).toBeNull();
  });
});

describe('analysisPeriod exact boundary membership', () => {
  it('week — exact millisecond membership with no overlap', () => {
    const bounds = resolveAnalysisRollingWindowBounds('week', NOW);
    const fixtures: TxReceipt[] = [
      { id: 'at-end', transaction_at: bounds.currentEndMs },
      { id: 'current-start', transaction_at: bounds.currentStartMs },
      { id: 'just-before-current', transaction_at: bounds.currentStartMs - 1 },
      { id: 'previous-start', transaction_at: bounds.previousStartMs },
      { id: 'just-before-previous', transaction_at: bounds.previousStartMs - 1 },
    ];

    const currentIds = ids(
      fixtures,
      bounds.currentStartMs,
      bounds.currentEndMs,
      true
    );
    const previousIds = ids(
      fixtures,
      bounds.previousStartMs,
      bounds.previousEndMs,
      false
    );

    expect(currentIds).toEqual(['at-end', 'current-start']);
    expect(previousIds).toEqual(['just-before-current', 'previous-start']);
    expect(currentIds).not.toContain('just-before-current');
    expect(previousIds).not.toContain('current-start');
    expect(previousIds).not.toContain('just-before-previous');
  });

  it('month — exact millisecond membership with no overlap', () => {
    const bounds = resolveAnalysisRollingWindowBounds('month', NOW);
    const fixtures: TxReceipt[] = [
      { id: 'at-end', transaction_at: bounds.currentEndMs },
      { id: 'current-start', transaction_at: bounds.currentStartMs },
      { id: 'just-before-current', transaction_at: bounds.currentStartMs - 1 },
      { id: 'previous-start', transaction_at: bounds.previousStartMs },
      { id: 'just-before-previous', transaction_at: bounds.previousStartMs - 1 },
    ];

    const currentIds = ids(
      fixtures,
      bounds.currentStartMs,
      bounds.currentEndMs,
      true
    );
    const previousIds = ids(
      fixtures,
      bounds.previousStartMs,
      bounds.previousEndMs,
      false
    );

    expect(currentIds).toEqual(['at-end', 'current-start']);
    expect(previousIds).toEqual(['just-before-current', 'previous-start']);
    expect(currentIds).not.toContain('just-before-current');
    expect(previousIds).not.toContain('current-start');
    expect(previousIds).not.toContain('just-before-previous');
  });

  it('selectAnalysisPeriodReceiptSets uses the same week boundaries', () => {
    const bounds = resolveAnalysisRollingWindowBounds('week', NOW);
    const rows = [
      { id: 'at-end', transaction_at: bounds.currentEndMs },
      { id: 'current-start', transaction_at: bounds.currentStartMs },
      { id: 'just-before-current', transaction_at: bounds.currentStartMs - 1 },
      { id: 'previous-start', transaction_at: bounds.previousStartMs },
      { id: 'just-before-previous', transaction_at: bounds.previousStartMs - 1 },
    ].map((f) => ({
      id: f.id,
      transaction_at: f.transaction_at,
      currency: 'JPY',
      merchant_type: 'supermarket',
      total: 100,
      analysis_json: '{}',
    })) as any;

    const sets = selectAnalysisPeriodReceiptSets(rows, 'week', NOW);
    expect(sets.currentPeriodReceipts.map((r) => r.id)).toEqual([
      'at-end',
      'current-start',
    ]);
    expect(sets.previousPeriodReceipts.map((r) => r.id)).toEqual([
      'just-before-current',
      'previous-start',
    ]);
  });
});
