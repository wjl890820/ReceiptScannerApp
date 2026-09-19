/**
 * Phase 2 — build offline historical receipt + item datasets.
 * Pure projection only. No DB writes / OCR / network.
 */

import type { ReceiptRow } from '../db';
import { inferReceiptTransactionTimePrecision } from '../dateParser';
import { applyProductIdentityToItem } from '../receiptItemIdentity';
import {
  buildReceiptItemIndexRows,
  type ReceiptItemIndexRow,
} from '../receiptItemIndex';
import type { ProductPriceHistoryRow } from '../productPriceHistory';
import type { RepeatProductRowInput } from '../repeatProductProfile';
import { loadHistoricalRow, type ExportEnvelope } from './parseExport';
import type { BaselineStage, LoadedHistoricalRow } from './types';

export type HistoricalReceiptMeta = {
  receiptId: string;
  createdAt: number | null;
  transactionAt: number | null;
  /** Production COALESCE(transaction_at, created_at). */
  occurredAt: number;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  currency: string | null;
  total: number | null;
  tax: number | null;
  taxIsKnown: number | null;
  baselineStage: BaselineStage;
  fallbackReason: string | null;
  parseError: string | null;
};

export type HistoricalItemObservation = RepeatProductRowInput & {
  itemId: string;
  skuKey: string | null;
  productFamilyKey: string | null;
  volumeBaseMl: number | null;
  weightBaseG: number | null;
  countBase: number | null;
  grossLineAmount: number | null;
  effectiveLineAmount: number | null;
  discountAllocated: number | null;
  amountProvenance: string | null;
  itemAmountEvidenceState: string | null;
  unitPrice: number | null;
  identitySource: string | null;
  identityConfidence: number | null;
  currency: string | null;
  transactionAt: number | null;
  createdAt: number | null;
};

export type HistoricalIndexDataset = {
  inputMode: 'current_projection';
  loadedRows: LoadedHistoricalRow[];
  /** Synthetic ReceiptRow[] for analytics SSOT (stored columns + baseline analysis). */
  rawReceiptRows: ReceiptRow[];
  rawItemRows: HistoricalItemObservation[];
  /** ProductPriceHistoryRow[] before analytics collapse. */
  rawPriceHistoryRows: ProductPriceHistoryRow[];
  receiptMetaById: Map<string, HistoricalReceiptMeta>;
  indexRowsByReceiptId: Map<string, ReceiptItemIndexRow[]>;
  usableReceiptCount: number;
  skippedReceiptIds: string[];
};

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function stringifyJsonColumn(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function productionOccurredAt(
  transactionAt: number | null,
  createdAt: number | null
): number {
  if (typeof transactionAt === 'number' && Number.isFinite(transactionAt)) {
    return transactionAt;
  }
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
    return createdAt;
  }
  return 0;
}

function enrichBaselineItems(
  payload: Record<string, unknown>,
  merchantRaw: string | null
): Record<string, unknown> {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const enrichedItems: unknown[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      enrichedItems.push(raw);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : '';
    const identified = applyProductIdentityToItem(item, {
      finalName: name || null,
      finalCategory:
        typeof item.category === 'string' ? item.category : null,
      merchantName: merchantRaw,
      useExistingClassificationEvidence: true,
    });
    enrichedItems.push({ ...item, ...identified });
  }
  return { ...payload, items: enrichedItems };
}

function displayNameFromIndex(row: ReceiptItemIndexRow): string {
  return (
    (row.normalized_full_name || '').trim() ||
    (row.raw_name || '').trim() ||
    (row.canonical_product_name || '').trim() ||
    (row.normalized_name || '').trim() ||
    ''
  );
}

/**
 * Build historical index + synthetic ReceiptRows from an export envelope.
 *
 * Analytics ReceiptRows preserve stored DB columns (HC fidelity).
 * Item / PPH projection uses production current authority:
 *   valid user_items_json → else analysis_json
 * recognition_snapshot_json is diagnostic only (not current item authority).
 */
