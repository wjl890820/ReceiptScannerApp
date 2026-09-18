/**
 * Phase 1 deterministic checks on stored snapshot/analysis payloads.
 * Does NOT claim re-normalize is "current OCR".
 */

import { buildReceiptItemIndexRows } from '../receiptItemIndex';
import { applyProductIdentityToItem } from '../receiptItemIdentity';
import { parseProductSpecification } from '../productSpecification';
import { deriveRetailerIdentity } from '../retailerIdentity';
import { projectCanonicalFromPayload } from './projectCanonical';
import type { DeterministicChecksResult } from './types';

/**
 * Run safe pure checks against the stored baseline payload.
 * ProductIdentity: per-item applyProductIdentityToItem (pure; no DB store).
 * Index: buildReceiptItemIndexRows (pure projection only).
 */
export function runDeterministicChecks(
  payload: Record<string, unknown>,
  rowHints?: {
    receiptId?: string;
    merchantRaw?: string | null;
    merchantNormalized?: string | null;
    total?: number | null;
    tax?: number | null;
    currency?: string | null;
    transactionAtMs?: number | null;
  }
): DeterministicChecksResult {
  const projection = projectCanonicalFromPayload(payload, rowHints);

  const retailer = deriveRetailerIdentity({
    merchantRaw: projection.merchantRaw,
    merchantNormalized: projection.merchantNormalized,
  });

  const quantityPriceIssues: string[] = [];
  let specParsedCount = 0;
  let identityProjected = false;

  const items = Array.isArray(payload.items) ? payload.items : [];
  const enrichedItems: unknown[] = [];

  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object') {
      enrichedItems.push(raw);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : '';
    const qty =
      typeof item.quantity === 'number'
        ? item.quantity
        : Number(item.quantity);
    const lineTotal =
      typeof item.lineTotal === 'number'
        ? item.lineTotal
        : typeof item.line_total === 'number'
          ? item.line_total
          : Number(item.lineTotal ?? item.line_total);
    const unitPrice =
      typeof item.unitPrice === 'number'
        ? item.unitPrice
        : typeof item.unit_price === 'number'
          ? item.unit_price
          : Number(item.unitPrice ?? item.unit_price);

    if (
      Number.isFinite(qty) &&
      qty > 0 &&
      Number.isFinite(unitPrice) &&
      Number.isFinite(lineTotal) &&
      Math.abs(qty * unitPrice - lineTotal) > 1
    ) {
      quantityPriceIssues.push(
        `item[${i}] qty*unitPrice!=lineTotal (${qty}*${unitPrice} vs ${lineTotal})`
      );
    }

    if (name) {
      const spec = parseProductSpecification(name);
      if (spec.sizeValue != null || spec.packCount != null) {
        specParsedCount += 1;
      }
    }

    const identified = applyProductIdentityToItem(item, {
      finalName: name || null,
      finalCategory:
        typeof item.category === 'string' ? item.category : null,
      merchantName: projection.merchantRaw,
      useExistingClassificationEvidence: true,
    });
    identityProjected = true;
    enrichedItems.push({ ...item, ...identified });
  }

  // Pure index projection via synthetic receipt SoT (no DB write).
  const analysisForIndex = {
    ...payload,
    items: enrichedItems,
    merchant: projection.merchantRaw ?? payload.merchant,
    total: projection.total ?? payload.total,
    tax: projection.tax ?? payload.tax,
    currency: projection.currency ?? payload.currency,
  };
  const analysisJson = JSON.stringify(analysisForIndex);
  const indexRows = buildReceiptItemIndexRows({
    id: rowHints?.receiptId ?? 'regression-temp',
    analysis_json: analysisJson,
    user_items_json: null,
  });

  // Re-project so identity fields appear in current projection items.
  const currentProjection = projectCanonicalFromPayload(analysisForIndex, rowHints);

  return {
    projection: currentProjection,
    retailerKey: retailer.retailerKey,
    retailerDisplayName: retailer.retailerDisplayName,
    indexRowCount: indexRows.length,
    identityProjected,
    quantityPriceIssues,
    specParsedCount,
    normalizeReplayExperimental: null,
  };
}
