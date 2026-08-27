/**
 * A1.4A — Raw authoritative item validation before normalized summary use.
 *
 * Presence-aware fail-closed: ABSENT field != MALFORMED PRESENT field.
 */

import type { ReceiptRow } from '../db';
import { AMOUNT_BASIS_TOLERANCE_JPY } from '../analysisFoundation/amountBasis';
import type {
  RawItemBasketValidationResult,
  ValidatedRawItemRow,
} from './types';

const NAME_KEYS = [
  'name',
  'raw_name',
  'normalized_full_name',
  'product_name',
  'display_name',
] as const;

const AMOUNT_KEYS = [
  'lineTotal',
  'line_total',
  'amount',
  'effectiveLineTotal',
] as const;

function fieldPresent(row: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function parseAnalysisItems(receipt: ReceiptRow): unknown[] {
  try {
    const parsed = JSON.parse(receipt.analysis_json || '{}');
    if (!parsed || typeof parsed !== 'object') return [];
    const items = (parsed as { items?: unknown }).items;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function parseUserItems(receipt: ReceiptRow): unknown[] | null {
  const raw = receipt.user_items_json;
  if (raw == null || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readPresenceAwareName(
  row: Record<string, unknown>
): { ok: true; name: string } | { ok: false; reasonCodes: string[] } {
  for (const key of NAME_KEYS) {
    if (!fieldPresent(row, key)) continue;
    const value = row[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return { ok: true, name: trimmed };
      return { ok: false, reasonCodes: ['name_malformed_present_empty'] };
    }
    return { ok: false, reasonCodes: ['name_malformed_present_non_string'] };
  }
  return { ok: false, reasonCodes: ['name_missing'] };
}

function readPresenceAwareQuantity(
  row: Record<string, unknown>
):
  | { ok: true; evidence: ValidatedRawItemRow['quantityEvidence']; quantity: number }
  | { ok: false; reasonCodes: string[] } {
  if (!fieldPresent(row, 'quantity')) {
    return { ok: true, evidence: 'missing_default_one', quantity: 1 };
  }
  const raw = row.quantity;
  if (raw === null || raw === undefined) {
    return { ok: false, reasonCodes: ['quantity_malformed_present_null'] };
  }
  if (typeof raw !== 'number') {
    return { ok: false, reasonCodes: ['quantity_malformed_present_non_numeric'] };
  }
  if (!Number.isFinite(raw) || raw <= 0) {
    return { ok: false, reasonCodes: ['quantity_invalid_non_positive'] };
  }
  return { ok: true, evidence: 'explicit_positive', quantity: raw };
}

function readPresenceAwareLineAmount(
  row: Record<string, unknown>
): { ok: true; amount: number } | { ok: false; reasonCodes: string[] } {
  const presentValues: number[] = [];
  let anyPresent = false;

  for (const key of AMOUNT_KEYS) {
    if (!fieldPresent(row, key)) continue;
    anyPresent = true;
    const raw = row[key];
    if (raw === null || raw === undefined) {
      return { ok: false, reasonCodes: ['amount_malformed_present_null'] };
    }
    if (typeof raw !== 'number') {
      return { ok: false, reasonCodes: ['amount_malformed_present_non_numeric'] };
    }
    if (!Number.isFinite(raw) || raw <= 0) {
      return { ok: false, reasonCodes: ['amount_invalid_non_positive'] };
    }
    presentValues.push(raw);
  }

  if (!anyPresent) {
    return { ok: false, reasonCodes: ['amount_missing'] };
  }

  const first = presentValues[0]!;
  if (
    presentValues.some((n) => Math.abs(n - first) > AMOUNT_BASIS_TOLERANCE_JPY)
  ) {
    return { ok: false, reasonCodes: ['amount_conflicting_aliases'] };
  }

  return { ok: true, amount: first };
}

function validateRawItemRows(items: unknown[]): RawItemBasketValidationResult {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: 'empty_basket', reasonCodes: ['empty_basket'] };
  }

  const rows: ValidatedRawItemRow[] = [];
  const evidence: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const raw = items[index];
    if (!raw || typeof raw !== 'object') {
      return {
        ok: false,
        reason: `malformed_item_row_index_${index}`,
        reasonCodes: ['malformed_item_row'],
      };
    }
    const row = raw as Record<string, unknown>;

    const nameResult = readPresenceAwareName(row);
    if (!nameResult.ok) {
      return {
        ok: false,
        reason: `invalid_item_name_index_${index}`,
        reasonCodes: nameResult.reasonCodes,
      };
    }

    const qtyResult = readPresenceAwareQuantity(row);
    if (!qtyResult.ok) {
      return {
        ok: false,
        reason: `invalid_quantity_index_${index}`,
        reasonCodes: qtyResult.reasonCodes,
      };
    }
    if (qtyResult.evidence === 'missing_default_one') {
      evidence.push(`row_${index}_quantity_missing_default_one`);
    }

    const amountResult = readPresenceAwareLineAmount(row);
    if (!amountResult.ok) {
      return {
        ok: false,
        reason: `invalid_line_amount_index_${index}`,
        reasonCodes: amountResult.reasonCodes,
      };
    }

    rows.push({
      index,
      name: nameResult.name,
      quantityEvidence: qtyResult.evidence,
      quantity: qtyResult.quantity,
      lineAmount: amountResult.amount,
    });
  }

  return { ok: true, rows, evidence };
}

/** Validate OCR analysis_json items for shadow authorization. */
export function validateRawOcrItemBasket(
  receipt: ReceiptRow
): RawItemBasketValidationResult {
  return validateRawItemRows(parseAnalysisItems(receipt));
}

/** Validate user_items_json when user layer is authoritative. */
export function validateRawUserItemBasket(
  receipt: ReceiptRow
): RawItemBasketValidationResult {
  const userItems = parseUserItems(receipt);
  if (userItems == null) {
    return {
      ok: false,
      reason: 'user_items_unavailable',
      reasonCodes: ['user_items_unavailable'],
    };
  }
  return validateRawItemRows(userItems);
}

export function isShadowAuthorizingCurrency(currency: string): boolean {
  return currency.trim().toUpperCase() === 'JPY';
}

export function normalizeShadowCurrency(receipt: ReceiptRow): string {
  return String(receipt.currency ?? '').trim().toUpperCase();
}

export function rawBasketVectorsEqual(
  a: readonly ValidatedRawItemRow[],
  b: readonly ValidatedRawItemRow[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.quantity !== right.quantity) return false;
    if (Math.round(left.lineAmount * 100) !== Math.round(right.lineAmount * 100)) {
      return false;
    }
  }
  return true;
}
