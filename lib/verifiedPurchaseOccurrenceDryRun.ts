/**
 * Read-only exact-ID dry run for historical verified-occurrence repair.
 * SELECT only. Does not assign, enqueue outbox, or mutate receipts.
 */

import type { ReceiptRow } from './db';
import { buildEffectivePurchaseTruth } from './purchaseTruthPartition';
import { verifiedPurchaseOccurrenceColumnsSql } from './receiptVerifiedPurchaseOccurrenceSelect';
import {
  evaluateVerifiedPurchaseOccurrenceAssignment,
  type VerifiedOccurrenceProvenanceReport,
} from './verifiedPurchaseOccurrencePlan';
import {
  classifyVerifiedPurchaseOccurrenceBundle,
  isDurableEpochMs,
  isValidVerifiedPurchaseOccurrenceId,
  isVerifiedPurchaseOccurrenceSource,
  type VerifiedPurchaseOccurrenceSource,
} from './verifiedPurchaseOccurrenceProvenance';

export class VerifiedPurchaseOccurrenceDryRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifiedPurchaseOccurrenceDryRunError';
  }
}

export type VerifiedOccurrenceDryRunDb = {
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
};

export type DryRunVerifiedPurchaseOccurrenceRepairParams = {
  userId: string;
  receiptIds: readonly string[];
  source: VerifiedPurchaseOccurrenceSource;
  /** In-memory audit timestamp only. Never written. */
  nowMs?: number;
};

export type VerifiedOccurrenceDryRunStatus =
  | 'READY_CREATE_NEW'
  | 'READY_ADOPT_EXISTING'
  | 'ALREADY_ASSIGNED'
  | 'BLOCK_CONFLICT'
  | 'BLOCK_INVALID_PROVENANCE'
  | 'BLOCK_MISSING_RECEIPT';

export type VerifiedOccurrenceDryRunSimulation = {
  simulatedOccurrenceId: string;
  simulatedOccurrenceIdIsSynthetic: boolean;
  simulatedSource: VerifiedPurchaseOccurrenceSource;
  simulatedVerifiedAt: number;
  ownerReceiptCount: number;
  effectivePurchaseCountBefore: number;
  effectivePurchaseCountAfter: number;
  effectivePurchaseDelta: number;
  selectedReceiptCount: number;
  selectedEffectiveOccurrenceCountBefore: number;
  selectedEffectiveOccurrenceCountAfter: number;
  simulatedMemberReceiptIds: string[];
  allSelectedInOneVerifiedActiveOccurrence: boolean;
  absorbedUnselectedReceiptIds: string[];
  unexpectedUnselectedAbsorption: boolean;
};

export type VerifiedOccurrenceDryRunResult = {
  status: VerifiedOccurrenceDryRunStatus;
  source: VerifiedPurchaseOccurrenceSource;
  provenance: VerifiedOccurrenceProvenanceReport[];
  missingReceiptIds: string[];
  conflictOccurrenceIds: string[];
  invalidReceiptId: string | null;
  simulation: VerifiedOccurrenceDryRunSimulation | null;
};

const MEMBER_SELECT_SQL = `
SELECT
  id,
  user_id,
  verified_purchase_occurrence_id,
  verified_purchase_occurrence_source,
  verified_purchase_occurrence_verified_at
FROM receipts
WHERE id IN (__PLACEHOLDERS__)
  AND user_id = ?
`.trim();

/**
 * Owner purchase-truth projection for in-memory simulation.
 * Must keep every ReceiptRow field that effective purchase truth reads:
 * duplicate/canonical evidence uses id, created_at, transaction_at,
 * transaction_time_precision, merchant_raw, merchant_normalized, total, tax,
 * tax_is_known, currency, analysis_json, user_items_json, and the verified
 * provenance triple. Representative scoring also reads user_edited,
 * final_total, and note. image_uri / merchant_type / final_category stay in
 * the projection so the simulated rows remain full stored receipts.
 * Owner scope is only `user_id = ?`. This is not the app-current-owner reader.
 */
const UNIVERSE_SELECT_SQL = `
SELECT
  id, created_at,
  transaction_at,
  COALESCE(transaction_time_precision, 'unknown') as transaction_time_precision,
  image_uri,
  merchant_raw, merchant_normalized,
  merchant_type,
  total, tax, COALESCE(tax_is_known, 0) as tax_is_known, currency,
  analysis_json,
  COALESCE(user_edited, 0) as user_edited,
  final_total,
  final_category,
  note,
  user_items_json,
  ${verifiedPurchaseOccurrenceColumnsSql()}
FROM receipts
WHERE user_id = ?
`.trim();

/** Columns the simulation SELECT must project. Kept next to the SQL above. */
export const VERIFIED_OCCURRENCE_DRY_RUN_TRUTH_COLUMNS = [
  'id',
  'created_at',
  'transaction_at',
  'transaction_time_precision',
  'merchant_raw',
  'merchant_normalized',
  'total',
  'tax',
  'tax_is_known',
  'currency',
  'analysis_json',
  'user_items_json',
  'user_edited',
  'final_total',
  'note',
  'verified_purchase_occurrence_id',
  'verified_purchase_occurrence_source',
  'verified_purchase_occurrence_verified_at',
] as const;

