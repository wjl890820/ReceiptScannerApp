/**
 * A1.2.1 / A1.2.2 — Coherent monetary source bundle (read-only).
 *
 * items / discounts / total must come from one semantic layer.
 * Discount ownership is consumed via discountOwnership.ts — never re-guessed
 * with weaker evidence than the original normalization path.
 */

import type { ReceiptRow } from '../db';
import {
  discountsHaveAggregateSummaryAmbiguity,
  itemAmountForAnalytics,
  type DiscountableItem,
  type DiscountLine,
} from '../receiptDiscountAllocation';
import {
  resolveDiscountOwnership,
  type DiscountOwnershipStatus,
} from './discountOwnership';

export type MonetaryLayerKind = 'ocr' | 'user';

export type ReceiptMonetarySourceBundle = {
  coherent: boolean;
  layer: MonetaryLayerKind | null;
  items: DiscountableItem[];
  ocrDiscounts: DiscountLine[];
  /**
   * Genuine receipt-level remainder only (never unresolved ownership leftovers).
   */
  receiptLevelUnallocatedDiscountTotal: number;
  analyticsItemSumOverride: number | null;
  paidTotal: number | null;
  discountReconciliationAmbiguous: boolean;
  discountOwnershipStatus: DiscountOwnershipStatus | null;
  reasonCodes: string[];
  evidence: string[];
};

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeDiscountAmount(amount: number): number {
  return amount < 0 ? amount : -Math.abs(amount);
}

