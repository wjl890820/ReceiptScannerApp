/**
 * FLOW B — Restore existing Apple-linked account via SIGN-IN (not linkIdentity).
 *
 * Uses signInWithIdToken. Local DB must be empty with no pending outbox
 * BEFORE Apple account switch (Phase 6 safety contract).
 */
import type { Session } from '@supabase/supabase-js';

import {
  applyExternalSession,
  getAuthState,
  type AuthState,
} from './anonAuth';
import {
  countLocalReceipts,
  countPendingSyncOutbox,
} from './accountProtectionStatus';
import { requestAppleIdentityToken } from './appleAuthCredential';
import {
  restoreCloudReceiptsForCurrentUser,
  type CloudRestoreResult,
} from './cloudRestore';
import { getOrCreateInstallationId } from './installationId';
import { registerInstallationForUser } from './installationRegistration';
import { getSupabaseClient } from './supabaseClient';

export type AppleRestoreStatus =
  | 'ok'
  | 'ok_empty'
  | 'canceled'
  | 'blocked_local_data_present'
  | 'blocked_pending_local_changes'
  | 'auth_unavailable'
  | 'apple_unavailable'
  | 'missing_identity_token'
  | 'sign_in_failed'
  | 'restore_failed'
  | 'flag_off';

export type AppleRestoreResult = {
  status: AppleRestoreStatus;
  temporaryUserId?: string | null;
  restoredUserId?: string;
  restoredCount?: number;
  restore?: CloudRestoreResult;
  error?: string;
};

export type AppleRestoreDeps = {
  isEnabled: () => boolean;
  getAuth: () => AuthState;
  getClient: typeof getSupabaseClient;
  getDb: () => Promise<import('expo-sqlite').SQLiteDatabase>;
  requestAppleCredential: typeof requestAppleIdentityToken;
  applySession: (session: Session) => AuthState;
  restoreCloud: typeof restoreCloudReceiptsForCurrentUser;
  getInstallationId: () => Promise<string>;
  registerInstallation: typeof registerInstallationForUser;
  getPlatform: () => string;
  getAppVersion: () => string;
};

function resolveRestoreDeps(partial: Partial<AppleRestoreDeps>): AppleRestoreDeps {
  return {
    isEnabled:
      partial.isEnabled ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { isAppleLinkEnabled } = require('./env') as typeof import('./env');
        return isAppleLinkEnabled();
      }),
    getAuth: partial.getAuth ?? getAuthState,
    getClient: partial.getClient ?? getSupabaseClient,
    getDb:
      partial.getDb ??
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getReceiptsDatabase } = require('./db') as typeof import('./db');
        return getReceiptsDatabase();
      }),
    requestAppleCredential: partial.requestAppleCredential ?? requestAppleIdentityToken,
    applySession: partial.applySession ?? applyExternalSession,
    restoreCloud: partial.restoreCloud ?? restoreCloudReceiptsForCurrentUser,
    getInstallationId: partial.getInstallationId ?? getOrCreateInstallationId,
    registerInstallation: partial.registerInstallation ?? registerInstallationForUser,
    getPlatform:
      partial.getPlatform ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Platform } = require('react-native') as typeof import('react-native');
        return Platform.OS === 'ios' ? 'ios' : Platform.OS;
      }),
    getAppVersion:
      partial.getAppVersion ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Constants = require('expo-constants').default as typeof import('expo-constants').default;
        return Constants.expoConfig?.version || '1.0.0';
      }),
  };
}

/**
 * Sign in to an existing Apple-linked account and run Phase 6 restore.
 * Blocks BEFORE Apple sign-in if local data/outbox present.
 */
export async function restoreExistingAppleAccount(
  depsPartial: Partial<AppleRestoreDeps> = {}
): Promise<AppleRestoreResult> {
  const deps = resolveRestoreDeps(depsPartial);
  if (!deps.isEnabled()) {
    return { status: 'flag_off' };
  }

  const authBefore = deps.getAuth();
  const temporaryUserId = authBefore.userId;

  let db: import('expo-sqlite').SQLiteDatabase;
  try {
    db = await deps.getDb();
  } catch (e: any) {
    return { status: 'auth_unavailable', temporaryUserId, error: String(e?.message || e) };
  }

  const localCount = await countLocalReceipts(db);
  if (localCount > 0) {
    return {
      status: 'blocked_local_data_present',
      temporaryUserId,
    };
  }
  const pending = await countPendingSyncOutbox(db);
  if (pending > 0) {
    return {
      status: 'blocked_pending_local_changes',
      temporaryUserId,
    };
  }

  const apple = await deps.requestAppleCredential();
  if (apple.status === 'canceled') {
    return { status: 'canceled', temporaryUserId };
  }
  if (apple.status === 'unavailable') {
    return { status: 'apple_unavailable', temporaryUserId, error: apple.error };
  }
  if (apple.status === 'missing_identity_token') {
    return { status: 'missing_identity_token', temporaryUserId };
  }
  if (apple.status !== 'ok') {
    return { status: 'sign_in_failed', temporaryUserId, error: apple.error };
  }

  const client = deps.getClient();
  if (!client) {
    return { status: 'auth_unavailable', temporaryUserId };
  }

  // CRITICAL: signInWithIdToken — account switch to Apple-linked user A.
  const { data, error } = await client.auth.signInWithIdToken({
    provider: 'apple',
    token: apple.identityToken,
    nonce: apple.rawNonce,
  });

  if (error || !data?.session?.user?.id) {
    return {
      status: 'sign_in_failed',
      temporaryUserId,
      error: error?.message || 'sign_in_failed',
    };
  }

  const session = data.session;
  const restoredUserId = session.user.id;
  deps.applySession(session);

  try {
    const installationId = await deps.getInstallationId();
    await deps.registerInstallation({
      supabase: client,
      userId: restoredUserId,
      installationId,
      platform: deps.getPlatform(),
      appVersion: deps.getAppVersion(),
    });
  } catch (e) {
    console.warn('[AppleRestore] installation register failed (nonfatal):', e);
  }

  // Phase 6 restore as user A. Failure must NOT sign out.
  const restore = await deps.restoreCloud({
    getAuth: () => deps.getAuth(),
    getClient: deps.getClient,
    getDb: deps.getDb,
    getInstallationId: deps.getInstallationId,
  });

  if (restore.status === 'ok') {
    return {
      status: restore.restored === 0 ? 'ok_empty' : 'ok',
      temporaryUserId,
      restoredUserId,
      restoredCount: restore.restored,
      restore,
    };
  }

  return {
    status: 'restore_failed',
    temporaryUserId,
    restoredUserId,
    restoredCount: 0,
    restore,
    error: restore.error || restore.status,
  };
}