function assertSelectOnly(sql: string): void {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new VerifiedPurchaseOccurrenceDryRunError('dry run issued a non-SELECT');
  }
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(sql)) {
    throw new VerifiedPurchaseOccurrenceDryRunError('dry run issued a mutation');
  }
}

export function assertExactVerifiedOccurrenceReceiptIds(
  receiptIds: readonly string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of receiptIds) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw) {
      throw new VerifiedPurchaseOccurrenceDryRunError(
        'receiptIds must be exact non-empty ids'
      );
    }
    if (seen.has(raw)) {
      throw new VerifiedPurchaseOccurrenceDryRunError('duplicate receiptIds');
    }
    seen.add(raw);
    out.push(raw);
  }
  if (out.length < 2) {
    throw new VerifiedPurchaseOccurrenceDryRunError(
      'at least two distinct receiptIds required'
    );
  }
  return out;
}

/** Deterministic candidate. Index 0 is the bare hash; later indexes append _N. */
export function syntheticDryRunOccurrenceCandidate(
  receiptIds: readonly string[],
  collisionIndex = 0
): string {
  const basis = [...receiptIds].sort((a, b) => a.localeCompare(b)).join('\u001f');
  let hash = 2166136261;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const base = `dryrun_vpo_${(hash >>> 0).toString(16).padStart(8, '0')}`;
  const candidate = collisionIndex === 0 ? base : `${base}_${collisionIndex}`;
  if (!isValidVerifiedPurchaseOccurrenceId(candidate)) {
    throw new VerifiedPurchaseOccurrenceDryRunError(
      'synthetic dry-run occurrence id is not valid'
    );
  }
  return candidate;
}

/**
 * First deterministic candidate that is not already a valid assigned
 * occurrence id in this owner universe. Never persisted.
 */
export function chooseSyntheticDryRunOccurrenceId(
  receiptIds: readonly string[],
  usedOccurrenceIds: ReadonlySet<string>
): string {
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = syntheticDryRunOccurrenceCandidate(receiptIds, index);
    if (!usedOccurrenceIds.has(candidate)) return candidate;
  }
  throw new VerifiedPurchaseOccurrenceDryRunError(
    'unable to allocate a collision-free synthetic occurrence id'
  );
}

function validAssignedOccurrenceIds(universe: readonly ReceiptRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of universe) {
    const state = classifyVerifiedPurchaseOccurrenceBundle({
      occurrenceId: row.verified_purchase_occurrence_id,
      source: row.verified_purchase_occurrence_source,
      verifiedAt: row.verified_purchase_occurrence_verified_at,
    });
    if (state.state === 'assigned') ids.add(state.value.occurrenceId);
  }
  return ids;
}

function distinctPurchaseCount(
  purchaseByReceiptId: ReadonlyMap<string, { memberReceiptIds: readonly string[] }>,
  ids: readonly string[]
): number {
  const seen = new Set<object>();
  let count = 0;
  for (const id of ids) {
    const purchase = purchaseByReceiptId.get(id);
    if (!purchase) {
      count += 1;
      continue;
    }
    if (seen.has(purchase)) continue;
    seen.add(purchase);
    count += 1;
  }
  return count;
}

export function simulateVerifiedOccurrenceDryRunAssignment(input: {
  universe: readonly ReceiptRow[];
  selectedIds: readonly string[];
  /** Receipts real assignment would UPDATE. Already-assigned members stay put. */
  overlayReceiptIds: readonly string[];
  occurrenceId: string;
  source: VerifiedPurchaseOccurrenceSource;
  verifiedAt: number;
  synthetic: boolean;
}): {
  simulation: VerifiedOccurrenceDryRunSimulation;
  simulatedUniverse: ReceiptRow[];
} {
  const selected = new Set(input.selectedIds);
  const overlay = new Set(input.overlayReceiptIds);
  const before = buildEffectivePurchaseTruth(input.universe);
  const simulatedUniverse = input.universe.map((row) => {
    if (!overlay.has(row.id)) return row;
    return {
      ...row,
      verified_purchase_occurrence_id: input.occurrenceId,
      verified_purchase_occurrence_source: input.source,
      verified_purchase_occurrence_verified_at: input.verifiedAt,
    };
  });
  const after = buildEffectivePurchaseTruth(simulatedUniverse);
  const anchor = after.purchaseByReceiptId.get(input.selectedIds[0]!);
  const simulatedMemberReceiptIds = anchor ? [...anchor.memberReceiptIds] : [];
  const absorbedUnselectedReceiptIds = simulatedMemberReceiptIds
    .filter((id) => !selected.has(id))
    .sort((a, b) => a.localeCompare(b));
  const allSelectedInOneVerifiedActiveOccurrence =
    anchor != null &&
    anchor.verifiedActive === true &&
    input.selectedIds.every((id) => after.purchaseByReceiptId.get(id) === anchor);

  return {
    simulatedUniverse,
    simulation: {
    simulatedOccurrenceId: input.occurrenceId,
    simulatedOccurrenceIdIsSynthetic: input.synthetic,
    simulatedSource: input.source,
    simulatedVerifiedAt: input.verifiedAt,
    ownerReceiptCount: input.universe.length,
    effectivePurchaseCountBefore: before.purchases.length,
    effectivePurchaseCountAfter: after.purchases.length,
    effectivePurchaseDelta: after.purchases.length - before.purchases.length,
    selectedReceiptCount: input.selectedIds.length,
    selectedEffectiveOccurrenceCountBefore: distinctPurchaseCount(
      before.purchaseByReceiptId,
      input.selectedIds
    ),
    selectedEffectiveOccurrenceCountAfter: distinctPurchaseCount(
      after.purchaseByReceiptId,
      input.selectedIds
    ),
    simulatedMemberReceiptIds,
    allSelectedInOneVerifiedActiveOccurrence,
    absorbedUnselectedReceiptIds,
    unexpectedUnselectedAbsorption: absorbedUnselectedReceiptIds.length > 0,
  },
  };
}

