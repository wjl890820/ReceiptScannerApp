/**
 * Privacy-H1 — shared current local receipt owner read scope.
 */

import { resolvePersonalProductIdentityOwnerKey } from './personalProductIdentityContract';
import type { OwnershipAdoptionSettleResult } from './ownershipAdoptionOrchestrator';
import type { OwnerScopedReceiptReadUnavailableReason } from './ownerScopedReceiptReadError';

/**
 * FINAL auth mode is authoritative for whether adoption `not_applicable`
 * can authorize a user scope. Anonymous finals require V-specific settlement;
 * unknown isAnonymous never authorizes.
 */
export function adoptionMatchesFinalUser(
  adoption: OwnershipAdoptionSettleResult,
  candidateUserId: string,
  finalAuth: {
    status: string;
    userId: string | null;
    isAnonymous: boolean | null;
  }
): boolean {
  if (
    finalAuth.status !== 'authenticated' ||
    finalAuth.userId !== candidateUserId
  ) {
    return false;
  }
  if (finalAuth.isAnonymous === true) {
    return (
      adoption.status === 'settled' &&
      adoption.userId === candidateUserId &&
      adoption.userId === finalAuth.userId
    );
  }
  if (finalAuth.isAnonymous === false) {
    return adoption.status === 'not_applicable';
  }
  // isAnonymous null/unknown — fail closed; never treat as non-anonymous.
  return false;
}

export type LocalReceiptOwnerScopeReady = {
  status: 'ready';
  ownerKey: string;
  receiptWhereSql: string;
  itemWhereSql: string;
  params: string[];
};

export type LocalReceiptOwnerScope =
  | LocalReceiptOwnerScopeReady
  | {
      status: 'owner_unavailable';
      reason?: OwnerScopedReceiptReadUnavailableReason;
    };

export type OwnerScopedSqlPredicates = {
  ownerKey: string;
  receiptWhereSql: string;
  itemWhereSql: string;
  params: string[];
};

export type OwnerScopedNamedPredicates = {
  ownerKey: string;
  receiptWhereSql: string;
  itemWhereSql: string;
  binds: Record<string, string>;
};

type OwnerDescriptor = { kind: 'user' | 'installation'; id: string };

function parseOwnerKey(ownerKey: string): OwnerDescriptor | null {
  if (ownerKey.startsWith('user:')) {
    const id = ownerKey.slice('user:'.length).trim();
    return id ? { kind: 'user', id } : null;
  }
  if (ownerKey.startsWith('installation:')) {
    const id = ownerKey.slice('installation:'.length).trim();
    return id ? { kind: 'installation', id } : null;
  }
  return null;
}

function buildPositionalPredicatesFromDescriptor(
  ownerKey: string,
  parsed: OwnerDescriptor
): OwnerScopedSqlPredicates {
  if (parsed.kind === 'user') {
    return {
      ownerKey,
      itemWhereSql: 'receipts.user_id = ?',
      receiptWhereSql: 'receipts.user_id = ?',
      params: [parsed.id],
    };
  }
  return {
    ownerKey,
    itemWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
    receiptWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
    params: [parsed.id],
  };
}

function buildNamedPredicatesFromDescriptor(
  ownerKey: string,
  parsed: OwnerDescriptor
): OwnerScopedNamedPredicates {
  if (parsed.kind === 'user') {
    return {
      ownerKey,
      itemWhereSql: 'receipts.user_id = $ownerScopeUserId',
      receiptWhereSql: 'receipts.user_id = $ownerScopeUserId',
      binds: { $ownerScopeUserId: parsed.id },
    };
  }
  const installationSql =
    'receipts.user_id IS NULL AND receipts.installation_id = $ownerScopeInstallationId';
  return {
    ownerKey,
    itemWhereSql: installationSql,
    receiptWhereSql: installationSql,
    binds: { $ownerScopeInstallationId: parsed.id },
  };
}

export function buildOwnerScopedReceiptPredicates(
  ownerKey: string
): OwnerScopedSqlPredicates | null {
  const parsed = parseOwnerKey(ownerKey);
  if (!parsed) return null;
  return buildPositionalPredicatesFromDescriptor(ownerKey, parsed);
}

/** Named-bind form for SQLite queries that use $param binds (e.g. History search). */
export function buildOwnerScopedReceiptNamedPredicates(
  ownerKey: string
): OwnerScopedNamedPredicates | null {
  const parsed = parseOwnerKey(ownerKey);
  if (!parsed) return null;
  return buildNamedPredicatesFromDescriptor(ownerKey, parsed);
}

