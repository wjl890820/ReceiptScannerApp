/**
 * Legacy tax provenance recovery — read-only effective trust bridge.
 */
/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from '../db';
import { assessReceiptAmountBasis } from './amountBasis';
import {
  resolveEffectiveReceiptTaxProvenance,
  resolveOrReuseEffectiveReceiptTaxProvenance,
  type BoundEffectiveReceiptTaxProvenance,
  type EffectiveReceiptTaxProvenance,
} from './taxProvenance';
import * as receiptOcrNormalize from '../receiptOcrNormalize';
import {
  buildProductPriceHistory,
  buildReceiptEvidenceCache,
} from '../productPriceHistory';
import { makeTrustedG3TestRow } from '../productPriceHistory.testFixtures';
import { buildReceiptMonetaryCoherenceEvidence } from '../receiptEvidenceTruth/monetaryCoherenceEvidence';
import { assessSameLayerMonetaryClosure } from '../receiptEvidenceTruth/monetaryClosure';
import { resolveReceiptMonetarySourceBundle } from './monetarySourceBundle';

function decisionOf(receipt: ReceiptRow): EffectiveReceiptTaxProvenance {
  return resolveEffectiveReceiptTaxProvenance(receipt).decision;
}

function makeReceipt(args: {
  id: string;
  tax: number;
  taxIsKnown: number;
  total?: number;
  items?: Array<{ name: string; lineTotal: number }>;
  analysis?: Record<string, unknown> | null;
  analysisJsonRaw?: string | null;
  recognitionSnapshotJson?: string | null;
}): ReceiptRow {
  const items = args.items ?? [{ name: '牛乳', lineTotal: 1000 }];
  const analysis =
    args.analysis === null
      ? null
      : args.analysis ?? {
          items,
          tax: args.tax,
          total: args.total ?? 1080,
        };
  return {
    id: args.id,
    created_at: Date.now(),
    transaction_at: Date.parse('2024-06-01T12:00:00+09:00'),
    image_uri: '',
    total: args.total ?? 1080,
    tax: args.tax,
    tax_is_known: args.taxIsKnown,
    currency: 'JPY',
    analysis_json:
      args.analysisJsonRaw !== undefined
        ? args.analysisJsonRaw
        : analysis == null
          ? null
          : JSON.stringify(analysis),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    recognition_snapshot_json: args.recognitionSnapshotJson ?? null,
  } as ReceiptRow;
}

function closingLegacyRow(id: string, occurredAt: number) {
  const analysis = {
    items: [{ name: '牛乳', lineTotal: 1000, quantity: 1 }],
    tax: 80,
    total: 1080,
    evidenceCaptureVersion: 1,
    reconciliation: { ok: true },
    amount_mismatch: false,
  };
  return makeTrustedG3TestRow(id, {
    receiptId: id,
    occurredAt,
    displayName: '牛乳',
    grossLineAmount: 1000,
    lineTotal: 1000,
    purchaseQuantity: 1,
    receiptTotal: 1080,
    receiptTax: 80,
    receiptTaxIsKnown: 0,
    receiptAnalysisJson: JSON.stringify(analysis),
    skuKey: 'sku-milk',
    volumeBaseMl: 1000,
    productFamilyKey: 'milk',
    identitySource: 'normalized_exact',
    identityConfidence: 1,
  });
}

