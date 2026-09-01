/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from './db';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  areStructuralExactDuplicateSummaries,
  assessStructuralDuplicateReceiptEligibility,
  buildHighConfidenceDuplicateGroups,
  canonicalStructuralQtyAmountVector,
  extractRawStructuralBasketElements,
  hasValidKnownStructuralDuplicateTax,
  isExplicitStructuralDuplicateJpyReceipt,
  normalizeStructuralDuplicateCurrency,
  summarizeReceiptForDuplicateAudit,
} from './analysisDDuplicateAudit';

const TX_AT = Date.parse('2026-08-10T17:43:00+09:00');
const BASKET = [
  { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
  { name: 'B', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
] as const;

function makeReceipt(overrides: Partial<ReceiptRow> & { id: string }): ReceiptRow {
  const { id, ...rest } = overrides;
  const items =
    (rest.analysis_json
      ? JSON.parse(String(rest.analysis_json)).items
      : BASKET) ?? BASKET;
  return {
    id,
    created_at: rest.created_at ?? TX_AT,
    transaction_at: rest.transaction_at ?? TX_AT,
    image_uri: '',
    total: rest.total ?? 300,
    tax: rest.tax !== undefined ? rest.tax : 22,
    tax_is_known: rest.tax_is_known ?? 1,
    currency: rest.currency ?? 'JPY',
    analysis_json:
      rest.analysis_json ?? JSON.stringify({ items }),
    merchant_raw: rest.merchant_raw ?? '業務スーパー古川店',
    merchant_normalized: rest.merchant_normalized ?? '業務スーパー古川店',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    ...rest,
  } as ReceiptRow;
}

function summarize(id: string, overrides: Partial<ReceiptRow> = {}) {
  return summarizeReceiptForDuplicateAudit(makeReceipt({ id, ...overrides }));
}

describe('structural duplicate safety guards', () => {
  it('1. known 251 / known 251 => match', () => {
    const left = summarize('a', { tax: 251, tax_is_known: 1 });
    const right = summarize('b', { tax: 251, tax_is_known: 1 });
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(true);
  });

  it('2. known 251 / unknown => match', () => {
    const left = summarize('a', { tax: 251, tax_is_known: 1 });
    const right = summarize('b', { tax: 0, tax_is_known: 0 });
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(true);
  });

  it('3. unknown / unknown => match', () => {
    const left = summarize('a', { tax: 0, tax_is_known: 0 });
    const right = summarize('b', { tax: 0, tax_is_known: 0 });
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(true);
  });

  it('4. known 251 / known 250 => reject', () => {
    const left = summarize('a', { tax: 251, tax_is_known: 1 });
    const right = summarize('b', { tax: 250, tax_is_known: 1 });
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(false);
  });

  it('5. taxKnown=true + invalid/null tax => reject', () => {
    const left = summarize('a', { tax: 251, tax_is_known: 1 });
    const right = summarize('b', { tax: null as unknown as number, tax_is_known: 1 });
    expect(hasValidKnownStructuralDuplicateTax(right)).toBe(false);
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(false);
  });

  it('6. JPY / USD => reject', () => {
    const left = summarize('a', { currency: 'JPY' });
    const right = summarize('b', { currency: 'USD' });
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(false);
  });

  it('7. JPY / missing currency => reject', () => {
    const left = summarize('a', { currency: 'JPY' });
    const right = summarize('b', { currency: '' });
    expect(isExplicitStructuralDuplicateJpyReceipt(makeReceipt({ id: 'x', currency: '' }))).toBe(
      false
    );
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(false);
  });

  it('8. zero/negative/NaN total => reject', () => {
    for (const total of [0, -1, Number.NaN]) {
      const summary = summarize(`bad-total-${String(total)}`, { total });
      expect(summary.structuralDuplicateEligible).toBe(false);
    }
  });

  it('9. empty basket => reject', () => {
    const receipt = makeReceipt({
      id: 'empty',
      analysis_json: JSON.stringify({ items: [] }),
    });
    expect(assessStructuralDuplicateReceiptEligibility(receipt).eligible).toBe(false);
  });

  it('10. invalid quantity evidence => reject', () => {
    const receipt = makeReceipt({
      id: 'bad-qty',
      analysis_json: JSON.stringify({
        items: [{ name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 0 }],
      }),
    });
    expect(extractRawStructuralBasketElements(receipt)).toBeNull();
    expect(assessStructuralDuplicateReceiptEligibility(receipt).eligible).toBe(false);
  });

  it('11. invalid line amount evidence => reject', () => {
    const receipt = makeReceipt({
      id: 'bad-amt',
      analysis_json: JSON.stringify({
        items: [{ name: 'A', category: 'food_ingredients', lineTotal: 0, quantity: 1 }],
      }),
    });
    expect(extractRawStructuralBasketElements(receipt)).toBeNull();
    expect(assessStructuralDuplicateReceiptEligibility(receipt).eligible).toBe(false);
  });

  it('12. different structural multiset => reject', () => {
    const left = summarize('a');
    const right = summarize('b', {
      analysis_json: JSON.stringify({
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
        ],
      }),
      total: 400,
    });
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(false);
  });

  it('13. multiplicity preserved', () => {
    const vector = canonicalStructuralQtyAmountVector([
      { quantity: 1, lineAmount: 100 },
      { quantity: 1, lineAmount: 100 },
    ]);
    expect(vector).toEqual([
      { quantity: 1, lineAmount: 100 },
      { quantity: 1, lineAmount: 100 },
    ]);
    const single = canonicalStructuralQtyAmountVector([
      { quantity: 1, lineAmount: 100 },
    ]);
    expect(single).not.toEqual(vector);
  });

  it('14. different transaction_at => separate purchase', () => {
    const left = summarize('a', { transaction_at: TX_AT });
    const right = summarize('b', {
      transaction_at: Date.parse('2026-08-20T17:43:00+09:00'),
    });
    expect(areStructuralExactDuplicateSummaries(left, right)).toBe(false);
  });

  it('15. complete-link tax bridge does not overmerge A(251) B(unknown) C(250)', () => {
    const receipts = [
      makeReceipt({ id: 'A', tax: 251, tax_is_known: 1 }),
      makeReceipt({ id: 'B', tax: 0, tax_is_known: 0 }),
      makeReceipt({ id: 'C', tax: 250, tax_is_known: 1 }),
    ];
    const summaries = receipts.map(summarizeReceiptForDuplicateAudit);
    expect(areStructuralExactDuplicateSummaries(summaries[0]!, summaries[1]!)).toBe(
      true
    );
    expect(areStructuralExactDuplicateSummaries(summaries[1]!, summaries[2]!)).toBe(
      true
    );
    expect(areStructuralExactDuplicateSummaries(summaries[0]!, summaries[2]!)).toBe(
      false
    );

    const groups = buildHighConfidenceDuplicateGroups(summaries, receipts);
    expect(groups.some((group) => group.receiptIds.length === 3)).toBe(false);
    expect(groups).toHaveLength(1);
    expect([...groups[0]!.receiptIds].sort()).toEqual(['A', 'B']);
    expect(selectAnalyticsReceipts(receipts).analyticsPurchaseCandidateCount).toBe(2);
  });

  it('normalizes explicit JPY currency only for structural duplicate path', () => {
    expect(normalizeStructuralDuplicateCurrency('jpy')).toBe('JPY');
    expect(normalizeStructuralDuplicateCurrency('¥')).toBe('JPY');
    expect(normalizeStructuralDuplicateCurrency('')).toBeNull();
    expect(normalizeStructuralDuplicateCurrency(null)).toBeNull();
  });
});