export function ownerScopeNamedPredicatesFromReady(
  scope: LocalReceiptOwnerScopeReady
): OwnerScopedNamedPredicates | null {
  return buildOwnerScopedReceiptNamedPredicates(scope.ownerKey);
}

/** G4 inventory alias — same SQL predicate authority as buildOwnerScopedReceiptPredicates. */
export function buildOwnerScopedInventoryPredicates(ownerKey: string): {
  itemWhereSql: string;
  receiptWhereSql: string;
  params: string[];
} | null {
  const scoped = buildOwnerScopedReceiptPredicates(ownerKey);
  if (!scoped) return null;
  return {
    itemWhereSql: scoped.itemWhereSql,
    receiptWhereSql: scoped.receiptWhereSql,
    params: scoped.params,
  };
}

export async function resolveCurrentLocalReceiptOwnerScope(): Promise<LocalReceiptOwnerScope> {
  return resolveCurrentLocalReceiptOwnerScopeAttempt(0);
}

async function resolveCurrentLocalReceiptOwnerScopeAttempt(
  attempt: number
): Promise<LocalReceiptOwnerScope> {
  const {
    ensureAuthoritativeOwnerScopeReady,
    recordOwnerScopeWaitEnd,
  } = await import('./ownerScopeReadiness');
  const readiness = await ensureAuthoritativeOwnerScopeReady();

  // Adoption failed / DB not ready: fail closed — no authoritative user scope.
  if (readiness.blockAuthoritativeUserScope) {
    const reason =
      readiness.adoption.status === 'not_ready'
        ? 'adoption_not_ready'
        : 'adoption_failed';
    recordOwnerScopeWaitEnd(
      readiness,
      reason === 'adoption_not_ready' ? 'adoption_not_ready' : 'adoption_failed'
    );
    return { status: 'owner_unavailable', reason };
  }

  const { resolveOwnershipStamp } = await import('./receiptOwnershipContext');
  const stamp = await resolveOwnershipStamp();

  // Final authority check after all async readiness/stamp work.
  let authStatus: string = 'unavailable';
  let authUserId: string | null = null;
  let authIsAnonymous: boolean | null = null;
  let anonEnabled = true;
  try {
    const { getAuthState } = await import('./anonAuth');
    const { isAnonAuthEnabled } = await import('./env');
    anonEnabled = isAnonAuthEnabled();
    const auth = getAuthState();
    authStatus = auth.status;
    authUserId =
      typeof auth.userId === 'string' && auth.userId.trim()
        ? auth.userId.trim()
        : null;
    authIsAnonymous =
      typeof auth.isAnonymous === 'boolean' ? auth.isAnonymous : null;
  } catch {
    // Tests without Expo natives — fall through with stamp only.
    anonEnabled = false;
  }

  const candidateUserId =
    typeof stamp.userId === 'string' && stamp.userId.trim()
      ? stamp.userId.trim()
      : null;

  if (!anonEnabled) {
    // Feature off: installation scope only (ignore any stamp userId).
    const installKey = stamp.installationId
      ? `installation:${stamp.installationId}`
      : null;
    const ownerKey = installKey;
    if (!ownerKey) {
      recordOwnerScopeWaitEnd(readiness, 'unavailable');
      return { status: 'owner_unavailable' };
    }
    const predicates = buildOwnerScopedReceiptPredicates(ownerKey);
    if (!predicates) {
      recordOwnerScopeWaitEnd(readiness, 'unavailable');
      return { status: 'owner_unavailable' };
    }
    recordOwnerScopeWaitEnd(readiness, 'installation');
    return {
      status: 'ready',
      ownerKey: predicates.ownerKey,
      receiptWhereSql: predicates.receiptWhereSql,
      itemWhereSql: predicates.itemWhereSql,
      params: predicates.params,
    };
  }

  // User scope only if final auth matches candidate AND adoption matches FINAL auth mode.
  if (candidateUserId) {
    const finalAuth = {
      status: authStatus,
      userId: authUserId,
      isAnonymous: authIsAnonymous,
    };
    const adoptionMatchesUser = adoptionMatchesFinalUser(
      readiness.adoption,
      candidateUserId,
      finalAuth
    );

    if (adoptionMatchesUser) {
      const predicates = buildOwnerScopedReceiptPredicates(
        `user:${candidateUserId}`
      );
      if (!predicates) {
        recordOwnerScopeWaitEnd(readiness, 'unavailable');
        return { status: 'owner_unavailable' };
      }
      recordOwnerScopeWaitEnd(readiness, 'user');
      return {
        status: 'ready',
        ownerKey: predicates.ownerKey,
        receiptWhereSql: predicates.receiptWhereSql,
        itemWhereSql: predicates.itemWhereSql,
        params: predicates.params,
      };
    }

    // Auth changed during async resolution (U→V or U→unavailable),
    // not_applicable→anonymous V, unknown isAnonymous, or adoption mismatch.
    if (attempt === 0) {
      return resolveCurrentLocalReceiptOwnerScopeAttempt(1);
    }
    // Still unstable / mismatched after one full readiness retry.
    if (authStatus === 'unavailable') {
      // Fall through to installation fallback below.
    } else {
      recordOwnerScopeWaitEnd(readiness, 'unavailable');
      return { status: 'owner_unavailable', reason: 'auth_unstable' };
    }
  }

  // Installation fallback only when final auth is unavailable (or no user candidate).
  if (authStatus === 'unavailable' || authStatus === 'initializing') {
    // initializing should be rare here (readiness waited); treat as unavailable for safety.
    const installId =
      typeof stamp.installationId === 'string' && stamp.installationId.trim()
        ? stamp.installationId.trim()
        : null;
    if (!installId) {
      recordOwnerScopeWaitEnd(readiness, 'unavailable');
      return { status: 'owner_unavailable' };
    }
    const predicates = buildOwnerScopedReceiptPredicates(
      `installation:${installId}`
    );
    if (!predicates) {
      recordOwnerScopeWaitEnd(readiness, 'unavailable');
      return { status: 'owner_unavailable' };
    }
    recordOwnerScopeWaitEnd(readiness, 'installation');
    return {
      status: 'ready',
      ownerKey: predicates.ownerKey,
      receiptWhereSql: predicates.receiptWhereSql,
      itemWhereSql: predicates.itemWhereSql,
      params: predicates.params,
    };
  }

  // Authenticated but no stable user candidate after retry.
  recordOwnerScopeWaitEnd(readiness, 'unavailable');
  return { status: 'owner_unavailable' };
}


