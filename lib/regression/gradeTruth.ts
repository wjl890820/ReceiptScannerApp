/**
 * Truth-backed and no-truth field grading.
 */

import { deriveRetailerIdentity } from '../retailerIdentity';
import { receiptTimestampsEqual } from './dateCompare';
import { merchantCompatible, normalizeLoose } from './matchManifest';
import type {
  CanonicalReceiptProjection,
  FieldComparison,
  FieldVerdict,
  MerchantCompareResult,
  TruthFields,
} from './types';

function valuesEqual(a: unknown, b: unknown, field?: string, merchantHint?: string | null): boolean {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.round(a) === Math.round(b);
  }
  if (field === 'transactionAt' || field?.endsWith('.transactionAt')) {
    if (receiptTimestampsEqual(a, b, merchantHint)) return true;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return normalizeLoose(a) === normalizeLoose(b);
  }
  return a === b;
}

/**
 * Grade a single scalar field given optional truth.
 * baseline = observed historical projection
 * current = deterministic current projection
 */
export function gradeScalarField(input: {
  field: string;
  truth: unknown | undefined;
  baseline: unknown;
  current: unknown;
  hasTruth: boolean;
  merchantHint?: string | null;
}): FieldComparison {
  const { field, truth, baseline, current, hasTruth, merchantHint } = input;

  if (!hasTruth || truth === undefined) {
    if (valuesEqual(baseline, current, field, merchantHint)) {
      return { field, verdict: 'UNCHANGED', baseline, current };
    }
    return {
      field,
      verdict: 'CHANGED_UNKNOWN',
      baseline,
      current,
      detail: 'no_human_truth',
    };
  }

  const baselineOk = valuesEqual(baseline, truth, field, merchantHint);
  const currentOk = valuesEqual(current, truth, field, merchantHint);

  if (baselineOk && currentOk) {
    return { field, verdict: 'CORRECT_STABLE', truth, baseline, current };
  }
  if (!baselineOk && currentOk) {
    return { field, verdict: 'IMPROVEMENT', truth, baseline, current };
  }
  if (baselineOk && !currentOk) {
    return { field, verdict: 'REGRESSION', truth, baseline, current };
  }
  if (!valuesEqual(baseline, current, field, merchantHint)) {
    return {
      field,
      verdict: 'CHANGED_STILL_INCORRECT',
      truth,
      baseline,
      current,
    };
  }
  return {
    field,
    verdict: 'STABLE_INCORRECT',
    truth,
    baseline,
    current,
    detail: 'both_wrong_unchanged',
  };
}

export function compareMerchants(input: {
  truthMerchant: string | undefined;
  baselineMerchant: string | null;
  currentMerchant: string | null;
}): MerchantCompareResult & { comparisons: FieldComparison[] } {
  const { truthMerchant, baselineMerchant, currentMerchant } = input;
  if (truthMerchant === undefined) {
    const exact =
      baselineMerchant &&
      currentMerchant &&
      normalizeLoose(baselineMerchant) === normalizeLoose(currentMerchant);
    return {
      merchantExact: Boolean(exact),
      merchantRetailerCompatible: merchantCompatible(
        baselineMerchant ?? '',
        currentMerchant ?? ''
      ),
      truthRetailerKey: null,
      currentRetailerKey:
        deriveRetailerIdentity({ merchantRaw: currentMerchant }).retailerKey,
      verdict: exact ? 'UNCHANGED' : 'CHANGED_UNKNOWN',
      comparisons: [
        gradeScalarField({
          field: 'merchant',
          truth: undefined,
          baseline: baselineMerchant,
          current: currentMerchant,
          hasTruth: false,
        }),
      ],
    };
  }

  const truthExactCurrent =
    currentMerchant != null &&
    normalizeLoose(currentMerchant) === normalizeLoose(truthMerchant);
  const truthExactBaseline =
    baselineMerchant != null &&
    normalizeLoose(baselineMerchant) === normalizeLoose(truthMerchant);
  const truthCompatCurrent = merchantCompatible(
    truthMerchant,
    currentMerchant ?? ''
  );
  const truthCompatBaseline = merchantCompatible(
    truthMerchant,
    baselineMerchant ?? ''
  );

  const truthRetailerKey = deriveRetailerIdentity({
    merchantRaw: truthMerchant,
  }).retailerKey;
  const currentRetailerKey = deriveRetailerIdentity({
    merchantRaw: currentMerchant,
  }).retailerKey;

  // Exact grade
  const exactCmp = gradeScalarField({
    field: 'merchantExact',
    truth: truthMerchant,
    baseline: truthExactBaseline ? truthMerchant : baselineMerchant,
    current: truthExactCurrent ? truthMerchant : currentMerchant,
    hasTruth: true,
  });
  // Override equality semantics for exact: compare booleans via custom
  let exactVerdict: FieldVerdict;
  if (truthExactBaseline && truthExactCurrent) exactVerdict = 'CORRECT_STABLE';
  else if (!truthExactBaseline && truthExactCurrent) exactVerdict = 'IMPROVEMENT';
  else if (truthExactBaseline && !truthExactCurrent) exactVerdict = 'REGRESSION';
  else if (
    normalizeLoose(baselineMerchant ?? '') === normalizeLoose(currentMerchant ?? '')
  ) {
    exactVerdict = 'STABLE_INCORRECT';
  } else exactVerdict = 'CHANGED_STILL_INCORRECT';

  let compatVerdict: FieldVerdict;
  if (truthCompatBaseline && truthCompatCurrent) compatVerdict = 'CORRECT_STABLE';
  else if (!truthCompatBaseline && truthCompatCurrent) compatVerdict = 'IMPROVEMENT';
  else if (truthCompatBaseline && !truthCompatCurrent) compatVerdict = 'REGRESSION';
  else if (truthCompatBaseline === truthCompatCurrent) {
    compatVerdict = 'STABLE_INCORRECT';
  } else compatVerdict = 'CHANGED_STILL_INCORRECT';

  return {
    merchantExact: truthExactCurrent,
    merchantRetailerCompatible: truthCompatCurrent,
    truthRetailerKey,
    currentRetailerKey,
    verdict: exactVerdict,
    comparisons: [
      {
        field: 'merchantExact',
        verdict: exactVerdict,
        truth: truthMerchant,
        baseline: baselineMerchant,
        current: currentMerchant,
        detail: exactCmp.detail,
      },
      {
        field: 'merchantRetailerCompatible',
        verdict: compatVerdict,
        truth: truthMerchant,
        baseline: baselineMerchant,
        current: currentMerchant,
      },
    ],
  };
}

