/**
 * P0 Phase 4 / Privacy-H5 — installation-scoped local legacy receipt adoption.
 *
 * ONLY: NULL/empty user_id + current installation_id → current auth.uid()
 * NEVER: user A → user B; other-install; double-null; guessed ownership
 *
 * Automatic adoption is intended ONLY for the anonymous ownership-establishment
 * lifecycle on this installation.
 */
import type * as SQLite from 'expo-sqlite';

import { getOrCreateInstallationId } from './installationId';

export type LegacyAdoptionResult = {
  adopted: number;
  adopted_receipt_ids: string[];
  already_owned_by_current_user: number;
  owned_by_other_user: number;
  eligible_current_install_unowned: number;
  remaining_eligible_current_install_unowned: number;
  ambiguous_double_null: number;
  other_install_unowned: number;
  /** Compat alias: all unowned rows not adoptable by current automatic policy. */
  remaining_unowned: number;
};

export type AdoptionAuthEligibility = {
  isValid: () => boolean | Promise<boolean>;
};

export type LegacyAdoptionDeps = {
  getDb: () => Promise<SQLite.SQLiteDatabase>;
  getInstallationId: () => Promise<string>;
  authEligibility?: AdoptionAuthEligibility;
};

export type LegacyAdoptionTestHooks = {
  afterCandidateSelection?: () => void | Promise<void>;
};

let legacyAdoptionTestHooks: LegacyAdoptionTestHooks | null = null;

/** Test-only seam for auth-race coverage. */
export function __setLegacyAdoptionTestHooksForTests(
  hooks: LegacyAdoptionTestHooks | null
): void {
  legacyAdoptionTestHooks = hooks;
}

const UNOWNED_USER_SQL = `(user_id IS NULL OR TRIM(COALESCE(user_id, '')) = '')`;
const UNOWNED_INSTALL_SQL = `(installation_id IS NULL OR TRIM(COALESCE(installation_id, '')) = '')`;
const OWNED_USER_SQL = `(user_id IS NOT NULL AND TRIM(user_id) <> '')`;
const NONEMPTY_INSTALL_SQL = `(installation_id IS NOT NULL AND TRIM(installation_id) <> '')`;

export function isUnownedUserId(userId: unknown): boolean {
  return userId == null || (typeof userId === 'string' && userId.trim() === '');
}

/**
 * True only for Supabase anonymous users (User.is_anonymous).
 */
export function shouldAutoAdoptUnownedReceipts(user: {
  is_anonymous?: boolean | null;
  isAnonymous?: boolean | null;
}): boolean {
  if (user.is_anonymous === true) return true;
  if (user.isAnonymous === true) return true;
  return false;
}

async function assertAuthEligible(
  authEligibility: AdoptionAuthEligibility | undefined
): Promise<void> {
  if (!authEligibility) return;
  const valid = await authEligibility.isValid();
  if (!valid) {
    throw new Error('legacy adoption aborted: auth eligibility no longer valid');
  }
}

async function countRows(
  db: SQLite.SQLiteDatabase,
  sql: string,
  params: SQLite.SQLiteBindParams = []
): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(sql, params);
  return row?.c ?? 0;
}

async function classifyUnownedBuckets(
  db: SQLite.SQLiteDatabase,
  currentUserId: string,
  installationId: string
): Promise<{
  eligible_current_install_unowned: number;
  ambiguous_double_null: number;
  other_install_unowned: number;
  already_owned_by_current_user: number;
  owned_by_other_user: number;
}> {
  const [
    eligible_current_install_unowned,
    ambiguous_double_null,
    other_install_unowned,
    already_owned_by_current_user,
    owned_by_other_user,
  ] = await Promise.all([
    countRows(
      db,
      `SELECT COUNT(*) AS c FROM receipts
       WHERE ${UNOWNED_USER_SQL}
         AND installation_id = ?`,
      [installationId]
    ),
    countRows(
      db,
      `SELECT COUNT(*) AS c FROM receipts
       WHERE ${UNOWNED_USER_SQL}
         AND ${UNOWNED_INSTALL_SQL}`
    ),
    countRows(
      db,
      `SELECT COUNT(*) AS c FROM receipts
       WHERE ${UNOWNED_USER_SQL}
         AND ${NONEMPTY_INSTALL_SQL}
         AND installation_id <> ?`,
      [installationId]
    ),
    countRows(
      db,
      `SELECT COUNT(*) AS c FROM receipts WHERE TRIM(user_id) = ?`,
      [currentUserId]
    ),
    countRows(
      db,
      `SELECT COUNT(*) AS c FROM receipts
       WHERE ${OWNED_USER_SQL}
         AND TRIM(user_id) <> ?`,
      [currentUserId]
    ),
  ]);

  return {
    eligible_current_install_unowned,
    ambiguous_double_null,
    other_install_unowned,
    already_owned_by_current_user,
    owned_by_other_user,
  };
}

