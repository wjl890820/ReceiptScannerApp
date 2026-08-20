/**
 * Account protection / backup status for Settings (no server status table).
 *
 * Distinguishes:
 * - anonymous (not protected)
 * - apple_linked_backup_pending
 * - apple_linked_protected (outbox empty for current user)
 */
import type * as SQLite from 'expo-sqlite';

import { getAuthState, type AuthState } from './anonAuth';

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
  localReceiptCount: number;
};

export async function countPendingSyncOutbox(
  db: SQLite.SQLiteDatabase
): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM sync_outbox`
  );
  return row?.c ?? 0;
}

export async function countLocalReceipts(
  db: SQLite.SQLiteDatabase
): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM receipts`
  );
  return row?.c ?? 0;
}

export async function getAccountProtectionStatus(params?: {
  getDb?: () => Promise<SQLite.SQLiteDatabase>;
  getAuth?: () => AuthState;
}): Promise<AccountProtectionStatus> {
  const auth = (params?.getAuth ?? getAuthState)();
  const getDb =
    params?.getDb ??
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getReceiptsDatabase } = require('./db') as typeof import('./db');
      return getReceiptsDatabase();
    });

  if (auth.status !== 'authenticated' || !auth.userId) {
    return {
      uiState: 'auth_unavailable',
      userId: null,
      isAnonymous: auth.isAnonymous,
      hasAppleIdentity: false,
      pendingOutboxCount: 0,
      localReceiptCount: 0,
    };
  }

  let pendingOutboxCount = 0;
  let localReceiptCount = 0;
  try {
    const db = await getDb();
    pendingOutboxCount = await countPendingSyncOutbox(db);
    localReceiptCount = await countLocalReceipts(db);
  } catch {
    // treat as unknown pending → conservative pending if apple linked
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
}
