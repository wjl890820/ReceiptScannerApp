/**
 * Pure verified-occurrence assignment decision.
 * Callers supply rows already read under their own authority.
 * This module does not touch SQLite, outbox, or caches.
 */

import {
  classifyVerifiedPurchaseOccurrenceBundle,
  type VerifiedPurchaseOccurrenceSource,
} from './verifiedPurchaseOccurrenceProvenance';

export type VerifiedOccurrencePlanRow = {
  id: string;
  verified_purchase_occurrence_id: string | null;
  verified_purchase_occurrence_source: string | null;
  verified_purchase_occurrence_verified_at: number | null;
};

export type VerifiedOccurrenceProvenanceReport = {
  receiptId: string;
  state: 'unassigned' | 'assigned' | 'invalid';
  occurrenceId: string | null;
  source: VerifiedPurchaseOccurrenceSource | null;
  verifiedAt: number | null;
  invalidReason: string | null;
};

type ClassifiedMember = VerifiedOccurrencePlanRow & {
  bundle: ReturnType<typeof classifyVerifiedPurchaseOccurrenceBundle>;
};

export type VerifiedOccurrenceAssignmentDecision =
  | {
      status: 'READY_CREATE_NEW';
      provenance: VerifiedOccurrenceProvenanceReport[];
      toAssignReceiptIds: string[];
      unchangedReceiptIds: string[];
    }
  | {
      status: 'READY_ADOPT_EXISTING';
      occurrenceId: string;
      existingSource: VerifiedPurchaseOccurrenceSource;
      provenance: VerifiedOccurrenceProvenanceReport[];
      toAssignReceiptIds: string[];
      unchangedReceiptIds: string[];
    }
  | {
      status: 'READY_ASSIGN_SUPPLIED';
      occurrenceId: string;
      existingSource: VerifiedPurchaseOccurrenceSource | null;
      provenance: VerifiedOccurrenceProvenanceReport[];
      toAssignReceiptIds: string[];
      unchangedReceiptIds: string[];
    }
  | {
      status: 'ALREADY_ASSIGNED';
      occurrenceId: string;
      source: VerifiedPurchaseOccurrenceSource;
      provenance: VerifiedOccurrenceProvenanceReport[];
      unchangedReceiptIds: string[];
    }
  | {
      status: 'BLOCK_CONFLICT';
      conflict: 'multiple_existing_ids' | 'different_occurrence';
      receiptId: string | null;
      occurrenceIds: string[];
      provenance: VerifiedOccurrenceProvenanceReport[];
    }
  | {
      status: 'BLOCK_INVALID_PROVENANCE';
      receiptId: string;
      reason: string;
      provenance: VerifiedOccurrenceProvenanceReport[];
    }
  | {
      status: 'BLOCK_MISSING_RECEIPT';
      missingReceiptIds: string[];
      provenance: VerifiedOccurrenceProvenanceReport[];
    };

function provenanceOf(member: ClassifiedMember): VerifiedOccurrenceProvenanceReport {
  if (member.bundle.state === 'assigned') {
    return {
      receiptId: member.id,
      state: 'assigned',
      occurrenceId: member.bundle.value.occurrenceId,
      source: member.bundle.value.source,
      verifiedAt: member.bundle.value.verifiedAt,
      invalidReason: null,
    };
  }
  if (member.bundle.state === 'invalid') {
    return {
      receiptId: member.id,
      state: 'invalid',
      occurrenceId: null,
      source: null,
      verifiedAt: null,
      invalidReason: member.bundle.reason,
    };
  }
  return {
    receiptId: member.id,
    state: 'unassigned',
    occurrenceId: null,
    source: null,
    verifiedAt: null,
    invalidReason: null,
  };
}

function classifyRows(
  rows: readonly VerifiedOccurrencePlanRow[]
): ClassifiedMember[] {
  return rows.map((row) => ({
    ...row,
    bundle: classifyVerifiedPurchaseOccurrenceBundle({
      occurrenceId: row.verified_purchase_occurrence_id,
      source: row.verified_purchase_occurrence_source,
      verifiedAt: row.verified_purchase_occurrence_verified_at,
    }),
  }));
}