describe('resolveEffectiveReceiptTaxProvenance', () => {
  it('1 — persisted tax_is_known=1 → trusted persisted_known (no legacy recovery needed)', () => {
    const r = makeReceipt({
      id: 'known',
      tax: 80,
      taxIsKnown: 1,
      analysis: { items: [], tax: 999 },
    });
    expect(resolveEffectiveReceiptTaxProvenance(r).decision).toEqual({
      trust: 'trusted',
      source: 'persisted_known',
    });
  });

  it('1b — tax_is_known=1 + malformed analysis_json still trusted (fast path, no parse fail)', () => {
    const r = makeReceipt({
      id: 'known-malformed',
      tax: 80,
      taxIsKnown: 1,
      analysisJsonRaw: '{not-json',
    });
    expect(resolveEffectiveReceiptTaxProvenance(r).decision).toEqual({
      trust: 'trusted',
      source: 'persisted_known',
    });
  });

  it('2 — persisted=0 + analysis known positive matching tax → legacy recovered', () => {
    const r = makeReceipt({
      id: 'legacy',
      tax: 80,
      taxIsKnown: 0,
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 1080,
      },
    });
    expect(resolveEffectiveReceiptTaxProvenance(r).decision).toEqual({
      trust: 'trusted',
      source: 'legacy_analysis_recovered',
    });
  });

  it('3 — resolved tax != persisted tax → untrusted', () => {
    const r = makeReceipt({
      id: 'mismatch',
      tax: 80,
      taxIsKnown: 0,
      analysis: { items: [], tax: 99, tax_is_known: true, total: 1080 },
    });
    expect(decisionOf(r).trust).toBe('untrusted');
  });

  it('4 — analysis unknown → untrusted', () => {
    const r = makeReceipt({
      id: 'unknown',
      tax: 80,
      taxIsKnown: 0,
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 0,
        total: 1000,
      },
    });
    expect(decisionOf(r).trust).toBe('untrusted');
  });

  it('5 — malformed analysis → untrusted', () => {
    const r = makeReceipt({
      id: 'bad',
      tax: 80,
      taxIsKnown: 0,
      analysisJsonRaw: '{not-json',
    });
    expect(decisionOf(r).trust).toBe('untrusted');
  });

  it('6 — analysis unavailable → untrusted', () => {
    const r = makeReceipt({
      id: 'missing',
      tax: 80,
      taxIsKnown: 0,
      analysisJsonRaw: null,
    });
    expect(decisionOf(r).trust).toBe('untrusted');
  });

  it('7 — analysis known zero → untrusted', () => {
    const r = makeReceipt({
      id: 'known-zero',
      tax: 80,
      taxIsKnown: 0,
      analysis: { items: [], tax: 0, tax_is_known: true, total: 1000 },
    });
    expect(decisionOf(r).trust).toBe('untrusted');
  });

  it('8 — persisted tax zero → untrusted', () => {
    const r = makeReceipt({
      id: 'tax-zero',
      tax: 0,
      taxIsKnown: 0,
      analysis: { items: [], tax: 80, tax_is_known: true, total: 1080 },
    });
    expect(decisionOf(r).trust).toBe('untrusted');
  });

  it('9 — snapshot known but analysis unknown → still untrusted (no snapshot authority)', () => {
    const r = makeReceipt({
      id: 'snap-only',
      tax: 80,
      taxIsKnown: 0,
      analysis: { items: [], tax: 0, total: 1000 },
      recognitionSnapshotJson: JSON.stringify({
        tax: 80,
        tax_is_known: true,
        items: [],
      }),
    });
    expect(decisionOf(r).trust).toBe('untrusted');
  });
});