/** Compose owner + target + duplicate-exclusion predicates for item JOIN queries (H3). */
export function composeOwnerScopedItemHistoryWhere(
  ownerScope: LocalReceiptOwnerScopeReady,
  targetFilter: { sql: string; params: readonly string[] },
  duplicateExclusion: { sql: string; params: string[] } = { sql: '', params: [] }
): { whereSql: string; whereParams: string[] } {
  return {
    whereSql: `(${ownerScope.itemWhereSql}) AND (${targetFilter.sql})${duplicateExclusion.sql}`,
    whereParams: [
      ...ownerScope.params,
      ...targetFilter.params,
      ...duplicateExclusion.params,
    ],
  };
}

/** Owner-bounded broad fetch (e.g. merchant_product identity consumer input). */
export function composeOwnerScopedItemBroadFetchWhere(
  ownerScope: LocalReceiptOwnerScopeReady,
  duplicateExclusion: { sql: string; params: string[] } = { sql: '', params: [] }
): { whereSql: string; whereParams: string[] } {
  return {
    whereSql: `(${ownerScope.itemWhereSql})${duplicateExclusion.sql}`,
    whereParams: [...ownerScope.params, ...duplicateExclusion.params],
  };
}

export function composeReceiptListWhereClause(
  scope: LocalReceiptOwnerScopeReady,
  searchWhereClause: string,
  searchWhereParams: string[]
): { whereClause: string; whereParams: string[] } {
  const ownerClause = `(${scope.receiptWhereSql})`;
  if (!searchWhereClause.trim()) {
    return {
      whereClause: `WHERE ${ownerClause}`,
      whereParams: [...scope.params],
    };
  }
  const searchPredicate = searchWhereClause.replace(/^WHERE\s+/i, '').trim();
  return {
    whereClause: `WHERE ${ownerClause} AND (${searchPredicate})`,
    whereParams: [...scope.params, ...searchWhereParams],
  };
}

export function receiptMatchesOwnerScope(
  row: { user_id?: string | null; installation_id?: string | null },
  scope: LocalReceiptOwnerScopeReady
): boolean {
  const parsed = parseOwnerKey(scope.ownerKey);
  if (!parsed) return false;
  if (parsed.kind === 'user') {
    return row.user_id === parsed.id;
  }
  return (
    (row.user_id == null || row.user_id === '') &&
    row.installation_id === parsed.id
  );
}
