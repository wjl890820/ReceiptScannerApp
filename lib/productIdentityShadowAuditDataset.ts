/**
 * Product Identity Shadow Audit — Analysis D dataset wiring (Batch 3.1).
 * Used only by the live shadow audit test. Keeps analytics/db imports out of
 * the pure in-memory shadow audit module.
 */

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { isV1SupportedReceipt } from './merchantType';
import type { ReceiptRow } from './db';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import {
  observationsFromProductIntelligenceExport,
  runShadowIdentityAudit,
  type ProductIntelligenceExportPayload,
  type ShadowDatasetSummary,
  type ShadowIdentityAuditReport,
  type ShadowIdentityObservation,
} from './productIdentityShadowAudit';

function parseMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function asJsonString(value: unknown): string {
  if (value == null) return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function asJsonStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function as01(value: unknown): number {
  if (value === true || value === 1 || value === '1') return 1;
  if (typeof value === 'number' && value !== 0) return 1;
  return 0;
}

export function receiptRowFromIntelligenceExport(
  raw: Record<string, unknown>
): ReceiptRow {
  return {
    id: String(raw.id ?? ''),
    created_at: parseMs(raw.created_at) ?? parseMs(raw.scanned_at) ?? 0,
    transaction_at: parseMs(raw.transaction_at),
    image_uri: '',
    merchant_raw: (raw.merchant_raw as string | null) ?? null,
    merchant_normalized: (raw.merchant_normalized as string | null) ?? null,
    merchant_type: (raw.merchant_type as ReceiptRow['merchant_type']) ?? null,
    store_raw: (raw.store_raw as string | null) ?? null,
    store_normalized: (raw.store_normalized as string | null) ?? null,
    total: Number(raw.total ?? 0) || 0,
    tax: Number(raw.tax ?? 0) || 0,
    tax_is_known: as01(raw.tax_is_known),
    currency: String(raw.currency ?? 'JPY'),
    analysis_json: asJsonString(raw.analysis_json),
    user_edited: as01(raw.user_edited),
    final_total:
      raw.final_total == null || raw.final_total === ''
        ? null
        : Number(raw.final_total),
    final_category: (raw.final_category as string | null) ?? null,
    note: (raw.note as string | null) ?? null,
    user_items_json: asJsonStringOrNull(raw.user_items_json),
    transaction_source: (raw.transaction_source as string | null) ?? null,
    ocr_request_id: (raw.ocr_request_id as string | null) ?? null,
  };
}

export function buildDedupedShadowObservations(
  payload: ProductIntelligenceExportPayload,
  opts?: { applyV1MerchantFilter?: boolean }
): {
  dataset: ShadowDatasetSummary;
  observations: ShadowIdentityObservation[];
} {
  const applyV1 = opts?.applyV1MerchantFilter !== false;
  const receiptRows = (payload.receipts ?? []).map(receiptRowFromIntelligenceExport);
  const selection = selectAnalyticsReceipts(receiptRows);

  let purchaseReceipts = selection.analyticsReceipts;
  if (applyV1) {
    purchaseReceipts = purchaseReceipts.filter(isV1SupportedReceipt);
  }
  const allowedIds = new Set(purchaseReceipts.map((r) => r.id));

  const allObs = observationsFromProductIntelligenceExport(payload);
  const observations = allObs.filter((o) => allowedIds.has(o.receiptId));

  return {
    dataset: {
      storedReceiptCount: selection.storedReceipts.length,
      purchaseCandidateCount: selection.analyticsPurchaseCandidateCount,
      duplicateExtrasExcluded: selection.highConfidenceDuplicateExtras,
      contentExactExtras: selection.contentExactDuplicateExtras,
      structuralExactExtras: selection.structuralExactDuplicateExtras,
      reconciledStructuralExtras:
        selection.reconciledStructuralExactDuplicateExtras,
      v1SupportedPurchaseCandidateCount: purchaseReceipts.length,
      eligibleItemObservations: observations.length,
      appliedV1MerchantFilter: applyV1,
    },
    observations,
  };
}

export function runDedupedShadowIdentityAudit(
  payload: ProductIntelligenceExportPayload,
  opts?: { applyV1MerchantFilter?: boolean }
): ShadowIdentityAuditReport {
  const { dataset, observations } = buildDedupedShadowObservations(payload, opts);
  return runShadowIdentityAudit(
    observations,
    createMemoryProductIdentityStore(),
    dataset
  );
}
