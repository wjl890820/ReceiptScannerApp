/**
 * A-class fix: user-layer closure consumes bundle.paidTotal / bundle.items
 * (item-only override must not fail solely for missing final_total).
 */
/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import { resolveReceiptMonetarySourceBundle } from './analysisFoundation/monetarySourceBundle';
import { assessReceiptAmountBasis } from './analysisFoundation/amountBasis';
import { assessSameLayerMonetaryClosure } from './receiptEvidenceTruth/monetaryClosure';
import { buildReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/monetaryCoherenceEvidence';
import {
  buildProductPriceHistory,
  buildReceiptEvidenceCache,
} from './productPriceHistory';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';

function makeReceipt(args: {
  id: string;
  total?: number;
  tax?: number;
  taxIsKnown?: number;
  userEdited?: number;
  userItemsJson?: string | null;
  finalTotal?: number | null;
  items?: Array<Record<string, unknown>>;
  discounts?: Array<Record<string, unknown>>;
}): ReceiptRow {
  const total = args.total ?? 1080;
  const items = args.items ?? [{ name: 'A', quantity: 1, lineTotal: 1000 }];
  return {
    id: args.id,
    created_at: 1,
    transaction_at: 1,
    image_uri: '',
    merchant_raw: 'Store',
    merchant_normalized: 'store',
    total,
    tax: args.tax ?? 80,
    tax_is_known: args.taxIsKnown ?? 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items,
      discounts: args.discounts ?? [],
      evidenceCaptureVersion: 1,
      reconciliation: { ok: true },
      amount_mismatch: false,
    }),
    user_edited: args.userEdited ?? 0,
    final_total: args.finalTotal ?? null,
    final_category: null,
    note: null,
    user_items_json: args.userItemsJson ?? null,
  } as ReceiptRow;
}

/** Closable item-only override: items=1000, tax=80, receipt.total=1080, no final_total. */
function closableItemOnlyOverride(id = 'item-only-close'): ReceiptRow {
  return makeReceipt({
    id,
    total: 1080,
    tax: 80,
    taxIsKnown: 1,
    userEdited: 1,
    finalTotal: null,
    userItemsJson: JSON.stringify([
      { name: 'A', quantity: 1, lineTotal: 1000 },
    ]),
    items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
  });
}

