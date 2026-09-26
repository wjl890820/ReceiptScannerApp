/**
 * Owner-scoped verified purchase occurrence assignment (A2.1 / A2.1a).
 * Storage + guarded mutation only — does not change analytics occurrence behavior.
 *
 * Authority: SELECT → classify → target selection → conditional UPDATE + outbox
 * all run inside one exclusive SQLite transaction.
 */

import type * as SQLite from 'expo-sqlite';

import {
  generateSyncIntentId,
  replaceSyncOutboxIntent,
} from './syncOutbox';
import {
  classifyVerifiedPurchaseOccurrenceBundle,
  generateVerifiedPurchaseOccurrenceId,
  isDurableEpochMs,
  isValidVerifiedPurchaseOccurrenceId,
  isVerifiedPurchaseOccurrenceSource,
  type VerifiedPurchaseOccurrenceProvenance,
  type VerifiedPurchaseOccurrenceSource,
} from './verifiedPurchaseOccurrenceProvenance';

export class VerifiedPurchaseOccurrenceAssignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifiedPurchaseOccurrenceAssignError';
  }
}

export type AssignVerifiedPurchaseOccurrenceParams = {
  userId: string;
  receiptIds: readonly string[];
  /** Target group id; when omitted, generated or adopted from existing members. */
  occurrenceId?: string;
  source: VerifiedPurchaseOccurrenceSource;
  /** Audit time for newly assigned members; defaults to nowMs/Date.now(). */
  verifiedAt?: number;
  nowMs?: number;
};

export type AssignVerifiedPurchaseOccurrenceResult = {
  occurrenceId: string;
  /**
   * Source written for newly assigned members.
   * On idempotent no-write success, the existing stored source of group G.
   */
  source: VerifiedPurchaseOccurrenceSource;
  changedReceiptIds: string[];
  unchangedReceiptIds: string[];
};

type LoadedMember = {
  id: string;
  user_id: string | null;
  verified_purchase_occurrence_id: string | null;
  verified_purchase_occurrence_source: string | null;
  verified_purchase_occurrence_verified_at: number | null;
  bundle: ReturnType<typeof classifyVerifiedPurchaseOccurrenceBundle>;
};

function hasOwnParam<K extends string>(
  params: object,
  key: K
): boolean {
  return Object.prototype.hasOwnProperty.call(params, key);
}

function normalizeUniqueReceiptIds(receiptIds: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of receiptIds) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function requireDurableEpochMs(
  value: unknown,
  label: string
): number {
  if (!isDurableEpochMs(value)) {
    throw new VerifiedPurchaseOccurrenceAssignError(
      `invalid ${label}: must be finite positive Date-representable epoch ms`
    );
  }
  return value;
}

/**
 * Assign owned receipts into one verified purchase occurrence group.
 * Fail-closed: missing/wrong-owner/malformed/conflict/stale → no mutation.
 */
