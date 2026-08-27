/**
 * Pure Edge / DEV Gemini OCR analysis → ReceiptAnalysis conversion (no Expo deps).
 */

import type { ReceiptAnalysis, ReceiptItem } from './receiptAnalyzer';
import {
  applyPrintedEvidenceRootFields,
  mergePrintedEvidenceOntoReceiptItem,
  stampEvidenceCaptureVersion,
} from './receiptPrintedEvidence';

function readOcrTransactionDateStr(analysis: Record<string, unknown>): string | undefined {
  return (
    (typeof analysis.transactionDate === 'string' && analysis.transactionDate.trim()) ||
    (typeof analysis.transactionAt === 'string' && analysis.transactionAt.trim()) ||
    (typeof analysis.purchasedAt === 'string' && analysis.purchasedAt.trim()) ||
    (typeof analysis.datetime === 'string' && analysis.datetime.trim()) ||
    undefined
  );
}

function mapEdgeOcrItems(items: unknown): ReceiptItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const it =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const base: ReceiptItem = {
      name: typeof it.name === 'string' ? it.name : '',
      quantity: Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 1,
      unitPrice: Number.isFinite(Number(it.unitPrice)) ? Number(it.unitPrice) : 0,
      lineTotal: Number.isFinite(Number(it.lineTotal)) ? Number(it.lineTotal) : 0,
      categoryKey:
        typeof it.categoryKey === 'string'
          ? (it.categoryKey as ReceiptItem['categoryKey'])
          : undefined,
    };
    return mergePrintedEvidenceOntoReceiptItem(base, it);
  });
}

/**
 * Pure Edge OCR analysis → ReceiptAnalysis conversion.
 * Does NOT synthesize evidenceCaptureVersion; only preserves valid version 1 from Edge.
 */
export function convertEdgeOcrAnalysisResponse(
  analysis: Record<string, unknown>
): ReceiptAnalysis {
  const rootEvidence = applyPrintedEvidenceRootFields(analysis);
  return {
    merchant: typeof analysis.merchant === 'string' ? analysis.merchant : undefined,
    items: mapEdgeOcrItems(analysis.items),
    total: typeof analysis.total === 'number' ? analysis.total : 0,
    tax: typeof analysis.tax === 'number' && Number.isFinite(analysis.tax) ? analysis.tax : null,
    taxBreakdown: Array.isArray(analysis.taxBreakdown) ? analysis.taxBreakdown : undefined,
    currency:
      typeof analysis.currency === 'string' && analysis.currency.trim()
        ? analysis.currency
        : '¥',
    transactionDate: readOcrTransactionDateStr(analysis),
    discounts: Array.isArray(analysis.discounts)
      ? (analysis.discounts as ReceiptAnalysis['discounts'])
      : undefined,
    ...rootEvidence,
  };
}

/**
 * DEV direct-Gemini parsed payload → ReceiptAnalysis.
 * Local path implements G1-1 contract, so version 1 may be system-stamped.
 */
export function buildDirectGeminiReceiptAnalysisFromParsed(
  parsed: Record<string, unknown>,
  opts?: { ocrRawText?: string }
): ReceiptAnalysis {
  const rootEvidence = applyPrintedEvidenceRootFields(parsed);
  return {
    merchant: typeof parsed.merchant === 'string' ? parsed.merchant : undefined,
    items: mapEdgeOcrItems(parsed.items),
    total: typeof parsed.total === 'number' ? parsed.total : 0,
    tax: typeof parsed.tax === 'number' && Number.isFinite(parsed.tax) ? parsed.tax : null,
    taxBreakdown: Array.isArray(parsed.taxBreakdown) ? parsed.taxBreakdown : undefined,
    currency:
      typeof parsed.currency === 'string' && parsed.currency.trim()
        ? parsed.currency
        : '¥',
    transactionDate: readOcrTransactionDateStr(parsed),
    ocr_raw_text: opts?.ocrRawText,
    ...rootEvidence,
    evidenceCaptureVersion:
      rootEvidence.evidenceCaptureVersion ?? stampEvidenceCaptureVersion(),
  };
}