describe('user-layer closure consumes bundle.paidTotal (A-class)', () => {
  it('1 — item-only override: closure runs (not inputs_incomplete)', () => {
    const receipt = closableItemOnlyOverride();
    const bundle = resolveReceiptMonetarySourceBundle(receipt);
    expect(bundle.coherent).toBe(true);
    expect(bundle.layer).toBe('user');
    expect(bundle.paidTotal).toBe(1080);

    const closure = assessSameLayerMonetaryClosure(receipt, bundle, {
      reconciliationOk: true,
      amountMismatch: false,
    });
    expect(closure.reasonCodes).not.toContain(
      'user_same_layer_closure_inputs_incomplete'
    );
    expect(closure.state).toBe('known_coherent');
    expect(closure.hypothesis).toBe(
      'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
    );
    expect(closure.evidence).toContain(
      'paid_total_from_receipt_total_unoverridden'
    );
    expect(closure.evidence).toContain('paid_total=1080');
  });

  it('2 — buildReceiptMonetaryCoherenceEvidence for closable item-only override', () => {
    const monetary = buildReceiptMonetaryCoherenceEvidence(
      closableItemOnlyOverride('coherence-item-only')
    );
    expect(monetary.state).toBe('known_coherent');
    expect(monetary.monetaryProvenanceSufficient).toBe(true);
    expect(monetary.reasonCodes).not.toContain(
      'user_same_layer_closure_inputs_incomplete'
    );
    expect(monetary.evidence).toContain(
      'paid_total_from_receipt_total_unoverridden'
    );
    expect(monetary.evidence).not.toContain('paid_total_from_final_total');
  });

  it('3 — buildReceiptEvidenceCache shares amount-basis + coherence semantics', () => {
    const receipt = closableItemOnlyOverride('cache-item-only');
    const row = makeTrustedG3TestRow('1', {
      receiptId: receipt.id,
      displayName: 'A',
      grossLineAmount: 1000,
      lineTotal: 1000,
      purchaseQuantity: 1,
      receiptTotal: 1080,
      receiptTax: 80,
      receiptTaxIsKnown: 1,
      receiptFinalTotal: null,
      receiptUserEdited: 1,
      receiptUserItemsJson: receipt.user_items_json,
      receiptAnalysisJson: receipt.analysis_json,
      priceObservationVersion: 1,
      itemAmountEvidenceState: 'coherent',
    });
    const cache = buildReceiptEvidenceCache([row]);
    const entry = cache.get(receipt.id);
    expect(entry).toBeTruthy();
    expect(entry!.monetaryCoherenceEvidence.state).toBe('known_coherent');
    expect(
      entry!.monetaryCoherenceEvidence.monetaryProvenanceSufficient
    ).toBe(true);
    expect(entry!.amountBasisAssessment.basis).toBe('tax_excluded');
    expect(entry!.amountBasisAssessment.exactComparisonTrusted).toBe(true);
    expect(entry!.amountBasisAssessment.reasonCodes).not.toContain(
      'user_items_without_authoritative_total'
    );
  });

  it('4 — buildProductPriceHistory Level-2 does not reject for missing final_total contract', () => {
    const receiptA = closableItemOnlyOverride('hist-a');
    const receiptB = makeReceipt({
      id: 'hist-b',
      total: 1180,
      tax: 80,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: null,
      userItemsJson: JSON.stringify([
        { name: 'A', quantity: 1, lineTotal: 1100 },
      ]),
      items: [{ name: 'A', quantity: 1, lineTotal: 1100 }],
    });

    const rows = [
      makeTrustedG3TestRow('a', {
        receiptId: receiptA.id,
        sourceIndex: 0,
        occurredAt: 100,
        displayName: 'A',
        skuKey: 'sku-item-only',
        grossLineAmount: 1000,
        lineTotal: 1000,
        purchaseQuantity: 1,
        receiptTotal: 1080,
        receiptTax: 80,
        receiptTaxIsKnown: 1,
        receiptFinalTotal: null,
        receiptUserEdited: 1,
        receiptUserItemsJson: receiptA.user_items_json,
        receiptAnalysisJson: receiptA.analysis_json,
      }),
      makeTrustedG3TestRow('b', {
        receiptId: receiptB.id,
        sourceIndex: 0,
        occurredAt: 200,
        displayName: 'A',
        skuKey: 'sku-item-only',
        grossLineAmount: 1100,
        lineTotal: 1100,
        purchaseQuantity: 1,
        receiptTotal: 1180,
        receiptTax: 80,
        receiptTaxIsKnown: 1,
        receiptFinalTotal: null,
        receiptUserEdited: 1,
        receiptUserItemsJson: receiptB.user_items_json,
        receiptAnalysisJson: receiptB.analysis_json,
      }),
    ];

    const cache = buildReceiptEvidenceCache(rows);
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-item-only' },
      rows,
      {
        receiptEvidenceCache: cache,
        canonicalDuplicateSelectionApplied: true,
      }
    );

    for (const observation of history.observations) {
      expect(observation.level2RejectReasons).not.toContain(
        'user_same_layer_closure_inputs_incomplete'
      );
      expect(observation.level2RejectReasons).not.toContain('monetary_incoherent');
      expect(observation.level2RejectReasons).not.toContain(
        'monetary_provenance_insufficient'
      );
      expect(observation.level2RejectReasons).not.toContain(
        'amount_basis_untrusted'
      );
      expect(observation.level2Eligible).toBe(true);
    }
    expect(history.status).toBe('ready');
    expect(history.points.length).toBeGreaterThanOrEqual(2);
  });

  it('5 — invalid receipt.total with item-only override still fail closed', () => {
    const receipt = makeReceipt({
      id: 'bad-total',
      total: Number.NaN,
      userEdited: 1,
      finalTotal: null,
      userItemsJson: JSON.stringify([{ name: 'A', lineTotal: 1000 }]),
    });
    const bundle = resolveReceiptMonetarySourceBundle(receipt);
    expect(bundle.coherent).toBe(false);
    expect(bundle.reasonCodes).toContain('invalid_authoritative_total');

    const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
    expect(monetary.state).not.toBe('known_coherent');
    expect(monetary.monetaryProvenanceSufficient).toBe(false);
  });

  it('6 — full override (user items + final_total) unchanged', () => {
    const receipt = makeReceipt({
      id: 'full-override',
      total: 2000,
      tax: 80,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: 1080,
      userItemsJson: JSON.stringify([
        { name: 'A', quantity: 1, lineTotal: 1000 },
      ]),
    });
    const bundle = resolveReceiptMonetarySourceBundle(receipt);
    expect(bundle.paidTotal).toBe(1080);
    expect(bundle.evidence).toContain('paid_total_from_final_total');

    const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
    expect(monetary.state).toBe('known_coherent');
    expect(monetary.evidence).toContain('paid_total_from_final_total');
  });

  it('7 — legacy reviewed flag without overrides stays OCR/base layer', () => {
    const receipt = makeReceipt({
      id: 'legacy-flag',
      total: 1080,
      tax: 80,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: null,
      userItemsJson: null,
      items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
    });
    const bundle = resolveReceiptMonetarySourceBundle(receipt);
    expect(bundle.layer).toBe('ocr');
    expect(bundle.evidence).toContain(
      'legacy_user_edited_without_monetary_override_ignored'
    );
    const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
    expect(monetary.state).toBe('known_coherent');
    expect(monetary.authoritativeLayer).toBe('ocr');
  });

  it('8 — malformed user_items still fail closed', () => {
    const receipt = makeReceipt({
      id: 'malformed',
      userEdited: 1,
      finalTotal: 1080,
      userItemsJson: '{not-json',
    });
    const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
    expect(monetary.state).not.toBe('known_coherent');
    expect(
      monetary.reasonCodes.some(
        (c) =>
          c === 'malformed_user_items_json' ||
          c === 'monetary_source_bundle_incoherent'
      )
    ).toBe(true);
  });

  it('9 — final_total-only still fail closed', () => {
    const receipt = makeReceipt({
      id: 'final-only',
      userEdited: 1,
      finalTotal: 1080,
      userItemsJson: null,
    });
    const bundle = resolveReceiptMonetarySourceBundle(receipt);
    expect(bundle.coherent).toBe(false);
    expect(bundle.reasonCodes).toContain(
      'final_total_without_matching_item_layer'
    );
    const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
    expect(monetary.state).not.toBe('known_coherent');
  });

  it('10 — discount ownership unresolved still blocks even for item-only override', () => {
    const receipt = makeReceipt({
      id: 'disc-unresolved',
      total: 1080,
      tax: 80,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: null,
      userItemsJson: JSON.stringify([
        { name: 'A', quantity: 1, lineTotal: 1000 },
      ]),
      items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
      discounts: [
        { label: 'クーポン', amount: -50 },
        { label: '値引合計', amount: -50 },
      ],
    });
    const bundle = resolveReceiptMonetarySourceBundle(receipt);
    expect(bundle.coherent).toBe(false);
    expect(
      bundle.reasonCodes.some(
        (c) =>
          c === 'discount_ownership_unresolved' ||
          c === 'aggregate_discount_summary_ambiguous' ||
          c === 'monetary_source_incoherent'
      )
    ).toBe(true);

    const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
    expect(monetary.monetaryProvenanceSufficient).toBe(false);
    expect(monetary.state).not.toBe('known_coherent');
  });

  it('amount-basis still evaluates normally after source coherence (not hard-coded trusted)', () => {
    const receipt = closableItemOnlyOverride('basis-chain');
    const a = assessReceiptAmountBasis(receipt);
    expect(a.reasonCodes).not.toContain('user_items_without_authoritative_total');
    expect(a.reasonCodes).not.toContain('monetary_source_incoherent');
    expect(a.basis).toBe('tax_excluded');
    expect(a.exactComparisonTrusted).toBe(true);
  });
});
