/**
 * Shared representative quality scoring for high-confidence duplicate groups.
 *
 * SSOT used by:
 * - analysisDDuplicateAudit (group.representativeReceiptId / analytics)
 * - analysisFoundation/canonicalReceipt
 *
 * Does not prefer "latest scan" by default.
 * Higher score is better.
 *
 * Selection order (pickBestRepresentativeReceiptId):
 * 1. better amount closure (smaller |merchandiseSum - total|)
 * 2. tax known over tax unknown
 * 3. higher complete quality score (scoreReceiptRepresentativeQuality)
 * 4. earlier createdAt (deterministic tie-break only)
 * 5. receiptId ASC
 */

import type { ReceiptRow } from './db';
import { getReceiptItems } from './receiptItems';

/**
 * Minimal summary fields required for representative scoring.
 * Satisfied by AnalysisDDuplicateReceiptSummary without importing the audit module.
 */
export type RepresentativeQualitySummary = {
  receiptId: string;
  merchandiseSum: number;
  total: number;
  itemCount: number;
  hasExactTransactionTime: boolean;
  hasValidTransactionAt: boolean;
  taxKnown: boolean;
  structuralFingerprint: string | null;
  createdAt: number;
};

function readItemIdentityScore(item: Record<string, unknown>): number {
  let score = 0;
  if (typeof item.merchant_product_id === 'string' && item.merchant_product_id) {
    score += 40;
  }
  if (typeof item.canonical_product_id === 'string' && item.canonical_product_id) {
    score += 30;
  }
  const src = item.identity_source;
  if (typeof src === 'string' && src !== 'unknown') score += 15;
  const conf = item.identity_confidence;
  if (typeof conf === 'number' && Number.isFinite(conf)) {
    score += Math.min(15, Math.round(conf * 15));
  }
  if (
    typeof item.normalized_full_name === 'string' &&
    item.normalized_full_name.trim()
  ) {
    score += 5;
  }
  return score;
}

function closureGap(summary: RepresentativeQualitySummary): number {
  return Math.abs(summary.merchandiseSum - summary.total);
}

/**
 * Representative quality score — higher is better.
 * User-edited receipts win; amount closure and completeness follow.
 */
export function scoreReceiptRepresentativeQuality(
  receipt: ReceiptRow,
  summary: RepresentativeQualitySummary
): number {
  let score = 0;

  if (receipt.user_edited === 1) score += 10_000;
  if (receipt.user_items_json?.trim()) score += 500;

  const gap = closureGap(summary);
  score += Math.max(0, 800 - Math.round(gap * 20));

  score += summary.itemCount * 25;

  const items = getReceiptItems(receipt);
  let identityScore = 0;
  for (const raw of items) {
    identityScore += readItemIdentityScore(
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    );
  }
  score += identityScore;

  if (summary.hasExactTransactionTime) score += 120;
  else if (summary.hasValidTransactionAt) score += 40;
  if (summary.taxKnown) score += 60;

  if (receipt.final_total != null && Number.isFinite(receipt.final_total)) {
    score += 80;
  }
  if (receipt.note?.trim()) score += 10;

  // Mild preference for richer structural fingerprint support (not recency).
  if (summary.structuralFingerprint) score += 20;

  return score;
}

/** Summary-only fallback when ReceiptRow is unavailable (tests / partial callers). */
export function scoreRepresentativeSummaryOnly(
  summary: RepresentativeQualitySummary
): number {
  let score = 0;
  const gap = closureGap(summary);
  score += Math.max(0, 800 - Math.round(gap * 20));
  score += summary.itemCount * 25;
  if (summary.hasExactTransactionTime) score += 120;
  else if (summary.hasValidTransactionAt) score += 40;
  if (summary.taxKnown) score += 60;
  if (summary.structuralFingerprint) score += 20;
  return score;
}

function qualityScoreForMember(
  summary: RepresentativeQualitySummary,
  receiptById: ReadonlyMap<string, ReceiptRow>
): number {
  const receipt = receiptById.get(summary.receiptId);
  return receipt
    ? scoreReceiptRepresentativeQuality(receipt, summary)
    : scoreRepresentativeSummaryOnly(summary);
}

/**
 * Pick the best representative receipt id for a duplicate group.
 * Prefer full ReceiptRow scoring (user_edited / items / note) when available.
 *
 * Order:
 * 1. better amount closure
 * 2. tax known over tax unknown
 * 3. higher complete quality score
 * 4. earlier createdAt (tie-break only)
 * 5. receiptId ASC
 */
export function pickBestRepresentativeReceiptId(
  members: readonly RepresentativeQualitySummary[],
  receiptById: ReadonlyMap<string, ReceiptRow> = new Map()
): string {
  const sorted = [...members].sort((a, b) => {
    const gapA = closureGap(a);
    const gapB = closureGap(b);
    if (gapA !== gapB) return gapA - gapB;

    const taxA = a.taxKnown ? 1 : 0;
    const taxB = b.taxKnown ? 1 : 0;
    if (taxA !== taxB) return taxB - taxA;

    const qa = qualityScoreForMember(a, receiptById);
    const qb = qualityScoreForMember(b, receiptById);
    if (qa !== qb) return qb - qa;

    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.receiptId.localeCompare(b.receiptId);
  });
  return sorted[0]!.receiptId;
}
