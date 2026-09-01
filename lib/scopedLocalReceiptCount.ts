import type * as SQLite from 'expo-sqlite';

import type { LocalReceiptOwnerScopeReady } from './receiptOwnershipScope';

/**
 * Count stored receipt rows for a resolved owner scope snapshot.
 * Same visibility predicate as listReceiptRows(); not analytics-deduplicated.
 */
export async function countScopedLocalReceiptsForOwnerScope(
  scope: LocalReceiptOwnerScopeReady,
  db: SQLite.SQLiteDatabase
): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM receipts WHERE ${scope.receiptWhereSql}`,
    scope.params
  );
  return row?.c ?? 0;
}