export function buildHistoricalIndexFromEnvelope(
  envelope: ExportEnvelope
): HistoricalIndexDataset {
  const rawReceiptRows: ReceiptRow[] = [];
  const rawItemRows: HistoricalItemObservation[] = [];
  const rawPriceHistoryRows: ProductPriceHistoryRow[] = [];
  const receiptMetaById = new Map<string, HistoricalReceiptMeta>();
  const indexRowsByReceiptId = new Map<string, ReceiptItemIndexRow[]>();
  const loadedRows: LoadedHistoricalRow[] = [];
  const skippedReceiptIds: string[] = [];

  for (let rowIndex = 0; rowIndex < envelope.receipts.length; rowIndex += 1) {
    const raw = envelope.receipts[rowIndex]!;
    const rawObj =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const loaded = loadHistoricalRow(rawObj, rowIndex);
    loadedRows.push(loaded);

    const storedAnalysisJson = stringifyJsonColumn(rawObj.analysis_json);
    const storedSnapshotJson = stringifyJsonColumn(
      rawObj.recognition_snapshot_json
    );
    const storedUserItemsJson = stringifyJsonColumn(rawObj.user_items_json);

    // Current authority requires analysis_json and/or user_items_json.
    if (!storedAnalysisJson && !storedUserItemsJson) {
      skippedReceiptIds.push(loaded.receiptId);
      continue;
    }

    const createdAt = loaded.createdAt;
    const transactionAt = loaded.transactionAt;
    const occurredAt = productionOccurredAt(transactionAt, createdAt);
    const analysisObj =
      loaded.analysisObject ??
      (storedAnalysisJson
        ? (() => {
            try {
              const p = JSON.parse(storedAnalysisJson);
              return p && typeof p === 'object' && !Array.isArray(p)
                ? (p as Record<string, unknown>)
                : null;
            } catch {
              return null;
            }
          })()
        : null);
    const merchantRaw =
      loaded.merchantRaw ??
      asTrimmedString(analysisObj?.merchant) ??
      null;
    const merchantNormalized = loaded.merchantNormalized;
    const currency =
      loaded.currency ?? asTrimmedString(analysisObj?.currency) ?? null;
    const total = loaded.total ?? asFiniteNumber(analysisObj?.total);
    const tax = loaded.tax ?? asFiniteNumber(analysisObj?.tax);
    const taxIsKnown =
      asFiniteNumber(rawObj.tax_is_known) ??
      (analysisObj?.tax_is_known === true
        ? 1
        : analysisObj?.tax_is_known === false
          ? 0
          : asFiniteNumber(analysisObj?.tax_is_known));

    // Enrich current analysis items with pure identity projection (not snapshot).
    let analysisForIndex = storedAnalysisJson ?? '{}';
    if (analysisObj) {
      const enriched = enrichBaselineItems(analysisObj, merchantRaw);
      analysisForIndex = JSON.stringify({
        ...enriched,
        merchant: merchantRaw ?? enriched.merchant,
        total: total ?? enriched.total,
        tax: tax ?? enriched.tax,
        currency: currency ?? enriched.currency,
      });
    }

    const indexRows = buildReceiptItemIndexRows({
      id: loaded.receiptId,
      analysis_json: analysisForIndex,
      user_items_json: storedUserItemsJson,
    });
    indexRowsByReceiptId.set(loaded.receiptId, indexRows);

    const userEdited = asFiniteNumber(rawObj.user_edited) ?? 0;
    const finalTotal = asFiniteNumber(rawObj.final_total);
    const note = asTrimmedString(rawObj.note);

    const storedPrecision = asTrimmedString(rawObj.transaction_time_precision);
    let transactionTimePrecision =
      storedPrecision === 'second' ||
      storedPrecision === 'minute' ||
      storedPrecision === 'date' ||
      storedPrecision === 'unknown'
        ? storedPrecision
        : null;
    if (!transactionTimePrecision && analysisObj) {
      const dateText =
        asTrimmedString(analysisObj.transactionDate) ??
        asTrimmedString(analysisObj.transaction_date) ??
        asTrimmedString(analysisObj.transactionAt) ??
        asTrimmedString(analysisObj.purchasedAt) ??
        asTrimmedString(analysisObj.datetime);
      if (dateText) {
        transactionTimePrecision =
          inferReceiptTransactionTimePrecision(dateText);
      }
    }

    const receiptRow: ReceiptRow = {
      id: loaded.receiptId,
      created_at: createdAt ?? 0,
      transaction_at: transactionAt,
      transaction_time_precision: transactionTimePrecision ?? 'unknown',
      image_uri: asTrimmedString(rawObj.image_uri) ?? '',
      merchant_raw: merchantRaw,
      merchant_normalized: merchantNormalized,
      merchant_type:
        (asTrimmedString(rawObj.merchant_type) as ReceiptRow['merchant_type']) ??
        null,
      total: total ?? 0,
      tax: tax ?? 0,
      tax_is_known: taxIsKnown ?? undefined,
      currency: currency ?? '',
      analysis_json: storedAnalysisJson ?? analysisForIndex,
      recognition_snapshot_json: storedSnapshotJson,
      user_edited: userEdited,
      final_total: finalTotal,
      final_category: asTrimmedString(rawObj.final_category),
      note,
      user_items_json: storedUserItemsJson,
    };
    rawReceiptRows.push(receiptRow);

    receiptMetaById.set(loaded.receiptId, {
      receiptId: loaded.receiptId,
      createdAt,
      transactionAt,
      occurredAt,
      merchantRaw,
      merchantNormalized,
      currency,
      total,
      tax,
      taxIsKnown,
      baselineStage: loaded.baselineStage,
      fallbackReason: loaded.fallbackReason,
      parseError: loaded.parseError,
    });

    for (const indexRow of indexRows) {
      const displayName = displayNameFromIndex(indexRow);
      const observation: HistoricalItemObservation = {
        receiptId: loaded.receiptId,
        sourceIndex: indexRow.source_index,
        occurredAt,
        displayName,
        merchantNormalized,
        merchantRaw,
        lineTotal: indexRow.line_total,
        purchaseQuantity: indexRow.purchase_quantity,
        itemId: indexRow.id,
        skuKey: indexRow.sku_key,
        productFamilyKey: indexRow.product_family_key,
        volumeBaseMl: indexRow.volume_base_ml,
        weightBaseG: indexRow.weight_base_g,
        countBase: indexRow.count_base,
        grossLineAmount: indexRow.gross_line_amount,
        effectiveLineAmount: indexRow.effective_line_amount,
        discountAllocated: indexRow.discount_allocated,
        amountProvenance: indexRow.amount_provenance,
        itemAmountEvidenceState: indexRow.item_amount_evidence_state,
        unitPrice: indexRow.purchase_unit_price,
        identitySource: indexRow.identity_source,
        identityConfidence: indexRow.identity_confidence,
        currency,
        transactionAt,
        createdAt,
      };
      rawItemRows.push(observation);

      rawPriceHistoryRows.push({
        receiptId: loaded.receiptId,
        itemId: indexRow.id,
        sourceIndex: indexRow.source_index,
        occurredAt,
        merchantRaw,
        merchantNormalized,
        displayName,
        currency,
        lineTotal: indexRow.line_total,
        purchaseQuantity: indexRow.purchase_quantity,
        skuKey: indexRow.sku_key,
        productFamilyKey: indexRow.product_family_key,
        volumeBaseMl: indexRow.volume_base_ml,
        weightBaseG: indexRow.weight_base_g,
        countBase: indexRow.count_base,
        grossLineAmount: indexRow.gross_line_amount,
        effectiveLineAmount: indexRow.effective_line_amount,
        discountAllocated: indexRow.discount_allocated,
        amountProvenance: indexRow.amount_provenance,
        itemAmountEvidenceState: indexRow.item_amount_evidence_state,
        promoMarkersJson: indexRow.promo_markers_json,
        evidenceCaptureVersion: indexRow.evidence_capture_version,
        priceObservationVersion: indexRow.price_observation_version,
        itemSource: indexRow.item_source,
        identitySource: indexRow.identity_source,
        identityConfidence: indexRow.identity_confidence,
        // Current analysis authority for monetary overlay; user_items separate.
        receiptAnalysisJson: analysisForIndex,
        receiptRecognitionSnapshotJson: storedSnapshotJson,
        receiptUserItemsJson: storedUserItemsJson,
        receiptUserEdited: userEdited,
        receiptTotal: total,
        receiptFinalTotal: finalTotal,
        receiptTax: tax,
        receiptTaxIsKnown: taxIsKnown,
        receiptCurrency: currency,
        receiptTransactionAt: transactionAt,
        receiptCreatedAt: createdAt,
      });
    }
  }

  return {
    inputMode: 'current_projection',
    loadedRows,
    rawReceiptRows,
    rawItemRows,
    rawPriceHistoryRows,
    receiptMetaById,
    indexRowsByReceiptId,
    usableReceiptCount: rawReceiptRows.length,
    skippedReceiptIds,
  };
}
