/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(() => ({ status: 'unauthenticated', userId: null })),
  subscribeAuthState: jest.fn(() => () => undefined),
  ensureAnonAuth: jest.fn(async () => undefined),
}));
jest.mock('./installationId', () => ({
  getOrCreateInstallationId: jest.fn(async () => 'install-test'),
}));

import {
  buildOwnerScopedInventoryPredicates,
  buildOwnerScopedReceiptNamedPredicates,
  buildOwnerScopedReceiptPredicates,
  composeReceiptListWhereClause,
  ownerScopeNamedPredicatesFromReady,
  receiptMatchesOwnerScope,
  resolveCurrentLocalReceiptOwnerScope,
} from './receiptOwnershipScope';
import {
  __setOwnershipStampProviderForTests,
  type LocalOwnershipStamp,
} from './receiptOwnershipContext';

describe('receiptOwnershipScope', () => {
  afterEach(() => {
    __setOwnershipStampProviderForTests(null);
  });

  describe('buildOwnerScopedReceiptPredicates', () => {
    it('user owner returns correct SQL + params', () => {
      expect(buildOwnerScopedReceiptPredicates('user:uid-a')).toEqual({
        ownerKey: 'user:uid-a',
        receiptWhereSql: 'receipts.user_id = ?',
        itemWhereSql: 'receipts.user_id = ?',
        params: ['uid-a'],
      });
    });

    it('installation owner requires user_id IS NULL and installation_id', () => {
      expect(buildOwnerScopedReceiptPredicates('installation:install-a')).toEqual({
        ownerKey: 'installation:install-a',
        receiptWhereSql:
          'receipts.user_id IS NULL AND receipts.installation_id = ?',
        itemWhereSql:
          'receipts.user_id IS NULL AND receipts.installation_id = ?',
        params: ['install-a'],
      });
    });

    it.each([
      'user:',
      'installation:',
      'unknown:abc',
      '',
    ])('invalid owner key %j is unavailable', (ownerKey) => {
      expect(buildOwnerScopedReceiptPredicates(ownerKey)).toBeNull();
    });

    it('inventory alias delegates to shared predicate builder', () => {
      const shared = buildOwnerScopedReceiptPredicates('user:uid-a');
      const inventory = buildOwnerScopedInventoryPredicates('user:uid-a');
      expect(inventory).toEqual({
        receiptWhereSql: shared!.receiptWhereSql,
        itemWhereSql: shared!.itemWhereSql,
        params: shared!.params,
      });
    });
  });

  describe('buildOwnerScopedReceiptNamedPredicates', () => {
    it('user owner returns named SQL + binds', () => {
      expect(buildOwnerScopedReceiptNamedPredicates('user:uid-a')).toEqual({
        ownerKey: 'user:uid-a',
        receiptWhereSql: 'receipts.user_id = $ownerScopeUserId',
        itemWhereSql: 'receipts.user_id = $ownerScopeUserId',
        binds: { $ownerScopeUserId: 'uid-a' },
      });
    });

    it('installation owner returns named SQL + binds', () => {
      expect(buildOwnerScopedReceiptNamedPredicates('installation:install-a')).toEqual({
        ownerKey: 'installation:install-a',
        receiptWhereSql:
          'receipts.user_id IS NULL AND receipts.installation_id = $ownerScopeInstallationId',
        itemWhereSql:
          'receipts.user_id IS NULL AND receipts.installation_id = $ownerScopeInstallationId',
        binds: { $ownerScopeInstallationId: 'install-a' },
      });
    });

    it.each(['user:', 'installation:', 'unknown:abc', ''])(
      'malformed owner key %j is unavailable',
      (ownerKey) => {
        expect(buildOwnerScopedReceiptNamedPredicates(ownerKey)).toBeNull();
      }
    );

    it('ready scope helper delegates to shared named builder', () => {
      const positional = buildOwnerScopedReceiptPredicates('user:uid-a')!;
      const named = ownerScopeNamedPredicatesFromReady({
        status: 'ready',
        ...positional,
      });
      expect(named).toEqual(buildOwnerScopedReceiptNamedPredicates('user:uid-a'));
    });
  });

  describe('resolveCurrentLocalReceiptOwnerScope', () => {
    function setStamp(stamp: LocalOwnershipStamp) {
      __setOwnershipStampProviderForTests(async () => stamp);
    }

    it('authenticated stamp resolves to user scope', async () => {
      setStamp({
        userId: 'user-auth',
        installationId: 'install-x',
        transactionSource: 'receipt_ocr',
      });
      await expect(resolveCurrentLocalReceiptOwnerScope()).resolves.toEqual({
        status: 'ready',
        ownerKey: 'user:user-auth',
        receiptWhereSql: 'receipts.user_id = ?',
        itemWhereSql: 'receipts.user_id = ?',
        params: ['user-auth'],
      });
    });

    it('installation stamp resolves when user is absent', async () => {
      setStamp({
        userId: null,
        installationId: 'install-only',
        transactionSource: 'receipt_ocr',
      });
      await expect(resolveCurrentLocalReceiptOwnerScope()).resolves.toEqual({
        status: 'ready',
        ownerKey: 'installation:install-only',
        receiptWhereSql:
          'receipts.user_id IS NULL AND receipts.installation_id = ?',
        itemWhereSql:
          'receipts.user_id IS NULL AND receipts.installation_id = ?',
        params: ['install-only'],
      });
    });

    it('both unavailable resolves owner_unavailable', async () => {
      setStamp({
        userId: null,
        installationId: null,
        transactionSource: 'receipt_ocr',
      });
      await expect(resolveCurrentLocalReceiptOwnerScope()).resolves.toEqual({
        status: 'owner_unavailable',
      });
    });
  });

  describe('composeReceiptListWhereClause', () => {
    const userScope = buildOwnerScopedReceiptPredicates('user:uid-a')!;

    it('composes owner-only WHERE', () => {
      expect(
        composeReceiptListWhereClause(
          { status: 'ready', ...userScope },
          '',
          []
        )
      ).toEqual({
        whereClause: 'WHERE (receipts.user_id = ?)',
        whereParams: ['uid-a'],
      });
    });

    it('AND-composes owner with search predicate', () => {
      expect(
        composeReceiptListWhereClause(
          { status: 'ready', ...userScope },
          'WHERE (merchant_raw LIKE ? OR merchant_normalized LIKE ? OR note LIKE ?)',
          ['%lawson%', '%lawson%', '%lawson%']
        )
      ).toEqual({
        whereClause:
          'WHERE (receipts.user_id = ?) AND ((merchant_raw LIKE ? OR merchant_normalized LIKE ? OR note LIKE ?))',
        whereParams: ['uid-a', '%lawson%', '%lawson%', '%lawson%'],
      });
    });
  });

  describe('receiptMatchesOwnerScope', () => {
    const userScope = {
      status: 'ready' as const,
      ...buildOwnerScopedReceiptPredicates('user:uid-a')!,
    };
    const installScope = {
      status: 'ready' as const,
      ...buildOwnerScopedReceiptPredicates('installation:install-a')!,
    };

    it('user scope matches only same user_id', () => {
      expect(receiptMatchesOwnerScope({ user_id: 'uid-a' }, userScope)).toBe(
        true
      );
      expect(receiptMatchesOwnerScope({ user_id: 'uid-b' }, userScope)).toBe(
        false
      );
      expect(
        receiptMatchesOwnerScope(
          { user_id: null, installation_id: 'install-a' },
          userScope
        )
      ).toBe(false);
    });

    it('installation scope matches only NULL user_id + matching installation_id', () => {
      expect(
        receiptMatchesOwnerScope(
          { user_id: null, installation_id: 'install-a' },
          installScope
        )
      ).toBe(true);
      expect(
        receiptMatchesOwnerScope(
          { user_id: null, installation_id: 'install-b' },
          installScope
        )
      ).toBe(false);
      expect(
        receiptMatchesOwnerScope(
          { user_id: 'uid-a', installation_id: 'install-a' },
          installScope
        )
      ).toBe(false);
      expect(
        receiptMatchesOwnerScope(
          { user_id: null, installation_id: null },
          installScope
        )
      ).toBe(false);
    });

    it('double-NULL rows are excluded from both scopes', () => {
      const doubleNull = { user_id: null, installation_id: null };
      expect(receiptMatchesOwnerScope(doubleNull, userScope)).toBe(false);
      expect(receiptMatchesOwnerScope(doubleNull, installScope)).toBe(false);
    });
  });
});