/**
 * Exact-ID repair preview. Reads the owner-scoped rows, plans with the
 * shared A2.1 decision, and optionally simulates purchase truth in memory.
 */
export async function dryRunVerifiedPurchaseOccurrenceRepairWithDb(
  db: VerifiedOccurrenceDryRunDb,
  params: DryRunVerifiedPurchaseOccurrenceRepairParams
): Promise<VerifiedOccurrenceDryRunResult> {
  const userId = typeof params.userId === 'string' ? params.userId.trim() : '';
  if (!userId) {
    throw new VerifiedPurchaseOccurrenceDryRunError('userId required');
  }
  if (!isVerifiedPurchaseOccurrenceSource(params.source)) {
    throw new VerifiedPurchaseOccurrenceDryRunError(
      'unsupported verified_purchase_occurrence_source'
    );
  }
  const receiptIds = assertExactVerifiedOccurrenceReceiptIds(params.receiptIds);
  const verifiedAt =
    params.nowMs === undefined ? Date.now() : params.nowMs;
  if (!isDurableEpochMs(verifiedAt)) {
    throw new VerifiedPurchaseOccurrenceDryRunError(
      'invalid nowMs: must be finite positive Date-representable epoch ms'
    );
  }

  const memberSql = MEMBER_SELECT_SQL.replace(
    '__PLACEHOLDERS__',
    receiptIds.map(() => '?').join(',')
  );
  assertSelectOnly(memberSql);
  const rows = await db.getAllAsync<{
    id: string;
    verified_purchase_occurrence_id: string | null;
    verified_purchase_occurrence_source: string | null;
    verified_purchase_occurrence_verified_at: number | null;
  }>(memberSql, [...receiptIds, userId]);

  const decision = evaluateVerifiedPurchaseOccurrenceAssignment({
    requestedReceiptIds: receiptIds,
    foundRows: rows ?? [],
    fallbackSource: params.source,
  });

  const base = {
    source: params.source,
    provenance: decision.provenance,
    missingReceiptIds:
      decision.status === 'BLOCK_MISSING_RECEIPT' ? decision.missingReceiptIds : [],
    conflictOccurrenceIds:
      decision.status === 'BLOCK_CONFLICT' ? decision.occurrenceIds : [],
    invalidReceiptId:
      decision.status === 'BLOCK_INVALID_PROVENANCE' ? decision.receiptId : null,
    simulation: null,
  };

  if (
    decision.status !== 'READY_CREATE_NEW' &&
    decision.status !== 'READY_ADOPT_EXISTING'
  ) {
    if (decision.status === 'READY_ASSIGN_SUPPLIED') {
      throw new VerifiedPurchaseOccurrenceDryRunError(
        'dry run does not accept a supplied occurrence id'
      );
    }
    return { ...base, status: decision.status };
  }

  assertSelectOnly(UNIVERSE_SELECT_SQL);
  const universe = await db.getAllAsync<ReceiptRow>(UNIVERSE_SELECT_SQL, [userId]);
  const occurrenceId =
    decision.status === 'READY_CREATE_NEW'
      ? chooseSyntheticDryRunOccurrenceId(
          receiptIds,
          validAssignedOccurrenceIds(universe ?? [])
        )
      : decision.occurrenceId;
  const { simulation } = simulateVerifiedOccurrenceDryRunAssignment({
    universe: universe ?? [],
    selectedIds: receiptIds,
    overlayReceiptIds: decision.toAssignReceiptIds,
    occurrenceId,
    source: params.source,
    verifiedAt,
    synthetic: decision.status === 'READY_CREATE_NEW',
  });

  return {
    ...base,
    status: decision.status,
    simulation,
  };
}
