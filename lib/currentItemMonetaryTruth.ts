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
 * Also recovers collapsed charged-as-gross lines when structured discounts[]
 * carry deterministic inline original-price evidence (値下(元 N)).
 *
 * Never writes SQLite. Never mutates analysis_json / receipt_items on disk.
 */

import {
  resolveDiscountOwnership,
  type DiscountOwnershipResolution,
} from './analysisFoundation/discountOwnership';
import {
  ownershipBaseIdentityKey,
  type DiscountableItem,
  type DiscountLine,
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
  return raw.map((row) => projectAnalysisItemForMonetaryRecovery(row));
}

/**
 * Ownership reads camelCase lineTotal. A null camelCase field is missing
 * evidence, so a finite snake_case gross is copied onto the working item.
 * Explicit 0 stays 0 and is never replaced by line_total.
 */
function projectAnalysisItemForMonetaryRecovery(row: unknown): DiscountableItem {
  if (!row || typeof row !== 'object') return {};
  const item = { ...(row as DiscountableItem) };
  if (finiteNumber(item.lineTotal) == null) {
    const snake = finiteNumber(item.line_total);
    if (snake != null) item.lineTotal = snake;
  }
  return item;
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
      ownershipStatus:
        d.ownershipStatus === 'bound' || d.ownershipStatus === 'unbound'
          ? d.ownershipStatus
          : null,
      boundItemIndex:
        typeof d.boundItemIndex === 'number' ? d.boundItemIndex : null,
      ownershipReason:
        typeof d.ownershipReason === 'string' ? d.ownershipReason : null,
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
  const leftGross = Number(left.lineTotal);
  const rightGross = Number(right.lineTotal);
  const leftDiscNorm = Number.isFinite(leftDisc) ? leftDisc : 0;
  const rightDiscNorm = Number.isFinite(rightDisc) ? rightDisc : 0;
  const leftEffNorm = Number.isFinite(leftEff) ? leftEff : null;
  const rightEffNorm = Number.isFinite(rightEff) ? rightEff : null;
  const leftGrossNorm = Number.isFinite(leftGross) ? leftGross : null;
  const rightGrossNorm = Number.isFinite(rightGross) ? rightGross : null;
  return (
    leftDiscNorm === rightDiscNorm &&
    leftEffNorm === rightEffNorm &&
    leftGrossNorm === rightGrossNorm
  );
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
    const recoveredGross = Number(recovered.lineTotal);
    if (!Number.isFinite(discountAllocated) || !Number.isFinite(effectiveLineTotal)) {
      return raw;
    }
    const priorDisc = Number(base.discountAllocated);
    const priorEff = Number(base.effectiveLineTotal);
    const priorGross = Number(base.lineTotal);
    const grossUnchanged =
      !Number.isFinite(recoveredGross) ||
      (Number.isFinite(priorGross) && priorGross === recoveredGross);
    if (
      Number.isFinite(priorDisc) &&
      priorDisc === discountAllocated &&
      Number.isFinite(priorEff) &&
      priorEff === effectiveLineTotal &&
      grossUnchanged
    ) {
      return raw;
    }
    const nextGross = Number.isFinite(recoveredGross)
      ? recoveredGross
      : Number.isFinite(priorGross)
        ? priorGross
        : base.lineTotal;
    return {
      ...base,
      discountAllocated,
      effectiveLineTotal,
      // Gross may be lifted from inline-original evidence; otherwise stable.
      lineTotal: nextGross,
      line_total: nextGross,
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
  /** Indexed identity. Compared to the original analysis item, not the recovered tuple. */
  displayName?: string | null;
  rawName?: string | null;
  purchaseQuantity?: number | null;
};

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveFinite(value: unknown): number | null {
  const n = finiteNumber(value);
  return n != null && n > 0 ? n : null;
}

function indexedRowIdentityName(row: ProductRowMonetaryFields): string {
  const display = typeof row.displayName === 'string' ? row.displayName.trim() : '';
  if (display) return display;
  const raw = typeof row.rawName === 'string' ? row.rawName.trim() : '';
  return raw;
}

/**
 * CamelCase lineTotal wins when it is real numeric evidence, including 0.
 * Null, undefined, NaN, and Infinity are missing and may fall through to line_total.
 */
export function originalGrossForCorrespondence(
  item: DiscountableItem
): number | null {
  const camel = finiteNumber(item.lineTotal);
  if (camel != null) return camel;
  return finiteNumber(item.line_total);
}

/**
 * Correspondence-only amount. Same precedence as itemAmountForAnalytics,
 * without coercing null to 0.
 */
export function originalAnalyticsAmountForCorrespondence(
  item: DiscountableItem
): number | null {
  const gross = originalGrossForCorrespondence(item);
  if (item.amountUserEdited === true) return gross;
  if (originalEffectiveIsStaleAlias(item)) return gross;
  const effective = finiteNumber(item.effectiveLineTotal);
  if (effective != null) return effective;
  return gross;
}

function originalEffectiveIsStaleAlias(item: DiscountableItem): boolean {
  const allocated = finiteNumber(item.discountAllocated);
  if (allocated != null && allocated !== 0) return false;
  const camel = finiteNumber(item.lineTotal);
  const effective = finiteNumber(item.effectiveLineTotal);
  if (camel == null || effective == null || camel === effective) return false;
  const snake = finiteNumber(item.line_total);
  return snake != null && snake === effective && camel !== snake;
}

/**
 * Prove this indexed row is still the original analysis item at sourceIndex.
 * Monetary recovery may change gross/discount/effective afterwards; those
 * recovered fields are not used as identity evidence.
 * Missing proof skips the overlay. A disagreement skips the overlay.
 */
function rowCorrespondsToOriginalAnalysisItem(
  row: ProductRowMonetaryFields,
  originalItems: readonly DiscountableItem[],
  recoveredCount: number
): boolean {
  const sourceIndex = row.sourceIndex;
  if (
    typeof sourceIndex !== 'number' ||
    !Number.isInteger(sourceIndex) ||
    sourceIndex < 0 ||
    sourceIndex >= originalItems.length ||
    sourceIndex >= recoveredCount
  ) {
    return false;
  }

  const original = originalItems[sourceIndex];
  if (!original) return false;

  const indexedName = indexedRowIdentityName(row);
  const originalName =
    typeof original.name === 'string' ? original.name.trim() : '';
  if (!indexedName || !originalName) return false;
  const indexedKey = ownershipBaseIdentityKey(indexedName);
  const originalKey = ownershipBaseIdentityKey(originalName);
  if (!indexedKey || !originalKey || indexedKey !== originalKey) return false;

  const indexedQty = positiveFinite(row.purchaseQuantity);
  const originalQty = positiveFinite(
    (original as { quantity?: unknown }).quantity ??
      (original as { purchase_quantity?: unknown }).purchase_quantity
  );
  if (
    indexedQty != null &&
    originalQty != null &&
    indexedQty !== originalQty
  ) {
    return false;
  }

  const originalGross = originalGrossForCorrespondence(original);
  const rowGross = finiteNumber(row.grossLineAmount);
  if (rowGross != null && (originalGross == null || rowGross !== originalGross)) {
    return false;
  }

  const rowLineTotal = finiteNumber(row.lineTotal);
  if (rowLineTotal != null) {
    const originalAnalytics = originalAnalyticsAmountForCorrespondence(original);
    const matchesGross = originalGross != null && rowLineTotal === originalGross;
    const matchesAnalytics =
      originalAnalytics != null && rowLineTotal === originalAnalytics;
    if (!matchesGross && !matchesAnalytics) return false;
  }

  return true;
}

/**
 * Observational overlay for indexed product rows (receipt_items + analysis_json).
 * Skips receipts whose user_items_json is the item authority.
 * Does not write the database.
 */
export function enrichProductRowsWithCurrentItemMonetaryTruth<
  T extends ProductRowMonetaryFields,
>(rows: readonly T[]): T[] {
  if (rows.length === 0) return [];

  type IndexedRow = { row: T; originalIndex: number };
  const result = new Array<T>(rows.length);
  const byReceipt = new Map<string, IndexedRow[]>();

  for (let originalIndex = 0; originalIndex < rows.length; originalIndex++) {
    const row = rows[originalIndex]!;
    const receiptId =
      typeof row.receiptId === 'string' ? row.receiptId.trim() : '';
    if (!receiptId) {
      result[originalIndex] = row;
      continue;
    }
    const list = byReceipt.get(receiptId) ?? [];
    list.push({ row, originalIndex });
    byReceipt.set(receiptId, list);
  }

  for (const [, group] of byReceipt) {
    const sample = group[0]!.row;
    const keepGroup = () => {
      for (const entry of group) result[entry.originalIndex] = entry.row;
    };
    if (parseUserItemsPresent(sample.receiptUserItemsJson)) {
      keepGroup();
      continue;
    }
    const analysis = parseAnalysisObject(sample.receiptAnalysisJson);
    const originalItems = analysis ? readAnalysisItems(analysis) : [];
    const resolved = resolveCurrentAnalysisItemMonetaryTruth(
      sample.receiptAnalysisJson
    );
    if (
      resolved.ownershipStatus !== 'reallocated_with_evidence' &&
      resolved.ownershipStatus !== 'persisted_resolved'
    ) {
      keepGroup();
      continue;
    }

    for (const entry of group) {
      const row = entry.row;
      if (
        !rowCorrespondsToOriginalAnalysisItem(
          row,
          originalItems,
          resolved.items.length
        )
      ) {
        result[entry.originalIndex] = row;
        continue;
      }
      const recovered = resolved.items[row.sourceIndex];
      if (!recovered) {
        result[entry.originalIndex] = row;
        continue;
      }
      const discountAllocated = Number(recovered.discountAllocated);
      const effectiveLineTotal = Number(recovered.effectiveLineTotal);
      if (!Number.isFinite(discountAllocated) || !Number.isFinite(effectiveLineTotal)) {
        result[entry.originalIndex] = row;
        continue;
      }
      const recoveredGross = Number(recovered.lineTotal);
      const gross = Number.isFinite(recoveredGross)
        ? recoveredGross
        : row.grossLineAmount != null && Number.isFinite(row.grossLineAmount)
          ? row.grossLineAmount
          : Number.NaN;
      if (!Number.isFinite(gross) || gross < 0) {
        result[entry.originalIndex] = row;
        continue;
      }
      // Fail-closed if recovered effective does not match gross + discount.
      if (Math.abs(effectiveLineTotal - (gross + discountAllocated)) > 0.01) {
        result[entry.originalIndex] = row;
        continue;
      }
      if (
        row.discountAllocated === discountAllocated &&
        row.effectiveLineAmount === effectiveLineTotal &&
        row.grossLineAmount === gross
      ) {
        result[entry.originalIndex] = row;
        continue;
      }
      result[entry.originalIndex] = {
        ...row,
        // Canonical gross may be lifted from inline-original structured evidence.
        grossLineAmount: gross,
        discountAllocated,
        effectiveLineAmount: effectiveLineTotal,
      };
    }
  }

  return result;
}
