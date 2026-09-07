/**
 * Current-domain item monetary truth (read-time).
 *
 * Reuses analysisFoundation.resolveDiscountOwnership as the single SSOT for
 * ordinary-adjacent / coupon binding — the same rule set as amount-basis.
 *
 * For legacy receipts that still carry deterministic discounts[] evidence but
 * persisted item fields were never allocated, this derives corrected
 * discountAllocated / effectiveLineTotal observationally.
 *
 * Never writes SQLite. Never mutates analysis_json / receipt_items on disk.
 */

import {
  resolveDiscountOwnership,
  type DiscountOwnershipResolution,
} from './analysisFoundation/discountOwnership';
import type {
  DiscountableItem,
  DiscountLine,
} from './receiptDiscountAllocation';

export type CurrentItemMonetaryTruthSource = {
  recovered: boolean;
  ownershipStatus: DiscountOwnershipResolution['status'] | null;
  items: DiscountableItem[];
};

type AnalysisObject = Record<string, unknown>;

function parseAnalysisObject(
  analysisJson: string | null | undefined
): AnalysisObject | null {
  if (analysisJson == null || typeof analysisJson !== 'string' || !analysisJson.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(analysisJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as AnalysisObject;
  } catch {
    return null;
  }
}

function parseUserItemsPresent(
  userItemsJson: string | null | undefined
): boolean {
  if (userItemsJson == null || typeof userItemsJson !== 'string') return false;
  if (!userItemsJson.trim()) return false;
  try {
    return Array.isArray(JSON.parse(userItemsJson));
  } catch {
    return false;
  }
}

function readAnalysisItems(analysis: AnalysisObject): DiscountableItem[] {
  const raw = analysis.items;
  if (!Array.isArray(raw)) return [];
  return raw.map((row) =>
    row && typeof row === 'object'
      ? ({ ...(row as DiscountableItem) } as DiscountableItem)
      : ({} as DiscountableItem)
  );
}

function readAnalysisDiscounts(analysis: AnalysisObject): DiscountLine[] {
  const raw = analysis.discounts;
  if (!Array.isArray(raw)) return [];
  const out: DiscountLine[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const d = row as Record<string, unknown>;
    const amount = Number(d.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const label = typeof d.label === 'string' ? d.label : '値引';
    const adj = d.adjacentPrecedingItemIndex;
    out.push({
      label,
      amount: amount < 0 ? amount : -Math.abs(amount),
      adjacentPrecedingItemIndex:
        typeof adj === 'number' && Number.isInteger(adj) ? adj : null,
    });
  }
  return out;
}

function monetaryFieldsEqual(
  left: DiscountableItem,
  right: DiscountableItem
): boolean {
  const leftDisc = Number(left.discountAllocated);
  const rightDisc = Number(right.discountAllocated);
  const leftEff = Number(left.effectiveLineTotal);
  const rightEff = Number(right.effectiveLineTotal);
  const leftDiscNorm = Number.isFinite(leftDisc) ? leftDisc : 0;
  const rightDiscNorm = Number.isFinite(rightDisc) ? rightDisc : 0;
  const leftEffNorm = Number.isFinite(leftEff) ? leftEff : null;
  const rightEffNorm = Number.isFinite(rightEff) ? rightEff : null;
  return leftDiscNorm === rightDiscNorm && leftEffNorm === rightEffNorm;
}

/**
 * Derive current analysis-item monetary truth via ownership SSOT.
 * Returns shallow-copied items; never mutates the input array elements in place
 * unless ownership returns the same object references (persisted path).
 */
export function resolveCurrentAnalysisItemMonetaryTruth(
  analysisJson: string | null | undefined
): CurrentItemMonetaryTruthSource {
  const analysis = parseAnalysisObject(analysisJson);
  if (!analysis) {
    return { recovered: false, ownershipStatus: null, items: [] };
  }
  const ocrItems = readAnalysisItems(analysis);
  const ocrDiscounts = readAnalysisDiscounts(analysis);
  if (ocrItems.length === 0) {
    return { recovered: false, ownershipStatus: 'no_discounts', items: ocrItems };
  }
  if (ocrDiscounts.length === 0) {
    return {
      recovered: false,
      ownershipStatus: 'no_discounts',
      items: ocrItems,
    };
  }

  const ownership = resolveDiscountOwnership({
    ocrItems,
    ocrDiscounts,
    analysis,
  });

  if (
    ownership.status === 'unresolved' ||
    ownership.status === 'no_discounts'
  ) {
    return {
      recovered: false,
      ownershipStatus: ownership.status,
      items: ocrItems,
    };
  }

  const recovered =
    ownership.status === 'reallocated_with_evidence' &&
    ownership.items.some((item, index) => {
      const prior = ocrItems[index];
      return prior != null && !monetaryFieldsEqual(prior, item);
    });

  return {
    recovered,
    ownershipStatus: ownership.status,
    items: ownership.items,
  };
}

/**
 * Apply current-domain monetary fields onto analysis items for getReceiptItems.
 * No-op when ownership cannot deterministically improve item fields.
 */
export function applyCurrentItemMonetaryTruthToAnalysisItems(
  analysisJson: string | null | undefined,
  items: unknown[]
): unknown[] {
  if (!Array.isArray(items) || items.length === 0) return items;
  const resolved = resolveCurrentAnalysisItemMonetaryTruth(analysisJson);
  if (
    resolved.ownershipStatus !== 'reallocated_with_evidence' &&
    resolved.ownershipStatus !== 'persisted_resolved'
  ) {
    return items;
  }
  if (resolved.items.length !== items.length) {
    // Fail-closed: index drift between ownership items and source items.
    return items;
  }

  return items.map((raw, index) => {
    const recovered = resolved.items[index];
    if (!raw || typeof raw !== 'object' || !recovered) return raw;
    const base = raw as Record<string, unknown>;
    const discountAllocated = Number(recovered.discountAllocated);
    const effectiveLineTotal = Number(recovered.effectiveLineTotal);
    if (!Number.isFinite(discountAllocated) || !Number.isFinite(effectiveLineTotal)) {
      return raw;
    }
    const priorDisc = Number(base.discountAllocated);
    const priorEff = Number(base.effectiveLineTotal);
    if (
      Number.isFinite(priorDisc) &&
      priorDisc === discountAllocated &&
      Number.isFinite(priorEff) &&
      priorEff === effectiveLineTotal
    ) {
      return raw;
    }
    return {
      ...base,
      discountAllocated,
      effectiveLineTotal,
      // Keep gross aliases stable; lineTotal remains the gross merchandise amount.
      lineTotal:
        Number.isFinite(Number(base.lineTotal))
          ? Number(base.lineTotal)
          : Number.isFinite(Number(recovered.lineTotal))
            ? Number(recovered.lineTotal)
            : base.lineTotal,
    };
  });
}

export type ProductRowMonetaryFields = {
  receiptId: string;
  sourceIndex: number;
  grossLineAmount?: number | null;
  effectiveLineAmount?: number | null;
  discountAllocated?: number | null;
  lineTotal?: number | null;
  receiptAnalysisJson?: string | null;
  receiptUserItemsJson?: string | null;
};

/**
 * Observational overlay for indexed product rows (receipt_items + analysis_json).
 * Skips receipts whose user_items_json is the item authority.
 * Does not write the database.
 */
export function enrichProductRowsWithCurrentItemMonetaryTruth<
  T extends ProductRowMonetaryFields,
>(rows: readonly T[]): T[] {
  if (rows.length === 0) return [];

  const byReceipt = new Map<string, T[]>();
  for (const row of rows) {
    const receiptId =
      typeof row.receiptId === 'string' ? row.receiptId.trim() : '';
    if (!receiptId) continue;
    const list = byReceipt.get(receiptId) ?? [];
    list.push(row);
    byReceipt.set(receiptId, list);
  }

  const out: T[] = [];
  for (const [, group] of byReceipt) {
    const sample = group[0]!;
    if (parseUserItemsPresent(sample.receiptUserItemsJson)) {
      out.push(...group);
      continue;
    }
    const resolved = resolveCurrentAnalysisItemMonetaryTruth(
      sample.receiptAnalysisJson
    );
    if (
      resolved.ownershipStatus !== 'reallocated_with_evidence' &&
      resolved.ownershipStatus !== 'persisted_resolved'
    ) {
      out.push(...group);
      continue;
    }

    for (const row of group) {
      const recovered = resolved.items[row.sourceIndex];
      if (!recovered) {
        out.push(row);
        continue;
      }
      const discountAllocated = Number(recovered.discountAllocated);
      const effectiveLineTotal = Number(recovered.effectiveLineTotal);
      if (!Number.isFinite(discountAllocated) || !Number.isFinite(effectiveLineTotal)) {
        out.push(row);
        continue;
      }
      const gross =
        row.grossLineAmount != null && Number.isFinite(row.grossLineAmount)
          ? row.grossLineAmount
          : Number(recovered.lineTotal);
      if (!Number.isFinite(gross) || gross < 0) {
        out.push(row);
        continue;
      }
      // Fail-closed if recovered effective does not match gross + discount.
      if (Math.abs(effectiveLineTotal - (gross + discountAllocated)) > 0.01) {
        out.push(row);
        continue;
      }
      if (
        row.discountAllocated === discountAllocated &&
        row.effectiveLineAmount === effectiveLineTotal
      ) {
        out.push(row);
        continue;
      }
      out.push({
        ...row,
        // Gross comparison surface stays on the original gross.
        grossLineAmount: row.grossLineAmount ?? gross,
        discountAllocated,
        effectiveLineAmount: effectiveLineTotal,
      });
    }
  }

  // Preserve caller order.
  if (out.length !== rows.length) {
    return [...rows];
  }
  const byKey = new Map(
    out.map((row) => [`${row.receiptId}:${row.sourceIndex}`, row] as const)
  );
  return rows.map(
    (row) => byKey.get(`${row.receiptId}:${row.sourceIndex}`) ?? row
  );
}
