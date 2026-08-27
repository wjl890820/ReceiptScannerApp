/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from './db';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildCanonicalReceiptGroups } from './analysisFoundation/canonicalReceipt';
import { resolveReceiptMonetarySourceBundle } from './analysisFoundation/monetarySourceBundle';
import type { DiscountableItem } from './receiptDiscountAllocation';
import {
  buildDateYearConflictDiagnostic,
  buildProductionShadowCandidateNodes,
  buildReceiptMerchantEvidence,
  buildReceiptMonetaryCoherenceEvidence,
  buildReceiptTransactionEvidence,
  buildShadowDuplicateCandidateGroups,
  buildShadowRepresentativeRecommendation,
  diagnosticClockSimilarity,
  evaluateMerchantEvidenceCompatibility,
  evaluateShadowBasketGate,
  evaluateShadowMerchantMetadataVariantDetailed,
  evaluateShadowMerchantMetadataVariantPair,
  findProductionShadowCandidateForReceiptIds,
  GROUND_TRUTH_CASE_RECEIPT_IDS,
  isShadowAuthorizingCurrency,
  isValidLocalDateTimeComponents,
  normalizeShadowCurrency,
  orientCandidatePair,
  precisionCompatibleClockMatch,
  RECEIPT_EVIDENCE_TRUTH_VERSION,
  validateRawOcrItemBasket,
} from './receiptEvidenceTruth';
import { resolveSelectedItemMonetaryAmount } from './receiptEvidenceTruth/monetaryClosure';
import {
  buildProductionShadowCandidateNode,
  type ProductionShadowCandidateNode,
} from './receiptEvidenceTruth/shadowCandidateNode';
import * as receiptEvidenceTruth from './receiptEvidenceTruth';

function makeReceipt(args: {
  id: string;
  merchantRaw?: string;
  merchantNormalized?: string;
  transactionAt?: number | null;
  total?: number;
  tax?: number;
  taxIsKnown?: number;
  createdAt?: number;
  currency?: string;
  userEdited?: number;
  userItemsJson?: string | null;
  finalTotal?: number | null;
  analysis?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
}): ReceiptRow {
  const items = args.items ?? [
    { name: 'A', quantity: 1, lineTotal: args.total ?? 100 },
  ];
  const analysis = {
    items,
    transactionDate: args.analysis?.transactionDate,
    ...args.analysis,
  };
  return {
    id: args.id,
    created_at: args.createdAt ?? 1,
    transaction_at:
      args.transactionAt === undefined
        ? Date.parse('2026-01-06T07:23:00Z')
        : args.transactionAt,
    image_uri: '',
    merchant_raw: args.merchantRaw ?? 'テスト',
    merchant_normalized: args.merchantNormalized ?? args.merchantRaw ?? 'テスト',
    merchant_type: 'supermarket',
    store_raw: null,
    store_normalized: null,
    total: args.total ?? 100,
    tax: args.tax ?? 8,
    tax_is_known: args.taxIsKnown ?? 1,
    currency: args.currency ?? 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: args.userEdited ?? 0,
    final_total: args.finalTotal ?? null,
    final_category: null,
    note: null,
    user_items_json: args.userItemsJson ?? null,
  };
}

function canonicalNode(receipts: ReceiptRow[], groupIndex = 0) {
  const groups = buildCanonicalReceiptGroups(receipts);
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  return buildProductionShadowCandidateNode(groups[groupIndex]!, receiptById)!;
}

function withShadowAuthorizableTransaction(
  node: ProductionShadowCandidateNode,
  shadowAuthorizable: boolean
): ProductionShadowCandidateNode {
  return {
    ...node,
    transaction: {
      ...node.transaction,
      shadowAuthorizable,
      consistencyState: shadowAuthorizable ? 'consistent' : node.transaction.consistencyState,
    },
  };
}

