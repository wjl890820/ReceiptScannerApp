/**
 * POST-O9 H1 — reviewed derived analysis and amount warning.
 * Receipt092 / 093 patterns, discount 095 / 096, warning, overage, durability.
 */

import { resolveDiscountOwnership } from './analysisFoundation/discountOwnership';
import { resolveReceiptMonetarySourceBundle } from './analysisFoundation/monetarySourceBundle';
import { assessSameLayerMonetaryClosure } from './receiptEvidenceTruth/monetaryClosure';
import { buildCloudUserReceiptUpsertPayload } from './cloudBackupPayload';
import { resolveCurrentAnalysisItemMonetaryTruth } from './currentItemMonetaryTruth';
import {
  applyUserLineAmountEdit,
  assessReviewedDiscountRoleSet,
} from './receiptDiscountAllocation';
import { buildReceiptItemIndexRows } from './receiptItemIndex';
import { projectReceiptSaveMaterialEvidence } from './receiptSaveProjection';
import {
  evaluateReviewedReceiptSaveEligibility,
  projectReviewedMonetaryTruth,
} from './reviewedDerivedAnalysis';
import {
  evaluateScanReviewSaveEligibility,
  reviewedAmountWarningVisible,
  sumPositiveMerchandiseLineTotals,
  sumReceiptDiscountAmounts,
} from './scanReviewSaveSafety';

const CASE_A_AMOUNTS = [69, 178, 159, 168, 108, 596, 118, 218, 628, 334];

function line(amount: number, extra: Record<string, unknown> = {}) {
  return {
    name: `item-${amount}`,
    quantity: 1,
    lineTotal: amount,
    category: 'snacks_drinks',
    ...extra,
  };
}

function signal(
  analysis: Record<string, unknown>,
  key: string
): number | undefined {
  const outputs = analysis.analysis_outputs_v1 as {
    receipt_level?: { shopping_signals?: { key: string; value?: number }[] };
  };
  const hit = outputs?.receipt_level?.shopping_signals?.find((s) => s.key === key);
  return typeof hit?.value === 'number' ? hit.value : undefined;
}

function engineMerchandise(analysis: Record<string, unknown>): number | undefined {
  const engine = analysis.analysis_engine_v1 as {
    signals?: { key: string; value?: number }[];
  };
  const hit = engine?.signals?.find((s) => s.key === 'merchandise_amount');
  return typeof hit?.value === 'number' ? hit.value : undefined;
}

function categoryAmount(analysis: Record<string, unknown>, category: string): number {
  const engine = analysis.analysis_engine_v1 as {
    main_category_breakdown?: { category_main: string; amount: number }[];
  };
  const row = engine.main_category_breakdown?.find((entry) => entry.category_main === category);
  return row?.amount ?? 0;
}

const chickenA = line(372, {
  name: '鶏むね',
  category: 'food_ingredients',
  effectiveLineTotal: 334,
  discountAllocated: -38,
});
const chickenB = line(378, {
  name: '鶏もも',
  category: 'food_ingredients',
  effectiveLineTotal: 340,
  discountAllocated: -38,
});
const foodRest = line(416, { name: '野菜', category: 'food_ingredients', effectiveLineTotal: 416 });
const ready = line(1756, { name: '弁当', category: 'ready_to_eat', effectiveLineTotal: 1756 });
const snacks = line(296, { name: '菓子', category: 'snacks_drinks', effectiveLineTotal: 296 });
const discounts095 = [
  { label: '割引10%', amount: -38, ownershipStatus: 'bound' as const, boundItemIndex: 0, ownershipReason: 'ordinary_adjacent_product_discount' },
  { label: '割引10%', amount: -38, ownershipStatus: 'bound' as const, boundItemIndex: 1, ownershipReason: 'ordinary_adjacent_product_discount' },
];

function recognitionAnalysis(items: Record<string, unknown>[], extra: Record<string, unknown>) {
  const discounts = Array.isArray(extra.discounts) ? extra.discounts : [];
  const tax = Number(extra.tax) || 0;
  const total = Number(extra.total) || 0;
  return {
    merchant: 'recognition-merchant',
    currency: 'JPY',
    tax_is_known: true,
    items,
    discounts,
    tax,
    total,
    reconciliation: {
      ok: false,
      itemsPositiveSum: sumPositiveMerchandiseLineTotals(items),
      discountsSum: sumReceiptDiscountAmounts(discounts),
      tax,
      total,
      diff: 99,
      warnings: ['amount_mismatch'],
    },
    amount_mismatch: true,
    analysis_outputs_v1: {
      receipt_level: {
        shopping_signals: [
          { key: 'merchandise_amount', value: sumPositiveMerchandiseLineTotals(items) },
          { key: 'items_count', value: items.length },
        ],
      },
      templates_v1: { receipt_template: { level: 'L1', title_key: 'stale' } },
    },
    classification_telemetry_v1: { source: 'recognition' },
    ocr_raw_text: 'printed evidence',
    ...extra,
  };
}

function persistReviewed(analysis: Record<string, unknown>) {
  return projectReceiptSaveMaterialEvidence({
    analysis: analysis as never,
    reviewedSave: true,
  }).persistedAnalysis as Record<string, unknown>;
}

describe('reviewed derived analysis — Receipt092 / Receipt093', () => {
  it('CASE A: 108 → 168 closes external tax; snapshot stays mismatched', () => {
    const recognized = CASE_A_AMOUNTS.map((amount, index) =>
      line(amount, { name: index === 4 ? 'ファンタオレン' : `line-${index}` })
    );
    const snapshot = recognitionAnalysis(recognized, { tax: 210, total: 2846 });
    const snapshotJson = JSON.stringify(snapshot);

    const reviewedItems = recognized.map((item, index) =>
      index === 4 ? applyUserLineAmountEdit(item, 168) : item
    );
    const saved = persistReviewed({
      ...snapshot,
      items: reviewedItems,
    });

    expect(JSON.parse(snapshotJson).items[4].lineTotal).toBe(108);
    expect(JSON.parse(snapshotJson).amount_mismatch).toBe(true);
    expect(snapshot.items[4].lineTotal).toBe(108);
    expect(snapshot.amount_mismatch).toBe(true);

    const items = saved.items as { lineTotal: number; name: string }[];
    expect(items[4].lineTotal).toBe(168);
    expect(items[4].name).toBe('ファンタオレン');
    const recon = saved.reconciliation as {
      itemsPositiveSum: number;
      diff: number;
      ok: boolean;
    };
    expect(recon.itemsPositiveSum).toBe(2636);
    expect(recon.diff).toBe(0);
    expect(recon.ok).toBe(true);
    expect(saved.amount_mismatch).toBe(false);
    expect(signal(saved, 'merchandise_amount')).toBe(2636);
    expect(engineMerchandise(saved)).toBe(2636);
    expect(signal(saved, 'items_count')).toBe(10);
    expect(saved.classification_telemetry_v1).toEqual({ source: 'recognition' });
    expect(saved.ocr_raw_text).toBe('printed evidence');
  });

  it('CASE B: user-added 170 closes internal tax; snapshot stays four lines', () => {
    const recognized = [324, 288, 300, 300].map((amount) => line(amount));
    const snapshot = recognitionAnalysis(recognized, { tax: 102, total: 1382 });
    const saved = persistReviewed({
      ...snapshot,
      merchant: 'ヨークベニマル古川南店',
      items: [
        ...recognized,
        line(170, { name: 'パプリカ', user_added: true, category: 'food_ingredients' }),
      ],
    });

    expect(snapshot.items).toHaveLength(4);
    expect(snapshot.amount_mismatch).toBe(true);
    const items = saved.items as { name: string; lineTotal: number }[];
    expect(items).toHaveLength(5);
    expect(items[4].name).toBe('パプリカ');
    expect(items[4].lineTotal).toBe(170);
    const recon = saved.reconciliation as { itemsPositiveSum: number; diff: number; ok: boolean };
    expect(recon.itemsPositiveSum).toBe(1382);
    expect(recon.diff).toBe(0);
    expect(recon.ok).toBe(true);
    expect(saved.amount_mismatch).toBe(false);
    expect(signal(saved, 'merchandise_amount')).toBe(1382);
    expect(signal(saved, 'items_count')).toBe(5);
  });

  it('does not rebuild derived fields on a non-review save', () => {
    const analysis = recognitionAnalysis([line(100)], { tax: 8, total: 108, amount_mismatch: true });
    const saved = projectReceiptSaveMaterialEvidence({
      analysis: analysis as never,
      reviewedSave: false,
    }).persistedAnalysis as Record<string, unknown>;
    expect(saved.amount_mismatch).toBe(true);
    expect((saved.reconciliation as { diff: number }).diff).toBe(99);
  });
});

