/**
 * Observational current local receipt owner.
 *
 * Returns the owner authority that is already established in this process,
 * or fails closed. It does not create or repair that authority.
 *
 * Authoritative state, in order:
 * 1. In-memory auth from getAuthState(). This does not call ensureAnonAuth.
 * 2. For an already-authenticated anonymous session, the in-memory settled
 *    adoption user from readSettledOwnershipAdoptionUserId(). This does not
 *    call settle or adopt receipts.
 * 3. For auth that is already unavailable, an installation id already stored
 *    under INSTALLATION_ID_STORAGE_KEY. The read uses getItem only.
 *
 * Not authoritative, and therefore fail closed:
 * - auth still initializing
 * - authenticated anonymous session whose adoption has not already settled
 * - isAnonymous null/unknown
 * - no already-stored installation id
 *
 * No auth bootstrap, ownership adoption, installation-id creation, outbox,
 * cloud backup, or network.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getAuthState, type AuthState } from './anonAuth';
import { isAnonAuthEnabled } from './env';
import { INSTALLATION_ID_STORAGE_KEY } from './installationId';
import { readSettledOwnershipAdoptionUserId } from './ownershipAdoptionOrchestrator';
import {
  buildOwnerScopedReceiptPredicates,
  type LocalReceiptOwnerScope,
} from './receiptOwnershipScope';

export type ObservationalReceiptOwnerScopeDeps = {
  readAuthState?: () => AuthState;
  anonAuthEnabled?: boolean;
  readSettledAnonymousUserId?: () => string | null;
  readStoredInstallationId?: () => Promise<string | null>;
};

function unavailable(): LocalReceiptOwnerScope {
  return { status: 'owner_unavailable' };
}

function readyScope(ownerKey: string): LocalReceiptOwnerScope {
  const predicates = buildOwnerScopedReceiptPredicates(ownerKey);
  if (!predicates) return unavailable();
  return {
    status: 'ready',
    ownerKey: predicates.ownerKey,
    receiptWhereSql: predicates.receiptWhereSql,
    itemWhereSql: predicates.itemWhereSql,
    params: predicates.params,
  };
}

async function readStoredInstallationId(): Promise<string | null> {
  try {
    const existing = await AsyncStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
    if (typeof existing !== 'string') return null;
    const trimmed = existing.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function resolveObservationalReceiptOwnerScope(
  deps: ObservationalReceiptOwnerScopeDeps = {}
): Promise<LocalReceiptOwnerScope> {
  const readAuth = deps.readAuthState ?? getAuthState;
  const anonEnabled = deps.anonAuthEnabled ?? isAnonAuthEnabled();
  const readSettled =
    deps.readSettledAnonymousUserId ?? readSettledOwnershipAdoptionUserId;
  const readInstallation =
    deps.readStoredInstallationId ?? readStoredInstallationId;

  if (!anonEnabled) {
    const installationId = await readInstallation();
    return installationId ? readyScope(`installation:${installationId}`) : unavailable();
  }

  const auth = readAuth();
  if (auth.status === 'initializing') return unavailable();

  if (auth.status === 'authenticated') {
    const userId = nonEmpty(auth.userId);
    if (!userId) return unavailable();
    if (auth.isAnonymous === false) return readyScope(`user:${userId}`);
    if (auth.isAnonymous === true) {
      const settledUserId = nonEmpty(readSettled());
      if (settledUserId && settledUserId === userId) {
        return readyScope(`user:${userId}`);
      }
      return unavailable();
    }
    return unavailable();
  }

  const installationId = await readInstallation();
  return installationId ? readyScope(`installation:${installationId}`) : unavailable();
}
