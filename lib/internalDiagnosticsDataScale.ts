/**
 * Cheap data-scale snapshot for Internal Diagnostics export.
 * COUNT(*) only — never full-history reconstruction.
 */

export type InternalDiagnosticsDataScale = {
  receiptCount: number | null;
  receiptItemCount: number | null;
  personalIdentityDecisionCount: number | null;
  shoppingListItemCount: number | null;
  shoppingListIncompleteCount: number | null;
  notes: string[];
};

async function safeCount(
  db: { getFirstAsync: (sql: string) => Promise<unknown> },
  sql: string
): Promise<number | null> {
  try {
    const row = (await db.getFirstAsync(sql)) as
      | { c?: number | string }
      | null;
    const n = Number(row?.c);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort lightweight counts. Export must remain fast.
 */
export async function collectInternalDiagnosticsDataScale(): Promise<InternalDiagnosticsDataScale> {
  const notes: string[] = [];
  try {
    // Lazy import keeps unit tests that never touch SQLite isolated.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getReceiptsDatabase } = require('./db') as {
      getReceiptsDatabase: () => Promise<{
        getFirstAsync: (sql: string) => Promise<unknown>;
      }>;
    };
    const db = await getReceiptsDatabase();
    const receiptCount = await safeCount(db, 'SELECT COUNT(*) AS c FROM receipts');
    const receiptItemCount = await safeCount(
      db,
      'SELECT COUNT(*) AS c FROM receipt_items'
    );
    const personalIdentityDecisionCount = await safeCount(
      db,
      'SELECT COUNT(*) AS c FROM personal_product_identity_decisions'
    );
    const shoppingListItemCount = await safeCount(
      db,
      `SELECT COUNT(*) AS c FROM shopping_intents WHERE status IN ('active','completed')`
    );
    const shoppingListIncompleteCount = await safeCount(
      db,
      `SELECT COUNT(*) AS c FROM shopping_intents WHERE status = 'active'`
    );
    if (shoppingListItemCount == null) {
      notes.push('shopping_list_count_unavailable');
    }

    return {
      receiptCount,
      receiptItemCount,
      personalIdentityDecisionCount,
      shoppingListItemCount,
      shoppingListIncompleteCount,
      notes,
    };
  } catch {
    notes.push('data_scale_collection_failed');
    return {
      receiptCount: null,
      receiptItemCount: null,
      personalIdentityDecisionCount: null,
      shoppingListItemCount: null,
      shoppingListIncompleteCount: null,
      notes,
    };
  }
}