describe('A1.4A Receipt Evidence Truth Layer (v3 hardening)', () => {
  test('exports version constant', () => {
    expect(RECEIPT_EVIDENCE_TRUTH_VERSION).toBe(
      'meruno-receipt-evidence-truth-a1.4a-v3'
    );
  });

  test('low-level arbitrary-summary representative picker is not publicly exported', () => {
    expect(
      (receiptEvidenceTruth as Record<string, unknown>)[
        'pickShadowEvidenceAwareRepresentativeReceiptId'
      ]
    ).toBeUndefined();
  });

  describe('A. identity graph', () => {
    test('raw receipt inside production duplicate group is not an independent shadow node', () => {
      const at = Date.parse('2023-07-06T02:44:46Z');
      const items = [{ name: 'Item', quantity: 1, lineTotal: 9534 }];
      const r1 = makeReceipt({
        id: 'dup-a',
        merchantRaw: 'コストコ',
        total: 9534,
        transactionAt: at,
        items,
        analysis: {
          transactionDate: '07/06/2023 11:44:46',
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const r2 = makeReceipt({
        id: 'dup-b',
        merchantRaw: 'コストコ',
        total: 9534,
        transactionAt: at,
        createdAt: 2,
        items,
        analysis: {
          transactionDate: '07/06/2023 11:44:46',
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const nodes = buildProductionShadowCandidateNodes([r1, r2]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.sourceReceiptIds).toEqual(['dup-a', 'dup-b']);
    });

    test('year-conflict similar baskets do NOT create shadow duplicate groups', () => {
      const itemsA = [
        { name: 'apple', quantity: 1, lineTotal: 100 },
        { name: 'milk', quantity: 1, lineTotal: 200 },
      ];
      const itemsB = [
        { name: 'bread', quantity: 1, lineTotal: 100 },
        { name: 'cola', quantity: 1, lineTotal: 200 },
      ];
      const rA = makeReceipt({
        id: 'yc-a',
        merchantRaw: 'テスト',
        total: 300,
        tax: 0,
        taxIsKnown: 1,
        transactionAt: Date.parse('2024-01-06T07:23:00Z'),
        items: itemsA,
        analysis: {
          transactionDate: '2024/01/06 16:23',
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const rB = makeReceipt({
        id: 'yc-b',
        merchantRaw: 'テスト',
        total: 300,
        tax: 0,
        taxIsKnown: 1,
        transactionAt: Date.parse('2025-01-06T07:23:00Z'),
        items: itemsB,
        analysis: {
          transactionDate: '2025/01/06 16:23',
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const groups = buildShadowDuplicateCandidateGroups([rA, rB]);
      expect(groups).toHaveLength(0);

      const nodes = buildProductionShadowCandidateNodes([rA, rB]);
      const receiptById = new Map([rA, rB].map((r) => [r.id, r]));
      const diagnostic = buildDateYearConflictDiagnostic(
        ['yc-a', 'yc-b'],
        nodes,
        receiptById
      );
      expect(diagnostic.shadowDuplicateAuthorized).toBe(false);
      expect(diagnostic.reasonCodes).toContain(
        'diagnostic_only_not_duplicate_authorization'
      );
      expect(diagnostic.caseSourceReceiptIds.sort()).toEqual(['yc-a', 'yc-b']);
    });
  });

  describe('B. raw basket + currency gates', () => {
    const at = Date.parse('2026-01-06T07:23:00Z');

    test('different names + same qty/amount vector => reject', () => {
      const rA = makeReceipt({
        id: 'name-a',
        merchantRaw: 'ヨークベニマル',
        total: 500,
        transactionAt: at,
        items: [{ name: 'Alpha Product', quantity: 1, lineTotal: 500 }],
        analysis: {
          transactionDate: '2026年 1月 6日(火) 16:23',
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const rB = makeReceipt({
        id: 'name-b',
        merchantRaw: 'ヨークベニマル 古川南店',
        total: 500,
        transactionAt: at,
        items: [{ name: 'Beta Product', quantity: 1, lineTotal: 500 }],
        analysis: {
          transactionDate: '2026年 1月 6日(火) 16:23',
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      expect(evaluateShadowBasketGate(canonicalNode([rA]), canonicalNode([rB])).ok).toBe(
        false
      );
    });

    test('explicit quantity=true rejects authorization', () => {
      const receipt = makeReceipt({
        id: 'qty-bool',
        items: [{ name: 'A', quantity: true as unknown as number, lineTotal: 100 }],
      });
      const result = validateRawOcrItemBasket(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasonCodes).toContain('quantity_malformed_present_non_numeric');
      }
    });

    test('explicit quantity=null rejects authorization', () => {
      const receipt = makeReceipt({
        id: 'qty-null',
        items: [{ name: 'A', quantity: null, lineTotal: 100 }],
      });
      const result = validateRawOcrItemBasket(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasonCodes).toContain('quantity_malformed_present_null');
      }
    });

    test('quantity string numeric rejects authorization', () => {
      const receipt = makeReceipt({
        id: 'qty-string',
        items: [{ name: 'A', quantity: '1' as unknown as number, lineTotal: 100 }],
      });
      expect(validateRawOcrItemBasket(receipt).ok).toBe(false);
    });

    test('quantity=NaN rejects authorization', () => {
      const receipt = makeReceipt({
        id: 'qty-nan',
        items: [{ name: 'A', quantity: 'not-a-number', lineTotal: 100 }],
      });
      expect(validateRawOcrItemBasket(receipt).ok).toBe(false);
    });

    test('quantity=0 rejects authorization', () => {
      const receipt = makeReceipt({
        id: 'qty-zero',
        items: [{ name: 'A', quantity: 0, lineTotal: 100 }],
      });
      expect(validateRawOcrItemBasket(receipt).ok).toBe(false);
    });

    test('missing quantity may be implicit default-one', () => {
      const receipt = makeReceipt({
        id: 'qty-missing',
        items: [{ name: 'A', lineTotal: 100 }],
      });
      const result = validateRawOcrItemBasket(receipt);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rows[0]!.quantityEvidence).toBe('missing_default_one');
        expect(result.rows[0]!.quantity).toBe(1);
      }
    });

    test('malformed secondary amount alias rejects even when primary valid', () => {
      const receipt = makeReceipt({
        id: 'amount-secondary-bad',
        items: [{ name: 'A', quantity: 1, lineTotal: 100, amount: 'bad' }],
      });
      const result = validateRawOcrItemBasket(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasonCodes).toContain('amount_malformed_present_non_numeric');
      }
    });

    test('explicit empty primary name does not fall through to secondary alias', () => {
      const receipt = makeReceipt({
        id: 'name-priority',
        items: [{ name: '', raw_name: 'A', quantity: 1, lineTotal: 100 }],
      });
      const result = validateRawOcrItemBasket(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasonCodes).toContain('name_malformed_present_empty');
      }
    });

    test('malformed line amount rejects authorization', () => {
      const receipt = makeReceipt({
        id: 'bad-amount',
        items: [{ name: 'A', quantity: 1, lineTotal: 'bad' }],
      });
      expect(validateRawOcrItemBasket(receipt).ok).toBe(false);
    });

    test('one valid row + one malformed row rejects whole authorization', () => {
      const receipt = makeReceipt({
        id: 'mixed-rows',
        total: 200,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: null, lineTotal: 100 },
        ],
      });
      expect(validateRawOcrItemBasket(receipt).ok).toBe(false);
    });

    test('conflicting amount aliases reject authorization', () => {
      const receipt = makeReceipt({
        id: 'alias-conflict',
        items: [
          {
            name: 'A',
            quantity: 1,
            lineTotal: 100,
            amount: 200,
          },
        ],
      });
      expect(validateRawOcrItemBasket(receipt).ok).toBe(false);
    });

    test('empty primary name rejects without alias repair', () => {
      const receipt = makeReceipt({
        id: 'empty-name',
        items: [{ name: '   ', quantity: 1, lineTotal: 100 }],
      });
      const result = validateRawOcrItemBasket(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasonCodes).toContain('name_malformed_present_empty');
      }
    });

    test('currency gate rejects non-JPY values', () => {
      for (const currency of ['USD', '???', 'UNK', 'UNKNOWN', '']) {
        expect(isShadowAuthorizingCurrency(currency)).toBe(false);
      }
      const nullCurrencyReceipt = makeReceipt({ id: 'cur-null', currency: undefined });
      (nullCurrencyReceipt as { currency: string | null }).currency = null;
      expect(isShadowAuthorizingCurrency(normalizeShadowCurrency(nullCurrencyReceipt))).toBe(
        false
      );
      expect(isShadowAuthorizingCurrency('JPY')).toBe(true);
    });

    test('currency mismatch between candidates => reject', () => {
      const items = [{ name: 'A', quantity: 1, lineTotal: 100 }];
      const rA = makeReceipt({ id: 'cur-a', currency: 'JPY', total: 100, transactionAt: at, items });
      const rB = makeReceipt({ id: 'cur-b', currency: 'USD', total: 100, transactionAt: at, items });
      expect(evaluateShadowBasketGate(canonicalNode([rA]), canonicalNode([rB])).ok).toBe(false);
    });
  });

  describe('C. merchant gates', () => {
    test('same retailer + different observed store hints => reject', () => {
      const a = buildReceiptMerchantEvidence(
        makeReceipt({ id: 'a', merchantRaw: 'ヨークベニマル 古川南店' })
      );
      const b = buildReceiptMerchantEvidence(
        makeReceipt({ id: 'b', merchantRaw: 'ヨークベニマル 郡山店' })
      );
      const compat = evaluateMerchantEvidenceCompatibility(a, b);
      expect(compat.compatibility).toBe('incompatible');
      expect(compat.reasonCodes).toContain('observed_store_hint_conflict');
    });

    test('same retailer + one missing hint => compatible_missing_store_hint', () => {
      const a = buildReceiptMerchantEvidence(
        makeReceipt({ id: 'a', merchantRaw: 'ヨークベニマル 古川南店' })
      );
      const b = buildReceiptMerchantEvidence(
        makeReceipt({ id: 'b', merchantRaw: 'ヨークベニマル' })
      );
      expect(evaluateMerchantEvidenceCompatibility(a, b).compatibility).toBe(
        'compatible_missing_store_hint'
      );
    });

    test('unresolved retailer => fail_closed', () => {
      const a = buildReceiptMerchantEvidence(
        makeReceipt({ id: 'a', merchantRaw: '不明店舗A' })
      );
      const b = buildReceiptMerchantEvidence(
        makeReceipt({ id: 'b', merchantRaw: '不明店舗A' })
      );
      expect(evaluateMerchantEvidenceCompatibility(a, b).compatibility).toBe('fail_closed');
    });

    test('storeHint is never represented as verified branch', () => {
      const m = buildReceiptMerchantEvidence(
        makeReceipt({ id: 'a', merchantRaw: 'ヨークベニマル 古川南店' })
      );
      expect(m.storeHintEvidenceStatus).toBe('observed_store_hint');
      expect(m.evidence.some((e) => e.includes('not_verified'))).toBe(true);
    });
  });

  describe('D. transaction provenance', () => {
    test('2025/02/31 => invalid calendar', () => {
      expect(
        isValidLocalDateTimeComponents({
          year: 2025,
          month: 2,
          day: 31,
          hour: 12,
          minute: 0,
          second: 0,
        })
      ).toBe(false);
    });

    test('leap year Feb 29 valid, non-leap invalid', () => {
      expect(
        isValidLocalDateTimeComponents({
          year: 2024,
          month: 2,
          day: 29,
          hour: null,
          minute: null,
          second: null,
        })
      ).toBe(true);
      expect(
        isValidLocalDateTimeComponents({
          year: 2025,
          month: 2,
          day: 29,
          hour: null,
          minute: null,
          second: null,
        })
      ).toBe(false);
    });

    test('arbitrary unrelated OCR blob date is diagnostic-only, not authorizing', () => {
      const tx = buildReceiptTransactionEvidence(
        makeReceipt({
          id: 'blob-date',
          transactionAt: null,
          analysis: {
            ocr_raw_text: 'Membership expires 2030/12/31\nTotal 100',
          },
        })
      );
      expect(tx.diagnosticOcrDateCandidate).toBeTruthy();
      expect(tx.shadowAuthorizable).toBe(false);
      expect(tx.textProvenance).toBe('diagnostic_ocr_blob_candidate');
    });

    test('malformed structured date does not fall back to blob authorization', () => {
      const tx = buildReceiptTransactionEvidence(
        makeReceipt({
          id: 'malformed-structured',
          transactionAt: null,
          analysis: {
            transactionDate: 'not-a-date',
            ocr_raw_text: '2026/01/06 16:23:00',
          },
        })
      );
      expect(tx.shadowAuthorizable).toBe(false);
    });

    test('persisted timestamp alone => precision unknown, not authorizing', () => {
      const tx = buildReceiptTransactionEvidence(
        makeReceipt({
          id: 'persisted-only',
          transactionAt: Date.parse('2025-11-12T04:51:34.000Z'),
          analysis: {},
        })
      );
      expect(tx.precision).toBe('unknown');
      expect(tx.shadowAuthorizable).toBe(false);
      expect(tx.reasonCodes).toContain('persisted_timestamp_alone_not_authorizing');
    });

    test('structured analysis date is diagnostic-only without independent provenance', () => {
      const tx = buildReceiptTransactionEvidence(
        makeReceipt({
          id: 'structured-derived',
          transactionAt: Date.parse('2026-01-06T07:23:00Z'),
          analysis: { transactionDate: '2026/01/06 16:23:45' },
        })
      );
      expect(tx.textProvenance).toBe('structured_derived_analysis_field');
      expect(tx.shadowAuthorizable).toBe(false);
    });

    test('diagnosticClockSimilarity compares minute/second without authorizing', () => {
      const minute = buildReceiptTransactionEvidence(
        makeReceipt({
          id: 'min',
          transactionAt: null,
          analysis: { transactionDate: '2026/01/06 16:23' },
        })
      );
      const second = buildReceiptTransactionEvidence(
        makeReceipt({
          id: 'sec',
          transactionAt: null,
          analysis: { transactionDate: '2026/01/06 16:23:45' },
        })
      );
      expect(precisionCompatibleClockMatch(minute, second)).toBe(false);
      expect(diagnosticClockSimilarity(minute, second)).toBe(
        'compatible_minute_or_second'
      );
    });

    test('consistencyState=conflict cannot authorize shadow relation', () => {
      const tx = buildReceiptTransactionEvidence(
        makeReceipt({
          id: 'conflict',
          transactionAt: Date.parse('2026-01-06T07:23:00Z'),
          analysis: { transactionDate: '2026/01/07 16:23' },
        })
      );
      expect(tx.consistencyState).toBe('conflict');
      expect(tx.shadowAuthorizable).toBe(false);
    });
  });

  describe('E. monetary same-layer closure', () => {
    test('OCR incomplete item (100 + null) paidTotal=100 => unknown, NOT known_coherent', () => {
      const receipt = makeReceipt({
        id: 'ocr-incomplete-null',
        total: 100,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1, lineTotal: null as unknown as number },
        ],
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('unknown');
      expect(monetary.state).not.toBe('known_coherent');
      expect(monetary.reasonCodes).toContain(
        'incomplete_authoritative_item_monetary_evidence'
      );
    });

    test('structural: lineTotal=1000 line_total=999 rejects even with valid allocation', () => {
      const receipt = makeReceipt({
        id: 'structural-gross-alias-1yen',
        total: 900,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            line_total: 999,
            effectiveLineTotal: 900,
            discountAllocated: -100,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('structural: gross=1000 effective=999 missing allocation => NOT coherent', () => {
      const receipt = makeReceipt({
        id: 'structural-gross-eff-1yen-missing',
        total: 999,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 999,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('structural: gross=1000 effective=999 discountAllocated=null => NOT coherent', () => {
      const receipt = makeReceipt({
        id: 'structural-gross-eff-null-alloc',
        total: 999,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 999,
            discountAllocated: null as unknown as number,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('structural: gross=1000 effective=999 discountAllocated="bad" => NOT coherent', () => {
      const receipt = makeReceipt({
        id: 'structural-gross-eff-bad-alloc',
        total: 999,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 999,
            discountAllocated: 'bad' as unknown as number,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('structural: gross=1000 effective=999 discountAllocated=0 => NOT coherent', () => {
      const receipt = makeReceipt({
        id: 'structural-gross-eff-zero-alloc',
        total: 999,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 999,
            discountAllocated: 0,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('structural: gross=1000 effective=999 discountAllocated=-1 => valid persisted explanation', () => {
      const receipt = makeReceipt({
        id: 'structural-persisted-minus-one',
        total: 999,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 999,
            discountAllocated: -1,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).toBe(
        'known_coherent'
      );
    });

    test('CRITICAL: persisted discount gross≠effective explained by discountAllocated => known_coherent', () => {
      const receipt = makeReceipt({
        id: 'ocr-persisted-discount-valid',
        total: 900,
        taxIsKnown: 0,
        items: [
          {
            name: 'A',
            quantity: 1,
            lineTotal: 1000,
            line_total: 1000,
            effectiveLineTotal: 900,
            discountAllocated: -100,
          },
        ],
        analysis: {
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.closureHypothesis).toBe('tax_included_item_side_plus_remainder');
      expect(monetary.reasonCodes).not.toContain(
        'incomplete_authoritative_item_monetary_evidence'
      );
    });

    test('persisted discount: gross=1000 effective=900 allocated=-100 => valid', () => {
      const receipt = makeReceipt({
        id: 'persisted-valid-a',
        total: 900,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 900,
            discountAllocated: -100,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).toBe(
        'known_coherent'
      );
    });

    test('persisted discount: allocated=-50 does not explain 1000→900 => never coherent', () => {
      const receipt = makeReceipt({
        id: 'persisted-bad-delta',
        total: 900,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 900,
            discountAllocated: -50,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('persisted discount: discountAllocated=null => never coherent', () => {
      const receipt = makeReceipt({
        id: 'persisted-null-alloc',
        total: 900,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 900,
            discountAllocated: null as unknown as number,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('persisted discount: discountAllocated="100" string => never coherent', () => {
      const receipt = makeReceipt({
        id: 'persisted-string-alloc',
        total: 900,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 900,
            discountAllocated: '100' as unknown as number,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('persisted discount: discountAllocated=+100 positive => never coherent', () => {
      const receipt = makeReceipt({
        id: 'persisted-positive-alloc',
        total: 900,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            effectiveLineTotal: 900,
            discountAllocated: 100,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('conflicting gross aliases lineTotal≠line_total => never coherent', () => {
      const receipt = makeReceipt({
        id: 'gross-alias-conflict',
        total: 900,
        items: [
          {
            name: 'A',
            lineTotal: 1000,
            line_total: 950,
            effectiveLineTotal: 900,
            discountAllocated: -100,
          },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).not.toBe(
        'known_coherent'
      );
    });

    test('CRITICAL: allocation-generated zero cannot wash original null OCR evidence', () => {
      const receipt = makeReceipt({
        id: 'ocr-null-washed-by-allocation',
        total: 90,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1, lineTotal: null as unknown as number },
        ],
        analysis: {
          discounts: [
            {
              label: 'CPN A',
              amount: -10,
              adjacentPrecedingItemIndex: 0,
            },
          ],
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });

      const bundle = resolveReceiptMonetarySourceBundle(receipt);
      expect(bundle.coherent).toBe(true);
      expect(bundle.layer).toBe('ocr');
      // Post-normalization: production allocation writes Number(null)→0 onto B.
      const selectedKinds = bundle.items.map((item: DiscountableItem) =>
        resolveSelectedItemMonetaryAmount(item).kind
      );
      expect(selectedKinds).toContain('explicit_zero');
      // Without pre-normalization gate, H1 would close: 90+0 ≈ 90.
      expect(bundle.paidTotal).toBe(90);

      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('unknown');
      expect(monetary.state).not.toBe('known_coherent');
      expect(monetary.reasonCodes).toContain(
        'incomplete_authoritative_item_monetary_evidence'
      );
      expect(monetary.evidence.some((e) => e.includes('original_ocr'))).toBe(true);
    });

    test('original OCR missing monetary fields => unknown even if normalized looks complete', () => {
      const receipt = makeReceipt({
        id: 'ocr-fields-absent',
        total: 100,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1 },
        ],
        analysis: {
          discounts: [
            { label: 'CPN A', amount: -10, adjacentPrecedingItemIndex: 0 },
          ],
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('unknown');
      expect(monetary.reasonCodes).toContain(
        'incomplete_authoritative_item_monetary_evidence'
      );
    });

    test('original OCR lineTotal=null with effective absent => unknown', () => {
      const receipt = makeReceipt({
        id: 'ocr-null-no-effective',
        total: 100,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1, lineTotal: null as unknown as number },
        ],
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('unknown');
    });

    test('original OCR lineTotal="0" string => unknown, not explicit_zero', () => {
      const receipt = makeReceipt({
        id: 'ocr-string-zero',
        total: 100,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1, lineTotal: '0' as unknown as number },
        ],
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('unknown');
      expect(monetary.reasonCodes).toContain(
        'incomplete_authoritative_item_monetary_evidence'
      );
    });

    test('original OCR lineTotal=true => unknown', () => {
      const receipt = makeReceipt({
        id: 'ocr-bool-amount',
        total: 100,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1, lineTotal: true as unknown as number },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).toBe('unknown');
    });

    test('original OCR lineTotal=NaN => unknown', () => {
      const receipt = makeReceipt({
        id: 'ocr-nan-amount',
        total: 100,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1, lineTotal: Number.NaN },
        ],
        analysis: {},
      });
      expect(buildReceiptMonetaryCoherenceEvidence(receipt).state).toBe('unknown');
    });

    test('original explicit numeric zero with positive sibling may pass source completeness', () => {
      const receipt = makeReceipt({
        id: 'ocr-explicit-zero-ok',
        total: 100,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1, lineTotal: 0 },
        ],
        analysis: {
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      // Source completeness allows explicit 0; arithmetic 100≈100 → coherent.
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.reasonCodes).not.toContain(
        'incomplete_authoritative_item_monetary_evidence'
      );
    });

    test('complete original OCR + discount allocation + valid arithmetic remains known_coherent', () => {
      const receipt = makeReceipt({
        id: 'ocr-valid-discounted',
        total: 90,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1, lineTotal: 0 },
        ],
        analysis: {
          discounts: [
            {
              label: 'CPN A',
              amount: -10,
              adjacentPrecedingItemIndex: 0,
            },
          ],
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.closureHypothesis).toBe('tax_included_item_side_plus_remainder');
    });

    test('OCR incomplete item with reconciliation.ok=true still NOT known_coherent', () => {
      const receipt = makeReceipt({
        id: 'ocr-incomplete-meta-ok',
        total: 100,
        items: [
          { name: 'A', quantity: 1, lineTotal: 100 },
          { name: 'B', quantity: 1 },
        ],
        analysis: {
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).not.toBe('known_coherent');
      expect(monetary.reasonCodes).toContain(
        'incomplete_authoritative_item_monetary_evidence'
      );
    });

    test('user tax-excluded valid closure items=1000 tax=80 final=1080 => known_coherent', () => {
      const receipt = makeReceipt({
        id: 'user-tax-excluded',
        userEdited: 1,
        userItemsJson: JSON.stringify([{ name: 'A', quantity: 1, lineTotal: 1000 }]),
        finalTotal: 1080,
        total: 1080,
        tax: 80,
        taxIsKnown: 1,
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.closureHypothesis).toBe(
        'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
      );
    });

    test('user tax-excluded with untrusted tax must NOT use H2', () => {
      const receipt = makeReceipt({
        id: 'user-tax-untrusted',
        userEdited: 1,
        userItemsJson: JSON.stringify([{ name: 'A', quantity: 1, lineTotal: 1000 }]),
        finalTotal: 1080,
        total: 1080,
        tax: 80,
        taxIsKnown: 0,
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.closureHypothesis).not.toBe(
        'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
      );
      expect(monetary.state).not.toBe('known_coherent');
    });

    test('user tax-included items=1080 tax=80 final=1080 closes via H1 without double-adding tax', () => {
      const receipt = makeReceipt({
        id: 'user-tax-included-h1',
        userEdited: 1,
        userItemsJson: JSON.stringify([{ name: 'A', quantity: 1, lineTotal: 1080 }]),
        finalTotal: 1080,
        total: 1080,
        tax: 80,
        taxIsKnown: 1,
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.closureHypothesis).toBe('tax_included_item_side_plus_remainder');
    });

    test('user items=1000 remainder=-100 final_total=900 => known_coherent', () => {
      const receipt = makeReceipt({
        id: 'user-remainder-close',
        userEdited: 1,
        userItemsJson: JSON.stringify([{ name: 'A', quantity: 1, lineTotal: 1000 }]),
        finalTotal: 900,
        total: 900,
        items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
        analysis: {
          discounts: [{ label: '値引', amount: -100 }],
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.closureHypothesis).toBe('tax_included_item_side_plus_remainder');
    });

    test('user remainder + trusted tax => H2 known_coherent (1000-100+80=980)', () => {
      const receipt = makeReceipt({
        id: 'user-remainder-tax-h2',
        userEdited: 1,
        userItemsJson: JSON.stringify([{ name: 'A', quantity: 1, lineTotal: 1000 }]),
        finalTotal: 980,
        total: 980,
        tax: 80,
        taxIsKnown: 1,
        items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
        analysis: {
          discounts: [{ label: '値引', amount: -100 }],
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.closureHypothesis).toBe(
        'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
      );
    });

    test('OCR items=1000 remainder=-100 paidTotal=900 => known_coherent', () => {
      const receipt = makeReceipt({
        id: 'ocr-remainder-close',
        total: 900,
        items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
        analysis: {
          discounts: [{ label: '値引', amount: -100 }],
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.closureHypothesis).toBe('tax_included_item_side_plus_remainder');
    });

    test('negative trusted tax must NOT enable tax-excluded hypothesis', () => {
      const receipt = makeReceipt({
        id: 'neg-tax',
        total: 900,
        tax: -100,
        taxIsKnown: 1,
        items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
        analysis: {
          discounts: [{ label: '値引', amount: -100 }],
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.closureHypothesis).not.toBe(
        'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
      );
    });

    test('zero trusted tax must NOT enable tax-excluded hypothesis', () => {
      const receipt = makeReceipt({
        id: 'zero-tax',
        total: 1000,
        tax: 0,
        taxIsKnown: 1,
        items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
        analysis: {
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.closureHypothesis).not.toBe(
        'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
      );
    });

    test('trusted positive tax closing items=1000 remainder=0 tax=80 paidTotal=1080 => known_coherent', () => {
      const receipt = makeReceipt({
        id: 'pos-tax-close',
        total: 1080,
        tax: 80,
        taxIsKnown: 1,
        items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
        analysis: {
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.closureHypothesis).toBe(
        'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
      );
    });

    test('same tax case with untrusted tax is not known_coherent via tax-excluded', () => {
      const receipt = makeReceipt({
        id: 'untrusted-tax',
        total: 1080,
        tax: 80,
        taxIsKnown: 0,
        items: [{ name: 'A', quantity: 1, lineTotal: 1000 }],
        analysis: {
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.closureHypothesis).not.toBe(
        'tax_excluded_item_side_plus_remainder_plus_trusted_tax'
      );
    });

    test('complete arithmetic contradiction items=100 paidTotal=10000 with metadata ok => known_incoherent', () => {
      const receipt = makeReceipt({
        id: 'ocr-metadata-wash',
        total: 10000,
        items: [{ name: 'A', quantity: 1, lineTotal: 100 }],
        analysis: {
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_incoherent');
      expect(monetary.state).not.toBe('known_coherent');
      expect(monetary.reasonCodes).toContain('ocr_same_layer_arithmetic_does_not_close');
    });

    test('missing all item monetary evidence => unknown, never 0≈0 coherent', () => {
      const receipt = makeReceipt({
        id: 'ocr-all-missing',
        total: 100,
        items: [{ name: 'A', quantity: 1 }],
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('unknown');
      expect(monetary.state).not.toBe('known_coherent');
      expect(monetary.reasonCodes).toContain(
        'incomplete_authoritative_item_monetary_evidence'
      );
    });

    test('missing item monetary evidence with paidTotal=0 must NOT be known_coherent', () => {
      const receipt = makeReceipt({
        id: 'ocr-zero-total',
        total: 0,
        items: [{ name: 'A', quantity: 1, lineTotal: null as unknown as number }],
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).not.toBe('known_coherent');
    });

    test('user items=100, final_total=10000 must NOT be known_coherent', () => {
      const receipt = makeReceipt({
        id: 'user-mismatch',
        userEdited: 1,
        userItemsJson: JSON.stringify([{ name: 'A', quantity: 1, lineTotal: 100 }]),
        finalTotal: 10000,
        total: 10000,
        analysis: {
          amount_mismatch: false,
          reconciliation: { ok: true },
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).not.toBe('known_coherent');
    });

    test('user-authoritative layer ignores stale OCR amount_mismatch when user arithmetic closes', () => {
      const receipt = makeReceipt({
        id: 'user-over-ocr-metadata',
        userEdited: 1,
        userItemsJson: JSON.stringify([{ name: 'A', quantity: 1, lineTotal: 500 }]),
        finalTotal: 500,
        total: 9999,
        items: [{ name: 'A', quantity: 1, lineTotal: 100 }],
        analysis: {
          amount_mismatch: true,
          reconciliation: { ok: false },
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
      expect(monetary.authoritativeLayer).toBe('user');
    });

    test('known_coherent user-layer arithmetic closure case', () => {
      const receipt = makeReceipt({
        id: 'user-coherent',
        userEdited: 1,
        userItemsJson: JSON.stringify([{ name: 'A', quantity: 1, lineTotal: 100 }]),
        finalTotal: 100,
        total: 100,
        analysis: {},
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.state).toBe('known_coherent');
    });

    test('known_coherent beats known_incoherent in representative pool', () => {
      const at = Date.parse('2026-01-16T09:49:34Z');
      const incoherent = makeReceipt({
        id: 'high-quality-bad',
        merchantRaw: 'コストコ',
        total: 8351,
        transactionAt: at,
        items: [{ name: 'Item', quantity: 1, lineTotal: 9000 }],
        analysis: {
          transactionDate: '01/16/2026 18:49:34',
          amount_mismatch: true,
          reconciliation: { ok: false },
        },
      });
      const coherent = makeReceipt({
        id: 'low-quality-good',
        merchantRaw: 'コストコ',
        total: 8351,
        transactionAt: at,
        createdAt: 2,
        items: [{ name: 'Item', quantity: 1, lineTotal: 8351 }],
        analysis: {
          transactionDate: '01/16/2026 18:49:34',
          amount_mismatch: false,
          reconciliation: { ok: true },
        },
      });
      expect(buildReceiptMonetaryCoherenceEvidence(incoherent).state).toBe(
        'known_incoherent'
      );
      expect(buildReceiptMonetaryCoherenceEvidence(coherent).state).toBe('known_coherent');
      const baseGroup = buildCanonicalReceiptGroups([incoherent, coherent])[0]!;
      const group = {
        ...baseGroup,
        sourceReceiptIds: ['high-quality-bad', 'low-quality-good'],
        duplicateCount: 2,
      };
      const rec = buildShadowRepresentativeRecommendation(group, [
        incoherent,
        coherent,
      ]);
      expect(rec.shadowRecommendedRepresentativeReceiptId).toBe('low-quality-good');
      expect(rec.monetarySelectionPool).toBe('known_coherent');
    });

    test('known_coherent > unknown > known_incoherent pool ordering', () => {
      const unknown = makeReceipt({
        id: 'unknown-member',
        total: 200,
        taxIsKnown: 0,
        items: [{ name: 'Item', quantity: 1, lineTotal: null as unknown as number }],
        analysis: {},
      });
      const incoherent = makeReceipt({
        id: 'incoherent-member',
        total: 200,
        items: [{ name: 'Item', quantity: 1, lineTotal: 100 }],
        analysis: { amount_mismatch: true, reconciliation: { ok: false } },
      });
      expect(buildReceiptMonetaryCoherenceEvidence(unknown).state).toBe('unknown');
      expect(buildReceiptMonetaryCoherenceEvidence(incoherent).state).toBe(
        'known_incoherent'
      );
      const groups = buildCanonicalReceiptGroups([unknown, incoherent]);
      const rec = buildShadowRepresentativeRecommendation(groups[0]!, [
        unknown,
        incoherent,
      ]);
      expect(rec.monetarySelectionPool).toBe('unknown');
      expect(rec.shadowRecommendedRepresentativeReceiptId).toBe('unknown-member');
    });
  });

  describe('F. year diagnostic per-source attribution', () => {
    test('observedYearsByReceiptId uses each source receipt own evidence', () => {
      const rA = makeReceipt({
        id: 'src-a',
        transactionAt: Date.parse('2023-07-06T02:44:46Z'),
        analysis: { transactionDate: '2023/07/06 11:44:46' },
      });
      const rB = makeReceipt({
        id: 'src-b',
        transactionAt: Date.parse('2020-07-06T02:44:46Z'),
        analysis: { transactionDate: '2020/07/06 11:44:46' },
      });
      const rRep = makeReceipt({
        id: 'src-rep',
        transactionAt: Date.parse('2025-07-06T02:44:46Z'),
        analysis: { transactionDate: '2025/07/06 11:44:46' },
      });
      const nodes = buildProductionShadowCandidateNodes([rA, rB, rRep]);
      const multiNode = nodes.find((n) => n.sourceReceiptIds.includes('src-a'));
      expect(multiNode).toBeDefined();

      const syntheticCandidate = {
        ...multiNode!,
        sourceReceiptIds: ['src-a', 'src-b'],
        representativeReceiptId: 'src-rep',
        representativeReceipt: rRep,
        transaction: buildReceiptTransactionEvidence(rRep),
      };

      const receiptById = new Map(
        [rA, rB, rRep].map((r) => [r.id, r] as const)
      );
      const diagnostic = buildDateYearConflictDiagnostic(
        ['src-a', 'src-b'],
        [syntheticCandidate],
        receiptById
      );

      expect(diagnostic.observedYearsByReceiptId['src-a']).toBe(2023);
      expect(diagnostic.observedYearsByReceiptId['src-b']).toBe(2020);
      expect(diagnostic.observedYearsByReceiptId['src-a']).not.toBe(2025);
      expect(diagnostic.observedYearsByReceiptId['src-b']).not.toBe(2025);
    });
  });

  describe('G. pair determinism + merchant detailed evaluation', () => {
    const at = Date.parse('2026-01-06T07:23:00Z');
    const items = [{ name: 'A', quantity: 1, lineTotal: 1752 }];

    function merchantPairNodes() {
      const rA = makeReceipt({
        id: 'm-a',
        merchantRaw: 'ヨークベニマル 古川南店',
        total: 1752,
        transactionAt: at,
        items,
        analysis: {
          transactionDate: '2026年 1月 6日(火) 16:23',
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const rB = makeReceipt({
        id: 'm-b',
        merchantRaw: 'ヨークベニマル',
        total: 1752,
        transactionAt: at,
        items,
        analysis: {
          transactionDate: '2026年 1月 6日(火) 16:23',
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const nodeA = withShadowAuthorizableTransaction(canonicalNode([rA]), true);
      const nodeB = withShadowAuthorizableTransaction(canonicalNode([rB]), true);
      return { nodeA, nodeB };
    }

    test('evaluate(A,B) deeply equals evaluate(B,A)', () => {
      const { nodeA, nodeB } = merchantPairNodes();
      const ab = evaluateShadowMerchantMetadataVariantPair(nodeA, nodeB);
      const ba = evaluateShadowMerchantMetadataVariantPair(nodeB, nodeA);
      expect(ab).toEqual(ba);
    });

    test('detailed evaluation reversal is deeply equal', () => {
      const { nodeA, nodeB } = merchantPairNodes();
      const forward = evaluateShadowMerchantMetadataVariantDetailed(nodeA, nodeB);
      const reverse = evaluateShadowMerchantMetadataVariantDetailed(nodeB, nodeA);
      expect(forward).toEqual(reverse);
    });

    test('orientCandidatePair assigns left/right before evidence construction', () => {
      const { nodeA, nodeB } = merchantPairNodes();
      const { left, right } = orientCandidatePair(nodeA, nodeB);
      expect(left.candidateId <= right.candidateId).toBe(true);
      const rel = evaluateShadowMerchantMetadataVariantPair(nodeA, nodeB);
      expect(rel!.leftCandidateId).toBe(left.candidateId);
      expect(rel!.rightCandidateId).toBe(right.candidateId);
    });

    test('insufficient transaction provenance => shadowDuplicateAuthorized=false', () => {
      const { nodeA, nodeB } = merchantPairNodes();
      const nodeRealA = { ...nodeA, transaction: buildReceiptTransactionEvidence(nodeA.representativeReceipt) };
      const nodeRealB = { ...nodeB, transaction: buildReceiptTransactionEvidence(nodeB.representativeReceipt) };
      const evalResult = evaluateShadowMerchantMetadataVariantDetailed(nodeRealA, nodeRealB);
      expect(evalResult.transactionAuthorization).toBe('insufficient_provenance');
      expect(evalResult.shadowDuplicateAuthorized).toBe(false);
    });
  });

  describe('H. representative API requires canonical group', () => {
    test('recommendation builder requires CanonicalReceiptGroup', () => {
      const items = [{ name: 'Item', quantity: 1, lineTotal: 100 }];
      const r1 = makeReceipt({ id: 'g1', total: 100, items });
      const r2 = makeReceipt({ id: 'g2', total: 100, items, createdAt: 2 });
      const group = buildCanonicalReceiptGroups([r1, r2])[0]!;
      expect(group.sourceReceiptIds.length).toBeGreaterThanOrEqual(2);
      const rec = buildShadowRepresentativeRecommendation(group, [r1, r2]);
      expect(rec.sourceReceiptIds.sort()).toEqual(group.sourceReceiptIds.sort());
    });

    test('input order reversal yields deeply equal recommendation', () => {
      const items = [{ name: 'Item', quantity: 1, lineTotal: 8351 }];
      const at = Date.parse('2026-01-16T09:49:34Z');
      const bad = makeReceipt({
        id: 'pbU-like',
        merchantRaw: 'コストコ',
        total: 8351,
        transactionAt: at,
        items,
        analysis: {
          transactionDate: '01/16/2026 18:49:34',
          amount_mismatch: true,
          reconciliation: { ok: false },
        },
      });
      const good = makeReceipt({
        id: 'good-like',
        merchantRaw: 'コストコ',
        total: 8351,
        transactionAt: at,
        items,
        analysis: {
          transactionDate: '01/16/2026 18:49:34',
          amount_mismatch: false,
          reconciliation: { ok: true },
        },
      });
      const g1 = buildCanonicalReceiptGroups([bad, good])[0]!;
      const g2 = buildCanonicalReceiptGroups([good, bad])[0]!;
      expect(buildShadowRepresentativeRecommendation(g1, [bad, good])).toEqual(
        buildShadowRepresentativeRecommendation(g2, [good, bad])
      );
    });
  });

  describe('I. audit containment', () => {
    test('case shadow group requires candidate subset containment', () => {
      const receipts = [
        makeReceipt({ id: 'case-a', total: 100 }),
        makeReceipt({ id: 'case-b', total: 200 }),
        makeReceipt({ id: 'external-c', total: 300 }),
      ];
      const nodes = buildProductionShadowCandidateNodes(receipts);
      const caseCandidates = findProductionShadowCandidateForReceiptIds(
        ['case-a', 'case-b'],
        nodes
      );
      const caseCandidateIds = new Set(caseCandidates.map((c) => c.candidateId));
      const fakeGroup = {
        path: 'SHADOW_MERCHANT_METADATA_VARIANT' as const,
        candidateIds: [...caseCandidateIds, 'external-candidate-id'],
        sourceReceiptIds: ['case-a', 'case-b', 'external-c'],
        relationEvidence: [],
        evidence: [],
      };
      const contained = fakeGroup.candidateIds.every((id) => caseCandidateIds.has(id));
      expect(contained).toBe(false);
    });
  });

  describe('GT-020 regression', () => {
    test('bundle まとめ売り without ownership stays unresolved/fail-closed', () => {
      const receipt = makeReceipt({
        id: 'gt020-synthetic',
        merchantRaw: 'ヨークベニマル',
        total: 2733,
        taxIsKnown: 0,
        items: [
          { name: 'プレーンビス', quantity: 3, lineTotal: 324 },
          { name: 'チョコ', quantity: 1, lineTotal: 2409 },
        ],
        analysis: {
          transactionDate: '2026/01/17 18:38',
          discounts: [{ label: 'まとめ売り値引', amount: -33 }],
          reconciliation: { ok: true },
          amount_mismatch: false,
        },
      });
      const monetary = buildReceiptMonetaryCoherenceEvidence(receipt);
      expect(monetary.discountOwnershipStatus).toBe('unresolved');
      expect(monetary.state).not.toBe('known_coherent');
      expect(monetary.monetaryProvenanceSufficient).toBe(false);
      expect(monetary.reasonCodes).toContain('insufficient_discount_ownership_evidence');
    });
  });

  test('production analytics unchanged on isolated fixture set', () => {
    const receipts = [
      makeReceipt({ id: 'iso-a', total: 100 }),
      makeReceipt({ id: 'iso-b', total: 200 }),
    ];
    const selection = selectAnalyticsReceipts(receipts);
    expect(selection.highConfidenceDuplicateExtras).toBe(0);
    expect(selection.analyticsPurchaseCandidateCount).toBe(2);
  });

  test('ground truth case ids defined', () => {
    expect(GROUND_TRUTH_CASE_RECEIPT_IDS['GT-002']).toHaveLength(6);
    expect(GROUND_TRUTH_CASE_RECEIPT_IDS['GT-017']).toHaveLength(2);
  });
});
