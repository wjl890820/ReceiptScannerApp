/**
 * Account protection / backup status for Settings (no server status table).
 *
 * Distinguishes:
 * - anonymous (not protected)
 * - apple_linked_backup_pending
 * - apple_linked_protected (outbox empty for current user)
 * - auth_unavailable (auth/scope/db status could not be confirmed)
 * - empty_install (scoped local stored receipts = 0)
 */
import type * as SQLite from 'expo-sqlite';

import { getAuthState, type AuthState } from './anonAuth';
import {
  resolveCurrentLocalReceiptOwnerScope,
  type LocalReceiptOwnerScope,
  type LocalReceiptOwnerScopeReady,
} from './receiptOwnershipScope';

export type AccountProtectionUiState =
  | 'anonymous'
  | 'apple_linked_backup_pending'
  | 'apple_linked_protected'
  | 'auth_unavailable'
  | 'empty_install';

export type AccountProtectionStatus = {
  uiState: AccountProtectionUiState;
  userId: string | null;
  isAnonymous: boolean | null;
  hasAppleIdentity: boolean;
  pendingOutboxCount: number;
  /** Scoped stored receipt count; null when status could not be read safely. */
  localReceiptCount: number | null;
};

export async function countPendingSyncOutbox(
  db: SQLite.SQLiteDatabase
): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM sync_outbox`
  );
  return row?.c ?? 0;
}

/** Unscoped table count — legacy restore guard only; not Settings truth. */
export async function countLocalReceipts(
  db: SQLite.SQLiteDatabase
): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM receipts`
  );
  return row?.c ?? 0;
}

function authUnavailableStatus(auth: AuthState): AccountProtectionStatus {
  return {
    uiState: 'auth_unavailable',
    userId: auth.userId,
    isAnonymous: auth.isAnonymous,
    hasAppleIdentity: false,
    pendingOutboxCount: 0,
    localReceiptCount: null,
  };
}

export async function getAccountProtectionStatus(params?: {
  getDb?: () => Promise<SQLite.SQLiteDatabase>;
  getAuth?: () => AuthState;
  resolveOwnerScope?: () => Promise<LocalReceiptOwnerScope>;
  countScopedLocalReceiptsForScope?: (
    scope: LocalReceiptOwnerScopeReady,
    db: SQLite.SQLiteDatabase
  ) => Promise<number | null>;
}): Promise<AccountProtectionStatus> {
  const auth = (params?.getAuth ?? getAuthState)();
  const getDb =
    params?.getDb ??
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getReceiptsDatabase } = require('./db') as typeof import('./db');
      return getReceiptsDatabase();
    });
  const resolveOwnerScope =
    params?.resolveOwnerScope ?? resolveCurrentLocalReceiptOwnerScope;
  const readScopedLocalReceiptCount =
    params?.countScopedLocalReceiptsForScope ??
    (async (scope: LocalReceiptOwnerScopeReady, db: SQLite.SQLiteDatabase) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { countScopedLocalReceiptsForOwnerScope } =
        require('./scopedLocalReceiptCount') as typeof import('./scopedLocalReceiptCount');
      return countScopedLocalReceiptsForOwnerScope(scope, db);
    });

  if (auth.status !== 'authenticated' || !auth.userId) {
    return authUnavailableStatus(auth);
  }

  try {
    const scope = await resolveOwnerScope();
    if (scope.status !== 'ready') {
      return authUnavailableStatus(auth);
    }

    const db = await getDb();
    const pendingOutboxCount = await countPendingSyncOutbox(db);
    const localReceiptCount = await readScopedLocalReceiptCount(scope, db);
    if (localReceiptCount == null) {
      return authUnavailableStatus(auth);
    }

    const hasAppleIdentity = auth.hasAppleIdentity === true;
    const isAnonymous = auth.isAnonymous === true;

    if (!hasAppleIdentity || isAnonymous) {
      if (localReceiptCount === 0 && pendingOutboxCount === 0) {
        return {
          uiState: 'empty_install',
          userId: auth.userId,
          isAnonymous,
          hasAppleIdentity: false,
          pendingOutboxCount,
          localReceiptCount,
        };
      }
      return {
        uiState: 'anonymous',
        userId: auth.userId,
        isAnonymous,
        hasAppleIdentity: false,
        pendingOutboxCount,
        localReceiptCount,
      };
    }

    return {
      uiState:
        pendingOutboxCount > 0
          ? 'apple_linked_backup_pending'
          : 'apple_linked_protected',
      userId: auth.userId,
      isAnonymous: false,
      hasAppleIdentity: true,
      pendingOutboxCount,
      localReceiptCount,
    };
  } catch {
    return authUnavailableStatus(auth);
  }
}
