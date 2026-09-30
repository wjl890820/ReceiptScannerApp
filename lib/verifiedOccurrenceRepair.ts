/**
 * Internal/validation exact-ID verified occurrence repair.
 * Preview is the A2.3b dry run. Execution is A2.1 assignment only.
 */

import { requestCloudBackupFlush } from './cloudBackupWorker';
import { getReceiptsDatabase } from './db';
import {
  resolveCurrentLocalReceiptOwnerScope,
  userIdFromReadyOwnerScope,
  type LocalReceiptOwnerScope,
} from './receiptOwnershipScope';
import { assignVerifiedPurchaseOccurrenceWithDb } from './verifiedPurchaseOccurrence';
import {
  dryRunVerifiedPurchaseOccurrenceRepairWithDb,
  type VerifiedOccurrenceDryRunDb,
  type VerifiedOccurrenceDryRunResult,
} from './verifiedPurchaseOccurrenceDryRun';
import type { VerifiedPurchaseOccurrenceSource } from './verifiedPurchaseOccurrenceProvenance';

export const VERIFIED_OCCURRENCE_REPAIR_SOURCE =
  'user_verified' as const satisfies VerifiedPurchaseOccurrenceSource;

export type VerifiedOccurrenceRepairOwnerBlock =
  | 'owner_unavailable'
  | 'installation_owner'
  | 'auth_unstable';

export type PreviewVerifiedOccurrenceRepairResult =
  | {
      status: 'BLOCKED_OWNER';
      reason: VerifiedOccurrenceRepairOwnerBlock;
      executionAllowed: false;
    }
  | {
      status: 'PREVIEW';
      userId: string;
      receiptIds: string[];
      dryRun: VerifiedOccurrenceDryRunResult;
      executionAllowed: boolean;
      alreadyAssigned: boolean;
      existingOccurrenceId: string | null;
    };

export type ExecuteVerifiedOccurrenceRepairResult =
  | {
      status: 'BLOCKED_OWNER';
      reason: VerifiedOccurrenceRepairOwnerBlock;
    }
  | {
      status: 'NOT_ELIGIBLE';
      dryRun: VerifiedOccurrenceDryRunResult;
    }
  | {
      status: 'ALREADY_COMPLETE';
      occurrenceId: string;
      selectedReceiptIds: string[];
      postVerificationStatus: 'ALREADY_ASSIGNED';
      cloudSyncRequestStatus: 'not_needed';
      cloudSyncRequestError: null;
    }
  | {
      status: 'VERIFICATION_FAILED';
      occurrenceId: string;
      changedReceiptIds: string[];
      unchangedReceiptIds: string[];
      selectedReceiptIds: string[];
      postVerificationStatus: string;
      verificationError: string | null;
      localAssignmentCommitted: true;
      cloudSyncRequestStatus: VerifiedOccurrenceRepairCloudSyncRequestStatus;
      cloudSyncRequestError: string | null;
    }
  | {
      status: 'ASSIGNED';
      occurrenceId: string;
      source: typeof VERIFIED_OCCURRENCE_REPAIR_SOURCE;
      changedReceiptIds: string[];
      unchangedReceiptIds: string[];
      selectedReceiptIds: string[];
      postVerificationStatus: 'ALREADY_ASSIGNED';
      cloudSyncRequestStatus: VerifiedOccurrenceRepairCloudSyncRequestStatus;
      cloudSyncRequestError: string | null;
    };

type DryRunFn = typeof dryRunVerifiedPurchaseOccurrenceRepairWithDb;
type AssignFn = typeof assignVerifiedPurchaseOccurrenceWithDb;
type AssignVerifiedOccurrenceDb = Parameters<AssignFn>[0];

/** Enough for the dry run and for A2.1 assignment. UI never receives this handle. */
export type VerifiedOccurrenceRepairDb = VerifiedOccurrenceDryRunDb &
  AssignVerifiedOccurrenceDb;

export type VerifiedOccurrenceRepairCloudSyncRequestStatus =
  | 'requested'
  | 'request_failed'
  | 'not_needed';

export function isVerifiedOccurrenceRepairExecutionAllowed(
  dryRun: Pick<VerifiedOccurrenceDryRunResult, 'status' | 'simulation'>
): boolean {
  if (
    dryRun.status !== 'READY_CREATE_NEW' &&
    dryRun.status !== 'READY_ADOPT_EXISTING'
  ) {
    return false;
  }
  const simulation = dryRun.simulation;
  if (!simulation) return false;
  if (simulation.allSelectedInOneVerifiedActiveOccurrence !== true) return false;
  if (simulation.unexpectedUnselectedAbsorption !== false) return false;
  if (simulation.absorbedUnselectedReceiptIds.length !== 0) return false;
  return true;
}

