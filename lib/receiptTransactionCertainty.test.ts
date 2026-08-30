import {
  buildReceiptShoppingSummary,
  buildShoppingFrequency,
  receiptOrderingTimestamp,
} from './engagementMilestones';
import { buildHomeProgressiveExperience } from './homeProgressiveExperience';
import type { ReceiptRow } from './db';

function receiptRow(input: {
  id: string;
  transaction_at?: number | null;
  created_at: number;
  merchant_raw?: string;
  total?: number;
}): ReceiptRow {
  return {
    id: input.id,
    created_at: input.created_at,
    transaction_at: input.transaction_at ?? null,
    merchant_raw: input.merchant_raw ?? 'Costco',
    merchant_normalized: null,
    total: input.total ?? 1000,
    final_total: input.total ?? 1000,
    currency: 'JPY',
    items_json: JSON.stringify([{ name: 'Item', lineTotal: 1000 }]),
    analysis_json: null,
    tax: 0,
    tax_is_known: 0,
    user_id: null,
    installation_id: 'inst',
    source: 'scan',
    merchant_type: 'v1_supported',
  } as unknown as ReceiptRow;
}

describe('receipt transaction date certainty', () => {
  it('A: valid transaction_at becomes visible transactionAt', () => {
    const receipt = receiptRow({
      id: 'r-confirmed',
      transaction_at: Date.parse('2026-08-19T06:33:00.000Z'),
      created_at: Date.parse('2026-08-20T01:00:00.000Z'),
    });

    const summary = buildReceiptShoppingSummary(receipt);

    expect(summary.transactionAt).toBe(Date.parse('2026-08-19T06:33:00.000Z'));
    expect(receiptOrderingTimestamp(receipt)).toBe(
      Date.parse('2026-08-19T06:33:00.000Z')
    );
  });

  it('B: null transaction_at keeps visible date unknown while ordering may use created_at', () => {
    const createdAt = Date.parse('2026-08-20T01:00:00.000Z');
    const receipt = receiptRow({
      id: 'r-undated',
      transaction_at: null,
      created_at: createdAt,
    });

    const summary = buildReceiptShoppingSummary(receipt);

    expect(summary.transactionAt).toBeNull();
    expect(receiptOrderingTimestamp(receipt)).toBe(createdAt);
  });

  it('C: invalid/zero transaction_at keeps visible date unknown with deterministic ordering', () => {
    const createdAt = Date.parse('2026-08-21T01:00:00.000Z');
    const receipt = receiptRow({
      id: 'r-zero',
      transaction_at: 0,
      created_at: createdAt,
    });

    const summary = buildReceiptShoppingSummary(receipt);

    expect(summary.transactionAt).toBeNull();
    expect(receiptOrderingTimestamp(receipt)).toBe(createdAt);
  });

  it('D/F: latest purchase selection stays deterministic and does not expose created_at as purchase date', () => {
    const olderDated = receiptRow({
      id: 'A',
      transaction_at: Date.parse('2026-08-10T01:00:00.000Z'),
      created_at: Date.parse('2026-08-10T02:00:00.000Z'),
    });
    const newerUndated = receiptRow({
      id: 'B',
      transaction_at: null,
      created_at: Date.parse('2026-08-20T01:00:00.000Z'),
    });

    const experience = buildHomeProgressiveExperience(
      [olderDated, newerUndated],
      null
    );

    expect(experience.latestPurchase?.receiptId).toBe('B');
    expect(experience.latestPurchase?.transactionAt).toBeNull();
  });

  it('E: Home uses the same unknown-date key as Receipt Detail', () => {
    const home = require('fs').readFileSync(
      require('path').join(__dirname, '../components/ProgressiveHomeInsights.tsx'),
      'utf8'
    );
    const detail = require('fs').readFileSync(
      require('path').join(
        __dirname,
        '../app/(tabs)/history/[id].tsx'
      ),
      'utf8'
    );

    expect(home).toContain("t('history.detail.dateUnknown')");
    expect(detail).toContain("t('history.detail.dateUnknown')");
    expect(home).toContain('transactionAt != null');
  });

  it('preserves shoppingFrequency ordering fallback semantics', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const first = {
      id: 'a',
      created_at: DAY_MS,
      transaction_at: null,
      merchant_raw: 'A',
      merchant_normalized: null,
      total: 10,
      final_total: 10,
      currency: 'JPY',
      items_json: '[]',
    };
    const second = {
      id: 'b',
      created_at: 3 * DAY_MS,
      transaction_at: null,
      merchant_raw: 'B',
      merchant_normalized: null,
      total: 10,
      final_total: 10,
      currency: 'JPY',
      items_json: '[]',
    };

    const frequency = buildShoppingFrequency([first, second] as never);

    expect(frequency).not.toBeNull();
    expect(frequency?.firstRecordedAt).toBeLessThan(frequency!.lastRecordedAt!);
  });
});