describe('reviewed amount warning', () => {
  function gate(items: { lineTotal: number }[], tax: number, total: number, discounts: { amount: number }[] = []) {
    return evaluateScanReviewSaveEligibility({
      itemsPositiveSum: sumPositiveMerchandiseLineTotals(items),
      discountsSum: sumReceiptDiscountAmounts(discounts),
      tax,
      total,
    });
  }

  it('hides the warning after reviewed arithmetic closes even if recognition mismatch was true', () => {
    const reviewed = CASE_A_AMOUNTS.map((amount, index) =>
      line(index === 4 ? 168 : amount)
    );
    const eligibility = gate(reviewed, 210, 2846);
    expect(eligibility.reconciliationOk).toBe(true);
    expect(reviewedAmountWarningVisible(eligibility)).toBe(false);
  });

  it('shows the warning when the current reviewed basket still mismatches', () => {
    const eligibility = gate(CASE_A_AMOUNTS.map((amount) => line(amount)), 210, 2846);
    expect(eligibility.allowed).toBe(true);
    expect(reviewedAmountWarningVisible(eligibility)).toBe(true);
  });

  it('shows the warning and keeps the overage save block', () => {
    const eligibility = gate([line(3000)], 210, 2846);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reason).toBe('unexplained_positive_merchandise_overage');
    expect(reviewedAmountWarningVisible(eligibility)).toBe(true);
  });

  it('agrees with recognition when the user has not edited amounts', () => {
    const items = CASE_A_AMOUNTS.map((amount) => line(amount));
    const eligibility = gate(items, 210, 2846);
    const saved = persistReviewed(
      recognitionAnalysis(items, { tax: 210, total: 2846 })
    );
    expect(reviewedAmountWarningVisible(eligibility)).toBe(true);
    expect(saved.amount_mismatch).toBe(true);
    expect(eligibility.reconciliationOk).toBe(false);
  });
});

describe('discount regression Receipt095 / Receipt096', () => {
  it('keeps gross reconciliation, net merchandise, and bound discounts for 095', () => {
    const items = [chickenA, chickenB, foodRest, ready, snacks];
    const saved = persistReviewed(
      recognitionAnalysis(items, {
        tax: 251,
        total: 3393,
        discounts: discounts095,
        amount_mismatch: false,
        reconciliation: { ok: true, itemsPositiveSum: 3218, discountsSum: -76, tax: 251, total: 3393, diff: 0, warnings: [] },
      })
    );
    const recon = saved.reconciliation as {
      itemsPositiveSum: number;
      discountsSum: number;
      diff: number;
      ok: boolean;
    };
    expect(items.reduce((sum, item) => sum + item.lineTotal, 0)).toBe(3218);
    expect(recon.itemsPositiveSum).toBe(3142);
    expect(recon.discountsSum).toBe(0);
    expect(recon.itemsPositiveSum + recon.discountsSum).toBe(3142);
    expect(recon.diff).toBe(0);
    expect(recon.ok).toBe(true);
    expect(saved.amount_mismatch).toBe(false);
    expect(signal(saved, 'merchandise_amount')).toBe(3142);
    expect(engineMerchandise(saved)).toBe(3142);
    expect(signal(saved, 'receipt_level_discount')).toBe(0);
    expect(categoryAmount(saved, 'ready_to_eat')).toBe(1756);
    expect(categoryAmount(saved, 'food_ingredients')).toBe(1090);
    expect(categoryAmount(saved, 'snacks_drinks')).toBe(296);
    const savedItems = saved.items as { lineTotal: number; discountAllocated: number }[];
    expect(savedItems[0].lineTotal).toBe(372);
    expect(savedItems[0].discountAllocated).toBe(-38);
    expect(savedItems[1].lineTotal).toBe(378);
    const savedDiscounts = saved.discounts as { amount: number; boundItemIndex: number }[];
    expect(savedDiscounts.map((d) => d.amount)).toEqual([-38, -38]);
    expect(savedDiscounts.map((d) => d.boundItemIndex)).toEqual([0, 1]);
  });

  it('keeps the bread gross/effective split for 096', () => {
    const bread = line(160, {
      name: 'パン',
      category: 'snacks_drinks',
      effectiveLineTotal: 144,
      discountAllocated: -16,
    });
    const other = line(864, {
      name: 'その他',
      category: 'food_ingredients',
      effectiveLineTotal: 864,
    });
    const saved = persistReviewed(
      recognitionAnalysis([bread, other], {
        tax: 80,
        total: 1088,
        discounts: [
          {
            label: '割引10%',
            amount: -16,
            ownershipStatus: 'bound',
            boundItemIndex: 0,
            ownershipReason: 'ordinary_adjacent_product_discount',
          },
        ],
      })
    );
    const recon = saved.reconciliation as { itemsPositiveSum: number; discountsSum: number; ok: boolean };
    expect(recon.itemsPositiveSum).toBe(1008);
    expect(recon.discountsSum).toBe(0);
    expect(recon.ok).toBe(true);
    expect(signal(saved, 'merchandise_amount')).toBe(1008);
    const savedBread = (saved.items as { name: string; lineTotal: number; effectiveLineTotal: number }[])[0];
    expect(savedBread.name).toBe('パン');
    expect(savedBread.lineTotal).toBe(160);
    expect(savedBread.effectiveLineTotal).toBe(144);
  });

  it('does not subtract a bound discount twice after a line-amount edit', () => {
    const edited = applyUserLineAmountEdit(chickenA, 400);
    const saved = persistReviewed(
      recognitionAnalysis([edited, chickenB, foodRest, ready, snacks], {
        tax: 251,
        total: 3393,
        discounts: discounts095,
      })
    );
    expect(signal(saved, 'merchandise_amount')).toBe(3208);
    expect((saved.reconciliation as { discountsSum: number; itemsPositiveSum: number }).discountsSum).toBe(0);
    expect((saved.reconciliation as { itemsPositiveSum: number }).itemsPositiveSum).toBe(3208);
    expect(
      (saved.reconciliation as { itemsPositiveSum: number }).itemsPositiveSum +
        (saved.reconciliation as { discountsSum: number }).discountsSum
    ).toBe(3208);
    const savedChicken = (saved.items as { discountAllocated: number; lineTotal: number }[])[0];
    expect(savedChicken.lineTotal).toBe(400);
    expect(savedChicken.discountAllocated).toBe(0);
    const savedDiscounts = saved.discounts as {
      amount: number;
      ownershipStatus: string;
      boundItemIndex: number | null;
    }[];
    expect(savedDiscounts.map((d) => d.amount)).toEqual([-38, -38]);
    expect(savedDiscounts[0].ownershipStatus).toBe('absorbed');
    expect(savedDiscounts[0].boundItemIndex).toBeNull();
    expect(savedDiscounts[1].ownershipStatus).toBe('bound');
    expect(savedDiscounts[1].boundItemIndex).toBe(1);
  });
});