export function repairOwnerBlockReason(
  scope: LocalReceiptOwnerScope
): VerifiedOccurrenceRepairOwnerBlock | null {
  if (scope.status !== 'ready') {
    return scope.reason === 'auth_unstable' ? 'auth_unstable' : 'owner_unavailable';
  }
  if (userIdFromReadyOwnerScope(scope)) return null;
  if (scope.ownerKey.startsWith('installation:')) return 'installation_owner';
  return 'owner_unavailable';
}

function existingOccurrenceId(
  dryRun: VerifiedOccurrenceDryRunResult
): string | null {
  if (dryRun.status !== 'ALREADY_ASSIGNED') return null;
  const ids = new Set(
    dryRun.provenance
      .map((row) => row.occurrenceId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
  if (ids.size !== 1) return null;
  return [...ids][0]!;
}

function provenanceProvesAssignment(
  dryRun: VerifiedOccurrenceDryRunResult,
  receiptIds: readonly string[],
  occurrenceId: string
): boolean {
  if (dryRun.status !== 'ALREADY_ASSIGNED') return false;
  return receiptIds.every((id) => {
    const row = dryRun.provenance.find((item) => item.receiptId === id);
    return (
      row?.state === 'assigned' &&
      row.occurrenceId === occurrenceId &&
      row.invalidReason == null
    );
  });
}

export async function previewVerifiedOccurrenceRepairWithDb(
  db: VerifiedOccurrenceDryRunDb,
  params: { userId: string; receiptIds: readonly string[] },
  deps?: { dryRun?: DryRunFn }
): Promise<Extract<PreviewVerifiedOccurrenceRepairResult, { status: 'PREVIEW' }>> {
  const dryRun = deps?.dryRun ?? dryRunVerifiedPurchaseOccurrenceRepairWithDb;
  const result = await dryRun(db, {
    userId: params.userId,
    receiptIds: params.receiptIds,
    source: VERIFIED_OCCURRENCE_REPAIR_SOURCE,
  });
  return {
    status: 'PREVIEW',
    userId: params.userId,
    receiptIds: [...params.receiptIds],
    dryRun: result,
    executionAllowed: isVerifiedOccurrenceRepairExecutionAllowed(result),
    alreadyAssigned: result.status === 'ALREADY_ASSIGNED',
    existingOccurrenceId: existingOccurrenceId(result),
  };
}

function capturedErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function capturePostAssignmentVerification(
  read: () => Promise<VerifiedOccurrenceDryRunResult>,
  receiptIds: readonly string[],
  occurrenceId: string
): Promise<
  | { ok: true }
  | { ok: false; postVerificationStatus: string; verificationError: string | null }
> {
  try {
    const verified = await read();
    if (provenanceProvesAssignment(verified, receiptIds, occurrenceId)) {
      return { ok: true };
    }
    return {
      ok: false,
      postVerificationStatus: verified.status,
      verificationError: `post-verification did not prove assignment (${verified.status})`,
    };
  } catch (error) {
    return {
      ok: false,
      postVerificationStatus: 'THROWN',
      verificationError: capturedErrorMessage(error),
    };
  }
}

async function captureCloudFlush(
  changedReceiptIds: readonly string[],
  flush: () => Promise<unknown>
): Promise<{
  cloudSyncRequestStatus: VerifiedOccurrenceRepairCloudSyncRequestStatus;
  cloudSyncRequestError: string | null;
}> {
  if (changedReceiptIds.length === 0) {
    return { cloudSyncRequestStatus: 'not_needed', cloudSyncRequestError: null };
  }
  try {
    await flush();
    return { cloudSyncRequestStatus: 'requested', cloudSyncRequestError: null };
  } catch (error) {
    return {
      cloudSyncRequestStatus: 'request_failed',
      cloudSyncRequestError: capturedErrorMessage(error),
    };
  }
}

export async function executeVerifiedOccurrenceRepairWithDb(
  db: VerifiedOccurrenceRepairDb,
  params: { userId: string; receiptIds: readonly string[] },
  deps?: {
    dryRun?: DryRunFn;
    assign?: AssignFn;
    requestCloudBackupFlush?: () => Promise<unknown>;
  }
): Promise<Exclude<ExecuteVerifiedOccurrenceRepairResult, { status: 'BLOCKED_OWNER' }>> {
  const dryRun = deps?.dryRun ?? dryRunVerifiedPurchaseOccurrenceRepairWithDb;
  const assign = deps?.assign ?? assignVerifiedPurchaseOccurrenceWithDb;
  const flush = deps?.requestCloudBackupFlush ?? requestCloudBackupFlush;
  const receiptIds = [...params.receiptIds];
  const fresh = await dryRun(db, {
    userId: params.userId,
    receiptIds,
    source: VERIFIED_OCCURRENCE_REPAIR_SOURCE,
  });

  if (fresh.status === 'ALREADY_ASSIGNED') {
    const occurrenceId = existingOccurrenceId(fresh);
    if (
      occurrenceId &&
      provenanceProvesAssignment(fresh, receiptIds, occurrenceId)
    ) {
      return {
        status: 'ALREADY_COMPLETE',
        occurrenceId,
        selectedReceiptIds: receiptIds,
        postVerificationStatus: 'ALREADY_ASSIGNED',
        cloudSyncRequestStatus: 'not_needed',
        cloudSyncRequestError: null,
      };
    }
  }

  if (!isVerifiedOccurrenceRepairExecutionAllowed(fresh)) {
    return { status: 'NOT_ELIGIBLE', dryRun: fresh };
  }

  const assigned = await assign(db, {
    userId: params.userId,
    receiptIds,
    source: VERIFIED_OCCURRENCE_REPAIR_SOURCE,
  });

  const verification = await capturePostAssignmentVerification(
    () =>
      dryRun(db, {
        userId: params.userId,
        receiptIds,
        source: VERIFIED_OCCURRENCE_REPAIR_SOURCE,
      }),
    receiptIds,
    assigned.occurrenceId
  );
  const cloud = await captureCloudFlush(assigned.changedReceiptIds, flush);

  if (!verification.ok) {
    return {
      status: 'VERIFICATION_FAILED',
      occurrenceId: assigned.occurrenceId,
      changedReceiptIds: assigned.changedReceiptIds,
      unchangedReceiptIds: assigned.unchangedReceiptIds,
      selectedReceiptIds: receiptIds,
      postVerificationStatus: verification.postVerificationStatus,
      verificationError: verification.verificationError,
      localAssignmentCommitted: true,
      cloudSyncRequestStatus: cloud.cloudSyncRequestStatus,
      cloudSyncRequestError: cloud.cloudSyncRequestError,
    };
  }

  return {
    status: 'ASSIGNED',
    occurrenceId: assigned.occurrenceId,
    source: VERIFIED_OCCURRENCE_REPAIR_SOURCE,
    changedReceiptIds: assigned.changedReceiptIds,
    unchangedReceiptIds: assigned.unchangedReceiptIds,
    selectedReceiptIds: receiptIds,
    postVerificationStatus: 'ALREADY_ASSIGNED',
    cloudSyncRequestStatus: cloud.cloudSyncRequestStatus,
    cloudSyncRequestError: cloud.cloudSyncRequestError,
  };
}

async function resolveRepairUser(
  resolveOwnerScope: () => Promise<LocalReceiptOwnerScope>
): Promise<
  | { ok: true; userId: string }
  | { ok: false; reason: VerifiedOccurrenceRepairOwnerBlock }
> {
  const scope = await resolveOwnerScope();
  const blocked = repairOwnerBlockReason(scope);
  if (blocked) return { ok: false, reason: blocked };
  const userId = userIdFromReadyOwnerScope(scope);
  if (!userId) return { ok: false, reason: 'owner_unavailable' };
  return { ok: true, userId };
}

export async function previewVerifiedOccurrenceRepairForCurrentOwner(
  receiptIds: readonly string[],
  deps?: {
    resolveOwnerScope?: () => Promise<LocalReceiptOwnerScope>;
    getDatabase?: () => Promise<VerifiedOccurrenceDryRunDb>;
    dryRun?: DryRunFn;
  }
): Promise<PreviewVerifiedOccurrenceRepairResult> {
  const owner = await resolveRepairUser(
    deps?.resolveOwnerScope ?? resolveCurrentLocalReceiptOwnerScope
  );
  if (!owner.ok) {
    return { status: 'BLOCKED_OWNER', reason: owner.reason, executionAllowed: false };
  }
  const db = deps?.getDatabase
    ? await deps.getDatabase()
    : ((await getReceiptsDatabase()) as VerifiedOccurrenceDryRunDb);
  return previewVerifiedOccurrenceRepairWithDb(
    db,
    { userId: owner.userId, receiptIds },
    { dryRun: deps?.dryRun }
  );
}

export async function executeVerifiedOccurrenceRepairForCurrentOwner(
  receiptIds: readonly string[],
  deps?: {
    resolveOwnerScope?: () => Promise<LocalReceiptOwnerScope>;
    getDatabase?: () => Promise<VerifiedOccurrenceRepairDb>;
    dryRun?: DryRunFn;
    assign?: AssignFn;
    requestCloudBackupFlush?: () => Promise<unknown>;
  }
): Promise<ExecuteVerifiedOccurrenceRepairResult> {
  const owner = await resolveRepairUser(
    deps?.resolveOwnerScope ?? resolveCurrentLocalReceiptOwnerScope
  );
  if (!owner.ok) return { status: 'BLOCKED_OWNER', reason: owner.reason };
  const db = deps?.getDatabase
    ? await deps.getDatabase()
    : ((await getReceiptsDatabase()) as VerifiedOccurrenceRepairDb);
  return executeVerifiedOccurrenceRepairWithDb(
    db,
    { userId: owner.userId, receiptIds },
    deps
  );
}
