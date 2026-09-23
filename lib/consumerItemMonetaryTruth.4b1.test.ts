/**
 * Performance Slice 4B.1 / 4B.1a — Deduplicate receipt-level monetary preparation
 * inside one projectTrustedConsumerItemAmounts invocation; collision-safe keys.
 */

import {
  __getLastConsumerMonetaryBulkStatsForTests,
  __resetLastConsumerMonetaryBulkStatsForTests,
  buildConsumerReceiptMonetaryPreparationKey,
  isSameConsumerReceiptMonetaryPreparationKey,
  prepareConsumerReceiptMonetaryContext,
  projectTrustedConsumerItemAmount,
  projectTrustedConsumerItemAmountWithPreparedReceipt,
  projectTrustedConsumerItemAmounts,
  type ConsumerMonetaryRowFields,
} from './consumerItemMonetaryTruth';

function analysisPayload(args: {
  items: unknown[];
  discounts?: unknown[];
  total: number;
  tax?: number | null;
}) {
  return JSON.stringify({
    merchant: 'テスト',
    items: args.items,
    discounts: args.discounts ?? [],
    tax: args.tax ?? 0,
    total: args.total,
    tax_is_known: true,
    reconciliation: { ok: true },
    amount_mismatch: false,
  });
}

const multiItemAnalysis = analysisPayload({
  items: [
    { name: 'A', lineTotal: 1000, quantity: 1 },
    { name: 'B', lineTotal: 500, quantity: 2 },
    { name: 'C', lineTotal: 250, quantity: 1 },
  ],
  total: 1750,
});

function trustedRow(
  overrides: Partial<ConsumerMonetaryRowFields> &
    Pick<ConsumerMonetaryRowFields, 'receiptId' | 'lineTotal' | 'sourceIndex'>
): ConsumerMonetaryRowFields {
  return {
    currency: 'JPY',
    receiptAnalysisJson: multiItemAnalysis,
    receiptTotal: 1750,
    receiptTax: 0,
    receiptTaxIsKnown: 1,
    displayName:
      overrides.sourceIndex === 0
        ? 'A'
        : overrides.sourceIndex === 1
          ? 'B'
          : 'C',
    purchaseQuantity:
      overrides.sourceIndex === 1 ? 2 : 1,
    ...overrides,
  };
}

function baselineFromSingleItem(
  rows: readonly ConsumerMonetaryRowFields[]
): Array<
  ConsumerMonetaryRowFields & {
    monetaryTrusted: boolean;
    monetaryTrustReason: string;
  }
> {
  return rows.map((row) => {
    const projected = projectTrustedConsumerItemAmount({
      lineTotal: row.lineTotal,
      analysisJson: row.receiptAnalysisJson,
      userItemsJson: row.receiptUserItemsJson,
      receiptId: row.receiptId,
      receiptTotal: row.receiptTotal,
      receiptTax: row.receiptTax,
      receiptTaxIsKnown: row.receiptTaxIsKnown,
      finalTotal: row.receiptFinalTotal,
      userEdited: row.receiptUserEdited,
      currency: row.currency,
      sourceIndex: row.sourceIndex,
      displayName: row.displayName,
      rawName: row.rawName,
      purchaseQuantity: row.purchaseQuantity,
    });
    if (!projected.trusted || projected.amount == null) {
      return {
        ...row,
        lineTotal: null,
        monetaryTrusted: false,
        monetaryTrustReason: projected.reason,
      };
    }
    return {
      ...row,
      lineTotal: projected.amount,
      monetaryTrusted: true,
      monetaryTrustReason: projected.reason,
    };
  });
}

