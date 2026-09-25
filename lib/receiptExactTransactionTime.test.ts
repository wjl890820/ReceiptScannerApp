/**
 * Legacy transaction_time_precision reconstruction (resolver-only).
 */

import type { ReceiptRow } from './db';
import { parseReceiptDateTimeWithPrecision } from './dateParser';
import {
  hasExactTransactionTime,
  resolveReceiptTransactionTimePrecision,
} from './receiptExactTransactionTime';

const COSTCO_TX_AT = 1_688_611_486_000;
const GYOMU_TX_AT = 1_786_351_380_000;

function baseReceipt(
  overrides: Partial<ReceiptRow> &
    Pick<ReceiptRow, 'id' | 'transaction_at' | 'analysis_json'> & {
      transaction_time_precision?: string | null;
    }
): ReceiptRow {
  return {
    created_at: 1,
    image_uri: '',
    merchant_raw: null,
    merchant_normalized: null,
    total: 0,
    tax: 0,
    currency: 'JPY',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    transaction_time_precision: 'unknown',
    ...overrides,
  };
}

describe('resolveReceiptTransactionTimePrecision — legacy reconstruction', () => {
  it('1 — legacy unknown column + second-level date text + exact ms → second', () => {
    const parsed = parseReceiptDateTimeWithPrecision('2024-03-15 10:20:30', {
      fallbackToNow: false,
    });
    expect(parsed.ms).not.toBeNull();
    expect(parsed.precision).toBe('second');
    const receipt = baseReceipt({
      id: 'legacy-second',
      transaction_at: parsed.ms,
      transaction_time_precision: 'unknown',
      analysis_json: JSON.stringify({
        transactionDate: '2024-03-15 10:20:30',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('second');
    expect(hasExactTransactionTime(receipt)).toBe(true);
  });

  it('2 — legacy unknown column + minute-only date text + exact ms → minute', () => {
    const parsed = parseReceiptDateTimeWithPrecision('2026/08/10 17:43', {
      fallbackToNow: false,
    });
    expect(parsed.ms).not.toBeNull();
    expect(parsed.precision).toBe('minute');
    const receipt = baseReceipt({
      id: 'legacy-minute',
      transaction_at: parsed.ms,
      transaction_time_precision: 'unknown',
      analysis_json: JSON.stringify({
        transactionDate: '2026/08/10 17:43',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('minute');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('3 — legacy unknown column + date-only text + exact ms → date', () => {
    const parsed = parseReceiptDateTimeWithPrecision('2026-08-10', {
      fallbackToNow: false,
    });
    expect(parsed.ms).not.toBeNull();
    expect(parsed.precision).toBe('date');
    const receipt = baseReceipt({
      id: 'legacy-date',
      transaction_at: parsed.ms,
      transaction_time_precision: 'unknown',
      analysis_json: JSON.stringify({
        transactionDate: '2026-08-10',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('date');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('4 — parsed ms ≠ persisted transaction_at → unknown', () => {
    const receipt = baseReceipt({
      id: 'mismatch',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        // Different day than COSTCO_TX_AT
        transactionDate: '07/07/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('unknown');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('5 — malformed legacy date text → unknown', () => {
    const receipt = baseReceipt({
      id: 'malformed',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'unknown',
      analysis_json: JSON.stringify({
        transactionDate: 'not-a-real-date',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('unknown');
  });

  it('6 — explicit column second remains second', () => {
    const receipt = baseReceipt({
      id: 'col-second',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'second',
      analysis_json: JSON.stringify({
        transactionDate: '2026/08/10 17:43',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('second');
  });

  it('7 — explicit column minute remains minute', () => {
    const receipt = baseReceipt({
      id: 'col-minute',
      transaction_at: GYOMU_TX_AT,
      transaction_time_precision: 'minute',
      analysis_json: JSON.stringify({
        transactionDate: '07/06/2023 11:44:46',
        merchant: 'Costco',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('minute');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('8 — column unknown + explicit analysis precision unknown → no reconstruction', () => {
    const receipt = baseReceipt({
      id: 'explicit-unknown',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transaction_time_precision: 'unknown',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('unknown');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('9 — column unknown + explicit analysis precision second → uses second', () => {
    const receipt = baseReceipt({
      id: 'analysis-second',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'unknown',
      analysis_json: JSON.stringify({
        transaction_time_precision: 'second',
        transactionDate: 'garbage',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('second');
  });

  it('10 — no precision + no structured text → unknown', () => {
    const receipt = baseReceipt({
      id: 'empty',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: null,
      analysis_json: JSON.stringify({ merchant: 'Costco', total: 1 }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('unknown');
  });

  it('11 — Costco regression: unknown column + second text → second / exact-time', () => {
    const receipt = baseReceipt({
      id: 'costco-148',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: 'Costco',
      merchant_normalized: 'costco',
      total: 9534,
      currency: 'JPY',
      transaction_source: 'receipt_ocr',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        total: 9534,
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('second');
    expect(hasExactTransactionTime(receipt)).toBe(true);
  });

  it('12 — Gyomu regression: unknown column + minute text → minute / NOT exact-time', () => {
    const receipt = baseReceipt({
      id: 'gyomu-3393',
      transaction_at: GYOMU_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: '業務スーパー',
      total: 3393,
      currency: 'JPY',
      analysis_json: JSON.stringify({
        merchant: '業務スーパー',
        total: 3393,
        transactionDate: '2026/08/10 17:43',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('minute');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('Gyomu minute cohort is not structurally exact-time eligible', () => {
    const a = baseReceipt({
      id: 'gyomu-a',
      transaction_at: GYOMU_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: '業務スーパー',
      total: 3393,
      analysis_json: JSON.stringify({
        merchant: '業務スーパー',
        transactionDate: '2026/08/10 17:43',
      }),
    });
    const b = baseReceipt({
      id: 'gyomu-b',
      transaction_at: GYOMU_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: '業務スーパー',
      total: 3393,
      analysis_json: JSON.stringify({
        merchant: '業務スーパー',
        transactionDate: '2026/08/10 17:43',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(a)).toBe('minute');
    expect(resolveReceiptTransactionTimePrecision(b)).toBe('minute');
    expect(hasExactTransactionTime(a)).toBe(false);
    expect(hasExactTransactionTime(b)).toBe(false);
  });

  it('missing column (null) still allows legacy reconstruction', () => {
    const receipt = baseReceipt({
      id: 'missing-col',
      transaction_at: GYOMU_TX_AT,
      transaction_time_precision: null,
      analysis_json: JSON.stringify({
        transactionDate: '2026/08/10 17:43',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('minute');
  });

  it('does not upgrade minute text to second via epoch remainder', () => {
    const receipt = baseReceipt({
      id: 'no-epoch-infer',
      transaction_at: GYOMU_TX_AT,
      transaction_time_precision: 'unknown',
      analysis_json: JSON.stringify({
        transactionDate: '2026/08/10 17:43',
      }),
    });
    // Gyomu ms ends with 000 (second==0) — must still be minute from text.
    expect(GYOMU_TX_AT % 1000).toBe(0);
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('minute');
  });
});

describe('A1 A-blocker — malformed vs missing DB provenance', () => {
  it('1 — malformed DB "SECOND" blocks legacy recovery', () => {
    const receipt = baseReceipt({
      id: 'malformed-db-SECOND',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'SECOND',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('unknown');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('2 — explicit DB date remains authoritative over second-level text', () => {
    const receipt = baseReceipt({
      id: 'db-date-authoritative',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'date',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('date');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('3 — invalid explicit analysis precision blocks recovery', () => {
    const receipt = baseReceipt({
      id: 'analysis-SECOND',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transaction_time_precision: 'SECOND',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('unknown');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('4 — explicit analysis unknown continues blocking recovery', () => {
    const receipt = baseReceipt({
      id: 'analysis-unknown-blocks',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: 'unknown',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transaction_time_precision: 'unknown',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('unknown');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });

  it('5 — genuine missing DB column still reconstructs', () => {
    const receipt = baseReceipt({
      id: 'absent-col',
      transaction_at: COSTCO_TX_AT,
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    delete (receipt as { transaction_time_precision?: string | null })
      .transaction_time_precision;
    expect(
      Object.prototype.hasOwnProperty.call(
        receipt,
        'transaction_time_precision'
      )
    ).toBe(false);
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('second');
    expect(hasExactTransactionTime(receipt)).toBe(true);
  });

  it('6 — null DB column behaves as legacy missing and can reconstruct', () => {
    const receipt = baseReceipt({
      id: 'null-col-second',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: null,
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('second');
    expect(hasExactTransactionTime(receipt)).toBe(true);
  });

  it('empty-string DB precision is invalid, not missing', () => {
    const receipt = baseReceipt({
      id: 'empty-string-col',
      transaction_at: COSTCO_TX_AT,
      transaction_time_precision: '',
      merchant_raw: 'Costco',
      analysis_json: JSON.stringify({
        merchant: 'Costco',
        transactionDate: '07/06/2023 11:44:46',
      }),
    });
    expect(resolveReceiptTransactionTimePrecision(receipt)).toBe('unknown');
    expect(hasExactTransactionTime(receipt)).toBe(false);
  });
});
