import type * as SQLite from 'expo-sqlite';

import { countScopedLocalReceiptsForOwnerScope } from './scopedLocalReceiptCount';
import type { LocalReceiptOwnerScopeReady } from './receiptOwnershipScope';

const scope: LocalReceiptOwnerScopeReady = {
  status: 'ready',
  ownerKey: 'user:owner-a',
  receiptWhereSql: 'receipts.user_id = ? AND receipts.installation_id IS NULL',
  itemWhereSql: 'receipts.user_id = ?',
  params: ['owner-a'],
};

describe('countScopedLocalReceiptsForOwnerScope', () => {
  it('B. uses owner predicate and binds without analytics dedup', async () => {
    const getFirstAsync = jest.fn(async () => ({ c: 7 }));
    const db = { getFirstAsync } as unknown as SQLite.SQLiteDatabase;

    const count = await countScopedLocalReceiptsForOwnerScope(scope, db);

    expect(count).toBe(7);
    expect(getFirstAsync).toHaveBeenCalledTimes(1);
    expect(getFirstAsync).toHaveBeenCalledWith(
      'SELECT COUNT(*) as c FROM receipts WHERE receipts.user_id = ? AND receipts.installation_id IS NULL',
      ['owner-a']
    );
    expect(
      String((getFirstAsync.mock.calls[0] as unknown[] | undefined)?.[0] ?? '')
    ).not.toMatch(/selectAnalyticsReceipts|dedup/i);
  });
});