function findItemByName(
  items: CanonicalReceiptProjection['items'],
  name: string
): CanonicalReceiptProjection['items'][number] | undefined {
  const n = normalizeLoose(name);
  return items.find((it) => it.name && normalizeLoose(it.name) === n);
}

function findItemsContaining(
  items: CanonicalReceiptProjection['items'],
  fragment: string
): CanonicalReceiptProjection['items'] {
  const n = normalizeLoose(fragment);
  return items.filter((it) => it.name && normalizeLoose(it.name).includes(n));
}

/**
 * Grade truth fields against baseline observed vs current deterministic projection.
 */
export function gradeAgainstTruth(input: {
  truth: TruthFields;
  baseline: CanonicalReceiptProjection;
  current: CanonicalReceiptProjection;
}): {
  comparisons: FieldComparison[];
  merchantCompare: MerchantCompareResult | null;
  completeBasket: boolean;
} {
  const { truth, baseline, current } = input;
  const comparisons: FieldComparison[] = [];
  const completeBasket = truth.completeBasket === true;

  const merchant = compareMerchants({
    truthMerchant: truth.merchant,
    baselineMerchant: baseline.merchantRaw,
    currentMerchant: current.merchantRaw,
  });
  comparisons.push(...merchant.comparisons);

  if (truth.transactionAt !== undefined) {
    comparisons.push(
      gradeScalarField({
        field: 'transactionAt',
        truth: truth.transactionAt,
        baseline: baseline.transactionAt,
        current: current.transactionAt,
        hasTruth: true,
        merchantHint: truth.merchant ?? current.merchantRaw ?? baseline.merchantRaw,
      })
    );
  }
  if (truth.total !== undefined) {
    comparisons.push(
      gradeScalarField({
        field: 'total',
        truth: truth.total,
        baseline: baseline.total,
        current: current.total,
        hasTruth: true,
      })
    );
  }
  if (truth.tax !== undefined) {
    comparisons.push(
      gradeScalarField({
        field: 'tax',
        truth: truth.tax,
        baseline: baseline.tax,
        current: current.tax,
        hasTruth: true,
      })
    );
  }
  if (truth.currency !== undefined) {
    comparisons.push(
      gradeScalarField({
        field: 'currency',
        truth: truth.currency,
        baseline: baseline.currency,
        current: current.currency,
        hasTruth: true,
      })
    );
  }
  if (truth.itemRowCount !== undefined) {
    comparisons.push(
      gradeScalarField({
        field: 'itemRowCount',
        truth: truth.itemRowCount,
        baseline: baseline.itemRowCount,
        current: current.itemRowCount,
        hasTruth: true,
      })
    );
  }
  if (truth.quantityTotal !== undefined) {
    comparisons.push(
      gradeScalarField({
        field: 'quantityTotal',
        truth: truth.quantityTotal,
        baseline: baseline.quantityTotal,
        current: current.quantityTotal,
        hasTruth: true,
      })
    );
  }

  if (truth.orderedLineAmounts && truth.orderedLineAmounts.length > 0) {
    const curAmounts = current.items
      .map((i) => i.lineTotal)
      .filter((x): x is number => x != null && x > 0);
    const baseAmounts = baseline.items
      .map((i) => i.lineTotal)
      .filter((x): x is number => x != null && x > 0);
    const truthArr = truth.orderedLineAmounts;
    const curOk =
      curAmounts.length === truthArr.length &&
      curAmounts.every((v, i) => Math.round(v) === Math.round(truthArr[i]));
    const baseOk =
      baseAmounts.length === truthArr.length &&
      baseAmounts.every((v, i) => Math.round(v) === Math.round(truthArr[i]));
    let verdict: FieldVerdict;
    if (baseOk && curOk) verdict = 'CORRECT_STABLE';
    else if (!baseOk && curOk) verdict = 'IMPROVEMENT';
    else if (baseOk && !curOk) verdict = 'REGRESSION';
    else if (JSON.stringify(baseAmounts) === JSON.stringify(curAmounts)) {
      verdict = 'STABLE_INCORRECT';
    } else verdict = 'CHANGED_STILL_INCORRECT';
    comparisons.push({
      field: 'orderedLineAmounts',
      verdict,
      truth: truthArr,
      baseline: baseAmounts,
      current: curAmounts,
    });
  }

  if (truth.items && truth.items.length > 0) {
    for (const tItem of truth.items) {
      if (!tItem.name) continue;
      const b = findItemByName(baseline.items, tItem.name);
      const c = findItemByName(current.items, tItem.name);
      if (tItem.quantity !== undefined) {
        comparisons.push(
          gradeScalarField({
            field: `item[${tItem.name}].quantity`,
            truth: tItem.quantity,
            baseline: b?.quantity ?? null,
            current: c?.quantity ?? null,
            hasTruth: true,
          })
        );
      }
      if (tItem.unitPrice !== undefined) {
        comparisons.push(
          gradeScalarField({
            field: `item[${tItem.name}].unitPrice`,
            truth: tItem.unitPrice,
            baseline: b?.unitPrice ?? null,
            current: c?.unitPrice ?? null,
            hasTruth: true,
          })
        );
      }
      if (tItem.lineTotal !== undefined) {
        comparisons.push(
          gradeScalarField({
            field: `item[${tItem.name}].lineTotal`,
            truth: tItem.lineTotal,
            baseline: b?.lineTotal ?? null,
            current: c?.lineTotal ?? null,
            hasTruth: true,
          })
        );
      }
        comparisons.push({
          field: `item[${tItem.name}].present`,
          verdict: (() => {
            const baseOk = Boolean(b);
            const curOk = Boolean(c);
            if (baseOk && curOk) return 'CORRECT_STABLE';
            if (!baseOk && curOk) return 'IMPROVEMENT';
            if (baseOk && !curOk) return 'REGRESSION';
            if (baseOk === curOk) return 'STABLE_INCORRECT';
            return 'CHANGED_STILL_INCORRECT';
          })(),
          truth: true,
          baseline: Boolean(b),
          current: Boolean(c),
        });
    }
  }

  if (truth.confirmedMerchandise) {
    for (const m of truth.confirmedMerchandise) {
      const key = m.name ?? m.nameContains ?? '?';
      const finder = (items: CanonicalReceiptProjection['items']) => {
        if (m.name) return findItemByName(items, m.name);
        if (m.nameContains) {
          const hits = findItemsContaining(items, m.nameContains);
          if (m.lineTotal != null) {
            return hits.find(
              (h) =>
                h.lineTotal != null &&
                Math.round(h.lineTotal) === Math.round(m.lineTotal!)
            );
          }
          return hits[0];
        }
        return undefined;
      };
      const b = finder(baseline.items);
      const c = finder(current.items);
      if (m.lineTotal !== undefined) {
        comparisons.push(
          gradeScalarField({
            field: `merchandise[${key}].lineTotal`,
            truth: m.lineTotal,
            baseline: b?.lineTotal ?? null,
            current: c?.lineTotal ?? null,
            hasTruth: true,
          })
        );
      }
      if (m.quantity !== undefined) {
        comparisons.push(
          gradeScalarField({
            field: `merchandise[${key}].quantity`,
            truth: m.quantity,
            baseline: b?.quantity ?? null,
            current: c?.quantity ?? null,
            hasTruth: true,
          })
        );
      }
      if (m.unitPrice !== undefined) {
        comparisons.push(
          gradeScalarField({
            field: `merchandise[${key}].unitPrice`,
            truth: m.unitPrice,
            baseline: b?.unitPrice ?? null,
            current: c?.unitPrice ?? null,
            hasTruth: true,
          })
        );
      }
      if (
        m.lineTotal === undefined &&
        m.quantity === undefined &&
        m.unitPrice === undefined
      ) {
        comparisons.push({
          field: `merchandise[${key}].present`,
          verdict: (() => {
            const baseOk = Boolean(b);
            const curOk = Boolean(c);
            if (baseOk && curOk) return 'CORRECT_STABLE';
            if (!baseOk && curOk) return 'IMPROVEMENT';
            if (baseOk && !curOk) return 'REGRESSION';
            if (baseOk === curOk) return 'STABLE_INCORRECT';
            return 'CHANGED_STILL_INCORRECT';
          })(),
          truth: true,
          baseline: Boolean(b),
          current: Boolean(c),
        });
      }
    }
  }

  // Partial multi-row name constraint (e.g. three カイノミステーキ用)
  // Handled via confirmedMerchandise entries with same nameContains + different lineTotals.

  if (truth.confirmedCoupon) {
    const label = truth.confirmedCoupon.labelContains ?? 'coupon';
    const amt = truth.confirmedCoupon.amount;
    const findCoupon = (items: CanonicalReceiptProjection['items']) =>
      items.find(
        (it) =>
          it.name &&
          normalizeLoose(it.name).includes(normalizeLoose(label)) &&
          it.lineTotal != null &&
          Math.round(it.lineTotal) === Math.round(amt)
      );
    const b = findCoupon(baseline.items);
    const c = findCoupon(current.items);
    comparisons.push({
      field: `coupon[${label}]`,
      verdict: (() => {
        const baseOk = Boolean(b);
        const curOk = Boolean(c);
        if (baseOk && curOk) return 'CORRECT_STABLE';
        if (!baseOk && curOk) return 'IMPROVEMENT';
        if (baseOk && !curOk) return 'REGRESSION';
        if (baseOk === curOk) return 'STABLE_INCORRECT';
        return 'CHANGED_STILL_INCORRECT';
      })(),
      truth: { label, amount: amt },
      baseline: b ? { name: b.name, lineTotal: b.lineTotal } : null,
      current: c ? { name: c.name, lineTotal: c.lineTotal } : null,
      detail: truth.couponOwnershipUnresolved
        ? 'coupon_ownership_unresolved_do_not_grade_effective_598'
        : undefined,
    });
  }

  // No-truth: still emit reconciliation change visibility
  comparisons.push(
    gradeScalarField({
      field: 'reconciliation.ok',
      truth: undefined,
      baseline: baseline.reconciliation.ok,
      current: current.reconciliation.ok,
      hasTruth: false,
    })
  );

  return {
    comparisons,
    merchantCompare: {
      merchantExact: merchant.merchantExact,
      merchantRetailerCompatible: merchant.merchantRetailerCompatible,
      truthRetailerKey: merchant.truthRetailerKey,
      currentRetailerKey: merchant.currentRetailerKey,
      verdict: merchant.verdict,
    },
    completeBasket,
  };
}

/** Compare observed vs current without truth (row-level). */
export function gradeNoTruthDelta(
  baseline: CanonicalReceiptProjection,
  current: CanonicalReceiptProjection
): FieldComparison[] {
  const fields: Array<keyof CanonicalReceiptProjection> = [
    'merchantRaw',
    'total',
    'tax',
    'currency',
    'itemRowCount',
    'quantityTotal',
  ];
  return fields.map((field) =>
    gradeScalarField({
      field,
      truth: undefined,
      baseline: baseline[field],
      current: current[field],
      hasTruth: false,
    })
  );
}

export function tallyVerdicts(comparisons: FieldComparison[]): Record<FieldVerdict, number> {
  const out: Record<FieldVerdict, number> = {
    CORRECT_STABLE: 0,
    IMPROVEMENT: 0,
    REGRESSION: 0,
    CHANGED_STILL_INCORRECT: 0,
    STABLE_INCORRECT: 0,
    UNKNOWN: 0,
    UNCHANGED: 0,
    CHANGED_UNKNOWN: 0,
  };
  for (const c of comparisons) {
    out[c.verdict] += 1;
  }
  return out;
}