describe('legacy tax provenance through amount-basis / history', () => {
  it('10 — recovered row can reach known/high/trusted when equations close', () => {
    const r = makeReceipt({
      id: 'close',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 1080,
      },
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.taxProvenance).toBe('trusted');
    expect(a.evidence).toContain(
      'tax_provenance_source=legacy_analysis_recovered'
    );
    expect(a.basis).toBe('tax_excluded');
    expect(a.confidence).toBe('high');
    expect(a.exactComparisonTrusted).toBe(true);
    expect(a.reasonCodes).not.toContain('tax_untrusted');
  });

  it('11 — recovered provenance still fails when equations do not close', () => {
    const r = makeReceipt({
      id: 'no-close',
      tax: 80,
      taxIsKnown: 0,
      total: 2000,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 2000,
      },
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.taxProvenance).toBe('trusted');
    expect(a.exactComparisonTrusted).toBe(false);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('neither_hypothesis_closes');
  });

  it('12 — buildReceiptEvidenceCache uses recovered provenance consistently', () => {
    const row = closingLegacyRow('cache', 1000);
    const cache = buildReceiptEvidenceCache([row]);
    const entry = cache.get('cache');
    expect(entry?.amountBasisAssessment.taxProvenance).toBe('trusted');
    expect(entry?.amountBasisAssessment.exactComparisonTrusted).toBe(true);
    expect(entry?.amountBasisAssessment.evidence).toContain(
      'tax_provenance_source=legacy_analysis_recovered'
    );
  });

  it('13 — Level-2 eligible for legacy recovered tax-excluded fixture (full pipeline)', () => {
    const rows = [closingLegacyRow('r1', 1000), closingLegacyRow('r2', 2000)];
    const cache = buildReceiptEvidenceCache(rows);
    for (const row of rows) {
      const entry = cache.get(row.receiptId)!;
      expect(entry.amountBasisAssessment.exactComparisonTrusted).toBe(true);
      expect(entry.monetaryCoherenceEvidence.state).toBe('known_coherent');
      expect(entry.monetaryCoherenceEvidence.monetaryProvenanceSufficient).toBe(
        true
      );
      expect(entry.monetaryCoherenceEvidence.closureHypothesis).toBe(
        'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
      );
    }
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-milk' },
      rows,
      { receiptEvidenceCache: cache }
    );
    expect(history.observations.length).toBeGreaterThanOrEqual(2);
    for (const observation of history.observations) {
      expect(observation.level2RejectReasons).not.toContain(
        'amount_basis_untrusted'
      );
      expect(observation.level2RejectReasons).not.toContain(
        'monetary_incoherent'
      );
      expect(observation.level2RejectReasons).not.toContain(
        'monetary_provenance_insufficient'
      );
      expect(observation.level2Eligible).toBe(true);
    }
    expect(history.points.length).toBeGreaterThanOrEqual(2);
  });

  it('14 — true-unknown fixture remains Level-2 ineligible', () => {
    const r = makeReceipt({
      id: 'true-unknown',
      tax: 0,
      taxIsKnown: 0,
      total: 1000,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 0,
        total: 1000,
      },
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.taxProvenance).toBe('untrusted');
    expect(a.exactComparisonTrusted).toBe(false);
    expect(a.reasonCodes).toContain('tax_untrusted');

    const row = makeTrustedG3TestRow('tu1', {
      receiptId: 'true-unknown',
      occurredAt: 1000,
      grossLineAmount: 1000,
      receiptTotal: 1000,
      receiptTax: 0,
      receiptTaxIsKnown: 0,
      receiptAnalysisJson: JSON.stringify({
        items: [{ name: '牛乳', lineTotal: 1000, quantity: 1 }],
        tax: 0,
        total: 1000,
      }),
      skuKey: 'sku-milk',
    });
    const peer = makeTrustedG3TestRow('tu2', {
      receiptId: 'peer',
      occurredAt: 2000,
      grossLineAmount: 1100,
      receiptTotal: 1100,
      receiptTax: 0,
      receiptTaxIsKnown: 0,
      receiptAnalysisJson: JSON.stringify({
        items: [{ name: '牛乳', lineTotal: 1100, quantity: 1 }],
        tax: 0,
        total: 1100,
      }),
      skuKey: 'sku-milk',
    });
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-milk' },
      [row, peer],
      { receiptEvidenceCache: buildReceiptEvidenceCache([row, peer]) }
    );
    expect(
      history.observations.some((o) =>
        o.level2RejectReasons.includes('amount_basis_untrusted')
      )
    ).toBe(true);
    expect(history.observations.every((o) => o.level2Eligible === false)).toBe(
      true
    );
  });

  it('15 — item-only monetary override still works with recovered tax provenance', () => {
    const r = makeReceipt({
      id: 'item-only',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: 'ocr', lineTotal: 900 }],
      analysis: {
        items: [{ name: 'ocr', lineTotal: 900 }],
        tax: 80,
        total: 1080,
      },
    });
    (r as ReceiptRow).user_items_json = JSON.stringify([
      { name: 'user', lineTotal: 1000 },
    ]);
    const a = assessReceiptAmountBasis(r);
    expect(a.taxProvenance).toBe('trusted');
    expect(a.basis).toBe('tax_excluded');
    expect(a.exactComparisonTrusted).toBe(true);
  });
});

