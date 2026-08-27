/**
 * G1-1 — Printed evidence capture (additive, evidence-only).
 * Pure sanitizers; fail closed on ambiguous model output.
 */

import type { ReceiptItem } from './receiptAnalyzer';

export const EVIDENCE_CAPTURE_VERSION = 1 as const;

export type PrintedIdentifiers = {
  transactionId?: string;
  receiptNumber?: string;
  registerId?: string;
};

export type ReceiptItemPrintedEvidence = {
  merchantProductCode?: string;
  promoMarkers?: string[];
};

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Store-local printed product code — STRING ONLY; preserve leading zeros. */
export function sanitizeMerchantProductCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return trimNonEmptyString(value);
}

/** Verbatim short printed promo markers attached to a product line. */
export function sanitizePromoMarkers(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

export function sanitizePrintedIdentifiers(value: unknown): PrintedIdentifiers | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const transactionId = trimNonEmptyString(row.transactionId);
  const receiptNumber = trimNonEmptyString(row.receiptNumber);
  const registerId = trimNonEmptyString(row.registerId);
  if (!transactionId && !receiptNumber && !registerId) return undefined;
  return {
    ...(transactionId ? { transactionId } : {}),
    ...(receiptNumber ? { receiptNumber } : {}),
    ...(registerId ? { registerId } : {}),
  };
}

export function sanitizeItemPrintedEvidence(
  item: Record<string, unknown>
): ReceiptItemPrintedEvidence {
  const merchantProductCode = sanitizeMerchantProductCode(item.merchantProductCode);
  const promoMarkers = sanitizePromoMarkers(item.promoMarkers);
  return {
    ...(merchantProductCode ? { merchantProductCode } : {}),
    ...(promoMarkers ? { promoMarkers } : {}),
  };
}

/** Copy only G1-1 safe evidence fields from a raw OCR row. */
export function copyItemPrintedEvidenceFields(
  source: Record<string, unknown> | null | undefined
): ReceiptItemPrintedEvidence {
  if (!source || typeof source !== 'object') return {};
  return sanitizeItemPrintedEvidence(source);
}

export function sanitizeEvidenceCaptureVersion(
  value: unknown
): typeof EVIDENCE_CAPTURE_VERSION | undefined {
  return value === EVIDENCE_CAPTURE_VERSION ? EVIDENCE_CAPTURE_VERSION : undefined;
}

export function stampEvidenceCaptureVersion(): typeof EVIDENCE_CAPTURE_VERSION {
  return EVIDENCE_CAPTURE_VERSION;
}

export function applyPrintedEvidenceRootFields(
  analysis: Record<string, unknown>
): {
  printedIdentifiers?: PrintedIdentifiers;
  evidenceCaptureVersion?: typeof EVIDENCE_CAPTURE_VERSION;
} {
  const printedIdentifiers = sanitizePrintedIdentifiers(analysis.printedIdentifiers);
  const evidenceCaptureVersion = sanitizeEvidenceCaptureVersion(
    analysis.evidenceCaptureVersion
  );
  return {
    ...(printedIdentifiers ? { printedIdentifiers } : {}),
    ...(evidenceCaptureVersion ? { evidenceCaptureVersion } : {}),
  };
}

/** Fail-closed OCR item → ReceiptItem evidence fields only (caller supplies monetary fields). */
export function mergePrintedEvidenceOntoReceiptItem(
  item: ReceiptItem,
  source: Record<string, unknown> | null | undefined
): ReceiptItem {
  const evidence = copyItemPrintedEvidenceFields(source);
  if (!evidence.merchantProductCode && !evidence.promoMarkers) return item;
  return { ...item, ...evidence };
}

/**
 * Scan Review / save preservation merge seam.
 * Spreads snapshot first, then review overrides — evidence fields survive when present on snapshot.
 */
export function mergeReviewSnapshotPreservingEvidence<
  T extends Record<string, unknown>,
>(
  snapshot: T,
  overrides: Record<string, unknown>
): T & Record<string, unknown> {
  return { ...snapshot, ...overrides };
}

/**
 * Item-level Scan Review merge used by production save path.
 */
export function mergeReviewSnapshotItemForSave(args: {
  snapshotItem: Record<string, unknown>;
  name: string;
  category: string;
  quantity: number;
  lineTotal: number;
}): Record<string, unknown> {
  return mergeReviewSnapshotPreservingEvidence(args.snapshotItem, {
    name: args.name,
    category: args.category,
    quantity: args.quantity,
    lineTotal: args.lineTotal,
  });
}

/** Root-level Scan Review merge used by production save path. */
export function mergeReviewSnapshotAnalysisForSave(args: {
  snapshot: Record<string, unknown>;
  items: Record<string, unknown>[];
}): Record<string, unknown> {
  return mergeReviewSnapshotPreservingEvidence(args.snapshot, {
    items: args.items,
  });
}
