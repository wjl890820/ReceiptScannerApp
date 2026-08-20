/**
 * FLOW A — Protect current anonymous account via Apple identity LINKING.
 *
 * Uses Supabase auth.linkIdentity({ provider:'apple', token, nonce })
 * with link_identity:true (installed auth-js 2.90.1).
 *
 * MUST keep the same auth.uid(). Never signInWithIdToken here.
 */
import type { Session, User } from '@supabase/supabase-js';

import {
  applyExternalSession,
  getAuthState,
  userHasAppleIdentity,
  type AuthState,
} from './anonAuth';
import { requestAppleIdentityToken } from './appleAuthCredential';
import { bootstrapOwnedReceiptBackupIntents } from './cloudBackupBootstrap';
import { requestCloudBackupFlush } from './cloudBackupWorker';
import { getOrCreateInstallationId } from './installationId';
import { registerInstallationForUser } from './installationRegistration';
import { getSupabaseClient } from './supabaseClient';

export type AppleProtectStatus =
  | 'ok'
  | 'canceled'
  | 'auth_unavailable'
  | 'not_anonymous'
  | 'already_protected'
  | 'uid_changed'
  | 'apple_identity_in_use'
  | 'apple_unavailable'
  | 'missing_identity_token'
  | 'link_failed'
  | 'flag_off';

export type AppleProtectResult = {
  status: AppleProtectStatus;
  beforeUserId?: string;
  afterUserId?: string;
  error?: string;
};

function isIdentityInUseError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const msg = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  return (
    msg.includes('already') &&
    (msg.includes('identity') ||
      msg.includes('linked') ||
      msg.includes('registered') ||
      msg.includes('exists') ||
      msg.includes('in use'))
  );
}

export type AppleProtectDeps = {
  isEnabled: () => boolean;
  getAuth: () => AuthState;
  getClient: typeof getSupabaseClient;
  requestAppleCredential: typeof requestAppleIdentityToken;
  applySession: (session: Session) => AuthState;
  getDb: () => Promise<import('expo-sqlite').SQLiteDatabase>;
  getInstallationId: () => Promise<string>;
  registerInstallation: typeof registerInstallationForUser;
  bootstrapBackup: typeof bootstrapOwnedReceiptBackupIntents;
  requestFlush: typeof requestCloudBackupFlush;
  getPlatform: () => string;
  getAppVersion: () => string;
};

function resolveProtectDeps(partial: Partial<AppleProtectDeps>): AppleProtectDeps {
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
    requestAppleCredential: partial.requestAppleCredential ?? requestAppleIdentityToken,
    applySession: partial.applySession ?? applyExternalSession,
    getDb:
      partial.getDb ??
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getReceiptsDatabase } = require('./db') as typeof import('./db');
        return getReceiptsDatabase();
      }),
    getInstallationId: partial.getInstallationId ?? getOrCreateInstallationId,
    registerInstallation: partial.registerInstallation ?? registerInstallationForUser,
    bootstrapBackup: partial.bootstrapBackup ?? bootstrapOwnedReceiptBackupIntents,
    requestFlush: partial.requestFlush ?? requestCloudBackupFlush,
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
 * Link Apple to the CURRENT anonymous user. UID must not change.
 */
export async function protectCurrentAccountWithApple(
  depsPartial: Partial<AppleProtectDeps> = {}
): Promise<AppleProtectResult> {
  const deps = resolveProtectDeps(depsPartial);
  if (!deps.isEnabled()) {
    return { status: 'flag_off' };
  }

  const auth = deps.getAuth();
  if (auth.status !== 'authenticated' || !auth.userId || !auth.accessToken) {
    return { status: 'auth_unavailable' };
  }
  if (auth.hasAppleIdentity === true && auth.isAnonymous === false) {
    return { status: 'already_protected', beforeUserId: auth.userId, afterUserId: auth.userId };
  }
  if (auth.isAnonymous !== true) {
    return { status: 'not_anonymous', beforeUserId: auth.userId };
  }

  const beforeUserId = auth.userId;
  const apple = await deps.requestAppleCredential();
  if (apple.status === 'canceled') return { status: 'canceled', beforeUserId };
  if (apple.status === 'unavailable') {
    return { status: 'apple_unavailable', beforeUserId, error: apple.error };
  }
  if (apple.status === 'missing_identity_token') {
    return { status: 'missing_identity_token', beforeUserId };
  }
  if (apple.status !== 'ok') {
    return { status: 'link_failed', beforeUserId, error: apple.error };
  }

  const client = deps.getClient();
  if (!client) {
    return { status: 'auth_unavailable', beforeUserId };
  }

  // CRITICAL: linkIdentity — not signInWithIdToken.
  const { data, error } = await client.auth.linkIdentity({
    provider: 'apple',
    token: apple.identityToken,
    nonce: apple.rawNonce,
  });

  if (error) {
    if (isIdentityInUseError(error)) {
      return {
        status: 'apple_identity_in_use',
        beforeUserId,
        error: error.message,
      };
    }
    return {
      status: 'link_failed',
      beforeUserId,
      error: error.message || 'link_failed',
    };
  }

  const session = data?.session as Session | null | undefined;
  const user = (data?.user ?? session?.user) as User | null | undefined;
  if (!session?.user?.id || !user?.id) {
    return {
      status: 'link_failed',
      beforeUserId,
      error: 'link_returned_no_session',
    };
  }

  const afterUserId = user.id;
  if (afterUserId !== beforeUserId) {
    // Critical failure: do not adopt/migrate. Session may already have switched —
    // still report failure; caller must not rewrite ownership.
    deps.applySession(session);
    return {
      status: 'uid_changed',
      beforeUserId,
      afterUserId,
      error: 'apple_link_changed_uid',
    };
  }

  deps.applySession(session);

  // Soft assert Apple identity present when identities array is available.
  if (Array.isArray(user.identities) && user.identities.length > 0) {
    if (!userHasAppleIdentity(user) && __DEV__) {
      console.warn('[AppleProtect] linked but apple identity not yet visible on user');
    }
  }

  try {
    const installationId = await deps.getInstallationId();
    await deps.registerInstallation({
      supabase: client,
      userId: afterUserId,
      installationId,
      platform: deps.getPlatform(),
      appVersion: deps.getAppVersion(),
    });
  } catch (e) {
    console.warn('[AppleProtect] installation register failed (nonfatal):', e);
  }

  try {
    const db = await deps.getDb();
    await deps.bootstrapBackup(db, afterUserId);
  } catch (e) {
    console.warn('[AppleProtect] backup bootstrap failed (nonfatal):', e);
  }
  void deps.requestFlush();

  return { status: 'ok', beforeUserId, afterUserId };
}