describe('A1 discounted-line reviewed monetary truth', () => {
  const closedTotalFor400 = 3208 + 251;
  const closedTotalFor410 = 3218 + 251;

  function basket095(first: ReturnType<typeof line>) {
    return [first, chickenB, foodRest, ready, snacks];
  }

  function assertLayersAgree(saved: Record<string, unknown>, net: number) {
    const recon = saved.reconciliation as {
      itemsPositiveSum: number;
      discountsSum: number;
      diff: number;
      ok: boolean;
    };
    expect(recon.itemsPositiveSum + recon.discountsSum).toBe(net);
    expect(recon.diff).toBe(0);
    expect(recon.ok).toBe(true);
    expect(saved.amount_mismatch).toBe(false);
    expect(signal(saved, 'merchandise_amount')).toBe(net);
    expect(engineMerchandise(saved)).toBe(net);
    expect(signal(saved, 'receipt_level_discount')).toBe(0);
    expect(categoryAmount(saved, 'food_ingredients') + categoryAmount(saved, 'ready_to_eat') + categoryAmount(saved, 'snacks_drinks')).toBe(net);
    const rows = buildReceiptItemIndexRows({
      id: 'reviewed-discount',
      analysis_json: JSON.stringify(saved),
    });
    const indexSum = rows.reduce((sum, row) => sum + (row.line_total ?? 0), 0);
    expect(indexSum).toBe(net);
    const eligibility = evaluateReviewedReceiptSaveEligibility({
      items: saved.items as never,
      discounts: saved.discounts as never,
      tax: Number(saved.tax),
      total: Number(saved.total),
    });
    expect(eligibility.allowed).toBe(true);
    expect(eligibility.reconciliationOk).toBe(true);
    expect(reviewedAmountWarningVisible(eligibility)).toBe(false);
    const ownership = resolveDiscountOwnership({
      ocrItems: saved.items as never,
      ocrDiscounts: saved.discounts as never,
      analysis: saved,
    });
    expect(ownership.status).toBe('persisted_resolved');
    expect(ownership.genuineReceiptLevelRemainder).toBe(0);
    expect(ownership.analyticsItemSum).toBe(net);
  }

  it('keeps a final-paid edit, a second edit, and the recognition snapshot apart', () => {
    const snapshot = recognitionAnalysis(basket095(chickenA), {
      tax: 251,
      total: 3393,
      discounts: discounts095,
    });
    const snapshotJson = JSON.stringify(snapshot);

    const once = applyUserLineAmountEdit(chickenA, 400);
    const first = persistReviewed({
      ...snapshot,
      items: basket095(once),
      total: closedTotalFor400,
    });
    assertLayersAgree(first, 3208);
    expect(categoryAmount(first, 'food_ingredients')).toBe(1156);
    expect(categoryAmount(first, 'ready_to_eat')).toBe(1756);
    expect(categoryAmount(first, 'snacks_drinks')).toBe(296);
    const firstDiscounts = first.discounts as {
      amount: number;
      ownershipStatus: string;
      boundItemIndex: number | null;
      reviewedMonetaryRole: string;
      sourceBoundItemIndex: number | null;
    }[];
    expect(firstDiscounts[0]).toMatchObject({
      amount: -38,
      ownershipStatus: 'absorbed',
      reviewedMonetaryRole: 'absorbed',
      boundItemIndex: null,
      sourceBoundItemIndex: 0,
    });
    expect(firstDiscounts[1]).toMatchObject({
      amount: -38,
      ownershipStatus: 'bound',
      reviewedMonetaryRole: 'applied',
      boundItemIndex: 1,
    });
    expect(JSON.stringify(snapshot)).toBe(snapshotJson);
    expect((snapshot.items as { lineTotal: number }[])[0].lineTotal).toBe(372);
    expect((snapshot.discounts as { ownershipStatus: string; boundItemIndex: number }[])[0]).toMatchObject({
      ownershipStatus: 'bound',
      boundItemIndex: 0,
    });

    const twice = applyUserLineAmountEdit(once, 410);
    const second = persistReviewed({
      ...snapshot,
      items: basket095(twice),
      total: closedTotalFor410,
    });
    assertLayersAgree(second, 3218);
    expect((second.items as { lineTotal: number }[])[0].lineTotal).toBe(410);
    expect((second.discounts as { ownershipStatus: string; amount: number }[])[0]).toMatchObject({
      ownershipStatus: 'absorbed',
      amount: -38,
    });
    expect((second.reconciliation as { discountsSum: number }).discountsSum).toBe(0);

    const resaved = persistReviewed({
      ...first,
      items: basket095(applyUserLineAmountEdit(
        (first.items as never[])[0],
        410
      )),
      discounts: first.discounts,
      total: closedTotalFor410,
      tax: 251,
    });
    assertLayersAgree(resaved, 3218);
    expect(JSON.stringify(snapshot)).toBe(snapshotJson);
    const reread = resolveCurrentAnalysisItemMonetaryTruth(JSON.stringify(second));
    expect(reread.items[0]?.lineTotal).toBe(410);
    expect(reread.ownershipStatus).toBe('persisted_resolved');
  });

  it('uses the final paid line amount once when quantity and amount both change', () => {
    const edited = applyUserLineAmountEdit({ ...chickenA, quantity: 3 }, 400);
    const saved = persistReviewed(
      recognitionAnalysis(basket095(edited), {
        tax: 251,
        total: closedTotalFor400,
        discounts: discounts095,
      })
    );
    expect((saved.items as { quantity: number; lineTotal: number }[])[0]).toMatchObject({
      quantity: 3,
      lineTotal: 400,
    });
    assertLayersAgree(saved, 3208);
    expect((saved.reconciliation as { discountsSum: number }).discountsSum).toBe(0);
  });

  it('leaves discounted monetary totals unchanged when only quantity changes', () => {
    const qtyOnly = { ...chickenA, quantity: 4, quantityUserEdited: true };
    const saved = persistReviewed(
      recognitionAnalysis(basket095(qtyOnly), {
        tax: 251,
        total: 3393,
        discounts: discounts095,
      })
    );
    const recon = saved.reconciliation as { itemsPositiveSum: number; discountsSum: number; ok: boolean };
    expect(recon.itemsPositiveSum).toBe(3142);
    expect(recon.discountsSum).toBe(0);
    expect(recon.ok).toBe(true);
    expect(signal(saved, 'merchandise_amount')).toBe(3142);
    expect((saved.discounts as { ownershipStatus: string }[])[0].ownershipStatus).toBe('bound');
  });

  it('shows a warning for the real gap and hides it once the reviewed total closes', () => {
    const edited = applyUserLineAmountEdit(chickenA, 400);
    const open = persistReviewed(
      recognitionAnalysis(basket095(edited), {
        tax: 251,
        total: 3393,
        discounts: discounts095,
      })
    );
    expect((open.reconciliation as { diff: number; discountsSum: number }).diff).toBe(66);
    expect((open.reconciliation as { discountsSum: number }).discountsSum).toBe(0);
    const openGate = evaluateReviewedReceiptSaveEligibility({
      items: open.items as never,
      discounts: open.discounts as never,
      tax: 251,
      total: 3393,
    });
    expect(reviewedAmountWarningVisible(openGate)).toBe(true);
    expect(openGate.allowed).toBe(true);

    const closed = persistReviewed(
      recognitionAnalysis(basket095(edited), {
        tax: 251,
        total: closedTotalFor400,
        discounts: discounts095,
      })
    );
    expect(reviewedAmountWarningVisible(
      evaluateReviewedReceiptSaveEligibility({
        items: closed.items as never,
        discounts: closed.discounts as never,
        tax: 251,
        total: closedTotalFor400,
      })
    )).toBe(false);
  });

  it('still blocks an unexplained positive overage after a final-paid edit', () => {
    const edited = applyUserLineAmountEdit(chickenA, 5000);
    const gate = evaluateReviewedReceiptSaveEligibility({
      items: basket095(edited),
      discounts: discounts095 as never,
      tax: 251,
      total: closedTotalFor400,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('unexplained_positive_merchandise_overage');
    expect(reviewedAmountWarningVisible(gate)).toBe(true);
    const truth = projectReviewedMonetaryTruth({
      items: basket095(edited),
      discounts: discounts095 as never,
    });
    expect(truth.discountsSum).toBe(0);
    expect(truth.netMerchandise).toBe(truth.itemsPositiveSum);
  });

  it('turns a removed discounted row into an unapplied receipt discount', () => {
    const rows = basket095(chickenA).map((item, index) => ({
      ...item,
      review_source_index: index,
    }));
    const saved = persistReviewed(
      recognitionAnalysis(rows.filter((_, index) => index !== 0), {
        tax: 251,
        total: 3393,
        discounts: discounts095,
      })
    );
    const savedDiscounts = saved.discounts as {
      amount: number;
      ownershipStatus: string;
      reviewedMonetaryRole: string;
      boundItemIndex: number | null;
      sourceBoundItemIndex: number | null;
    }[];
    expect(savedDiscounts[0]).toMatchObject({
      amount: -38,
      ownershipStatus: 'unbound',
      reviewedMonetaryRole: 'unapplied',
      boundItemIndex: null,
      sourceBoundItemIndex: 0,
    });
    expect(savedDiscounts[1]).toMatchObject({
      amount: -38,
      ownershipStatus: 'bound',
      reviewedMonetaryRole: 'applied',
      boundItemIndex: 0,
      sourceBoundItemIndex: 1,
    });
    expect((saved.items as { name: string }[])[0].name).toBe('鶏もも');
    const recon = saved.reconciliation as { itemsPositiveSum: number; discountsSum: number };
    expect(recon.itemsPositiveSum).toBe(2808);
    expect(recon.discountsSum).toBe(-38);
    expect(recon.itemsPositiveSum + recon.discountsSum).toBe(2770);
    expect(signal(saved, 'merchandise_amount')).toBe(2808);
    expect(engineMerchandise(saved)).toBe(2808);
    expect(categoryAmount(saved, 'food_ingredients') + categoryAmount(saved, 'ready_to_eat') + categoryAmount(saved, 'snacks_drinks')).toBe(2808);
    expect(signal(saved, 'receipt_level_discount')).toBe(-38);
    const indexSum = buildReceiptItemIndexRows({
      id: 'removed-discount-row',
      analysis_json: JSON.stringify(saved),
    }).reduce((sum, row) => sum + (row.line_total ?? 0), 0);
    expect(indexSum).toBe(2808);
    expect(indexSum + (signal(saved, 'receipt_level_discount') ?? 0)).toBe(2770);
  });

  it('reindexes a later bound discount when an earlier row is removed', () => {
    const snack = line(296, {
      name: '菓子',
      category: 'snacks_drinks',
      effectiveLineTotal: 296,
      review_source_index: 0,
    });
    const second = { ...chickenB, review_source_index: 2 };
    const shifted = persistReviewed(
      recognitionAnalysis([snack, second], {
        tax: 0,
        total: 598,
        discounts: [
          { ...discounts095[0], boundItemIndex: 1 },
          { ...discounts095[1], boundItemIndex: 2 },
        ],
      })
    );
    const names = (shifted.items as { name: string }[]).map((item) => item.name);
    expect(names).toEqual(['菓子', '鶏もも']);
    const shiftedDiscounts = shifted.discounts as {
      ownershipStatus: string;
      boundItemIndex: number | null;
      sourceBoundItemIndex: number | null;
      reviewedMonetaryRole: string;
    }[];
    expect(shiftedDiscounts[0]).toMatchObject({
      ownershipStatus: 'unbound',
      reviewedMonetaryRole: 'unapplied',
      boundItemIndex: null,
      sourceBoundItemIndex: 1,
    });
    expect(shiftedDiscounts[1]).toMatchObject({
      ownershipStatus: 'bound',
      reviewedMonetaryRole: 'applied',
      boundItemIndex: 1,
      sourceBoundItemIndex: 2,
    });
    expect(shiftedDiscounts[1].boundItemIndex).not.toBe(0);
  });

  it('moves both surviving bindings when the row before them is removed', () => {
    const first = { ...chickenA, review_source_index: 1 };
    const second = { ...chickenB, review_source_index: 2 };
    const saved = persistReviewed(
      recognitionAnalysis([first, second], {
        tax: 0,
        total: 674,
        discounts: [
          { ...discounts095[0], boundItemIndex: 1 },
          { ...discounts095[1], boundItemIndex: 2 },
        ],
      })
    );
    const savedDiscounts = saved.discounts as {
      boundItemIndex: number | null;
      sourceBoundItemIndex: number | null;
      ownershipStatus: string;
    }[];
    expect((saved.items as { name: string }[]).map((item) => item.name)).toEqual([
      '鶏むね',
      '鶏もも',
    ]);
    expect(savedDiscounts[0]).toMatchObject({
      ownershipStatus: 'bound',
      boundItemIndex: 0,
      sourceBoundItemIndex: 1,
    });
    expect(savedDiscounts[1]).toMatchObject({
      ownershipStatus: 'bound',
      boundItemIndex: 1,
      sourceBoundItemIndex: 2,
    });
    expect(signal(saved, 'merchandise_amount')).toBe(674);
  });

  it('edits パン to a final paid amount without subtracting -16 again', () => {
    const bread = line(160, {
      name: 'パン',
      category: 'snacks_drinks',
      effectiveLineTotal: 144,
      discountAllocated: -16,
    });
    const other = line(864, {
      name: 'その他',
      category: 'food_ingredients',
      effectiveLineTotal: 864,
    });
    const snapshot = recognitionAnalysis([bread, other], {
      tax: 80,
      total: 1088,
      discounts: [
        {
          label: '割引10%',
          amount: -16,
          ownershipStatus: 'bound',
          boundItemIndex: 0,
          ownershipReason: 'ordinary_adjacent_product_discount',
        },
      ],
    });
    const snapshotJson = JSON.stringify(snapshot);
    const edited = applyUserLineAmountEdit(bread, 200);
    const saved = persistReviewed({
      ...snapshot,
      items: [edited, other],
      total: 200 + 864 + 80,
    });
    expect((saved.items as { lineTotal: number }[])[0].lineTotal).toBe(200);
    expect((saved.reconciliation as { itemsPositiveSum: number; discountsSum: number; diff: number; ok: boolean })).toMatchObject({
      itemsPositiveSum: 1064,
      discountsSum: 0,
      diff: 0,
      ok: true,
    });
    expect(signal(saved, 'merchandise_amount')).toBe(1064);
    expect(engineMerchandise(saved)).toBe(1064);
    expect(categoryAmount(saved, 'snacks_drinks')).toBe(200);
    expect((saved.discounts as { ownershipStatus: string; amount: number }[])[0]).toMatchObject({
      amount: -16,
      ownershipStatus: 'absorbed',
    });
    expect(JSON.stringify(snapshot)).toBe(snapshotJson);
    expect((snapshot.items as { lineTotal: number; effectiveLineTotal: number }[])[0]).toMatchObject({
      lineTotal: 160,
      effectiveLineTotal: 144,
    });
    expect(reviewedAmountWarningVisible(
      evaluateReviewedReceiptSaveEligibility({
        items: saved.items as never,
        discounts: saved.discounts as never,
        tax: 80,
        total: 1144,
      })
    )).toBe(false);
  });
});

describe('review edit types and durable consistency', () => {
  it('quantity-only edits do not change monetary reconciliation', () => {
    const items = CASE_A_AMOUNTS.map((amount) => line(amount));
    const qtyEdited = items.map((item, index) =>
      index === 0 ? { ...item, quantity: 3, quantityUserEdited: true } : item
    );
    const before = persistReviewed(recognitionAnalysis(items, { tax: 210, total: 2846 }));
    const after = persistReviewed(recognitionAnalysis(qtyEdited, { tax: 210, total: 2846 }));
    expect((after.items as { quantity: number }[])[0].quantity).toBe(3);
    expect(after.reconciliation).toEqual(before.reconciliation);
    expect(signal(after, 'merchandise_amount')).toBe(signal(before, 'merchandise_amount'));
  });

  it('removing a line recomputes mismatch from the remaining basket', () => {
    const items = CASE_A_AMOUNTS.slice(0, -1).map((amount) => line(amount));
    const saved = persistReviewed(recognitionAnalysis(items, { tax: 210, total: 2846 }));
    expect((saved.items as unknown[]).length).toBe(9);
    expect((saved.reconciliation as { itemsPositiveSum: number }).itemsPositiveSum).toBe(2242);
    expect(saved.amount_mismatch).toBe(true);
    expect(signal(saved, 'items_count')).toBe(9);
  });

  it('persisted analysis, category totals, and receipt item index agree', () => {
    const recognized = CASE_A_AMOUNTS.map((amount, index) =>
      line(index === 4 ? 168 : amount, { name: `n-${index}` })
    );
    const saved = persistReviewed(
      recognitionAnalysis(recognized, { tax: 210, total: 2846, amount_mismatch: true })
    );
    const analysisJson = JSON.stringify(saved);
    const rows = buildReceiptItemIndexRows({ id: 'r-092', analysis_json: analysisJson });
    const indexSum = rows.reduce((sum, row) => sum + (row.line_total ?? 0), 0);
    expect(indexSum).toBe(2636);
    expect(signal(saved, 'merchandise_amount')).toBe(indexSum);
    expect(engineMerchandise(saved)).toBe(indexSum);
    expect((saved.reconciliation as { itemsPositiveSum: number }).itemsPositiveSum).toBe(indexSum);
    expect(saved.amount_mismatch).toBe(false);
    const parsed = JSON.parse(analysisJson) as { items: { lineTotal: number }[] };
    expect(parsed.items.reduce((sum, item) => sum + item.lineTotal, 0)).toBe(2636);
  });

  it('cloud backup serializes the reviewed analysis and the original snapshot separately', () => {
    const recognized = CASE_A_AMOUNTS.map((amount) => line(amount));
    const snapshot = recognitionAnalysis(recognized, { tax: 210, total: 2846 });
    const reviewedItems = recognized.map((item, index) =>
      index === 4 ? { ...item, lineTotal: 168 } : item
    );
    const saved = persistReviewed({ ...snapshot, items: reviewedItems });
    const payload = buildCloudUserReceiptUpsertPayload({
      id: 'receipt-092',
      user_id: 'user-1',
      created_at: 1,
      transaction_time_precision: 'minute',
      total: 2846,
      tax: 210,
      currency: 'JPY',
      analysis_json: JSON.stringify(saved),
      recognition_snapshot_json: JSON.stringify(snapshot),
    });
    const uploaded = JSON.parse(payload.analysis_json) as {
      amount_mismatch: boolean;
      items: { lineTotal: number }[];
    };
    const evidence = JSON.parse(payload.recognition_snapshot_json ?? '{}') as {
      amount_mismatch: boolean;
      items: { lineTotal: number }[];
    };
    expect(uploaded.items[4].lineTotal).toBe(168);
    expect(uploaded.amount_mismatch).toBe(false);
    expect(evidence.items[4].lineTotal).toBe(108);
    expect(evidence.amount_mismatch).toBe(true);
    expect(payload.analysis_json).toBe(JSON.stringify(saved));
  });
});

function readBack(saved: Record<string, unknown>) {
  const json = JSON.stringify(saved);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const ownership = resolveDiscountOwnership({
    ocrItems: (parsed.items ?? []) as never,
    ocrDiscounts: (parsed.discounts ?? []) as never,
    analysis: parsed,
  });
  const bundle = resolveReceiptMonetarySourceBundle({
    id: 'read-back',
    analysis_json: json,
    total: Number(parsed.total) || 0,
    tax: Number(parsed.tax) || 0,
    user_edited: 0,
    user_items_json: null,
    final_total: null,
  } as never);
  return { parsed, ownership, bundle };
}

describe('reviewed role save/read-back and cloud restore', () => {
  function cloudRestore(saved: Record<string, unknown>, snapshot: Record<string, unknown>) {
    const payload = buildCloudUserReceiptUpsertPayload({
      id: 'cloud-reviewed',
      user_id: 'user-1',
      created_at: 1,
      transaction_time_precision: 'minute',
      total: Number(saved.total) || 0,
      tax: Number(saved.tax) || 0,
      currency: 'JPY',
      analysis_json: JSON.stringify(saved),
      recognition_snapshot_json: JSON.stringify(snapshot),
    });
    const restored = JSON.parse(payload.analysis_json) as Record<string, unknown>;
    const evidence = JSON.parse(payload.recognition_snapshot_json ?? '{}') as Record<string, unknown>;
    return { restored, evidence, read: readBack(restored) };
  }

  it('keeps Receipt096 all-absorbed truth after serialize, read-back, and cloud restore', () => {
    const bread = line(160, {
      name: 'パン',
      category: 'snacks_drinks',
      effectiveLineTotal: 144,
      discountAllocated: -16,
      review_source_index: 0,
    });
    const other = line(864, {
      name: 'その他',
      category: 'food_ingredients',
      effectiveLineTotal: 864,
      review_source_index: 1,
    });
    const snapshot = recognitionAnalysis([bread, other], {
      tax: 80,
      total: 1088,
      discounts: [
        {
          label: '割引10%',
          amount: -16,
          ownershipStatus: 'bound',
          boundItemIndex: 0,
          ownershipReason: 'ordinary_adjacent_product_discount',
        },
      ],
    });
    const snapshotJson = JSON.stringify(snapshot);
    const saved = persistReviewed({
      ...snapshot,
      items: [applyUserLineAmountEdit(bread, 200), other],
      total: 1144,
    });
    expect(signal(saved, 'merchandise_amount')).toBe(1064);
    expect(signal(saved, 'receipt_level_discount')).toBe(0);
    expect((saved.reconciliation as { itemsPositiveSum: number; discountsSum: number; diff: number }).itemsPositiveSum).toBe(1064);
    expect((saved.reconciliation as { discountsSum: number }).discountsSum).toBe(0);
    expect((saved.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('absorbed');

    const read = readBack(saved);
    expect(read.ownership.status).toBe('persisted_resolved');
    expect(read.ownership.status).not.toBe('reallocated_with_evidence');
    expect(read.ownership.genuineReceiptLevelRemainder).toBe(0);
    expect(read.ownership.analyticsItemSum).toBe(1064);
    expect(read.bundle.coherent).toBe(true);
    expect(read.bundle.receiptLevelUnallocatedDiscountTotal).toBe(0);
    expect(read.bundle.analyticsItemSumOverride).toBe(1064);
    expect((read.parsed.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('absorbed');

    const again = persistReviewed(read.parsed);
    expect(signal(again, 'merchandise_amount')).toBe(1064);
    expect(signal(again, 'receipt_level_discount')).toBe(0);
    expect((again.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('absorbed');
    expect(readBack(again).ownership.genuineReceiptLevelRemainder).toBe(0);

    const cloud = cloudRestore(saved, snapshot);
    expect(cloud.read.ownership.genuineReceiptLevelRemainder).toBe(0);
    expect(cloud.read.ownership.analyticsItemSum).toBe(1064);
    expect((cloud.restored.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('absorbed');
    expect(JSON.stringify(cloud.evidence)).toBe(snapshotJson);
  });

  it('keeps Receipt095 mixed absorbed and bound truth after read-back', () => {
    const rows = [chickenA, chickenB, foodRest, ready, snacks].map((item, index) => ({
      ...item,
      review_source_index: index,
    }));
    const snapshot = recognitionAnalysis(rows, {
      tax: 251,
      total: 3393,
      discounts: discounts095,
    });
    const saved = persistReviewed({
      ...snapshot,
      items: rows.map((item, index) =>
        index === 0 ? applyUserLineAmountEdit(item, 400) : item
      ),
      total: 3459,
    });
    expect(signal(saved, 'merchandise_amount')).toBe(3208);
    expect(signal(saved, 'receipt_level_discount')).toBe(0);
    expect(categoryAmount(saved, 'food_ingredients') + categoryAmount(saved, 'ready_to_eat') + categoryAmount(saved, 'snacks_drinks')).toBe(3208);
    const roles = (saved.discounts as { reviewedMonetaryRole: string; ownershipStatus: string }[]).map(
      (discount) => discount.reviewedMonetaryRole
    );
    expect(roles).toEqual(['absorbed', 'applied']);
    const read = readBack(saved);
    expect(read.ownership.status).toBe('persisted_resolved');
    expect(read.ownership.genuineReceiptLevelRemainder).toBe(0);
    expect(read.ownership.analyticsItemSum).toBe(3208);
    expect(read.bundle.receiptLevelUnallocatedDiscountTotal).toBe(0);
    const restoredRoles = (read.parsed.discounts as { reviewedMonetaryRole: string }[]).map(
      (discount) => discount.reviewedMonetaryRole
    );
    expect(restoredRoles).toEqual(['absorbed', 'applied']);
    const cloud = cloudRestore(saved, snapshot);
    expect((cloud.restored.discounts as { reviewedMonetaryRole: string }[]).map((d) => d.reviewedMonetaryRole)).toEqual([
      'absorbed',
      'applied',
    ]);
    expect(cloud.read.ownership.analyticsItemSum).toBe(3208);
    expect(cloud.read.ownership.genuineReceiptLevelRemainder).toBe(0);
    expect((cloud.evidence.discounts as { ownershipStatus: string }[])[0].ownershipStatus).toBe('bound');
  });

  it('reads an unbound deleted-host discount once and restores that role from cloud', () => {
    const rows = [chickenA, chickenB, foodRest, ready, snacks].map((item, index) => ({
      ...item,
      review_source_index: index,
    }));
    const saved = persistReviewed(
      recognitionAnalysis(rows.filter((_, index) => index !== 0), {
        tax: 251,
        total: 3393,
        discounts: discounts095,
      })
    );
    expect(signal(saved, 'merchandise_amount')).toBe(2808);
    expect(signal(saved, 'receipt_level_discount')).toBe(-38);
    expect((saved.reconciliation as { itemsPositiveSum: number }).itemsPositiveSum + (saved.reconciliation as { discountsSum: number }).discountsSum).toBe(2770);
    const read = readBack(saved);
    expect(read.ownership.analyticsItemSum).toBe(2808);
    expect(read.ownership.genuineReceiptLevelRemainder).toBe(-38);
    expect(read.ownership.analyticsItemSum + read.ownership.genuineReceiptLevelRemainder).toBe(2770);
    expect(read.bundle.analyticsItemSumOverride).toBe(2808);
    expect(read.bundle.receiptLevelUnallocatedDiscountTotal).toBe(-38);
    expect((read.parsed.discounts as { reviewedMonetaryRole: string; boundItemIndex: number | null }[])[0]).toMatchObject({
      reviewedMonetaryRole: 'unapplied',
      boundItemIndex: null,
    });
    const cloud = cloudRestore(saved, recognitionAnalysis(rows, { tax: 251, total: 3393, discounts: discounts095 }));
    expect(cloud.read.ownership.genuineReceiptLevelRemainder).toBe(-38);
    expect(cloud.read.ownership.analyticsItemSum).toBe(2808);
    expect((cloud.restored.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('unapplied');
  });

  it('turns an absorbed discount into one unbound discount after its host is removed', () => {
    const bread = line(160, {
      name: 'パン',
      category: 'snacks_drinks',
      effectiveLineTotal: 144,
      discountAllocated: -16,
      review_source_index: 0,
    });
    const other = line(864, {
      name: 'その他',
      category: 'food_ingredients',
      effectiveLineTotal: 864,
      review_source_index: 1,
    });
    const absorbed = persistReviewed(
      recognitionAnalysis([applyUserLineAmountEdit(bread, 200), other], {
        tax: 80,
        total: 1144,
        discounts: [
          {
            label: '割引10%',
            amount: -16,
            ownershipStatus: 'bound' as const,
            boundItemIndex: 0,
            ownershipReason: 'ordinary_adjacent_product_discount',
          },
        ],
      })
    );
    expect((absorbed.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('absorbed');
    const withoutHost = persistReviewed({
      ...absorbed,
      items: [other],
      total: 864,
      tax: 0,
    });
    const discount = (withoutHost.discounts as {
      reviewedMonetaryRole: string;
      ownershipStatus: string;
      boundItemIndex: number | null;
      amount: number;
    }[])[0];
    expect(discount).toMatchObject({
      reviewedMonetaryRole: 'unapplied',
      ownershipStatus: 'unbound',
      boundItemIndex: null,
      amount: -16,
    });
    expect((withoutHost.items as { name: string }[]).map((item) => item.name)).toEqual(['その他']);
    expect(signal(withoutHost, 'merchandise_amount')).toBe(864);
    expect(signal(withoutHost, 'receipt_level_discount')).toBe(-16);
    expect((withoutHost.reconciliation as { itemsPositiveSum: number; discountsSum: number }).itemsPositiveSum).toBe(864);
    expect((withoutHost.reconciliation as { discountsSum: number }).discountsSum).toBe(-16);
    const read = readBack(withoutHost);
    expect(read.ownership.analyticsItemSum).toBe(864);
    expect(read.ownership.genuineReceiptLevelRemainder).toBe(-16);
    expect(read.ownership.analyticsItemSum + read.ownership.genuineReceiptLevelRemainder).toBe(848);
  });

  it('leaves a legacy discount without reviewed metadata on the old resolver', () => {
    const legacy = recognitionAnalysis(
      [
        line(372, {
          name: '鶏むね',
          category: 'food_ingredients',
          effectiveLineTotal: 334,
          discountAllocated: -38,
        }),
      ],
      {
        tax: 0,
        total: 334,
        discounts: [
          {
            label: '割引10%',
            amount: -38,
            ownershipStatus: 'bound',
            boundItemIndex: 0,
            ownershipReason: 'ordinary_adjacent_product_discount',
          },
        ],
      }
    );
    const ownership = resolveDiscountOwnership({
      ocrItems: legacy.items as never,
      ocrDiscounts: legacy.discounts as never,
      analysis: legacy,
    });
    expect(ownership.status).toBe('persisted_resolved');
    expect(ownership.genuineReceiptLevelRemainder).toBe(0);
    expect(ownership.evidence.join(' ')).not.toContain('reviewed_role_authoritative');
    expect(ownership.analyticsItemSum).toBe(334);
    expect(Number.isNaN(ownership.analyticsItemSum)).toBe(false);
  });
});

describe('malformed reviewed monetary roles', () => {
  function item100(extra: Record<string, unknown> = {}) {
    return line(100, {
      name: '品',
      effectiveLineTotal: 100,
      discountAllocated: 0,
      review_source_index: 0,
      ...extra,
    });
  }

  function appliedDiscount(amount: number, extra: Record<string, unknown> = {}) {
    return {
      label: '値引',
      amount,
      reviewedMonetaryRole: 'applied' as const,
      ownershipStatus: 'bound' as const,
      boundItemIndex: 0,
      sourceBoundItemIndex: 0,
      ownershipReason: 'ordinary_adjacent_product_discount',
      ...extra,
    };
  }

  function readOwnership(analysis: Record<string, unknown>) {
    return resolveDiscountOwnership({
      ocrItems: (analysis.items ?? []) as never,
      ocrDiscounts: (analysis.discounts ?? []) as never,
      analysis,
    });
  }

  function expectCountedOnce(
    analysis: Record<string, unknown>,
    itemMerchandise: number,
    receiptLevel: number
  ) {
    const ownership = readOwnership(analysis);
    expect(ownership.status).not.toBe('reallocated_with_evidence');
    expect(ownership.analyticsItemSum).toBe(itemMerchandise);
    expect(ownership.genuineReceiptLevelRemainder).toBe(receiptLevel);
    expect(ownership.analyticsItemSum + ownership.genuineReceiptLevelRemainder).toBe(
      itemMerchandise + receiptLevel
    );
    expect(Number.isNaN(ownership.analyticsItemSum)).toBe(false);
    expect(Number.isNaN(ownership.genuineReceiptLevelRemainder)).toBe(false);
    expect(ownership.evidence.join(' ')).not.toContain('reallocated_with_evidence');
  }

  it('rejects applied metadata when the host allocation is zero', () => {
    const analysis = recognitionAnalysis([item100()], {
      tax: 0,
      total: 100,
      discounts: [appliedDiscount(-10)],
    });
    const ownership = readOwnership(analysis);
    expect(ownership.evidence.join(' ')).toContain('reviewed_role_set=contradictory');
    expect(ownership.reasonCodes).toContain('invalid_reviewed_monetary_role');
    expectCountedOnce(analysis, 100, -10);
    const gate = evaluateReviewedReceiptSaveEligibility({
      items: analysis.items as never,
      discounts: analysis.discounts as never,
      tax: 0,
      total: 100,
    });
    expect(gate.allowed).toBe(true);
    expect(reviewedAmountWarningVisible(gate)).toBe(true);
    const saved = persistReviewed(analysis);
    expect(signal(saved, 'merchandise_amount')).toBe(100);
    expect(signal(saved, 'receipt_level_discount')).toBe(-10);
    expect((saved.reconciliation as { itemsPositiveSum: number; discountsSum: number; diff: number }).itemsPositiveSum).toBe(100);
    expect((saved.reconciliation as { discountsSum: number }).discountsSum).toBe(-10);
    expect(saved.amount_mismatch).toBe(true);
    expect((saved.discounts as { reviewedMonetaryRole: string; boundItemIndex: number | null }[])[0]).toMatchObject({
      reviewedMonetaryRole: 'unapplied',
      boundItemIndex: null,
      amount: -10,
    });
  });

  it('keeps a discount when the effective equation does not prove applied', () => {
    const analysis = recognitionAnalysis(
      [item100({ discountAllocated: -5 })],
      { tax: 0, total: 100, discounts: [appliedDiscount(-10)] }
    );
    expectCountedOnce(analysis, 100, -10);
    const saved = persistReviewed(analysis);
    expect(signal(saved, 'merchandise_amount')! + signal(saved, 'receipt_level_discount')!).toBe(90);
    expect(signal(saved, 'receipt_level_discount')).toBe(-10);
  });

  it('reconciles two applied discounts to the host allocation as one residual', () => {
    const host = line(100, {
      effectiveLineTotal: 80,
      discountAllocated: -20,
      review_source_index: 0,
    });
    const analysis = recognitionAnalysis([host], {
      tax: 0,
      total: 80,
      discounts: [appliedDiscount(-20), appliedDiscount(-18, { label: '値引B' })],
    });
    expectCountedOnce(analysis, 80, -18);
    const saved = persistReviewed(analysis);
    const roles = (saved.discounts as { reviewedMonetaryRole: string; amount: number }[]).map(
      (discount) => `${discount.reviewedMonetaryRole}:${discount.amount}`
    );
    expect(roles).toEqual(['applied:-20', 'unapplied:-18']);
    expect(signal(saved, 'merchandise_amount')).toBe(80);
    expect(signal(saved, 'receipt_level_discount')).toBe(-18);
    expect((saved.reconciliation as { itemsPositiveSum: number; discountsSum: number }).itemsPositiveSum).toBe(80);
    expect((saved.reconciliation as { discountsSum: number }).discountsSum).toBe(-18);
  });

  it('counts an applied discount once when its host is gone', () => {
    const analysis = recognitionAnalysis(
      [line(100, { effectiveLineTotal: 100, review_source_index: 1 })],
      { tax: 0, total: 100, discounts: [appliedDiscount(-10)] }
    );
    expectCountedOnce(analysis, 100, -10);
  });

  it('counts an absorbed discount once when its host is gone', () => {
    const analysis = recognitionAnalysis(
      [line(100, { effectiveLineTotal: 100, review_source_index: 1 })],
      {
        tax: 0,
        total: 100,
        discounts: [
          {
            ...appliedDiscount(-10),
            reviewedMonetaryRole: 'absorbed',
            ownershipStatus: 'absorbed',
            boundItemIndex: null,
          },
        ],
      }
    );
    expectCountedOnce(analysis, 100, -10);
    const saved = persistReviewed(analysis);
    expect((saved.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('unapplied');
    expect(signal(saved, 'receipt_level_discount')).toBe(-10);
  });

  it('does not trust absorbed metadata without final-paid evidence', () => {
    const analysis = recognitionAnalysis([item100()], {
      tax: 0,
      total: 100,
      discounts: [
        {
          ...appliedDiscount(-10),
          reviewedMonetaryRole: 'absorbed',
          ownershipStatus: 'absorbed',
          boundItemIndex: null,
        },
      ],
    });
    expectCountedOnce(analysis, 100, -10);
    const saved = persistReviewed(analysis);
    expect((saved.discounts as { reviewedMonetaryRole: string; boundItemIndex: number | null }[])[0]).toMatchObject({
      reviewedMonetaryRole: 'unapplied',
      boundItemIndex: null,
    });
    expect((saved.items as { name: string }[])[0].name).toBe('品');
  });

  it('keeps an unapplied role ahead of a stale bound index', () => {
    const analysis = recognitionAnalysis([item100()], {
      tax: 0,
      total: 90,
      discounts: [
        {
          ...appliedDiscount(-10),
          reviewedMonetaryRole: 'unapplied',
          ownershipStatus: 'bound',
        },
      ],
    });
    const ownership = readOwnership(analysis);
    expect(ownership.evidence.join(' ')).toContain('reviewed_role_set=valid');
    expect(ownership.genuineReceiptLevelRemainder).toBe(-10);
    const saved = persistReviewed(analysis);
    const again = persistReviewed(saved);
    for (const projected of [saved, again]) {
      expect((projected.discounts as { reviewedMonetaryRole: string; boundItemIndex: number | null; ownershipStatus: string }[])[0]).toMatchObject({
        reviewedMonetaryRole: 'unapplied',
        ownershipStatus: 'unbound',
        boundItemIndex: null,
      });
      expect(signal(projected, 'receipt_level_discount')).toBe(-10);
      expect(signal(projected, 'merchandise_amount')).toBe(100);
    }
  });

  it('does not drop a role-less discount beside a reviewed discount', () => {
    const priced = line(372, {
      name: '鶏',
      effectiveLineTotal: 334,
      discountAllocated: -38,
      review_source_index: 0,
    });
    const plain = item100({ review_source_index: 1 });
    const analysis = recognitionAnalysis([priced, plain], {
      tax: 0,
      total: 434,
      discounts: [
        appliedDiscount(-38),
        { label: '値引', amount: -10 },
      ],
    });
    const ownership = readOwnership(analysis);
    expect(ownership.evidence.join(' ')).toContain('reviewed_role_set=partial');
    expect(ownership.status).not.toBe('reallocated_with_evidence');
    expectCountedOnce(analysis, 434, -10);
  });

  it('keeps a malformed absorbed discount beside a valid applied discount', () => {
    const plain = item100();
    const priced = line(372, {
      name: '鶏',
      effectiveLineTotal: 334,
      discountAllocated: -38,
      review_source_index: 1,
    });
    const analysis = recognitionAnalysis([plain, priced], {
      tax: 0,
      total: 434,
      discounts: [
        {
          ...appliedDiscount(-10),
          reviewedMonetaryRole: 'absorbed',
          ownershipStatus: 'absorbed',
          boundItemIndex: null,
        },
        {
          ...appliedDiscount(-38),
          boundItemIndex: 1,
          sourceBoundItemIndex: 1,
        },
      ],
    });
    const ownership = readOwnership(analysis);
    expect(ownership.reasonCodes).toContain('invalid_reviewed_monetary_role');
    expect(ownership.evidence.join(' ')).toContain('reviewed_role_set=contradictory');
    expect(ownership.status).not.toBe('reallocated_with_evidence');
    expectCountedOnce(analysis, 434, -10);
  });

  it('ignores a non-finite amount without dropping the finite discount', () => {
    const analysis = recognitionAnalysis([item100()], {
      tax: 0,
      total: 90,
      discounts: [
        { ...appliedDiscount(Number.NaN), label: '壊れた値引' },
        {
          label: '値引',
          amount: -10,
          reviewedMonetaryRole: 'unapplied' as const,
          ownershipStatus: 'unbound' as const,
          boundItemIndex: null,
        },
      ],
    });
    const ownership = readOwnership(analysis);
    expect(Number.isNaN(ownership.genuineReceiptLevelRemainder)).toBe(false);
    expect(ownership.genuineReceiptLevelRemainder).toBe(-10);
    expect(ownership.analyticsItemSum).toBe(100);
    const saved = persistReviewed(analysis);
    expect(signal(saved, 'receipt_level_discount')).toBe(-10);
    expect((saved.discounts as { amount: number }[]).map((discount) => discount.amount)).toEqual([-10]);
  });

  it('repairs malformed applied state across project, read, and project again', () => {
    const analysis = recognitionAnalysis([item100()], {
      tax: 0,
      total: 100,
      discounts: [appliedDiscount(-10)],
    });
    const saved = persistReviewed(analysis);
    const read = readOwnership(saved);
    expect(read.genuineReceiptLevelRemainder).toBe(-10);
    expect(read.analyticsItemSum).toBe(100);
    expect(read.status).toBe('persisted_resolved');
    const again = persistReviewed(saved);
    expect(signal(again, 'merchandise_amount')).toBe(100);
    expect(signal(again, 'receipt_level_discount')).toBe(-10);
    expect((again.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('unapplied');
    expect((again.reconciliation as { discountsSum: number }).discountsSum).toBe(-10);
    expect(again.amount_mismatch).toBe(true);
  });
});

describe('explicit unapplied and strict reviewed metadata', () => {
  function finalPaidHost() {
    return line(100, {
      name: '品',
      effectiveLineTotal: 100,
      discountAllocated: 0,
      amountUserEdited: true,
      review_source_index: 0,
    });
  }

  function explicitUnapplied() {
    return {
      label: '値引',
      amount: -10,
      reviewedMonetaryRole: 'unapplied' as const,
      ownershipStatus: 'unbound' as const,
      boundItemIndex: null,
      sourceBoundItemIndex: 0,
    };
  }

  function analysisFor(items: Record<string, unknown>[], discounts: Record<string, unknown>[], total: number) {
    return recognitionAnalysis(items, { tax: 0, total, discounts });
  }

  it('keeps explicit unapplied at receipt level when the source host is final-paid', () => {
    const analysis = analysisFor([finalPaidHost()], [explicitUnapplied()], 90);
    const assessed = assessReviewedDiscountRoleSet(
      analysis.items as never,
      analysis.discounts as never
    );
    expect(assessed.kind).toBe('valid_reviewed');
    expect(assessed.receiptLevelDiscount).toBe(-10);
    const ownership = resolveDiscountOwnership({
      ocrItems: analysis.items as never,
      ocrDiscounts: analysis.discounts as never,
      analysis,
    });
    expect(ownership.analyticsItemSum).toBe(100);
    expect(ownership.genuineReceiptLevelRemainder).toBe(-10);
    expect(ownership.analyticsItemSum + ownership.genuineReceiptLevelRemainder).toBe(90);
    const saved = persistReviewed(analysis);
    const read = readBack(saved);
    const again = persistReviewed(read.parsed);
    for (const projected of [saved, again]) {
      expect(signal(projected, 'merchandise_amount')).toBe(100);
      expect(signal(projected, 'receipt_level_discount')).toBe(-10);
      expect((projected.reconciliation as { itemsPositiveSum: number; discountsSum: number }).itemsPositiveSum).toBe(100);
      expect((projected.reconciliation as { discountsSum: number }).discountsSum).toBe(-10);
      expect(projected.amount_mismatch).toBe(false);
      expect((projected.discounts as { reviewedMonetaryRole: string; boundItemIndex: number | null; sourceBoundItemIndex: number | null; ownershipStatus: string }[])[0]).toMatchObject({
        reviewedMonetaryRole: 'unapplied',
        ownershipStatus: 'unbound',
        boundItemIndex: null,
        sourceBoundItemIndex: 0,
        amount: -10,
      });
    }
    expect(read.ownership.genuineReceiptLevelRemainder).toBe(-10);
    expect(read.ownership.analyticsItemSum).toBe(100);
    expect(read.bundle.receiptLevelUnallocatedDiscountTotal).toBe(-10);
    expect(read.bundle.analyticsItemSumOverride).toBe(100);

    const itemTruth = resolveCurrentAnalysisItemMonetaryTruth(JSON.stringify(saved));
    expect(itemTruth.items[0]?.lineTotal ?? (itemTruth.items[0] as { line_total?: number }).line_total).toBe(100);
    expect(Number((itemTruth.items[0] as { discountAllocated?: number }).discountAllocated) || 0).toBe(0);

    const closure = assessSameLayerMonetaryClosure(
      {
        id: 'unapplied-final-paid',
        analysis_json: JSON.stringify(saved),
        total: 90,
        tax: 0,
        user_edited: 0,
        user_items_json: null,
        final_total: null,
      } as never,
      read.bundle,
      { reconciliationOk: true, amountMismatch: false }
    );
    expect(closure.evidence.join(' ')).toContain('remainder=-10');
    expect(closure.evidence.join(' ')).not.toContain('remainder=0');

    const cloud = buildCloudUserReceiptUpsertPayload({
      id: 'cloud-unapplied',
      user_id: 'user-1',
      created_at: 1,
      transaction_time_precision: 'minute',
      total: 90,
      tax: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify(saved),
      recognition_snapshot_json: JSON.stringify(analysis),
    });
    const restored = JSON.parse(cloud.analysis_json) as Record<string, unknown>;
    const restoredRead = readBack(restored);
    expect(signal(restored, 'merchandise_amount')).toBe(100);
    expect(signal(restored, 'receipt_level_discount')).toBe(-10);
    expect(restoredRead.ownership.analyticsItemSum + restoredRead.ownership.genuineReceiptLevelRemainder).toBe(90);
    expect((restored.discounts as { sourceBoundItemIndex: number | null }[])[0].sourceBoundItemIndex).toBe(0);
  });

  it('rejects a positive reviewed amount as authoritative applied metadata', () => {
    const host = line(100, {
      effectiveLineTotal: 100,
      discountAllocated: 0,
      review_source_index: 0,
    });
    const analysis = analysisFor(
      [host],
      [
        {
          label: '値引',
          amount: 10,
          reviewedMonetaryRole: 'applied',
          ownershipStatus: 'bound',
          boundItemIndex: 0,
          sourceBoundItemIndex: 0,
        },
      ],
      100
    );
    const assessed = assessReviewedDiscountRoleSet(analysis.items as never, analysis.discounts as never);
    expect(assessed.kind).toBe('invalid_reviewed');
    expect(assessed.receiptLevelDiscount).toBe(-10);
    const saved = persistReviewed(analysis);
    expect((saved.discounts as { reviewedMonetaryRole: string; amount: number }[])[0].reviewedMonetaryRole).not.toBe('applied');
    expect(signal(saved, 'merchandise_amount')! + signal(saved, 'receipt_level_discount')!).toBe(90);
  });

  it('does not treat a positive applied amount as valid when allocation already matches', () => {
    const host = line(110, {
      effectiveLineTotal: 100,
      discountAllocated: -10,
      review_source_index: 0,
    });
    const analysis = analysisFor(
      [host],
      [
        {
          label: '値引',
          amount: 10,
          reviewedMonetaryRole: 'applied',
          ownershipStatus: 'bound',
          boundItemIndex: 0,
          sourceBoundItemIndex: 0,
        },
      ],
      100
    );
    const assessed = assessReviewedDiscountRoleSet(analysis.items as never, analysis.discounts as never);
    expect(assessed.kind).toBe('invalid_reviewed');
    expect(assessed.receiptLevelDiscount).toBe(0);
    const ownership = resolveDiscountOwnership({
      ocrItems: analysis.items as never,
      ocrDiscounts: analysis.discounts as never,
      analysis,
    });
    expect(ownership.analyticsItemSum).toBe(100);
    expect(ownership.genuineReceiptLevelRemainder).toBe(0);
    expect(ownership.evidence.join(' ')).not.toContain('reviewed_role_set=valid');
  });

  it('rejects absorbed metadata while a final-paid host still carries an allocation', () => {
    const host = line(100, {
      effectiveLineTotal: 100,
      discountAllocated: -10,
      amountUserEdited: true,
      review_source_index: 0,
    });
    const analysis = analysisFor(
      [host],
      [
        {
          label: '値引',
          amount: -10,
          reviewedMonetaryRole: 'absorbed',
          ownershipStatus: 'absorbed',
          boundItemIndex: null,
          sourceBoundItemIndex: 0,
        },
      ],
      100
    );
    const assessed = assessReviewedDiscountRoleSet(analysis.items as never, analysis.discounts as never);
    expect(assessed.kind).toBe('invalid_reviewed');
    expect(assessed.receiptLevelDiscount).toBe(0);
    const ownership = resolveDiscountOwnership({
      ocrItems: analysis.items as never,
      ocrDiscounts: analysis.discounts as never,
      analysis,
    });
    expect(ownership.analyticsItemSum + ownership.genuineReceiptLevelRemainder).toBe(100);
    const saved = persistReviewed(analysis);
    expect((saved.items as { discountAllocated?: number }[])[0].discountAllocated).toBe(0);
    expect((saved.discounts as { reviewedMonetaryRole: string }[])[0].reviewedMonetaryRole).toBe('absorbed');
    expect(signal(saved, 'merchandise_amount')).toBe(100);
    expect(signal(saved, 'receipt_level_discount')).toBe(0);
    const reread = assessReviewedDiscountRoleSet(saved.items as never, saved.discounts as never);
    expect(reread.kind).toBe('valid_reviewed');
    expect(reread.receiptLevelDiscount).toBe(0);
  });

  it('keeps explicit unapplied inside a partial reviewed-role set', () => {
    const analysis = analysisFor(
      [finalPaidHost()],
      [
        explicitUnapplied(),
        { label: '別値引', amount: -4 },
      ],
      86
    );
    const assessed = assessReviewedDiscountRoleSet(analysis.items as never, analysis.discounts as never);
    expect(assessed.kind).toBe('invalid_reviewed');
    expect(assessed.evidence).toBe('reviewed_role_set=partial');
    expect(assessed.receiptLevelDiscount).toBe(-14);
    const ownership = resolveDiscountOwnership({
      ocrItems: analysis.items as never,
      ocrDiscounts: analysis.discounts as never,
      analysis,
    });
    expect(ownership.status).not.toBe('reallocated_with_evidence');
    expect(ownership.analyticsItemSum).toBe(100);
    expect(ownership.genuineReceiptLevelRemainder).toBe(-14);
  });
});

describe('raw reviewed discount sign survives adapter read-back', () => {
  function plusTenApplied(allocation: number, effective: number, gross: number) {
    return {
      merchant: 'Test',
      currency: 'JPY',
      tax: 0,
      tax_is_known: true,
      total: 100,
      items: [
        {
          name: '品',
          quantity: 1,
          lineTotal: gross,
          effectiveLineTotal: effective,
          discountAllocated: allocation,
          review_source_index: 0,
        },
      ],
      discounts: [
        {
          label: '値引',
          amount: 10,
          reviewedMonetaryRole: 'applied',
          ownershipStatus: 'bound',
          boundItemIndex: 0,
          sourceBoundItemIndex: 0,
        },
      ],
    };
  }

  function receiptFor(analysis: Record<string, unknown>) {
    return {
      id: 'plus-ten',
      analysis_json: JSON.stringify(analysis),
      total: Number(analysis.total) || 0,
      tax: 0,
      user_edited: 0,
      user_items_json: null,
      final_total: null,
      currency: 'JPY',
    } as never;
  }

  it('keeps +10 applied invalid through current item monetary truth', () => {
    const analysis = plusTenApplied(-10, 100, 110);
    const truth = resolveCurrentAnalysisItemMonetaryTruth(JSON.stringify(analysis));
    expect(truth.reasonCodes).toContain('invalid_reviewed_monetary_role');
    expect(truth.ownershipStatus).not.toBe('reallocated_with_evidence');
    expect(truth.recovered).toBe(false);
    expect(Number.isNaN(Number(truth.items[0]?.effectiveLineTotal))).toBe(false);
    expect(truth.items[0]?.effectiveLineTotal).toBe(100);
  });

  it('does not report a valid reviewed role when the bundle sees persisted +10', () => {
    const analysis = plusTenApplied(-10, 100, 110);
    const bundle = resolveReceiptMonetarySourceBundle(receiptFor(analysis));
    expect(bundle.ocrDiscounts[0]?.amount).toBe(10);
    expect(bundle.evidence.join(' ')).toContain('reviewed_role_set=contradictory');
    expect(bundle.evidence.join(' ')).toContain('reviewed_role_invalid');
    expect(bundle.evidence.join(' ')).not.toContain('reviewed_role_set=valid');
    expect(bundle.analyticsItemSumOverride).toBe(100);
    expect(bundle.receiptLevelUnallocatedDiscountTotal).toBe(0);
    expect(Number.isNaN(bundle.receiptLevelUnallocatedDiscountTotal)).toBe(false);
  });

  it('closes the +10 reviewed discount on the invalid conservative path', () => {
    const analysis = plusTenApplied(-10, 100, 110);
    const bundle = resolveReceiptMonetarySourceBundle(receiptFor(analysis));
    const closure = assessSameLayerMonetaryClosure(receiptFor(analysis), bundle, {
      reconciliationOk: true,
      amountMismatch: false,
    });
    expect(bundle.ocrDiscounts[0]?.amount).toBe(10);
    expect(bundle.evidence.join(' ')).not.toContain('reviewed_role_set=valid');
    expect(closure.evidence.join(' ')).toContain('remainder=0');
    expect(closure.evidence.join(' ')).not.toContain('NaN');
    expect(closure.reasonCodes.join(' ')).not.toContain('reviewed_role_set=valid');
  });

  it('preserves a positive reviewed discount once when the host allocation does not contain it', () => {
    const analysis = plusTenApplied(0, 100, 100);
    const bundle = resolveReceiptMonetarySourceBundle(receiptFor(analysis));
    expect(bundle.ocrDiscounts[0]?.amount).toBe(10);
    expect(bundle.evidence.join(' ')).toContain('reviewed_role_set=contradictory');
    expect(bundle.analyticsItemSumOverride).toBe(100);
    expect(bundle.receiptLevelUnallocatedDiscountTotal).toBe(-10);
    expect(bundle.analyticsItemSumOverride! + bundle.receiptLevelUnallocatedDiscountTotal).toBe(90);
  });

  it('keeps cloud-restored +10 applied classified invalid', () => {
    const analysis = plusTenApplied(-10, 100, 110);
    const payload = buildCloudUserReceiptUpsertPayload({
      id: 'cloud-plus-ten',
      user_id: 'user-1',
      created_at: 1,
      transaction_time_precision: 'minute',
      total: 100,
      tax: 0,
      currency: 'JPY',
      analysis_json: JSON.stringify(analysis),
      recognition_snapshot_json: JSON.stringify({ items: [{ lineTotal: 110 }] }),
    });
    const restored = JSON.parse(payload.analysis_json) as { discounts: { amount: number }[] };
    expect(restored.discounts[0].amount).toBe(10);
    const bundle = resolveReceiptMonetarySourceBundle({
      id: 'cloud-plus-ten',
      analysis_json: payload.analysis_json,
      total: 100,
      tax: 0,
      user_edited: 0,
      user_items_json: null,
      final_total: null,
      currency: 'JPY',
    } as never);
    expect(bundle.ocrDiscounts[0]?.amount).toBe(10);
    expect(bundle.evidence.join(' ')).toContain('reviewed_role_set=contradictory');
    expect(bundle.evidence.join(' ')).not.toContain('reviewed_role_set=valid');
    expect(bundle.analyticsItemSumOverride! + bundle.receiptLevelUnallocatedDiscountTotal).toBe(100);
  });

  it('still normalizes a role-less positive discount on the legacy path', () => {
    const legacy = (amount: number) =>
      resolveReceiptMonetarySourceBundle(
        receiptFor({
          merchant: 'Test',
          currency: 'JPY',
          tax: 0,
          total: 90,
          items: [{ name: '品', quantity: 1, lineTotal: 100 }],
          discounts: [{ label: '値引', amount }],
        })
      );
    const positive = legacy(10);
    const negative = legacy(-10);
    expect(positive.ocrDiscounts[0]?.amount).toBe(-10);
    expect(negative.ocrDiscounts[0]?.amount).toBe(-10);
    expect(positive.discountOwnershipStatus).toBe(negative.discountOwnershipStatus);
    expect(positive.receiptLevelUnallocatedDiscountTotal).toBe(
      negative.receiptLevelUnallocatedDiscountTotal
    );
    expect(positive.evidence.join(' ')).not.toContain('invalid_reviewed');
    expect(Number.isNaN(positive.receiptLevelUnallocatedDiscountTotal)).toBe(false);
  });
});