describe('Slice 4B.1 — receipt monetary preparation dedupe', () => {
  beforeEach(() => {
    __resetLastConsumerMonetaryBulkStatsForTests();
  });

  describe('differential vs single-item semantics', () => {
    it('multi-item same receipt: bulk deep-equals per-row single-item baseline', () => {
      const rows = [
        trustedRow({ receiptId: 'r1', lineTotal: 1000, sourceIndex: 0 }),
        trustedRow({ receiptId: 'r1', lineTotal: 500, sourceIndex: 1 }),
        trustedRow({ receiptId: 'r1', lineTotal: 250, sourceIndex: 2 }),
      ];
      const bulk = projectTrustedConsumerItemAmounts(rows);
      expect(bulk).toEqual(baselineFromSingleItem(rows));
      expect(bulk.every((r) => r.monetaryTrusted)).toBe(true);
      expect(bulk.map((r) => r.lineTotal)).toEqual([1000, 500, 250]);
    });

    it('mixed receipts preserve order and match baseline', () => {
      const other = analysisPayload({
        items: [{ name: 'X', lineTotal: 80, quantity: 1 }],
        total: 80,
      });
      const rows = [
        trustedRow({ receiptId: 'r2', lineTotal: 500, sourceIndex: 1 }),
        {
          receiptId: 'r3',
          lineTotal: 80,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'X',
          receiptAnalysisJson: other,
          receiptTotal: 80,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
        trustedRow({ receiptId: 'r2', lineTotal: 1000, sourceIndex: 0 }),
      ];
      expect(projectTrustedConsumerItemAmounts(rows)).toEqual(
        baselineFromSingleItem(rows)
      );
    });
  });

  describe('preparation count', () => {
    it('N rows one receipt → prepare once (not N or N+1)', () => {
      const rows = [
        trustedRow({ receiptId: 'r1', lineTotal: 1000, sourceIndex: 0 }),
        trustedRow({ receiptId: 'r1', lineTotal: 500, sourceIndex: 1 }),
        trustedRow({ receiptId: 'r1', lineTotal: 250, sourceIndex: 2 }),
      ];
      projectTrustedConsumerItemAmounts(rows);
      const stats = __getLastConsumerMonetaryBulkStatsForTests();
      expect(stats).toEqual({
        receiptContextBuildCount: 1,
        receiptContextReuseCount: 2,
      });
    });

    it('R distinct receipts → prepare R times', () => {
      const a = analysisPayload({
        items: [{ name: 'A', lineTotal: 10, quantity: 1 }],
        total: 10,
      });
      const b = analysisPayload({
        items: [{ name: 'B', lineTotal: 20, quantity: 1 }],
        total: 20,
      });
      const c = analysisPayload({
        items: [{ name: 'C', lineTotal: 30, quantity: 1 }],
        total: 30,
      });
      projectTrustedConsumerItemAmounts([
        {
          receiptId: 'ra',
          lineTotal: 10,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'A',
          receiptAnalysisJson: a,
          receiptTotal: 10,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
        {
          receiptId: 'rb',
          lineTotal: 20,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'B',
          receiptAnalysisJson: b,
          receiptTotal: 20,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
        {
          receiptId: 'rc',
          lineTotal: 30,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'C',
          receiptAnalysisJson: c,
          receiptTotal: 30,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
      ]);
      expect(__getLastConsumerMonetaryBulkStatsForTests()).toEqual({
        receiptContextBuildCount: 3,
        receiptContextReuseCount: 0,
      });
    });
  });

  describe('edge cases', () => {
    it('A: multi-item trusted receipt', () => {
      const rows = [
        trustedRow({ receiptId: 'r1', lineTotal: 1000, sourceIndex: 0 }),
        trustedRow({ receiptId: 'r1', lineTotal: 500, sourceIndex: 1 }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out.map((r) => r.monetaryTrustReason)).toEqual([
        'trusted_product_spend',
        'trusted_product_spend',
      ]);
    });

    it('B: one-item receipt', () => {
      const analysis = analysisPayload({
        items: [{ name: 'Solo', lineTotal: 42, quantity: 1 }],
        total: 42,
      });
      const rows = [
        {
          receiptId: 'solo',
          lineTotal: 42,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'Solo',
          receiptAnalysisJson: analysis,
          receiptTotal: 42,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
      ];
      expect(projectTrustedConsumerItemAmounts(rows)).toEqual(
        baselineFromSingleItem(rows)
      );
      expect(__getLastConsumerMonetaryBulkStatsForTests()?.receiptContextBuildCount).toBe(
        1
      );
    });

    it('C: receipt-level blocked receipt applies to all rows', () => {
      const analysisJson = analysisPayload({
        items: [
          { name: 'A', lineTotal: 1000, quantity: 1 },
          { name: 'B', lineTotal: 500, quantity: 1 },
        ],
        discounts: [{ label: '店舗クーポン共通', amount: -1 }],
        total: 1499,
      });
      const rows = [
        {
          receiptId: 'blocked',
          lineTotal: 1000,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'A',
          receiptAnalysisJson: analysisJson,
          receiptTotal: 1499,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
        {
          receiptId: 'blocked',
          lineTotal: 500,
          sourceIndex: 1,
          currency: 'JPY',
          displayName: 'B',
          receiptAnalysisJson: analysisJson,
          receiptTotal: 1499,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(out.every((r) => r.lineTotal === null)).toBe(true);
      expect(out.every((r) => !r.monetaryTrusted)).toBe(true);
      expect(out.map((r) => r.monetaryTrustReason)).toEqual([
        'receipt_level_discount_unallocated_for_spend',
        'receipt_level_discount_unallocated_for_spend',
      ]);
      // prepare once; no reuse because later rows skip projection via gate
      expect(__getLastConsumerMonetaryBulkStatsForTests()).toEqual({
        receiptContextBuildCount: 1,
        receiptContextReuseCount: 0,
      });
    });

    it('D: one item-specific failure among valid siblings', () => {
      const rows = [
        trustedRow({ receiptId: 'r1', lineTotal: 1000, sourceIndex: 0 }),
        trustedRow({
          receiptId: 'r1',
          lineTotal: 499, // amount mismatch vs mapped 500
          sourceIndex: 1,
        }),
        trustedRow({ receiptId: 'r1', lineTotal: 250, sourceIndex: 2 }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(out[0].monetaryTrusted).toBe(true);
      expect(out[1].monetaryTrusted).toBe(false);
      expect(out[1].monetaryTrustReason).toBe('item_correspondence_mismatch');
      expect(out[2].monetaryTrusted).toBe(true);
    });

    it('E: malformed user_items_json fails closed / matches baseline', () => {
      const rows = [
        trustedRow({
          receiptId: 'r1',
          lineTotal: 1000,
          sourceIndex: 0,
          receiptUserItemsJson: '{not-json',
          receiptFinalTotal: 1000,
          receiptUserEdited: 1,
        }),
        trustedRow({
          receiptId: 'r1',
          lineTotal: 500,
          sourceIndex: 1,
          receiptUserItemsJson: '{not-json',
          receiptFinalTotal: 1000,
          receiptUserEdited: 1,
        }),
      ];
      expect(projectTrustedConsumerItemAmounts(rows)).toEqual(
        baselineFromSingleItem(rows)
      );
    });

    it('F: malformed analysis_json fails closed', () => {
      const rows = [
        {
          receiptId: 'bad',
          lineTotal: 100,
          sourceIndex: 0,
          currency: 'JPY',
          receiptAnalysisJson: '{broken',
          receiptTotal: 100,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(out[0].monetaryTrusted).toBe(false);
    });

    it('G: user_items authority over analysis amounts', () => {
      const analysis = analysisPayload({
        items: [{ name: 'Milk', lineTotal: 500, quantity: 1 }],
        total: 500,
      });
      const userItems = JSON.stringify([
        { name: 'Milk', lineTotal: 450, quantity: 1 },
      ]);
      const rows = [
        {
          receiptId: 'user',
          lineTotal: 450,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'Milk',
          purchaseQuantity: 1,
          receiptAnalysisJson: analysis,
          receiptUserItemsJson: userItems,
          receiptTotal: 500,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
          receiptFinalTotal: 450,
          receiptUserEdited: 1,
        },
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(out[0].lineTotal).toBe(450);
      expect(out[0].monetaryTrusted).toBe(true);
    });

    it('H: OCR/analysis fallback when user_items absent', () => {
      const rows = [
        trustedRow({ receiptId: 'r1', lineTotal: 1000, sourceIndex: 0 }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out[0].lineTotal).toBe(1000);
      expect(out[0].monetaryTrustReason).toBe('trusted_product_spend');
    });

    it('I: unknown currency path', () => {
      const rows = [
        trustedRow({
          receiptId: 'unk',
          lineTotal: 1000,
          sourceIndex: 0,
          currency: 'UNKNOWN',
        }),
        trustedRow({
          receiptId: 'unk',
          lineTotal: 500,
          sourceIndex: 1,
          currency: 'UNKNOWN',
        }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(
        out.every((r) => r.monetaryTrustReason === 'currency_unknown')
      ).toBe(true);
    });

    it('J: discount ownership unresolved blocks receipt', () => {
      const analysisJson = analysisPayload({
        items: [
          {
            name: 'ケージフリータマゴ',
            lineTotal: 758,
            discountAllocated: 0,
            effectiveLineTotal: 758,
          },
        ],
        discounts: [
          {
            label: 'CAGE FREE EGG CPN',
            amount: -160,
            ownershipStatus: 'unbound',
            boundItemIndex: null,
            ownershipReason: 'no_deterministic_ownership',
          },
        ],
        total: 598,
      });
      const rows = [
        {
          receiptId: 'own',
          lineTotal: 758,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'ケージフリータマゴ',
          receiptAnalysisJson: analysisJson,
          receiptTotal: 598,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(out[0].monetaryTrustReason).toBe('discount_ownership_unresolved');
    });

    it('K: invalid sourceIndex', () => {
      const rows = [
        trustedRow({ receiptId: 'r1', lineTotal: 1000, sourceIndex: 0 }),
        trustedRow({ receiptId: 'r1', lineTotal: 500, sourceIndex: 99 as number }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(out[1].monetaryTrustReason).toBe('source_index_invalid');
      expect(out[0].monetaryTrusted).toBe(true);
    });

    it('L: amount correspondence mismatch', () => {
      const rows = [
        trustedRow({ receiptId: 'r1', lineTotal: 999, sourceIndex: 0 }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out[0].monetaryTrustReason).toBe('item_correspondence_mismatch');
    });

    it('M: quantity correspondence mismatch', () => {
      const rows = [
        trustedRow({
          receiptId: 'r1',
          lineTotal: 500,
          sourceIndex: 1,
          purchaseQuantity: 9,
        }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out[0].monetaryTrustReason).toBe('item_correspondence_mismatch');
    });

    it('N: output ordering preserved (not grouped by receipt)', () => {
      const other = analysisPayload({
        items: [{ name: 'Z', lineTotal: 7, quantity: 1 }],
        total: 7,
      });
      const rows = [
        trustedRow({ receiptId: 'rB', lineTotal: 250, sourceIndex: 2 }),
        {
          receiptId: 'rA',
          lineTotal: 7,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: 'Z',
          receiptAnalysisJson: other,
          receiptTotal: 7,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
        trustedRow({ receiptId: 'rB', lineTotal: 1000, sourceIndex: 0 }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out.map((r) => r.receiptId)).toEqual(['rB', 'rA', 'rB']);
      expect(out.map((r) => r.lineTotal)).toEqual([250, 7, 1000]);
    });

    it('O: thrown error from preparation propagates', () => {
      const spy = jest
        .spyOn(
          require('./analysisFoundation/monetarySourceBundle') as typeof import('./analysisFoundation/monetarySourceBundle'),
          'resolveReceiptMonetarySourceBundle'
        )
        .mockImplementation(() => {
          throw new Error('prep-boom');
        });
      expect(() =>
        projectTrustedConsumerItemAmounts([
          trustedRow({ receiptId: 'r1', lineTotal: 1000, sourceIndex: 0 }),
        ])
      ).toThrow('prep-boom');
      spy.mockRestore();
    });

    it('P: repeated receiptIds with same receipt truth prepare once', () => {
      const rows = [
        trustedRow({ receiptId: 'same', lineTotal: 1000, sourceIndex: 0 }),
        trustedRow({ receiptId: 'same', lineTotal: 500, sourceIndex: 1 }),
        trustedRow({ receiptId: 'same', lineTotal: 250, sourceIndex: 2 }),
        trustedRow({ receiptId: 'same', lineTotal: 1000, sourceIndex: 0 }),
      ];
      projectTrustedConsumerItemAmounts(rows);
      expect(__getLastConsumerMonetaryBulkStatsForTests()).toEqual({
        receiptContextBuildCount: 1,
        receiptContextReuseCount: 3,
      });
    });

    it('Q: conflicting same receiptId does not silently reuse incompatible truth', () => {
      const alt = analysisPayload({
        items: [
          { name: 'A', lineTotal: 1000, quantity: 1 },
          { name: 'B', lineTotal: 500, quantity: 2 },
          { name: 'C', lineTotal: 250, quantity: 1 },
        ],
        discounts: [{ label: '店舗クーポン共通', amount: -1 }],
        total: 1749,
      });
      // First row trusted; second row same receiptId but conflicting analysis.
      // Gate first-wins (existing contract): receipt remains allowed from probe.
      // Prepared context must not silently reuse the first preparation key.
      const rows = [
        trustedRow({ receiptId: 'conflict', lineTotal: 1000, sourceIndex: 0 }),
        {
          ...trustedRow({
            receiptId: 'conflict',
            lineTotal: 1000,
            sourceIndex: 0,
          }),
          receiptAnalysisJson: alt,
          receiptTotal: 1749,
        },
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      const stats = __getLastConsumerMonetaryBulkStatsForTests();
      expect(stats!.receiptContextBuildCount).toBeGreaterThanOrEqual(2);
      expect(out[0].monetaryTrusted).toBe(true);
      // Second row gets its own preparation (blocked remainder) — not silent reuse.
      expect(out[1].monetaryTrusted).toBe(false);
      expect(out[1].monetaryTrustReason).toBe(
        'receipt_level_discount_unallocated_for_spend'
      );
    });

    it('Q2: ordinary conflict does not poison original cache for later matching rows', () => {
      const alt = analysisPayload({
        items: [
          { name: 'A', lineTotal: 1000, quantity: 1 },
          { name: 'B', lineTotal: 500, quantity: 2 },
          { name: 'C', lineTotal: 250, quantity: 1 },
        ],
        discounts: [{ label: '店舗クーポン共通', amount: -1 }],
        total: 1749,
      });
      const rows = [
        trustedRow({ receiptId: 'poison', lineTotal: 1000, sourceIndex: 0 }),
        {
          ...trustedRow({
            receiptId: 'poison',
            lineTotal: 1000,
            sourceIndex: 0,
          }),
          receiptAnalysisJson: alt,
          receiptTotal: 1749,
        },
        trustedRow({ receiptId: 'poison', lineTotal: 500, sourceIndex: 1 }),
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out[0].monetaryTrusted).toBe(true);
      expect(out[1].monetaryTrusted).toBe(false);
      expect(out[2].monetaryTrusted).toBe(true);
      expect(out[2].lineTotal).toBe(500);
      const stats = __getLastConsumerMonetaryBulkStatsForTests();
      // build: first trusted + conflict ephemeral; reuse: third matching original
      expect(stats!.receiptContextBuildCount).toBe(2);
      expect(stats!.receiptContextReuseCount).toBe(1);
    });
  });

  describe('Slice 4B.1a — collision-safe preparation key', () => {
    const SEP = '\u001f';

    /** Pre-4B.1a delimiter fingerprint — retained only to prove the regression class. */
    function legacyConcatFingerprint(row: {
      receiptAnalysisJson?: string | null;
      receiptUserItemsJson?: string | null;
      receiptTotal?: number | null;
      receiptTax?: number | null;
      receiptTaxIsKnown?: number | null;
      receiptFinalTotal?: number | null;
      receiptUserEdited?: number | null;
      currency?: string | null;
    }): string {
      return [
        row.receiptAnalysisJson ?? '',
        row.receiptUserItemsJson ?? '',
        String(row.receiptTotal ?? ''),
        String(row.receiptTax ?? ''),
        String(row.receiptTaxIsKnown ?? ''),
        String(row.receiptFinalTotal ?? ''),
        String(row.receiptUserEdited ?? ''),
        String(row.currency ?? ''),
      ].join(SEP);
    }

    function delimiterCollisionPair(): {
      readyRow: ConsumerMonetaryRowFields;
      blockedRow: ConsumerMonetaryRowFields;
    } {
      const validAnalysis = analysisPayload({
        items: [{ name: 'Milk', lineTotal: 100, quantity: 1 }],
        total: 100,
      });
      const validUser = JSON.stringify([
        { name: 'Milk', lineTotal: 100, quantity: 1 },
      ]);
      const junk = 'x';
      // OLD fingerprint collides:
      // (validAnalysis + SEP + junk) + SEP + validUser
      // === validAnalysis + SEP + (junk + SEP + validUser)
      const readyRow: ConsumerMonetaryRowFields = {
        receiptId: 'collide',
        lineTotal: 100,
        sourceIndex: 0,
        currency: 'JPY',
        displayName: 'Milk',
        purchaseQuantity: 1,
        receiptAnalysisJson: validAnalysis + SEP + junk,
        receiptUserItemsJson: validUser,
        receiptTotal: 100,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        receiptFinalTotal: 100,
        receiptUserEdited: 1,
      };
      const blockedRow: ConsumerMonetaryRowFields = {
        receiptId: 'collide',
        lineTotal: 100,
        sourceIndex: 0,
        currency: 'JPY',
        displayName: 'Milk',
        purchaseQuantity: 1,
        receiptAnalysisJson: validAnalysis,
        receiptUserItemsJson: junk + SEP + validUser,
        receiptTotal: 100,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        receiptFinalTotal: 100,
        receiptUserEdited: 1,
      };
      return { readyRow, blockedRow };
    }

    it('legacy concat fingerprint collides for Codex-class delimiter split', () => {
      const { readyRow, blockedRow } = delimiterCollisionPair();
      expect(legacyConcatFingerprint(readyRow)).toBe(
        legacyConcatFingerprint(blockedRow)
      );
      expect(
        isSameConsumerReceiptMonetaryPreparationKey(
          buildConsumerReceiptMonetaryPreparationKey({
            analysisJson: readyRow.receiptAnalysisJson,
            userItemsJson: readyRow.receiptUserItemsJson,
            receiptTotal: readyRow.receiptTotal,
            receiptTax: readyRow.receiptTax,
            receiptTaxIsKnown: readyRow.receiptTaxIsKnown,
            finalTotal: readyRow.receiptFinalTotal,
            userEdited: readyRow.receiptUserEdited,
            currency: readyRow.currency,
          }),
          buildConsumerReceiptMonetaryPreparationKey({
            analysisJson: blockedRow.receiptAnalysisJson,
            userItemsJson: blockedRow.receiptUserItemsJson,
            receiptTotal: blockedRow.receiptTotal,
            receiptTax: blockedRow.receiptTax,
            receiptTaxIsKnown: blockedRow.receiptTaxIsKnown,
            finalTotal: blockedRow.receiptFinalTotal,
            userEdited: blockedRow.receiptUserEdited,
            currency: blockedRow.currency,
          })
        )
      ).toBe(false);
    });

    it('ready-then-blocked delimiter collision: no wrong reuse; matches baseline', () => {
      const { readyRow, blockedRow } = delimiterCollisionPair();
      const readyBaseline = projectTrustedConsumerItemAmount({
        lineTotal: readyRow.lineTotal,
        analysisJson: readyRow.receiptAnalysisJson,
        userItemsJson: readyRow.receiptUserItemsJson,
        receiptId: readyRow.receiptId,
        receiptTotal: readyRow.receiptTotal,
        receiptTax: readyRow.receiptTax,
        receiptTaxIsKnown: readyRow.receiptTaxIsKnown,
        finalTotal: readyRow.receiptFinalTotal,
        userEdited: readyRow.receiptUserEdited,
        currency: readyRow.currency,
        sourceIndex: readyRow.sourceIndex,
        displayName: readyRow.displayName,
        purchaseQuantity: readyRow.purchaseQuantity,
      });
      const blockedBaseline = projectTrustedConsumerItemAmount({
        lineTotal: blockedRow.lineTotal,
        analysisJson: blockedRow.receiptAnalysisJson,
        userItemsJson: blockedRow.receiptUserItemsJson,
        receiptId: blockedRow.receiptId,
        receiptTotal: blockedRow.receiptTotal,
        receiptTax: blockedRow.receiptTax,
        receiptTaxIsKnown: blockedRow.receiptTaxIsKnown,
        finalTotal: blockedRow.receiptFinalTotal,
        userEdited: blockedRow.receiptUserEdited,
        currency: blockedRow.currency,
        sourceIndex: blockedRow.sourceIndex,
        displayName: blockedRow.displayName,
        purchaseQuantity: blockedRow.purchaseQuantity,
      });
      expect(readyBaseline.trusted).toBe(true);
      expect(blockedBaseline.trusted).toBe(false);
      expect(blockedBaseline.reason).toBe('monetary_source_incoherent');

      const rows = [readyRow, blockedRow];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(out[0].monetaryTrusted).toBe(true);
      expect(out[0].lineTotal).toBe(100);
      expect(out[1].monetaryTrusted).toBe(false);
      expect(out[1].monetaryTrustReason).toBe('monetary_source_incoherent');
      const stats = __getLastConsumerMonetaryBulkStatsForTests();
      expect(stats!.receiptContextBuildCount).toBe(2);
      expect(stats!.receiptContextReuseCount).toBe(0);
    });

    it('blocked-then-ready reverse order: gate first-wins; no forced ready truth', () => {
      const { readyRow, blockedRow } = delimiterCollisionPair();
      const rows = [blockedRow, readyRow];
      const out = projectTrustedConsumerItemAmounts(rows);
      // First-wins receipt gate: first row blocks the receipt for later rows.
      expect(out[0].monetaryTrusted).toBe(false);
      expect(out[0].monetaryTrustReason).toBe('monetary_source_incoherent');
      expect(out[1].monetaryTrusted).toBe(false);
      expect(out[1].monetaryTrustReason).toBe('monetary_source_incoherent');
      // Only one prepare (probe); later row uses gate without reuse of a ready context.
      expect(__getLastConsumerMonetaryBulkStatsForTests()).toEqual({
        receiptContextBuildCount: 1,
        receiptContextReuseCount: 0,
      });
      // Single-item ready row would be trusted — bulk must not invent that via reuse.
      expect(
        projectTrustedConsumerItemAmount({
          lineTotal: readyRow.lineTotal,
          analysisJson: readyRow.receiptAnalysisJson,
          userItemsJson: readyRow.receiptUserItemsJson,
          receiptId: readyRow.receiptId,
          receiptTotal: readyRow.receiptTotal,
          receiptTax: readyRow.receiptTax,
          receiptTaxIsKnown: readyRow.receiptTaxIsKnown,
          finalTotal: readyRow.receiptFinalTotal,
          userEdited: readyRow.receiptUserEdited,
          currency: readyRow.currency,
          sourceIndex: readyRow.sourceIndex,
          displayName: readyRow.displayName,
          purchaseQuantity: readyRow.purchaseQuantity,
        }).trusted
      ).toBe(true);
    });

    it('U+001F inside analysis/user JSON is ordinary data, not a key delimiter', () => {
      const withSepInName = analysisPayload({
        items: [
          {
            name: `Milk${SEP}Brand`,
            lineTotal: 100,
            quantity: 1,
          },
        ],
        total: 100,
      });
      const userWithSep = JSON.stringify([
        { name: `Milk${SEP}Brand`, lineTotal: 100, quantity: 1 },
      ]);
      const keyA = buildConsumerReceiptMonetaryPreparationKey({
        analysisJson: withSepInName,
        userItemsJson: userWithSep,
        receiptTotal: 100,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        finalTotal: null,
        userEdited: 0,
        currency: 'JPY',
      });
      const keyB = buildConsumerReceiptMonetaryPreparationKey({
        analysisJson: withSepInName,
        userItemsJson: userWithSep,
        receiptTotal: 100,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        finalTotal: null,
        userEdited: 0,
        currency: 'JPY',
      });
      const keyDifferentUser = buildConsumerReceiptMonetaryPreparationKey({
        analysisJson: withSepInName,
        userItemsJson: JSON.stringify([
          { name: 'Milk', lineTotal: 100, quantity: 1 },
        ]),
        receiptTotal: 100,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        finalTotal: null,
        userEdited: 0,
        currency: 'JPY',
      });
      expect(isSameConsumerReceiptMonetaryPreparationKey(keyA, keyB)).toBe(
        true
      );
      expect(
        isSameConsumerReceiptMonetaryPreparationKey(keyA, keyDifferentUser)
      ).toBe(false);

      const rows = [
        {
          receiptId: 'sep',
          lineTotal: 100,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: `Milk${SEP}Brand`,
          purchaseQuantity: 1,
          receiptAnalysisJson: withSepInName,
          receiptTotal: 100,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
        {
          receiptId: 'sep',
          lineTotal: 100,
          sourceIndex: 0,
          currency: 'JPY',
          displayName: `Milk${SEP}Brand`,
          purchaseQuantity: 1,
          receiptAnalysisJson: withSepInName,
          receiptTotal: 100,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
        },
      ];
      const out = projectTrustedConsumerItemAmounts(rows);
      expect(out).toEqual(baselineFromSingleItem(rows));
      expect(__getLastConsumerMonetaryBulkStatsForTests()).toEqual({
        receiptContextBuildCount: 1,
        receiptContextReuseCount: 1,
      });
    });

    it('null vs undefined preparation fields remain distinct', () => {
      const withNull = buildConsumerReceiptMonetaryPreparationKey({
        analysisJson: '{}',
        userItemsJson: null,
        receiptTotal: 1,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        finalTotal: null,
        userEdited: 0,
        currency: 'JPY',
      });
      const withUndefined = buildConsumerReceiptMonetaryPreparationKey({
        analysisJson: '{}',
        userItemsJson: undefined,
        receiptTotal: 1,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        finalTotal: undefined,
        userEdited: 0,
        currency: 'JPY',
      });
      expect(
        isSameConsumerReceiptMonetaryPreparationKey(withNull, withUndefined)
      ).toBe(false);
    });
  });

  describe('single-item API + prepared helpers', () => {
    it('projectTrustedConsumerItemAmount still prepares then projects', () => {
      const proj = projectTrustedConsumerItemAmount({
        lineTotal: 1000,
        analysisJson: multiItemAnalysis,
        receiptId: 'r1',
        receiptTotal: 1750,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        currency: 'JPY',
        sourceIndex: 0,
        displayName: 'A',
      });
      expect(proj).toEqual({
        amount: 1000,
        trusted: true,
        reason: 'trusted_product_spend',
      });
    });

    it('prepare + WithPreparedReceipt matches public single-item', () => {
      const input = {
        lineTotal: 500,
        analysisJson: multiItemAnalysis,
        receiptId: 'r1',
        receiptTotal: 1750,
        receiptTax: 0,
        receiptTaxIsKnown: 1,
        currency: 'JPY',
        sourceIndex: 1,
        displayName: 'B',
        purchaseQuantity: 2,
      };
      const prepared = prepareConsumerReceiptMonetaryContext(input);
      expect(
        projectTrustedConsumerItemAmountWithPreparedReceipt(input, prepared)
      ).toEqual(projectTrustedConsumerItemAmount(input));
    });
  });

  describe('same-receipt JOIN invariant (production callers)', () => {
    it('documents that productHistory JOIN attaches identical receipt fields per receiptId', () => {
      // Production SQL: INNER JOIN receipts ON receipts.id = receipt_items.receipt_id
      // with CONSUMER_MONETARY_RECEIPT_SELECT_SQL — one receipts row per id.
      // Therefore receiptId is a safe reuse key for JOIN-sourced rows.
      const same = [
        trustedRow({ receiptId: 'join', lineTotal: 1000, sourceIndex: 0 }),
        trustedRow({ receiptId: 'join', lineTotal: 500, sourceIndex: 1 }),
      ];
      expect(same[0].receiptAnalysisJson).toBe(same[1].receiptAnalysisJson);
      expect(same[0].receiptTotal).toBe(same[1].receiptTotal);
      expect(projectTrustedConsumerItemAmounts(same)[0].monetaryTrusted).toBe(
        true
      );
    });
  });
});
