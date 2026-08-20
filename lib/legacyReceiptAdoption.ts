/**
 * P0 Phase 4 — one-time/idempotent local legacy receipt ownership adoption.
 *
 * ONLY: NULL/empty user_id → current auth.uid()
 * NEVER: user A → user B
 *
 * Automatic adoption is intended ONLY for the anonymous ownership-establishment
 * lifecycle on this installation. Callers must gate with is_anonymous === true
 * so a later Apple restore to a different account cannot silently merge locals.
 */
import type * as SQLite from 'expo-sqlite';

import { getOrCreateInstallationId } from './installationId';

export type LegacyAdoptionResult = {
  adopted: number;
  already_owned_by_current_user: number;
  owned_by_other_user: number;
  remaining_unowned: number;
  /** IDs that transitioned NULL/empty → current user (for backup handoff). */
  adopted_receipt_ids: string[];
};

export type LegacyAdoptionDeps = {
  getDb: () => Promise<SQLite.SQLiteDatabase>;
  getInstallationId: () => Promise<string>;
};

function isUnownedUserId(userId: unknown): boolean {
  return userId == null || (typeof userId === 'string' && userId.trim() === '');
}

/**
 * True only for Supabase anonymous users (User.is_anonymous).
 * Non-anonymous authenticated accounts (e.g. future Apple restore target)
 * must NOT auto-adopt unowned local receipts.
 */
export function shouldAutoAdoptUnownedReceipts(user: {
  is_anonymous?: boolean | null;
  isAnonymous?: boolean | null;
}): boolean {
  if (user.is_anonymous === true) return true;
  if (user.isAnonymous === true) return true;
  return false;
}

/**
 * Adopt unowned local receipts for the verified current user.
 * Idempotent via row state: WHERE user_id IS NULL OR user_id = ''.
 */
export async function adoptUnownedReceiptsForUser(
  currentUserId: string,
  deps: LegacyAdoptionDeps
): Promise<LegacyAdoptionResult> {
  const uid = typeof currentUserId === 'string' ? currentUserId.trim() : '';
  if (!uid) {
    return {
      adopted: 0,
      already_owned_by_current_user: 0,
      owned_by_other_user: 0,
      remaining_unowned: 0,
      adopted_receipt_ids: [],
    };
  }

  const db = await deps.getDb();
  const installationId = await deps.getInstallationId();

  let result: LegacyAdoptionResult = {
    adopted: 0,
    already_owned_by_current_user: 0,
    owned_by_other_user: 0,
    remaining_unowned: 0,
    adopted_receipt_ids: [],
  };

  await db.withTransactionAsync(async () => {
    const rows = await db.getAllAsync<{ id: string; user_id: string | null }>(
      `SELECT id, user_id FROM receipts`
    );

    let unownedBefore = 0;
    let alreadyOwnedBefore = 0;
    let ownedByOtherBefore = 0;
    const unownedIds: string[] = [];

    for (const row of rows) {
      if (isUnownedUserId(row.user_id)) {
        unownedBefore += 1;
        unownedIds.push(row.id);
      } else if (String(row.user_id).trim() === uid) {
        alreadyOwnedBefore += 1;
      } else {
        ownedByOtherBefore += 1;
      }
    }

    let adopted = 0;
    if (unownedBefore > 0) {
      const updateResult = await db.runAsync(
        `
        UPDATE receipts
        SET user_id = ?, installation_id = ?
        WHERE user_id IS NULL OR user_id = ''
        `,
        [uid, installationId]
      );
      adopted =
        typeof updateResult?.changes === 'number' ? updateResult.changes : unownedBefore;
    }

    const afterUnowned = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) as c FROM receipts WHERE user_id IS NULL OR user_id = ''`
    );

    result = {
      adopted,
      already_owned_by_current_user: alreadyOwnedBefore,
      owned_by_other_user: ownedByOtherBefore,
      remaining_unowned: afterUnowned?.c ?? 0,
      adopted_receipt_ids: adopted > 0 ? unownedIds : [],
    };
  });

  return result;
}

export async function adoptUnownedReceiptsForUserWithDefaults(
  currentUserId: string,
  getDb: () => Promise<SQLite.SQLiteDatabase>
): Promise<LegacyAdoptionResult> {
  return adoptUnownedReceiptsForUser(currentUserId, {
    getDb,
    getInstallationId: getOrCreateInstallationId,
  });
}
