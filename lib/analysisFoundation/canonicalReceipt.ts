/**
 * A1 — Physical receipt canonicalization (read-only).
 *
 * Reuses Analysis D duplicate fingerprints/grouping. Does not delete or merge stored rows.
 */

import type { ReceiptRow } from '../db';
import {
  buildHighConfidenceDuplicateGroups,
  summarizeReceiptForDuplicateAudit,
  type AnalysisDDuplicateGroup,
  type AnalysisDDuplicateReceiptSummary,
} from '../analysisDDuplicateAudit';
import { getReceiptItems } from '../receiptItems';
import type {
  CanonicalReceiptConfidence,
  CanonicalReceiptGroup,
} from './types';

function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Ephemeral snapshot group id for the current membership set only.
 * NOT a persistent physical-receipt identity — membership changes may change the id.
 */
export function buildEphemeralSnapshotGroupId(
  sourceReceiptIds: readonly string[]
): string {
  const sorted = [...sourceReceiptIds].sort();
  return `crg_${fnv1aHex(sorted.join('\u001f'))}`;
}

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
  if (typeof item.normalized_full_name === 'string' && item.normalized_full_name.trim()) {
    score += 5;
  }
  return score;
}

/**
 * Representative quality score — higher is better.
 * User-edited receipts win; amount closure and completeness follow.
 * Does NOT prefer "latest scan" by default.
 */
export function scoreReceiptRepresentativeQuality(
  receipt: ReceiptRow,
  summary: AnalysisDDuplicateReceiptSummary
): number {
  let score = 0;

  if (receipt.user_edited === 1) score += 10_000;
  if (receipt.user_items_json?.trim()) score += 500;

  const closureGap = Math.abs(summary.merchandiseSum - summary.total);
  score += Math.max(0, 800 - Math.round(closureGap * 20));

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

export function pickCanonicalRepresentativeReceipt(
  members: ReceiptRow[],
  summaries: AnalysisDDuplicateReceiptSummary[]
): ReceiptRow {
  const summaryById = new Map(summaries.map((s) => [s.receiptId, s]));
  const sorted = [...members].sort((a, b) => {
    const sa = summaryById.get(a.id)!;
    const sb = summaryById.get(b.id)!;
    const qa = scoreReceiptRepresentativeQuality(a, sa);
    const qb = scoreReceiptRepresentativeQuality(b, sb);
    if (qa !== qb) return qb - qa;
    if (sa.createdAt !== sb.createdAt) return sa.createdAt - sb.createdAt;
    return a.id.localeCompare(b.id);
  });
  return sorted[0]!;
}

function mapDuplicateGroup(
  group: AnalysisDDuplicateGroup,
  receiptById: Map<string, ReceiptRow>
): CanonicalReceiptGroup {
  const members = group.receiptIds
    .map((id) => receiptById.get(id))
    .filter((r): r is ReceiptRow => r != null);
  const representativeReceipt = pickCanonicalRepresentativeReceipt(
    members,
    group.members
  );
  return {
    ephemeralSnapshotGroupId: buildEphemeralSnapshotGroupId(group.receiptIds),
    representativeReceipt,
    sourceReceiptIds: [...group.receiptIds].sort(),
    duplicateCount: Math.max(0, group.receiptIds.length - 1),
    confidence: group.confidence as CanonicalReceiptConfidence,
    evidence: [
      ...group.matchingEvidence,
      `representative_receipt_id=${representativeReceipt.id}`,
      `duplicate_confidence=${group.confidence}`,
      'ephemeral_snapshot_group_id_not_persistent_physical_identity',
    ],
  };
}

function singletonGroup(receipt: ReceiptRow): CanonicalReceiptGroup {
  return {
    ephemeralSnapshotGroupId: buildEphemeralSnapshotGroupId([receipt.id]),
    representativeReceipt: receipt,
    sourceReceiptIds: [receipt.id],
    duplicateCount: 0,
    confidence: 'SINGLETON',
    evidence: [
      'singleton_stored_receipt',
      'no_high_confidence_duplicate_group',
      'ephemeral_snapshot_group_id_not_persistent_physical_identity',
    ],
  };
}

/**
 * Build canonical receipt groups for all stored receipts.
 * High-confidence duplicates collapse to one group; every receipt id appears exactly once.
 */
export function buildCanonicalReceiptGroups(
  receipts: ReceiptRow[]
): CanonicalReceiptGroup[] {
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const summaries = receipts.map(summarizeReceiptForDuplicateAudit);
  const duplicateGroups = buildHighConfidenceDuplicateGroups(summaries);

  const groupedIds = new Set<string>();
  const out: CanonicalReceiptGroup[] = [];

  for (const group of duplicateGroups) {
    for (const id of group.receiptIds) groupedIds.add(id);
    out.push(mapDuplicateGroup(group, receiptById));
  }

  for (const receipt of receipts) {
    if (groupedIds.has(receipt.id)) continue;
    out.push(singletonGroup(receipt));
  }

  out.sort((a, b) => {
    const ta =
      a.representativeReceipt.transaction_at ??
      a.representativeReceipt.created_at;
    const tb =
      b.representativeReceipt.transaction_at ??
      b.representativeReceipt.created_at;
    if (ta !== tb) return tb - ta;
    return a.ephemeralSnapshotGroupId.localeCompare(b.ephemeralSnapshotGroupId);
  });

  return out;
}

/** Lookup: receipt id → canonical group (if built from same receipt set). */
export function indexCanonicalReceiptGroupsByReceiptId(
  groups: CanonicalReceiptGroup[]
): Map<string, CanonicalReceiptGroup> {
  const map = new Map<string, CanonicalReceiptGroup>();
  for (const group of groups) {
    for (const id of group.sourceReceiptIds) {
      map.set(id, group);
    }
  }
  return map;
}

/** True when receipt is a non-representative duplicate in a high-confidence group. */
export function isDuplicateReceiptExtra(
  receiptId: string,
  groups: CanonicalReceiptGroup[]
): boolean {
  const group = groups.find((g) => g.sourceReceiptIds.includes(receiptId));
  if (!group) return false;
  if (group.duplicateCount === 0) return false;
  return group.representativeReceipt.id !== receiptId;
}