export async function assignVerifiedPurchaseOccurrenceWithDb(
  db: SQLite.SQLiteDatabase,
  params: AssignVerifiedPurchaseOccurrenceParams
): Promise<AssignVerifiedPurchaseOccurrenceResult> {
  const userId =
    typeof params.userId === 'string' ? params.userId.trim() : '';
  if (!userId) {
    throw new VerifiedPurchaseOccurrenceAssignError('userId required');
  }
  if (!isVerifiedPurchaseOccurrenceSource(params.source)) {
    throw new VerifiedPurchaseOccurrenceAssignError(
      'unsupported verified_purchase_occurrence_source'
    );
  }

  const uniqueIds = normalizeUniqueReceiptIds(params.receiptIds);
  if (uniqueIds.length < 2) {
    throw new VerifiedPurchaseOccurrenceAssignError(
      'at least two distinct receiptIds required'
    );
  }

  const now = hasOwnParam(params, 'nowMs') && params.nowMs !== undefined
    ? requireDurableEpochMs(params.nowMs, 'nowMs')
    : Date.now();

  const verifiedAtForNew =
    hasOwnParam(params, 'verifiedAt') && params.verifiedAt !== undefined
      ? requireDurableEpochMs(params.verifiedAt, 'verifiedAt')
      : now;

  let suppliedOccurrenceId: string | undefined;
  if (
    hasOwnParam(params, 'occurrenceId') &&
    params.occurrenceId !== undefined
  ) {
    if (!isValidVerifiedPurchaseOccurrenceId(params.occurrenceId)) {
      throw new VerifiedPurchaseOccurrenceAssignError(
        'invalid verified_purchase_occurrence_id'
      );
    }
    suppliedOccurrenceId = params.occurrenceId;
  }

  let result: AssignVerifiedPurchaseOccurrenceResult | null = null;

  await db.withExclusiveTransactionAsync(async (txn) => {
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = await txn.getAllAsync<{
      id: string;
      user_id: string | null;
      verified_purchase_occurrence_id: string | null;
      verified_purchase_occurrence_source: string | null;
      verified_purchase_occurrence_verified_at: number | null;
    }>(
      `
      SELECT
        id,
        user_id,
        verified_purchase_occurrence_id,
        verified_purchase_occurrence_source,
        verified_purchase_occurrence_verified_at
      FROM receipts
      WHERE id IN (${placeholders})
        AND user_id = ?
      `,
      [...uniqueIds, userId]
    );

    if ((rows ?? []).length !== uniqueIds.length) {
      const found = new Set((rows ?? []).map((r) => r.id));
      const missing = uniqueIds.filter((id) => !found.has(id));
      throw new VerifiedPurchaseOccurrenceAssignError(
        `missing or wrong-owner receipts: ${missing.join(', ')}`
      );
    }

    const members: LoadedMember[] = (rows ?? []).map((row) => {
      const bundle = classifyVerifiedPurchaseOccurrenceBundle({
        occurrenceId: row.verified_purchase_occurrence_id,
        source: row.verified_purchase_occurrence_source,
        verifiedAt: row.verified_purchase_occurrence_verified_at,
      });
      return {
        id: row.id,
        user_id: row.user_id,
        verified_purchase_occurrence_id: row.verified_purchase_occurrence_id,
        verified_purchase_occurrence_source:
          row.verified_purchase_occurrence_source,
        verified_purchase_occurrence_verified_at:
          row.verified_purchase_occurrence_verified_at,
        bundle,
      };
    });

    for (const member of members) {
      if (member.bundle.state === 'invalid') {
        throw new VerifiedPurchaseOccurrenceAssignError(
          `malformed verified provenance on receipt ${member.id}: ${member.bundle.reason}`
        );
      }
    }

    const assignedIds = new Set<string>();
    let existingSourceForG: VerifiedPurchaseOccurrenceSource | null = null;
    for (const member of members) {
      if (member.bundle.state === 'assigned') {
        assignedIds.add(member.bundle.value.occurrenceId);
        if (existingSourceForG == null) {
          existingSourceForG = member.bundle.value.source;
        }
      }
    }

    let targetId: string;
    if (suppliedOccurrenceId != null) {
      targetId = suppliedOccurrenceId;
    } else if (assignedIds.size === 0) {
      targetId = generateVerifiedPurchaseOccurrenceId();
    } else if (assignedIds.size === 1) {
      targetId = [...assignedIds][0]!;
    } else {
      throw new VerifiedPurchaseOccurrenceAssignError(
        'conflicting verified_purchase_occurrence_id among members'
      );
    }

    for (const member of members) {
      if (
        member.bundle.state === 'assigned' &&
        member.bundle.value.occurrenceId !== targetId
      ) {
        throw new VerifiedPurchaseOccurrenceAssignError(
          `receipt ${member.id} already assigned to a different occurrence`
        );
      }
    }

    const toAssign: LoadedMember[] = [];
    const unchanged: string[] = [];
    for (const member of members) {
      if (
        member.bundle.state === 'assigned' &&
        member.bundle.value.occurrenceId === targetId
      ) {
        unchanged.push(member.id);
      } else if (member.bundle.state === 'unassigned') {
        toAssign.push(member);
      } else {
        // Defensive: assigned-to-other already rejected; invalid already rejected.
        throw new VerifiedPurchaseOccurrenceAssignError(
          `unexpected membership state for receipt ${member.id}`
        );
      }
    }

    if (toAssign.length === 0) {
      result = {
        occurrenceId: targetId,
        source: existingSourceForG ?? params.source,
        changedReceiptIds: [],
        unchangedReceiptIds: unchanged,
      };
      return;
    }

    for (const member of toAssign) {
      const updateResult = await txn.runAsync(
        `
        UPDATE receipts
        SET
          verified_purchase_occurrence_id = ?,
          verified_purchase_occurrence_source = ?,
          verified_purchase_occurrence_verified_at = ?,
          client_updated_at = ?
        WHERE id = ?
          AND user_id = ?
          AND verified_purchase_occurrence_id IS NULL
          AND verified_purchase_occurrence_source IS NULL
          AND verified_purchase_occurrence_verified_at IS NULL
        `,
        [
          targetId,
          params.source,
          verifiedAtForNew,
          now,
          member.id,
          userId,
        ]
      );
      if ((updateResult?.changes ?? 0) !== 1) {
        throw new VerifiedPurchaseOccurrenceAssignError(
          `stale verified membership state for receipt ${member.id}`
        );
      }
      await replaceSyncOutboxIntent(txn, {
        receiptId: member.id,
        userId,
        operation: 'upsert',
        intentId: generateSyncIntentId(),
        nowMs: now,
      });
    }

    result = {
      occurrenceId: targetId,
      source: params.source,
      changedReceiptIds: toAssign.map((m) => m.id),
      unchangedReceiptIds: unchanged,
    };
  });

  if (!result) {
    throw new VerifiedPurchaseOccurrenceAssignError(
      'assignment transaction produced no result'
    );
  }
  return result;
}

export type {
  VerifiedPurchaseOccurrenceProvenance,
  VerifiedPurchaseOccurrenceSource,
};