function parseJsonObject(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (raw == null || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseUserItemsJson(
  raw: string | null | undefined
): { ok: true; items: DiscountableItem[] } | { ok: false; malformed: boolean } {
  if (raw == null || typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, malformed: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, malformed: true };
    return {
      ok: true,
      items: parsed.map((row) =>
        row && typeof row === 'object'
          ? (row as DiscountableItem)
          : ({} as DiscountableItem)
      ),
    };
  } catch {
    return { ok: false, malformed: true };
  }
}

function readAnalysisItems(analysis: Record<string, unknown> | null): DiscountableItem[] {
  if (!analysis) return [];
  const items = analysis.items;
  if (!Array.isArray(items)) return [];
  return items.map((row) =>
    row && typeof row === 'object'
      ? (row as DiscountableItem)
      : ({} as DiscountableItem)
  );
}

function readAnalysisDiscounts(
  analysis: Record<string, unknown> | null
): DiscountLine[] {
  if (!analysis) return [];
  const discounts = analysis.discounts;
  if (!Array.isArray(discounts)) return [];
  const out: DiscountLine[] = [];
  for (const d of discounts) {
    if (!d || typeof d !== 'object') continue;
    const row = d as Record<string, unknown>;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const label = typeof row.label === 'string' ? row.label : '';
    out.push({
      label,
      amount: normalizeDiscountAmount(amount),
      adjacentPrecedingItemIndex:
        typeof row.adjacentPrecedingItemIndex === 'number'
          ? row.adjacentPrecedingItemIndex
          : null,
    });
  }
  return out;
}

function hasFinitePositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Resolve a single coherent monetary bundle for amount-basis assessment.
 */
export function resolveReceiptMonetarySourceBundle(
  receipt: ReceiptRow
): ReceiptMonetarySourceBundle {
  const evidence: string[] = [];
  const reasonCodes: string[] = [];

  const analysis = parseJsonObject(receipt.analysis_json);
  const ocrItems = readAnalysisItems(analysis);
  const ocrDiscounts = readAnalysisDiscounts(analysis);
  const userParsed = parseUserItemsJson(receipt.user_items_json);
  const hasUserItemsField =
    receipt.user_items_json != null &&
    typeof receipt.user_items_json === 'string' &&
    receipt.user_items_json.trim().length > 0;
  const hasFinalTotal =
    receipt.final_total != null && Number.isFinite(Number(receipt.final_total));
  const userEdited = receipt.user_edited === 1;

  if (discountsHaveAggregateSummaryAmbiguity(ocrDiscounts)) {
    reasonCodes.push('aggregate_discount_summary_ambiguous');
    evidence.push('ocr_discounts_mix_summary_and_components');
  }

  const discountReconciliationAmbiguous = reasonCodes.includes(
    'aggregate_discount_summary_ambiguous'
  );

  const ownership = resolveDiscountOwnership({
    ocrItems,
    ocrDiscounts,
    analysis,
  });
  evidence.push(...ownership.evidence);
  reasonCodes.push(...ownership.reasonCodes.filter((c) => !reasonCodes.includes(c)));

  const incoherent = (
    codes: string[],
    extraEvidence: string[]
  ): ReceiptMonetarySourceBundle => ({
    coherent: false,
    layer: null,
    items: [],
    ocrDiscounts,
    receiptLevelUnallocatedDiscountTotal: 0,
    analyticsItemSumOverride: null,
    paidTotal: null,
    discountReconciliationAmbiguous,
    discountOwnershipStatus: ownership.status,
    reasonCodes: [...reasonCodes, ...codes],
    evidence: [...evidence, ...extraEvidence],
  });

  if (discountReconciliationAmbiguous || ownership.status === 'unresolved') {
    return incoherent(
      ownership.status === 'unresolved'
        ? ['discount_ownership_unresolved', 'monetary_source_incoherent']
        : ['monetary_source_incoherent'],
      ['discount_ownership_blocks_amount_basis']
    );
  }

  // --- Incoherent user-edit / layer combinations ---
  if (userParsed.ok === false && userParsed.malformed) {
    return incoherent(
      ['malformed_user_items_json', 'monetary_source_incoherent'],
      ['user_items_json_malformed']
    );
  }

  if (hasUserItemsField && userParsed.ok && !hasFinalTotal) {
    return incoherent(
      ['user_items_without_authoritative_total', 'monetary_source_incoherent'],
      ['user_items_present_final_total_absent']
    );
  }

  if (hasFinalTotal && !userParsed.ok) {
    return incoherent(
      ['final_total_without_matching_item_layer', 'monetary_source_incoherent'],
      ['final_total_present_user_items_absent']
    );
  }

  if (hasUserItemsField && userParsed.ok && hasFinalTotal && !userEdited) {
    return incoherent(
      ['inconsistent_legacy_user_edit_metadata', 'monetary_source_incoherent'],
      ['user_items_and_final_total_but_user_edited_flag_off']
    );
  }

  if (userEdited && !hasUserItemsField && !hasFinalTotal) {
    return incoherent(
      ['inconsistent_legacy_user_edit_metadata', 'monetary_source_incoherent'],
      ['user_edited_flag_without_monetary_layers']
    );
  }

  // --- Coherent user monetary layer ---
  if (userEdited && userParsed.ok && hasFinalTotal) {
    const paidTotal = Number(receipt.final_total);
    evidence.push('monetary_layer=user', 'paid_total_from_final_total');
    // Inherit ONLY genuine receipt-level remainder from resolved OCR ownership.
    // unresolved leftovers are never inherited (blocked above).
    return {
      coherent: true,
      layer: 'user',
      items: userParsed.items,
      ocrDiscounts,
      receiptLevelUnallocatedDiscountTotal:
        ownership.genuineReceiptLevelRemainder,
      analyticsItemSumOverride: null,
      paidTotal: Number.isFinite(paidTotal) ? paidTotal : null,
      discountReconciliationAmbiguous: false,
      discountOwnershipStatus: ownership.status,
      reasonCodes: [],
      evidence,
    };
  }

  // --- Coherent OCR monetary layer ---
  const ocrTotal = Number(receipt.total);
  evidence.push('monetary_layer=ocr', 'paid_total_from_receipt_total');
  return {
    coherent: true,
    layer: 'ocr',
    items: ownership.items,
    ocrDiscounts,
    receiptLevelUnallocatedDiscountTotal:
      ownership.genuineReceiptLevelRemainder,
    analyticsItemSumOverride: ownership.analyticsItemSum,
    paidTotal: Number.isFinite(ocrTotal) ? ocrTotal : null,
    discountReconciliationAmbiguous: false,
    discountOwnershipStatus: ownership.status,
    reasonCodes: [],
    evidence,
  };
}

export function sumBundleAnalyticsItemAmounts(
  items: DiscountableItem[]
): number {
  let sum = 0;
  for (const item of items) {
    const amount = itemAmountForAnalytics(item);
    if (!Number.isFinite(amount)) continue;
    sum += amount;
  }
  return roundMoney(sum);
}

export function bundleHasMeaningfulItemMonetaryEvidence(
  items: DiscountableItem[]
): boolean {
  if (!Array.isArray(items) || items.length === 0) return false;
  for (const item of items) {
    const amount = itemAmountForAnalytics(item);
    if (Number.isFinite(amount) && amount > 0) return true;
  }
  return false;
}

export { hasFinitePositive };
