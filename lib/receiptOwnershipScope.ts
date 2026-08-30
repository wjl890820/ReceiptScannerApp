/**
 * Privacy-H1 — shared current local receipt owner read scope.
 */

import { resolvePersonalProductIdentityOwnerKey } from './personalProductIdentityContract';

export type LocalReceiptOwnerScopeReady = {
  status: 'ready';
  ownerKey: string;
  receiptWhereSql: string;
  itemWhereSql: string;
  params: string[];
};

export type LocalReceiptOwnerScope =
  | LocalReceiptOwnerScopeReady
  | { status: 'owner_unavailable' };

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
  const { resolveOwnershipStamp } = await import('./receiptOwnershipContext');
  const stamp = await resolveOwnershipStamp();
  const ownerKey = resolvePersonalProductIdentityOwnerKey(stamp);
  if (!ownerKey) {
    return { status: 'owner_unavailable' };
  }
  const predicates = buildOwnerScopedReceiptPredicates(ownerKey);
  if (!predicates) {
    return { status: 'owner_unavailable' };
  }
  return {
    status: 'ready',
    ownerKey: predicates.ownerKey,
    receiptWhereSql: predicates.receiptWhereSql,
    itemWhereSql: predicates.itemWhereSql,
    params: predicates.params,
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