/**
 * Same target / conflict / idempotency rules as A2.1 assignment.
 * `suppliedOccurrenceId` is only for the real assignment API.
 * Historical dry run omits it, so it cannot force a chosen id.
 */
export function evaluateVerifiedPurchaseOccurrenceAssignment(input: {
  requestedReceiptIds: readonly string[];
  foundRows: readonly VerifiedOccurrencePlanRow[];
  suppliedOccurrenceId?: string;
  /** Used only when every member is already on the target and no stored source exists. */
  fallbackSource: VerifiedPurchaseOccurrenceSource;
}): VerifiedOccurrenceAssignmentDecision {
  const requested = input.requestedReceiptIds;
  const members = classifyRows(input.foundRows);
  const provenance = members.map(provenanceOf);
  const found = new Set(members.map((member) => member.id));
  const missing = requested.filter((id) => !found.has(id));
  if (missing.length > 0 || members.length !== requested.length) {
    return {
      status: 'BLOCK_MISSING_RECEIPT',
      missingReceiptIds: missing,
      provenance,
    };
  }

  for (const member of members) {
    if (member.bundle.state === 'invalid') {
      return {
        status: 'BLOCK_INVALID_PROVENANCE',
        receiptId: member.id,
        reason: member.bundle.reason,
        provenance,
      };
    }
  }

  const assignedIds = new Set<string>();
  let existingSource: VerifiedPurchaseOccurrenceSource | null = null;
  for (const member of members) {
    if (member.bundle.state === 'assigned') {
      assignedIds.add(member.bundle.value.occurrenceId);
      if (existingSource == null) existingSource = member.bundle.value.source;
    }
  }

  const supplied = input.suppliedOccurrenceId;
  let targetId: string | null = null;
  if (supplied != null) {
    targetId = supplied;
  } else if (assignedIds.size === 0) {
    return {
      status: 'READY_CREATE_NEW',
      provenance,
      toAssignReceiptIds: members.map((member) => member.id),
      unchangedReceiptIds: [],
    };
  } else if (assignedIds.size === 1) {
    targetId = [...assignedIds][0]!;
  } else {
    return {
      status: 'BLOCK_CONFLICT',
      conflict: 'multiple_existing_ids',
      receiptId: null,
      occurrenceIds: [...assignedIds].sort((a, b) => a.localeCompare(b)),
      provenance,
    };
  }

  for (const member of members) {
    if (
      member.bundle.state === 'assigned' &&
      member.bundle.value.occurrenceId !== targetId
    ) {
      return {
        status: 'BLOCK_CONFLICT',
        conflict: 'different_occurrence',
        receiptId: member.id,
        occurrenceIds: [...assignedIds].sort((a, b) => a.localeCompare(b)),
        provenance,
      };
    }
  }

  const toAssignReceiptIds: string[] = [];
  const unchangedReceiptIds: string[] = [];
  for (const member of members) {
    if (
      member.bundle.state === 'assigned' &&
      member.bundle.value.occurrenceId === targetId
    ) {
      unchangedReceiptIds.push(member.id);
    } else if (member.bundle.state === 'unassigned') {
      toAssignReceiptIds.push(member.id);
    } else {
      return {
        status: 'BLOCK_INVALID_PROVENANCE',
        receiptId: member.id,
        reason: 'unexpected_membership_state',
        provenance,
      };
    }
  }

  if (toAssignReceiptIds.length === 0) {
    return {
      status: 'ALREADY_ASSIGNED',
      occurrenceId: targetId!,
      source: existingSource ?? input.fallbackSource,
      provenance,
      unchangedReceiptIds,
    };
  }

  if (supplied != null && (assignedIds.size === 0 || existingSource == null)) {
    return {
      status: 'READY_ASSIGN_SUPPLIED',
      occurrenceId: targetId!,
      existingSource,
      provenance,
      toAssignReceiptIds,
      unchangedReceiptIds,
    };
  }

  return {
    status: 'READY_ADOPT_EXISTING',
    occurrenceId: targetId!,
    existingSource: existingSource ?? input.fallbackSource,
    provenance,
    toAssignReceiptIds,
    unchangedReceiptIds,
  };
}
