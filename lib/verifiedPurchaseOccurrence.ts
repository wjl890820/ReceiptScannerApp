/**
 * Owner-scoped verified purchase occurrence assignment (A2.1 / A2.1a).
 * Storage + guarded mutation only — does not change analytics occurrence behavior.
 *
 * Authority: SELECT → classify → target selection → conditional UPDATE + outbox
 * all run inside one exclusive SQLite transaction.
 */

import type * as SQLite from 'expo-sqlite';

import { invalidateAnalyticsReceiptSelection } from './analyticsReceiptSelectionCache';
import {
  generateSyncIntentId,
  replaceSyncOutboxIntent,
} from './syncOutbox';
import {
  generateVerifiedPurchaseOccurrenceId,
  isDurableEpochMs,
  isValidVerifiedPurchaseOccurrenceId,
  isVerifiedPurchaseOccurrenceSource,
  type VerifiedPurchaseOccurrenceProvenance,
  type VerifiedPurchaseOccurrenceSource,
} from './verifiedPurchaseOccurrenceProvenance';
import { evaluateVerifiedPurchaseOccurrenceAssignment } from './verifiedPurchaseOccurrencePlan';

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

  const outcome: {
    result: AssignVerifiedPurchaseOccurrenceResult | null;
  } = { result: null };

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

    const decision = evaluateVerifiedPurchaseOccurrenceAssignment({
      requestedReceiptIds: uniqueIds,
      foundRows: rows ?? [],
      suppliedOccurrenceId,
      fallbackSource: params.source,
    });

    if (decision.status === 'BLOCK_MISSING_RECEIPT') {
      throw new VerifiedPurchaseOccurrenceAssignError(
        `missing or wrong-owner receipts: ${decision.missingReceiptIds.join(', ')}`
      );
    }
    if (decision.status === 'BLOCK_INVALID_PROVENANCE') {
      throw new VerifiedPurchaseOccurrenceAssignError(
        `malformed verified provenance on receipt ${decision.receiptId}: ${decision.reason}`
      );
    }
    if (decision.status === 'BLOCK_CONFLICT') {
      if (decision.conflict === 'multiple_existing_ids') {
        throw new VerifiedPurchaseOccurrenceAssignError(
          'conflicting verified_purchase_occurrence_id among members'
        );
      }
      throw new VerifiedPurchaseOccurrenceAssignError(
        `receipt ${decision.receiptId} already assigned to a different occurrence`
      );
    }
    if (decision.status === 'ALREADY_ASSIGNED') {
      outcome.result = {
        occurrenceId: decision.occurrenceId,
        source: decision.source,
        changedReceiptIds: [],
        unchangedReceiptIds: decision.unchangedReceiptIds,
      };
      return;
    }

    const targetId =
      decision.status === 'READY_CREATE_NEW'
        ? generateVerifiedPurchaseOccurrenceId()
        : decision.occurrenceId;

    for (const memberId of decision.toAssignReceiptIds) {
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
          memberId,
          userId,
        ]
      );
      if ((updateResult?.changes ?? 0) !== 1) {
        throw new VerifiedPurchaseOccurrenceAssignError(
          `stale verified membership state for receipt ${memberId}`
        );
      }
      await replaceSyncOutboxIntent(txn, {
        receiptId: memberId,
        userId,
        operation: 'upsert',
        intentId: generateSyncIntentId(),
        nowMs: now,
      });
    }

    outcome.result = {
      occurrenceId: targetId,
      source: params.source,
      changedReceiptIds: decision.toAssignReceiptIds,
      unchangedReceiptIds: decision.unchangedReceiptIds,
    };
  });

  if (!outcome.result) {
    throw new VerifiedPurchaseOccurrenceAssignError(
      'assignment transaction produced no result'
    );
  }
  if (outcome.result.changedReceiptIds.length > 0) {
    invalidateAnalyticsReceiptSelection(
      'verified_purchase_occurrence_assigned'
    );
  }
  return outcome.result;
}

export type {
  VerifiedPurchaseOccurrenceProvenance,
  VerifiedPurchaseOccurrenceSource,
};
