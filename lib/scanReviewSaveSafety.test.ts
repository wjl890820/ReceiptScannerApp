/**
 * Receipt080 Round 2 — Scan Review save eligibility (A1).
 * Exercises the real evaluateScanReviewSaveEligibility / reconcile contract.
 */

import * as fs from 'fs';
import * as path from 'path';

import { reconcileReceiptTotals } from './receiptOcrNormalize';
import {
  evaluateScanReviewSaveEligibility,
  isUnexplainedPositiveMerchandiseOverage,
  sumPositiveMerchandiseLineTotals,
  sumReceiptDiscountAmounts,
  UNEXPLAINED_POSITIVE_OVERAGE_REASON,
} from './scanReviewSaveSafety';

const MERCH_9534 = [418, 698, 428, 899, 488, 298, 998, 698, 777, 3484, 348];

describe('scanReviewSaveSafety — Receipt080 A1', () => {
  it('S1: positive unexplained overage → cannot save', () => {
    const itemsPositiveSum = 9534 + 1;
    const discountsSum = 0;
    const total = 9534;
    expect(
      isUnexplainedPositiveMerchandiseOverage({
        itemsPositiveSum,
        discountsSum,
        total,
      })
    ).toBe(true);
    const gate = evaluateScanReviewSaveEligibility({
      itemsPositiveSum,
      discountsSum,
      tax: 708,
      total,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(UNEXPLAINED_POSITIVE_OVERAGE_REASON);
    expect(gate.reconciliationOk).toBe(false);
    const recon = reconcileReceiptTotals(itemsPositiveSum, discountsSum, 708, total);
    expect(recon.ok).toBe(false);
    expect(recon.warnings.some((w) => w.includes(UNEXPLAINED_POSITIVE_OVERAGE_REASON))).toBe(
      true
    );
  });

  it('S2: corrected receipt (phantom removed) → can save', () => {
    const itemsPositiveSum = 9534;
    const gate = evaluateScanReviewSaveEligibility({
      itemsPositiveSum,
      discountsSum: 0,
      tax: 708,
      total: 9534,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
    expect(gate.reconciliationOk).toBe(true);
  });

  it('S3: explained discount overage → can save', () => {
    // items 9535 + discount -1 = 9534 total
    const gate = evaluateScanReviewSaveEligibility({
      itemsPositiveSum: 9535,
      discountsSum: -1,
      tax: 708,
      total: 9534,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
    expect(gate.reconciliationOk).toBe(true);
  });

  it('S4: legitimate negative rounding/tolerance (±2 under total) → unchanged / allowed', () => {
    // merchandise under total by 1 — within tolerance, not overage
    const gate = evaluateScanReviewSaveEligibility({
      itemsPositiveSum: 9533,
      discountsSum: 0,
      tax: 708,
      total: 9534,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
    const recon = reconcileReceiptTotals(9533, 0, 708, 9534);
    expect(recon.ok).toBe(true);
  });

  it('S5: Receipt074 coupon shape remains save-eligible', () => {
    // 6292 total; merchandise includes negative coupon line handled as discount net
    const items = [
      998, 1280, 648, 1198, 890, 680, 758,
    ];
    const itemsPositiveSum = items.reduce((a, b) => a + b, 0); // 6452
    const discountsSum = -160;
    const gate = evaluateScanReviewSaveEligibility({
      itemsPositiveSum,
      discountsSum,
      tax: 466,
      total: 6292,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
    // 6452 - 160 = 6292
    expect(itemsPositiveSum + discountsSum).toBe(6292);
  });

  it('S6: Receipt078 mixed-tax / balanced totals remain save-eligible', () => {
    // Balanced basket: no unexplained overage
    const gate = evaluateScanReviewSaveEligibility({
      itemsPositiveSum: 2100,
      discountsSum: 0,
      tax: 160,
      total: 2260,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
  });

  it('helpers: sumPositiveMerchandiseLineTotals / sumReceiptDiscountAmounts', () => {
    const items = [
      ...MERCH_9534.map((lineTotal) => ({ lineTotal })),
      { lineTotal: 1 },
      { lineTotal: -50 },
    ];
    expect(sumPositiveMerchandiseLineTotals(items)).toBe(9535);
    expect(sumReceiptDiscountAmounts([{ amount: -160 }, { amount: 40 }])).toBe(-200);
  });

  it('Review screen wires save eligibility gate (no persistence on block)', () => {
    const reviewSrc = fs.readFileSync(
      path.join(__dirname, '../app/scan-review/[draftId].tsx'),
      'utf8'
    );
    expect(reviewSrc).toContain('evaluateScanReviewSaveEligibility');
    expect(reviewSrc).toContain('saveBlocked={saveBlockedByOverage}');
    expect(reviewSrc).toContain('if (!saveGate.allowed)');
    // Block happens before saveReceipt
    const gateIdx = reviewSrc.indexOf('if (!saveGate.allowed)');
    const saveIdx = reviewSrc.indexOf('await saveReceipt(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(gateIdx);
  });

  it('saveReceipt defense-in-depth guards reviewedSave overage', () => {
    const dbSrc = fs.readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
    expect(dbSrc).toContain('scanReviewSaveSafety');
    expect(dbSrc).toContain('params.reviewedSave');
    expect(dbSrc).toContain('evaluateScanReviewSaveEligibility');
  });
});