function emptyAdoptionResult(
  buckets: Awaited<ReturnType<typeof classifyUnownedBuckets>>
): LegacyAdoptionResult {
  return {
    adopted: 0,
    adopted_receipt_ids: [],
    already_owned_by_current_user: buckets.already_owned_by_current_user,
    owned_by_other_user: buckets.owned_by_other_user,
    eligible_current_install_unowned: buckets.eligible_current_install_unowned,
    remaining_eligible_current_install_unowned:
      buckets.eligible_current_install_unowned,
    ambiguous_double_null: buckets.ambiguous_double_null,
    other_install_unowned: buckets.other_install_unowned,
    remaining_unowned:
      buckets.ambiguous_double_null + buckets.other_install_unowned,
  };
}

/**
 * Adopt current-installation unowned receipts for the verified current user.
 * Idempotent via row state + installation predicate in SQL.
 */
export async function adoptUnownedReceiptsForUser(
  currentUserId: string,
  deps: LegacyAdoptionDeps
): Promise<LegacyAdoptionResult> {
  const uid = typeof currentUserId === 'string' ? currentUserId.trim() : '';
  if (!uid) {
    return {
      adopted: 0,
      adopted_receipt_ids: [],
      already_owned_by_current_user: 0,
      owned_by_other_user: 0,
      eligible_current_install_unowned: 0,
      remaining_eligible_current_install_unowned: 0,
      ambiguous_double_null: 0,
      other_install_unowned: 0,
      remaining_unowned: 0,
    };
  }

  const db = await deps.getDb();
  const installationId = (await deps.getInstallationId()).trim();
  if (!installationId) {
    const buckets = await classifyUnownedBuckets(db, uid, '');
    return emptyAdoptionResult(buckets);
  }

  let result: LegacyAdoptionResult = emptyAdoptionResult({
    eligible_current_install_unowned: 0,
    ambiguous_double_null: 0,
    other_install_unowned: 0,
    already_owned_by_current_user: 0,
    owned_by_other_user: 0,
  });

  await db.withExclusiveTransactionAsync(async (txn) => {
    await assertAuthEligible(deps.authEligibility);

    const beforeBuckets = await classifyUnownedBuckets(txn, uid, installationId);
    if (beforeBuckets.eligible_current_install_unowned === 0) {
      result = emptyAdoptionResult(beforeBuckets);
      return;
    }

    const candidates = await txn.getAllAsync<{ id: string }>(
      `SELECT id
       FROM receipts
       WHERE ${UNOWNED_USER_SQL}
         AND installation_id = ?
       ORDER BY id ASC`,
      [installationId]
    );
    const candidateIds = candidates.map((row) => row.id);
    if (candidateIds.length === 0) {
      result = emptyAdoptionResult(beforeBuckets);
      return;
    }

    await legacyAdoptionTestHooks?.afterCandidateSelection?.();
    await assertAuthEligible(deps.authEligibility);

    const updateResult = await txn.runAsync(
      `UPDATE receipts
       SET user_id = ?
       WHERE ${UNOWNED_USER_SQL}
         AND installation_id = ?`,
      [uid, installationId]
    );
    const adopted = updateResult.changes ?? 0;
    if (adopted !== candidateIds.length) {
      throw new Error(
        `legacy adoption ownership update mismatch: expected ${candidateIds.length}, got ${adopted}`
      );
    }

    await assertAuthEligible(deps.authEligibility);

    const afterBuckets = await classifyUnownedBuckets(txn, uid, installationId);
    result = {
      adopted,
      adopted_receipt_ids: adopted > 0 ? candidateIds : [],
      already_owned_by_current_user: afterBuckets.already_owned_by_current_user,
      owned_by_other_user: afterBuckets.owned_by_other_user,
      eligible_current_install_unowned: afterBuckets.eligible_current_install_unowned,
      remaining_eligible_current_install_unowned:
        afterBuckets.eligible_current_install_unowned,
      ambiguous_double_null: afterBuckets.ambiguous_double_null,
      other_install_unowned: afterBuckets.other_install_unowned,
      remaining_unowned:
        afterBuckets.ambiguous_double_null + afterBuckets.other_install_unowned,
    };
  });

  return result;
}

export async function adoptUnownedReceiptsForUserWithDefaults(
  currentUserId: string,
  getDb: () => Promise<SQLite.SQLiteDatabase>,
  options: { authEligibility?: AdoptionAuthEligibility } = {}
): Promise<LegacyAdoptionResult> {
  return adoptUnownedReceiptsForUser(currentUserId, {
    getDb,
    getInstallationId: getOrCreateInstallationId,
    authEligibility: options.authEligibility,
  });
}