describe('monetary closure shares effective tax provenance authority', () => {
  function closureOf(receipt: ReceiptRow) {
    const bundle = resolveReceiptMonetarySourceBundle(receipt);
    return {
      monetary: buildReceiptMonetaryCoherenceEvidence(receipt),
      closure: assessSameLayerMonetaryClosure(receipt, bundle, {
        reconciliationOk: true,
        amountMismatch: false,
      }),
    };
  }

  it('N1 — persisted known=1 + positive tax → tax-excluded coherent unchanged', () => {
    const r = makeReceipt({
      id: 'n1',
      tax: 80,
      taxIsKnown: 1,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 1080,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    const { monetary } = closureOf(r);
    expect(monetary.state).toBe('known_coherent');
    expect(monetary.closureHypothesis).toBe(
      'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
    );
    expect(monetary.monetaryProvenanceSufficient).toBe(true);
  });

  it('N2 — persisted known=1 + tax=0 → provenance trusted but no tax-excluded forge', () => {
    const r = makeReceipt({
      id: 'n2',
      tax: 0,
      taxIsKnown: 1,
      total: 1000,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 0,
        tax_is_known: true,
        total: 1000,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    expect(decisionOf(r).trust).toBe('trusted');
    const { monetary } = closureOf(r);
    // tax-included can still close without positive tax; must not invent excluded.
    expect(monetary.closureHypothesis).not.toMatch(/tax_excluded/);
    if (monetary.state === 'known_coherent') {
      expect(monetary.closureHypothesis).toBe(
        'tax_included_item_side_plus_remainder'
      );
    }
  });

  it('N3 — legacy recovered + tax-excluded equation closes → monetary coherent', () => {
    const r = makeReceipt({
      id: 'n3',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 1080,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    const { monetary } = closureOf(r);
    expect(monetary.state).toBe('known_coherent');
    expect(monetary.closureHypothesis).toBe(
      'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
    );
    expect(monetary.evidence.some((e) => e.includes('trusted_tax=80'))).toBe(
      true
    );
  });

  it('N4 — legacy recovered BUT equation mismatch → normal closure failure', () => {
    const r = makeReceipt({
      id: 'n4',
      tax: 80,
      taxIsKnown: 0,
      total: 2000,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 2000,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    expect(decisionOf(r).source).toBe(
      'legacy_analysis_recovered'
    );
    const { monetary } = closureOf(r);
    expect(monetary.state).toBe('known_incoherent');
  });

  it('N5 — legacy mismatch tax values → untrusted, no positive trusted tax in closure', () => {
    const r = makeReceipt({
      id: 'n5',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 99,
        tax_is_known: true,
        total: 1080,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    expect(decisionOf(r).trust).toBe('untrusted');
    const { monetary } = closureOf(r);
    expect(monetary.evidence.some((e) => e.startsWith('trusted_tax='))).toBe(
      false
    );
  });

  it('N6 — analysis explicit false + no production-recognized evidence → untrusted', () => {
    const r = makeReceipt({
      id: 'n6',
      tax: 80,
      taxIsKnown: 0,
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 0,
        tax_is_known: false,
        total: 1000,
      },
    });
    expect(decisionOf(r).trust).toBe('untrusted');
  });

  it('N7 — analysis explicit false + production resolver recognizes printed tax → recovery if match', () => {
    const r = makeReceipt({
      id: 'n7',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      analysis: {
        items: [
          { name: '牛乳', lineTotal: 1000 },
          { name: '消費税等 8%', lineTotal: 80 },
        ],
        tax: 0,
        tax_is_known: false,
        total: 1080,
      },
    });
    // Follow production resolveReceiptTax only — no duplicated harvest heuristic.
    const effective = resolveEffectiveReceiptTaxProvenance(r);
    expect(effective.decision).toEqual({
      trust: 'trusted',
      source: 'legacy_analysis_recovered',
    });
  });

  it('N8 — malformed / scalar / array analysis → untrusted', () => {
    for (const raw of ['{bad', '80', '[1,2]', 'null']) {
      const r = makeReceipt({
        id: `n8-${raw}`,
        tax: 80,
        taxIsKnown: 0,
        analysisJsonRaw: raw,
      });
      expect(decisionOf(r).trust).toBe('untrusted');
    }
  });

  it('N10 — snapshot known + analysis unknown → monetary closure cannot recover', () => {
    const r = makeReceipt({
      id: 'n10',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 0,
        total: 1000,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
      recognitionSnapshotJson: JSON.stringify({
        tax: 80,
        tax_is_known: true,
        items: [{ name: '牛乳', lineTotal: 1000 }],
        total: 1080,
      }),
    });
    expect(decisionOf(r).trust).toBe('untrusted');
    const { monetary } = closureOf(r);
    expect(monetary.evidence.some((e) => e.startsWith('trusted_tax='))).toBe(
      false
    );
  });
});

describe('bound effective tax provenance authority (runtime binding)', () => {
  const forgedTrusted = {
    decision: { trust: 'trusted', source: 'persisted_known' },
  } as BoundEffectiveReceiptTaxProvenance;

  it('rounded-yen equality recovers; rounded mismatch stays untrusted', () => {
    const equal = makeReceipt({
      id: 'round-eq',
      tax: 80.4,
      taxIsKnown: 0,
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80.4,
        tax_is_known: true,
        total: 1080,
      },
    });
    expect(decisionOf(equal).source).toBe('legacy_analysis_recovered');

    const mismatch = makeReceipt({
      id: 'round-mismatch',
      tax: 80.4,
      taxIsKnown: 0,
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80.6,
        tax_is_known: true,
        total: 1080,
      },
    });
    // Math.round(80.4)=80, Math.round(80.6)=81
    expect(decisionOf(mismatch).trust).toBe('untrusted');
  });

  it('forged plain trusted object cannot authorize amountBasis / closure', () => {
    const r = makeReceipt({
      id: 'forge-untrusted',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 0,
        total: 1000,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    expect(decisionOf(r).trust).toBe('untrusted');

    const a = assessReceiptAmountBasis(r, {
      boundTaxProvenance: forgedTrusted,
    });
    expect(a.taxProvenance).toBe('untrusted');
    expect(a.exactComparisonTrusted).toBe(false);

    const monetary = buildReceiptMonetaryCoherenceEvidence(r, {
      boundTaxProvenance: forgedTrusted,
    });
    expect(monetary.evidence.some((e) => e.startsWith('trusted_tax='))).toBe(
      false
    );
  });

  it('A-token on B-receipt cannot authorize untrusted B', () => {
    const aReceipt = makeReceipt({
      id: 'A',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 1080,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    const bReceipt = makeReceipt({
      id: 'B',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 0,
        total: 1000,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    const aBound = resolveEffectiveReceiptTaxProvenance(aReceipt);
    expect(aBound.decision.trust).toBe('trusted');

    const reused = resolveOrReuseEffectiveReceiptTaxProvenance(
      bReceipt,
      aBound
    );
    expect(reused.decision.trust).toBe('untrusted');
    expect(reused).not.toBe(aBound);

    const assessment = assessReceiptAmountBasis(bReceipt, {
      boundTaxProvenance: aBound,
    });
    expect(assessment.taxProvenance).toBe('untrusted');
    expect(assessment.exactComparisonTrusted).toBe(false);

    const monetary = buildReceiptMonetaryCoherenceEvidence(bReceipt, {
      boundTaxProvenance: aBound,
    });
    expect(monetary.evidence.some((e) => e.startsWith('trusted_tax='))).toBe(
      false
    );
  });

  it('same id but changed tax inputs cannot reuse stale bound token', () => {
    const a = makeReceipt({
      id: 'same-id',
      tax: 80,
      taxIsKnown: 1,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 1080,
      },
    });
    const bound = resolveEffectiveReceiptTaxProvenance(a);
    expect(bound.decision.trust).toBe('trusted');

    const changed = makeReceipt({
      id: 'same-id',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 0,
        total: 1000,
      },
    });
    const reused = resolveOrReuseEffectiveReceiptTaxProvenance(changed, bound);
    expect(reused.decision.trust).toBe('untrusted');
    expect(reused).not.toBe(bound);

    const assessment = assessReceiptAmountBasis(changed, {
      boundTaxProvenance: bound,
    });
    expect(assessment.taxProvenance).toBe('untrusted');
  });

  it('legitimate same-receipt reuse does not re-call resolveReceiptTax', () => {
    const r = makeReceipt({
      id: 'reuse',
      tax: 80,
      taxIsKnown: 0,
      total: 1080,
      items: [{ name: '牛乳', lineTotal: 1000 }],
      analysis: {
        items: [{ name: '牛乳', lineTotal: 1000 }],
        tax: 80,
        total: 1080,
        reconciliation: { ok: true },
        amount_mismatch: false,
      },
    });
    const spy = jest.spyOn(receiptOcrNormalize, 'resolveReceiptTax');
    try {
      const bound = resolveEffectiveReceiptTaxProvenance(r);
      expect(bound.decision.trust).toBe('trusted');
      expect(spy).toHaveBeenCalledTimes(1);

      assessReceiptAmountBasis(r, { boundTaxProvenance: bound });
      buildReceiptMonetaryCoherenceEvidence(r, { boundTaxProvenance: bound });
      expect(spy).toHaveBeenCalledTimes(1);

      const again = resolveOrReuseEffectiveReceiptTaxProvenance(r, bound);
      expect(again).toBe(bound);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('buildReceiptEvidenceCache calls resolveReceiptTax once per unique receipt', () => {
    const rows = [closingLegacyRow('cache-once', 1000)];
    const spy = jest.spyOn(receiptOcrNormalize, 'resolveReceiptTax');
    try {
      const cache = buildReceiptEvidenceCache(rows);
      expect(spy).toHaveBeenCalledTimes(1);
      const entry = cache.get('cache-once');
      expect(entry?.amountBasisAssessment.taxProvenance).toBe('trusted');
      expect(entry?.monetaryCoherenceEvidence.state).toBe('known_coherent');
    } finally {
      spy.mockRestore();
    }
  });

  it('resolver exception yields fail-closed bound decision that reuses without rethrow', () => {
    const spy = jest
      .spyOn(receiptOcrNormalize, 'resolveReceiptTax')
      .mockImplementation(() => {
        throw new Error('boom');
      });
    try {
      const r = makeReceipt({
        id: 'throw',
        tax: 80,
        taxIsKnown: 0,
        analysis: {
          items: [{ name: '牛乳', lineTotal: 1000 }],
          tax: 80,
          total: 1080,
        },
      });
      const bound = resolveEffectiveReceiptTaxProvenance(r);
      expect(bound.decision.trust).toBe('untrusted');
      expect(spy).toHaveBeenCalledTimes(1);

      const reused = resolveOrReuseEffectiveReceiptTaxProvenance(r, bound);
      expect(reused).toBe(bound);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('production export surface has no resolver override setter', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const surface = require('./taxProvenance') as Record<string, unknown>;
    expect(surface.__testOnly_setResolveReceiptTaxOverride).toBeUndefined();
    expect(
      Object.keys(surface).some((k) =>
        /ResolveReceiptTaxOverride|setResolveReceiptTax/i.test(k)
      )
    ).toBe(false);
  });

  it('forged authority cannot make untrusted Level-2 eligible', () => {
    const row = makeTrustedG3TestRow('forge-l2', {
      receiptId: 'forge-l2',
      occurredAt: 1000,
      grossLineAmount: 1000,
      lineTotal: 1000,
      purchaseQuantity: 1,
      receiptTotal: 1080,
      receiptTax: 80,
      receiptTaxIsKnown: 0,
      receiptAnalysisJson: JSON.stringify({
        items: [{ name: '牛乳', lineTotal: 1000, quantity: 1 }],
        tax: 0,
        total: 1000,
      }),
      skuKey: 'sku-milk',
    });
    const peer = closingLegacyRow('peer-l2', 2000);
    // Native path (no forge) must already reject.
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-milk' },
      [row, peer],
      { receiptEvidenceCache: buildReceiptEvidenceCache([row, peer]) }
    );
    const forgedObs = history.observations.find((o) => o.receiptId === 'forge-l2');
    expect(forgedObs?.level2Eligible).toBe(false);

    // Direct assessment still rejects forged bound capability.
    const receipt = {
      ...makeReceipt({
        id: 'forge-l2',
        tax: 80,
        taxIsKnown: 0,
        total: 1080,
        items: [{ name: '牛乳', lineTotal: 1000 }],
        analysis: {
          items: [{ name: '牛乳', lineTotal: 1000 }],
          tax: 0,
          total: 1000,
        },
      }),
    };
    expect(
      assessReceiptAmountBasis(receipt, { boundTaxProvenance: forgedTrusted })
        .exactComparisonTrusted
    ).toBe(false);
  });
});
