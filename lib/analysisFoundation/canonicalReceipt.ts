/**
 * A1 — Physical receipt canonicalization (read-only).
 *
 * Reuses Analysis D duplicate fingerprints/grouping. Does not delete or merge stored rows.
 * Representative quality SSOT: lib/receiptRepresentativeQuality.ts
 */

import type { ReceiptRow } from '../db';
import {
  buildHighConfidenceDuplicateGroups,
  summarizeReceiptForDuplicateAudit,
  type AnalysisDDuplicateGroup,
  type AnalysisDDuplicateReceiptSummary,
} from '../analysisDDuplicateAudit';
import {
  pickBestRepresentativeReceiptId,
} from '../receiptRepresentativeQuality';
import { applyEvidenceAwareRepresentativeOverride } from './evidenceAwareRepresentative';
import type {
  CanonicalReceiptConfidence,
  CanonicalReceiptGroup,
} from './types';

export {
  scoreReceiptRepresentativeQuality,
  pickBestRepresentativeReceiptId,
} from '../receiptRepresentativeQuality';

export {
  applyEvidenceAwareRepresentativeOverride,
  isTrustedMonetaryRepresentative,
} from './evidenceAwareRepresentative';

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

export function pickCanonicalRepresentativeReceipt(
  members: ReceiptRow[],
  summaries: AnalysisDDuplicateReceiptSummary[]
): ReceiptRow {
  const receiptById = new Map(members.map((r) => [r.id, r]));
  const memberSummaries = summaries.filter((s) => receiptById.has(s.receiptId));
  const id = pickBestRepresentativeReceiptId(memberSummaries, receiptById);
  return receiptById.get(id)!;
}

function mapDuplicateGroup(
  group: AnalysisDDuplicateGroup,
  receiptById: Map<string, ReceiptRow>
): CanonicalReceiptGroup {
  const sourceReceiptIds = [...group.receiptIds].sort();
  const baselineRepresentativeId =
    receiptById.has(group.representativeReceiptId) &&
    sourceReceiptIds.includes(group.representativeReceiptId)
      ? group.representativeReceiptId
      : pickCanonicalRepresentativeReceipt(
          sourceReceiptIds
            .map((id) => receiptById.get(id))
            .filter((r): r is ReceiptRow => r != null),
          group.members
        ).id;

  // A1.4B-1: strict trusted-monetary override only. Membership unchanged.
  const override = applyEvidenceAwareRepresentativeOverride({
    baselineRepresentativeId,
    sourceReceiptIds,
    receiptById,
    memberSummaries: group.members,
  });

  const representativeReceipt = receiptById.get(override.representativeId)!;
  const semanticEvidence = group.semanticRescanEvidence;
  const semanticDiff =
    semanticEvidence == null
      ? []
      : semanticEvidence.quantityConflicts.map(
          (c) =>
            `observation_quantity_conflict;left_receipt_id=${c.leftReceiptId};right_receipt_id=${c.rightReceiptId};item_index=${c.itemIndex};left_quantity=${c.leftQuantity};right_quantity=${c.rightQuantity};line_amount=${c.lineAmount}`
        );
  const overrideEvidence =
    override.changed
      ? [
          `evidence_aware_representative_override;baseline=${override.baselineRepresentativeId};selected=${override.representativeId};reason=${override.reason}`,
        ]
      : [`evidence_aware_representative_policy;reason=${override.reason}`];
  return {
    ephemeralSnapshotGroupId: buildEphemeralSnapshotGroupId(group.receiptIds),
    representativeReceipt,
    sourceReceiptIds,
    duplicateCount: Math.max(0, group.receiptIds.length - 1),
    confidence: group.confidence as CanonicalReceiptConfidence,
    evidence: [
      ...group.matchingEvidence,
      ...group.differenceEvidence,
      ...semanticDiff,
      `representative_receipt_id=${representativeReceipt.id}`,
      `duplicate_confidence=${group.confidence}`,
      'ephemeral_snapshot_group_id_not_persistent_physical_identity',
      ...overrideEvidence,
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
  const duplicateGroups = buildHighConfidenceDuplicateGroups(
    summaries,
    receipts
  );

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

export function indexCanonicalReceiptGroupsByReceiptId(
  groups: readonly CanonicalReceiptGroup[]
): Map<string, CanonicalReceiptGroup> {
  const map = new Map<string, CanonicalReceiptGroup>();
  for (const g of groups) {
    for (const id of g.sourceReceiptIds) map.set(id, g);
  }
  return map;
}

/** True when this receipt id is a non-representative member of a high-confidence group. */
export function isDuplicateReceiptExtra(
  receiptId: string,
  groups: readonly CanonicalReceiptGroup[]
): boolean {
  for (const g of groups) {
    if (!g.sourceReceiptIds.includes(receiptId)) continue;
    if (g.duplicateCount === 0) return false;
    return g.representativeReceipt.id !== receiptId;
  }
  return false;
}
