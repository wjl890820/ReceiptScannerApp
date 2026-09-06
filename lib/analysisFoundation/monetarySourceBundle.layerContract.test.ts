/**
 * Monetary-layer source contract repair — observe override fields, not user_edited alone.
 */
import { resolveReceiptMonetarySourceBundle } from './monetarySourceBundle';
import type { ReceiptRow } from '../db';

function receipt(overrides: Partial<ReceiptRow> & { id?: string }): ReceiptRow {
  return {
    id: overrides.id ?? 'r1',
    created_at: 1,
    transaction_at: 1,
    image_uri: '',
    merchant_raw: 'm',
    merchant_normalized: 'm',
    total: overrides.total ?? 1080,
    tax: overrides.tax ?? 80,
    tax_is_known: overrides.tax_is_known ?? 1,
    currency: 'JPY',
    analysis_json:
      overrides.analysis_json ??
      JSON.stringify({
        items: [{ name: 'x', lineTotal: 1000 }],
        discounts: [],
      }),
    user_edited: overrides.user_edited ?? 0,
    final_total: overrides.final_total ?? null,
    final_category: null,
    note: null,
    user_items_json: overrides.user_items_json ?? null,
    ...overrides,
  } as ReceiptRow;
}

describe('resolveReceiptMonetarySourceBundle layer contract', () => {
  it('legacy user_edited=1 without override fields uses OCR layer', () => {
    const bundle = resolveReceiptMonetarySourceBundle(
      receipt({
        user_edited: 1,
        user_items_json: null,
        final_total: null,
      })
    );
    expect(bundle.coherent).toBe(true);
    expect(bundle.layer).toBe('ocr');
    expect(bundle.reasonCodes).not.toContain(
      'inconsistent_legacy_user_edit_metadata'
    );
    expect(bundle.evidence).toContain(
      'legacy_user_edited_without_monetary_override_ignored'
    );
    expect(bundle.paidTotal).toBe(1080);
  });

  it('user_edited=0 without overrides matches OCR layer paidTotal', () => {
    const a = resolveReceiptMonetarySourceBundle(
      receipt({ user_edited: 1, user_items_json: null, final_total: null })
    );
    const b = resolveReceiptMonetarySourceBundle(
      receipt({ user_edited: 0, user_items_json: null, final_total: null })
    );
    expect(a.coherent).toBe(true);
    expect(b.coherent).toBe(true);
    expect(a.layer).toBe('ocr');
    expect(b.layer).toBe('ocr');
    expect(a.paidTotal).toBe(b.paidTotal);
  });

  it('user_items without final_total uses receipt.total paidTotal', () => {
    const bundle = resolveReceiptMonetarySourceBundle(
      receipt({
        user_edited: 1,
        final_total: null,
        user_items_json: JSON.stringify([
          { name: 'edited', lineTotal: 900, quantity: 1 },
        ]),
      })
    );
    expect(bundle.coherent).toBe(true);
    expect(bundle.layer).toBe('user');
    expect(bundle.paidTotal).toBe(1080);
    expect(bundle.items).toHaveLength(1);
    expect(bundle.reasonCodes).not.toContain(
      'user_items_without_authoritative_total'
    );
    expect(bundle.evidence).toContain('monetary_layer=user_items_override');
    expect(bundle.evidence).toContain(
      'paid_total_from_receipt_total_unoverridden'
    );
  });

  it('user_items without final_total + invalid receipt.total fails closed', () => {
    const bundle = resolveReceiptMonetarySourceBundle(
      receipt({
        total: Number.NaN,
        user_edited: 1,
        final_total: null,
        user_items_json: JSON.stringify([{ name: 'edited', lineTotal: 900 }]),
      })
    );
    expect(bundle.coherent).toBe(false);
    expect(bundle.reasonCodes).toContain('invalid_authoritative_total');
  });

  it('user_items + final_total keeps full user layer', () => {
    const bundle = resolveReceiptMonetarySourceBundle(
      receipt({
        user_edited: 1,
        final_total: 950,
        user_items_json: JSON.stringify([{ name: 'edited', lineTotal: 950 }]),
      })
    );
    expect(bundle.coherent).toBe(true);
    expect(bundle.layer).toBe('user');
    expect(bundle.paidTotal).toBe(950);
    expect(bundle.evidence).toContain('paid_total_from_final_total');
  });

  it('malformed user_items still fail closed', () => {
    const bundle = resolveReceiptMonetarySourceBundle(
      receipt({
        user_edited: 1,
        final_total: 1080,
        user_items_json: '{not-json',
      })
    );
    expect(bundle.coherent).toBe(false);
    expect(bundle.reasonCodes).toContain('malformed_user_items_json');
  });

  it('final_total-only remains fail closed', () => {
    const bundle = resolveReceiptMonetarySourceBundle(
      receipt({
        user_edited: 1,
        final_total: 1080,
        user_items_json: null,
      })
    );
    expect(bundle.coherent).toBe(false);
    expect(bundle.reasonCodes).toContain(
      'final_total_without_matching_item_layer'
    );
  });
});
